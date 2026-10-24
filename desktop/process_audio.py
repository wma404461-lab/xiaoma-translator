"""WASAPI process-tree loopback. Never silently fall back to the desktop mix."""
import ctypes as c
from ctypes import wintypes as w
import uuid

HRESULT=c.c_long
PTR=c.c_void_p

class GUID(c.Structure):
    _fields_=[('bytes',c.c_ubyte*16)]
    def __init__(self,value):
        super().__init__();c.memmove(c.addressof(self),uuid.UUID(value).bytes_le,16)

class Activation(c.Structure):
    _fields_=[('kind',c.c_int),('pid',w.DWORD),('mode',c.c_int)]

class Blob(c.Structure):
    _fields_=[('size',w.ULONG),('data',PTR)]

class VariantValue(c.Union):
    _fields_=[('blob',Blob),('padding',c.c_ulonglong*2)]

class Variant(c.Structure):
    _fields_=[('type',w.WORD),('reserved',w.WORD*3),('value',VariantValue)]

class WaveFormat(c.Structure):
    _pack_=1
    _fields_=[('tag',w.WORD),('channels',w.WORD),('rate',w.DWORD),('bytes_per_second',w.DWORD),('block',w.WORD),('bits',w.WORD),('extra',w.WORD)]

def method(pointer,index,result,*types):
    if not pointer:raise RuntimeError('Missing COM interface')
    table=c.cast(pointer,c.POINTER(c.POINTER(PTR))).contents
    return c.WINFUNCTYPE(result,PTR,*types)(table[index])

def check(result,operation):
    if result<0:raise RuntimeError(f'{operation}: HRESULT 0x{result&0xffffffff:08x}')

def release(pointer):
    if pointer:method(pointer,2,w.ULONG)(pointer)

kernel=c.WinDLL('kernel32',use_last_error=True)
kernel.CreateEventW.argtypes=[PTR,w.BOOL,w.BOOL,w.LPCWSTR];kernel.CreateEventW.restype=w.HANDLE
kernel.SetEvent.argtypes=[w.HANDLE];kernel.SetEvent.restype=w.BOOL
kernel.WaitForSingleObject.argtypes=[w.HANDLE,w.DWORD];kernel.WaitForSingleObject.restype=w.DWORD
kernel.CloseHandle.argtypes=[w.HANDLE]
ole=c.WinDLL('ole32');ole.CoInitializeEx.argtypes=[PTR,w.DWORD];ole.CoInitializeEx.restype=HRESULT
audio=c.WinDLL('mmdevapi');audio.ActivateAudioInterfaceAsync.argtypes=[w.LPCWSTR,c.POINTER(GUID),c.POINTER(Variant),PTR,c.POINTER(PTR)];audio.ActivateAudioInterfaceAsync.restype=HRESULT

AUDIO_CLIENT=GUID('1cb9ad4c-dbfa-4c32-b178-c2f568a703b2')
CAPTURE_CLIENT=GUID('c8adbd64-e71e-48a0-a4de-185c395cd317')
HANDLER_IIDS={uuid.UUID(value).bytes_le for value in ('00000000-0000-0000-c000-000000000046','41d949ab-9862-444a-80f6-c261334da5eb','94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90')}
_pending_handlers=[]

class Completion:
    def __init__(self):
        self.event=kernel.CreateEventW(None,True,False,None);self.result=-2147467259;self.interface=PTR();self.refs=1
        query=c.WINFUNCTYPE(HRESULT,PTR,c.POINTER(GUID),c.POINTER(PTR))
        ref=c.WINFUNCTYPE(w.ULONG,PTR)
        complete=c.WINFUNCTYPE(HRESULT,PTR,PTR)
        def qi(this,iid,output):
            if bytes(iid.contents.bytes) in HANDLER_IIDS:output[0]=this;self.refs+=1;return 0
            output[0]=None;return -2147467262
        def add(this):self.refs+=1;return self.refs
        def drop(this):self.refs=max(0,self.refs-1);return self.refs
        def done(this,operation):
            result=HRESULT();interface=PTR()
            try:
                hr=method(operation,3,HRESULT,c.POINTER(HRESULT),c.POINTER(PTR))(operation,c.byref(result),c.byref(interface))
                self.result=hr if hr<0 else result.value;self.interface=interface
            except Exception:self.result=-2147467259
            kernel.SetEvent(self.event);return 0
        self.callbacks=[query(qi),ref(add),ref(drop),complete(done)]
        self.table=(PTR*4)(*[c.cast(callback,PTR).value for callback in self.callbacks])
        self.object=(PTR*1)(c.cast(self.table,PTR).value);self.pointer=c.cast(self.object,PTR)

class ProcessCapture:
    """48 kHz stereo float32 audio from only the named process and descendants."""
    def __init__(self,pid):
        self.client=PTR();self.capture=PTR();self.started=False
        hr=ole.CoInitializeEx(None,0)
        if hr not in (0,1,-2147417850):check(hr,'COM initialization')
        self.com_owned=hr in (0,1)
        self.handler=Completion();params=Activation(1,int(pid),0);variant=Variant();variant.type=65;variant.value.blob=Blob(c.sizeof(params),c.addressof(params));operation=PTR();failed=False
        try:
            check(audio.ActivateAudioInterfaceAsync('VAD\\Process_Loopback',c.byref(AUDIO_CLIENT),c.byref(variant),self.handler.pointer,c.byref(operation)),'Process-loopback activation')
            if kernel.WaitForSingleObject(self.handler.event,5000)!=0:
                # Keep callback storage alive if Windows completes a timed-out operation later.
                _pending_handlers.append((self.handler,params,variant));raise RuntimeError('Process-loopback activation timed out')
            check(self.handler.result,'Process-loopback activation result')
            check(method(self.handler.interface,0,HRESULT,c.POINTER(GUID),c.POINTER(PTR))(self.handler.interface,c.byref(AUDIO_CLIENT),c.byref(self.client)),'Audio client interface')
            self.format=WaveFormat(3,2,48000,48000*8,8,32,0)
            check(method(self.client,3,HRESULT,c.c_int,w.DWORD,c.c_longlong,c.c_longlong,c.POINTER(WaveFormat),PTR)(self.client,0,0x20000,1000000,0,c.byref(self.format),None),'Process-loopback format')
            check(method(self.client,14,HRESULT,c.POINTER(GUID),c.POINTER(PTR))(self.client,c.byref(CAPTURE_CLIENT),c.byref(self.capture)),'Capture client interface')
            check(method(self.client,10,HRESULT)(self.client),'Start process audio');self.started=True
        except Exception:
            failed=True;raise
        finally:
            release(operation);release(self.handler.interface);self.handler.interface=PTR()
            if kernel.WaitForSingleObject(self.handler.event,0)==0:kernel.CloseHandle(self.handler.event);self.handler.event=None
            if failed:self.close()
    def read(self):
        result=bytearray()
        for _ in range(100):
            count=w.UINT();check(method(self.capture,5,HRESULT,c.POINTER(w.UINT))(self.capture,c.byref(count)),'Read packet count')
            if not count.value:break
            data=PTR();frames=w.UINT();flags=w.DWORD()
            check(method(self.capture,3,HRESULT,c.POINTER(PTR),c.POINTER(w.UINT),c.POINTER(w.DWORD),PTR,PTR)(self.capture,c.byref(data),c.byref(frames),c.byref(flags),None,None),'Read audio packet')
            try:
                size=frames.value*self.format.block
                if size and not data and not flags.value&2:raise RuntimeError('Missing process-audio packet data')
                result.extend(bytes(size) if flags.value&2 else c.string_at(data,size))
            finally:check(method(self.capture,4,HRESULT,w.UINT)(self.capture,frames.value),'Release audio packet')
        return bytes(result)
    def close(self):
        if self.started:method(self.client,11,HRESULT)(self.client);self.started=False
        release(self.capture);release(self.client);self.capture=PTR();self.client=PTR()
        if getattr(self,'com_owned',False):ole.CoUninitialize();self.com_owned=False

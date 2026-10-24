"""One Windows process-table snapshot per poll, with fresh PID identities."""
import ctypes,time
from ctypes import wintypes
import psutil

class ProcessEntry(ctypes.Structure):
    _fields_=[('dwSize',wintypes.DWORD),('cntUsage',wintypes.DWORD),('th32ProcessID',wintypes.DWORD),('th32DefaultHeapID',ctypes.c_size_t),('th32ModuleID',wintypes.DWORD),('cntThreads',wintypes.DWORD),('th32ParentProcessID',wintypes.DWORD),('pcPriClassBase',wintypes.LONG),('dwFlags',wintypes.DWORD),('szExeFile',wintypes.WCHAR*260)]

kernel=ctypes.WinDLL('kernel32',use_last_error=True)
kernel.CreateToolhelp32Snapshot.argtypes=[wintypes.DWORD,wintypes.DWORD];kernel.CreateToolhelp32Snapshot.restype=wintypes.HANDLE
kernel.Process32FirstW.argtypes=[wintypes.HANDLE,ctypes.POINTER(ProcessEntry)];kernel.Process32FirstW.restype=wintypes.BOOL
kernel.Process32NextW.argtypes=[wintypes.HANDLE,ctypes.POINTER(ProcessEntry)];kernel.Process32NextW.restype=wintypes.BOOL
kernel.CloseHandle.argtypes=[wintypes.HANDLE];kernel.CloseHandle.restype=wintypes.BOOL

def process_table():
    handle=kernel.CreateToolhelp32Snapshot(2,0)
    if handle==ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
    entries={};entry=ProcessEntry();entry.dwSize=ctypes.sizeof(entry)
    try:
        if not kernel.Process32FirstW(handle,ctypes.byref(entry)):raise ctypes.WinError(ctypes.get_last_error())
        while True:
            entries[entry.th32ProcessID]=entry.th32ParentProcessID
            if not kernel.Process32NextW(handle,ctypes.byref(entry)):
                if ctypes.get_last_error()!=18:raise ctypes.WinError(ctypes.get_last_error())
                break
    finally:kernel.CloseHandle(handle)
    return entries

class PollProcessTree:
    def __init__(self):
        self.observed_at=time.time();self.ppids=process_table();self.processes={};self.trees={}
    def process(self,pid):
        if pid not in self.ppids:raise psutil.NoSuchProcess(pid)
        if pid not in self.processes:
            process=psutil.Process(pid)
            # A PID born during/after enumeration cannot safely inherit the
            # enumerated process's ancestry. Try it again on the next poll.
            if process.create_time()>self.observed_at:raise psutil.NoSuchProcess(pid)
            self.processes[pid]=process
        return self.processes[pid]
    def parents(self,process):
        if process.pid in self.trees:return self.trees[process.pid]
        child=self.process(process.pid);parents=[];seen={child.pid}
        while True:
            pid=self.ppids.get(child.pid)
            if not pid or pid in seen:break
            try:parent=self.process(pid)
            except psutil.Error:break
            # Match psutil's parent-PID reuse protection: a parent must have
            # existed before the child. Nothing is cached across polls.
            if parent.create_time()>child.create_time():break
            parents.append(parent);seen.add(pid);child=parent
        self.trees[process.pid]=parents
        return parents

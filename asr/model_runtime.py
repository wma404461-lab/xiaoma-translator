"""Use the available NVIDIA device for final recognition, with a CPU fallback."""
import gc
import ctypes
import importlib.util
import json
import os
import pathlib
import subprocess
import numpy as np
import ctranslate2
from faster_whisper import WhisperModel

_dll_handles = []
_vendor_libraries = []
def load_whisper(cache):
    if os.name=='nt':
        paths=[]
        for package in ('nvidia.cuda_runtime','nvidia.cublas','nvidia.cudnn'):
            try:
                spec=importlib.util.find_spec(package)
            except (ImportError,ModuleNotFoundError):
                spec=None
            if spec and spec.submodule_search_locations:
                paths.extend(pathlib.Path(path)/'bin' for path in spec.submodule_search_locations)
        paths.append(cache/'llama-b11382')
        for path in paths:
            if path.is_dir():
                _dll_handles.append(os.add_dll_directory(str(path)))
    model_path=os.environ.get('FLOWSUB_WHISPER_MODEL',str(cache/'whisper-small-en'))
    requested=os.environ.get('FLOWSUB_ASR_DEVICE','auto')
    free_mib=0
    try:
        report=subprocess.run(['nvidia-smi','--query-gpu=memory.free','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=5,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        free_mib=int(report.stdout.splitlines()[0])
    except Exception:
        pass
    device='cuda' if requested!='cpu' and ctranslate2.get_cuda_device_count()>0 and (requested=='cuda' or free_mib>=1400) else 'cpu'
    fallback=False
    fallback_error=''
    candidate=None
    try:
        if device=='cuda' and os.name=='nt':
            # CTranslate2 uses LoadLibrary; preload vendor dependencies from scoped DLL directories.
            for name in ('cudart64_12.dll','cublasLt64_12.dll','cublas64_12.dll','cudnn64_9.dll'):
                target=next((path/name for path in paths if (path/name).is_file()),name)
                _vendor_libraries.append(ctypes.WinDLL(str(target)))
        candidate=WhisperModel(model_path,device=device,compute_type='int8_float16' if device=='cuda' else 'int8',cpu_threads=4)
        # Exercise encoder and decoder before publishing readiness; missing vendor DLLs fail here.
        segments,_=candidate.transcribe(np.zeros(8000,dtype=np.float32),language='en',beam_size=1,max_new_tokens=8,vad_filter=False)
        list(segments)
    except Exception as error:
        if device=='cpu':
            raise
        fallback_error=str(error)[:500]
        candidate=None;gc.collect();device='cpu';fallback=True
        candidate=WhisperModel(model_path,device='cpu',compute_type='int8',cpu_threads=4)
    label={'whisper-small-en':'Whisper small.en','whisper-medium-en':'Whisper medium.en'}.get(pathlib.Path(model_path).name,'Custom Whisper model')
    candidate.flowsub_label=label
    (cache/'asr-runtime.json').write_text(json.dumps({'model':label,'device':device,'computeType':'int8_float16' if device=='cuda' else 'int8','cudaFreeMiBBeforeLoad':free_mib,'cpuFallback':fallback,'fallbackError':fallback_error}),encoding='utf-8')
    return candidate,device

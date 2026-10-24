"""Optional GPU dependencies must not make CPU recognition unavailable."""
import importlib.util,json,pathlib,sys,tempfile,types,unittest
from unittest.mock import patch
root=pathlib.Path(__file__).resolve().parents[1]

class FakeModel:
    devices=[]
    def __init__(self,path,device,**kwargs):self.device=device;self.devices.append(device)
    def transcribe(self,*args,**kwargs):return iter([]),None

class OptionalGpuTest(unittest.TestCase):
    def module(self):
        spec=importlib.util.spec_from_file_location('tested_model_runtime',root/'asr/model_runtime.py')
        module=importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules,{'numpy':types.SimpleNamespace(zeros=lambda *args,**kwargs:[],float32='float32'),'faster_whisper':types.SimpleNamespace(WhisperModel=FakeModel),'ctranslate2':types.SimpleNamespace(get_cuda_device_count=lambda:1)}):
            spec.loader.exec_module(module)
        return module

    def test_missing_namespace_and_dll_fall_back_to_cpu(self):
        module=self.module();FakeModel.devices=[]
        with tempfile.TemporaryDirectory() as temporary:
            cache=pathlib.Path(temporary)
            with patch.object(module.importlib.util,'find_spec',side_effect=ModuleNotFoundError('No nvidia package')),patch.object(module.subprocess,'run',return_value=types.SimpleNamespace(stdout='2048\n')),patch.object(module.ctypes,'WinDLL',side_effect=OSError('Optional DLL absent')),patch.dict(module.os.environ,{'FLOWSUB_ASR_DEVICE':'auto'}):
                _,device=module.load_whisper(cache)
            self.assertEqual(device,'cpu');self.assertEqual(FakeModel.devices,['cpu'])
            self.assertTrue(json.loads((cache/'asr-runtime.json').read_text())['cpuFallback'])

    def test_explicit_cpu_avoids_loading_vendor_libraries(self):
        module=self.module();FakeModel.devices=[]
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(module.importlib.util,'find_spec',return_value=None),patch.object(module.subprocess,'run',return_value=types.SimpleNamespace(stdout='4096\n')),patch.object(module.ctypes,'WinDLL') as vendor,patch.dict(module.os.environ,{'FLOWSUB_ASR_DEVICE':'cpu'}):
                _,device=module.load_whisper(pathlib.Path(temporary))
            self.assertEqual(device,'cpu');vendor.assert_not_called()

if __name__=='__main__':unittest.main()

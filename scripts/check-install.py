"""Fast launch preflight: dependencies must import and all model files must exist."""
import os
import pathlib
import subprocess
import sys

cache = pathlib.Path(os.environ.get('FLOWSUB_CACHE', pathlib.Path.home()/'.cache/flowsub'))
try:
    import PyQt6.QtWidgets
    import pyaudiowpatch
    import sherpa_onnx
    import faster_whisper
    import yaml
    import pycaw
    import psutil
    required = [
        cache/'Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        cache/'download-manifest.json',
        cache/'zipformer-en-giga/manifest.json',
        cache/'zipformer-en-giga/tokens.txt',
        cache/'whisper-small-en/model.bin',
        cache/'whisper-small-en/config.json',
        cache/'whisper-small-en/tokenizer.json',
        cache/'grammar-venv/Scripts/python.exe',
    ]
    assert all(path.is_file() and path.stat().st_size for path in required)
    assert len(list((cache/'zipformer-en-giga').glob('*.int8.onnx'))) == 3
    assert any((cache/'llama-b11382').rglob('llama-server.exe'))
    subprocess.run([str(cache/'grammar-venv/Scripts/python.exe'), '-c',
                    "import spacy; spacy.load('en_core_web_sm',exclude=['ner','lemmatizer'])"],
                   check=True, timeout=40, capture_output=True)
except Exception as error:
    print('Preparation required:', type(error).__name__)
    sys.exit(1)
print('Ready')

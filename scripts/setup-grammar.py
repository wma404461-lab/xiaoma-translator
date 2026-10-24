"""Install the pinned free parser in an isolated venv, verify model bytes first."""
import hashlib,os,pathlib,subprocess,sys,urllib.request,venv
cache=pathlib.Path(os.environ.get('FLOWSUB_CACHE',pathlib.Path.home()/'.cache/flowsub'))
environment=cache/'grammar-venv';python=environment/'Scripts/python.exe'
compatible = python.exists() and subprocess.run([str(python), '-c', 'import sys;assert sys.version_info[:2]==(3,12)'],capture_output=True).returncode == 0
if not compatible:venv.EnvBuilder(with_pip=True,clear=True).create(environment)
requirements=pathlib.Path(__file__).resolve().parents[1]/'asr/grammar-requirements-lock.txt'
subprocess.run([str(python),'-m','pip','install','-r',str(requirements)],check=True)
directory=cache/'grammar-model';directory.mkdir(parents=True,exist_ok=True)
wheel=directory/'en_core_web_sm-3.8.0-py3-none-any.whl'
digest='1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85'
valid=lambda path:path.is_file() and hashlib.file_digest(path.open('rb'),'sha256').hexdigest()==digest
if not valid(wheel):
    temporary=wheel.with_suffix('.part')
    with urllib.request.urlopen('https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl',timeout=60) as source,temporary.open('wb') as output:
        while block:=source.read(1024*1024):output.write(block)
    if not valid(temporary):raise ValueError('English grammar model SHA256 mismatch')
    temporary.replace(wheel)
subprocess.run([str(python),'-m','pip','install','--no-deps',str(wheel)],check=True)
subprocess.run([str(python),'-c',"import spacy; n=spacy.load('en_core_web_sm',exclude=['ner','lemmatizer']); assert n.meta['version']=='3.8.0'; print('Free grammar model ready.')"],check=True)

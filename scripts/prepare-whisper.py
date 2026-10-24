"""Pin and verify upstream CTranslate2 conversions of English Whisper models."""
import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import urllib.request
from ranged_download import download_verified

cache = pathlib.Path(os.environ.get('FLOWSUB_CACHE',pathlib.Path.home()/'.cache'/'flowsub'))
parser=argparse.ArgumentParser();parser.add_argument('--model',choices=['small.en','medium.en'],default='small.en');args=parser.parse_args()
directory = cache/('whisper-'+args.model.replace('.','-'))
directory.mkdir(parents=True,exist_ok=True)
repo = 'Systran/faster-whisper-'+args.model
revision = {'small.en':'d1d751a5f8271d482d14ca55d9e2deeebbae577f','medium.en':'a29b04bd15381511a9af671baec01072039215e3'}[args.model]
with urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true',timeout=60) as response:
    info = json.load(response)
items = [item for item in info['siblings'] if item['rfilename'] in ['model.bin','config.json','tokenizer.json','vocabulary.json','vocabulary.txt']]
if not any(item['rfilename']=='model.bin' for item in items):
    raise ValueError('Unexpected model manifest')
print(json.dumps({'revision':info['sha'],'files':[item['rfilename'] for item in items]}),flush=True)

def download(item):
    target = directory/item['rfilename']
    expected = item.get('lfs',{}).get('sha256')
    if target.exists() and (not expected or hashlib.file_digest(target.open('rb'),'sha256').hexdigest()==expected):
        return
    if download_verified(f'https://huggingface.co/{repo}/resolve/{info["sha"]}/{item["rfilename"]}',target,expected,item.get('lfs',{}).get('size')):
        return
    with urllib.request.urlopen(f'https://huggingface.co/{repo}/resolve/{info["sha"]}/{item["rfilename"]}',timeout=90) as response,target.with_suffix('.part').open('wb') as output:
        while chunk:=response.read(1024*1024):
            output.write(chunk)
    partial = target.with_suffix('.part')
    if expected and hashlib.file_digest(partial.open('rb'),'sha256').hexdigest()!=expected:
        raise ValueError('Model checksum mismatch')
    partial.replace(target)
    print(f"Ready: {item['rfilename']}",flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(download,items))
(directory/'manifest.json').write_text(json.dumps({'repo':repo,'revision':info['sha'],'files':items},indent=2),encoding='utf-8')

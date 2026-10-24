import hashlib, json, os, pathlib, urllib.request, concurrent.futures
cache=pathlib.Path(os.environ.get('FLOWSUB_CACHE',pathlib.Path.home()/'.cache'/'flowsub'))/'zipformer-en-giga';cache.mkdir(parents=True,exist_ok=True)
repo='csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-21'
with urllib.request.urlopen('https://huggingface.co/api/models/'+repo+'/revision/9a65b6ea94c311ca770c2bf895b30f456a22d703?blobs=true',timeout=60) as response:info=json.load(response)
items=[x for x in info['siblings'] if x['rfilename']=='tokens.txt' or (x['rfilename'].endswith('.int8.onnx') and '/' not in x['rfilename'])]
if len(items)!=4:raise ValueError('Unexpected official model manifest')
def download(item):
    path=cache/item['rfilename'];digest=item.get('lfs',{}).get('sha256')
    if path.exists() and (not digest or hashlib.file_digest(path.open('rb'),'sha256').hexdigest()==digest):return
    with urllib.request.urlopen(f'https://huggingface.co/{repo}/resolve/{info["sha"]}/{item["rfilename"]}',timeout=90) as response,path.with_suffix('.part').open('wb') as output:
        while chunk:=response.read(1024*1024):output.write(chunk)
    partial=path.with_suffix('.part')
    if digest and hashlib.file_digest(partial.open('rb'),'sha256').hexdigest()!=digest:raise ValueError('Checksum mismatch')
    partial.replace(path);print('Ready:',path.name,flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(download,items))
(cache/'manifest.json').write_text(json.dumps({'repo':repo,'revision':info['sha'],'files':items},indent=2),encoding='utf-8')

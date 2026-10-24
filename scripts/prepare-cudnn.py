"""Fetch the pinned optional recognition runtime in parallel, then install locally."""
import concurrent.futures
import importlib.metadata
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.request
from ranged_download import download_verified, sha256

def install_runtime(package,version):
    try:
        if importlib.metadata.version(package)==version:
            print('NVIDIA recognition runtime ready.',flush=True)
            return
    except importlib.metadata.PackageNotFoundError:
        pass
    with urllib.request.urlopen('https://pypi.org/pypi/'+package+'/'+version+'/json',timeout=30) as reply:
        info=json.load(reply)
    wheel=next(item for item in info['urls'] if item['filename'].endswith('win_amd64.whl'))
    cache=pathlib.Path(os.environ.get('FLOWSUB_CACHE',pathlib.Path.home()/'.cache/flowsub'))/'wheels'
    cache.mkdir(parents=True,exist_ok=True)
    destination=cache/wheel['filename']
    digest=wheel['digests']['sha256']
    if not destination.is_file() or sha256(destination)!=digest:
        official=wheel['url']
        mirror=official.replace('https://files.pythonhosted.org/','https://pypi.tuna.tsinghua.edu.cn/')
        def speed(url):
            start=time.monotonic()
            try:
                request=urllib.request.Request(url,headers={'Range':'bytes=0-1048575','User-Agent':'FlowSub/0.2'})
                with urllib.request.urlopen(request,timeout=15) as reply:
                    data=reply.read(1048576)
                return (len(data)/max(.001,time.monotonic()-start),url)
            except Exception:
                return (0,url)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            sources=sorted(pool.map(speed,[official,mirror]),reverse=True)
        for _,url in sources:
            try:
                if download_verified(url,destination,digest,wheel['size']):
                    break
                subprocess.run([sys.executable,'-m','pip','download','--no-deps','--dest',str(cache),url],check=True)
                if destination.is_file() and sha256(destination)==digest:
                    break
            except Exception:
                continue
        if not destination.is_file() or sha256(destination)!=digest:
            raise RuntimeError('NVIDIA runtime download verification failed')
    subprocess.run([sys.executable,'-m','pip','install','--disable-pip-version-check','--no-deps',str(destination)],check=True)

for package,version in [('nvidia-cuda-runtime-cu12','12.8.90'),('nvidia-cublas-cu12','12.8.5.5'),('nvidia-cudnn-cu12','9.10.2.21')]:
    install_runtime(package,version)

"""Download pinned open model quantization/vendor runtime outside project folders."""
import concurrent.futures, hashlib, json, os, pathlib, time, urllib.request, zipfile,zlib
from ranged_download import download_verified
from importlib.machinery import SourceFileLoader
mirror_source = SourceFileLoader('model_mirror',str(pathlib.Path(__file__).with_name('model-mirror.py'))).load_module().mirror_source

CACHE = pathlib.Path(os.environ.get('FLOWSUB_CACHE', pathlib.Path.home() / '.cache' / 'flowsub'))
CACHE.mkdir(parents=True, exist_ok=True)
def request(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'FlowSub/0.1'}), timeout=60)
def download(url, dest, expected=None, size=None):
    if dest.exists() and (not expected or hashlib.file_digest(dest.open('rb'), 'sha256').hexdigest() == expected):
        return str(dest)
    upstream = url
    url, opener = mirror_source(url, dest.name)
    try:
        parallel = download_verified(url,dest,expected,size,opener=opener)
    except (OSError, urllib.error.URLError):
        if url == upstream: raise
        url, opener = upstream, urllib.request.urlopen
        parallel = download_verified(url,dest,expected,size)
    if parallel:
        return parallel
    partial = dest.with_suffix(dest.suffix + '.part')
    for attempt in range(4):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            headers = {'User-Agent': 'FlowSub/0.1'}
            if offset: headers['Range'] = f'bytes={offset}-'
            with opener(urllib.request.Request(url, headers=headers), timeout=90) as response:
                if response.status != 206: offset = 0
                with partial.open('ab' if offset else 'wb') as output:
                    reported = offset
                    while block := response.read(1024 * 1024):
                        output.write(block); offset += len(block)
                        if offset - reported > 100 * 1024 * 1024:
                            print(f'FLOWSUB_DOWNLOAD|当前文件已下载 {offset // 1048576} MB', flush=True); reported = offset
            if expected and hashlib.file_digest(partial.open('rb'), 'sha256').hexdigest() != expected:
                partial.unlink(); raise ValueError(f'Checksum mismatch: {dest.name}')
            partial.replace(dest); print(f'Ready: {dest.name}', flush=True); return str(dest)
        except Exception:
            if attempt == 3: raise
            time.sleep(2 ** attempt)

release = json.load(request('https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b11382'))
names = ['llama-b11382-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip']
model_repo='bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF'
model_info = {'sha':'ae44f08e1392f39c0e474af10c3ff8355c8b6688'}
model_name = 'Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf'
model = {'lfs':{'sha256':'2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e','size':2497280736}}
jobs = [(f'https://huggingface.co/{model_repo}/resolve/{model_info["sha"]}/{model_name}', CACHE / model_name, model['lfs']['sha256'], model['lfs']['size'])]
for name in names:
    asset = next(x for x in release['assets'] if x['name'] == name)
    jobs.append((asset['browser_download_url'], CACHE / name, (asset.get('digest') or '').removeprefix('sha256:') or None, asset['size']))
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    paths = list(pool.map(lambda args: download(*args), jobs))
binary_dir = CACHE / 'llama-b11382'; binary_dir.mkdir(exist_ok=True)
for path in paths[1:]:
    with zipfile.ZipFile(path) as archive:
        for entry in archive.infolist():
            target = (binary_dir / entry.filename).resolve()
            if not target.is_relative_to(binary_dir.resolve()): raise ValueError('Invalid archive path')
            if entry.is_dir():target.mkdir(parents=True,exist_ok=True);continue
            if target.is_file() and target.stat().st_size==entry.file_size:
                checksum=0
                with target.open('rb') as existing:
                    while block:=existing.read(1024*1024):checksum=zlib.crc32(block,checksum)
                if checksum==entry.CRC:continue
            try:archive.extract(entry,binary_dir)
            except PermissionError as error:raise RuntimeError('A different runtime is in use. Stop FlowSub, then rerun setup-local.ps1.') from error
(CACHE / 'download-manifest.json').write_text(json.dumps({'llama_release': release['tag_name'], 'original_model':'Qwen/Qwen3-4B-Instruct-2507','quantized_repository':model_repo,'model_revision': model_info['sha'], 'model_sha256': model['lfs']['sha256'], 'model': str(CACHE / model_name), 'binary_dir': str(binary_dir)}, indent=2), encoding='utf-8')
print('Local translation runtime ready.', flush=True)

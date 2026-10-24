"""Parallel, resumable HTTPS ranges; publish a file only after its SHA-256 matches."""
import concurrent.futures
import hashlib
import pathlib
import re
import shutil
import threading
import time
import urllib.request

def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while data := source.read(8*1024*1024):
            digest.update(data)
    return digest.hexdigest()

def download_verified(url, destination, expected, size, workers=6, chunk_size=32*1024*1024, opener=None):
    destination = pathlib.Path(destination)
    if not expected or not size or size < 64*1024*1024:
        return None
    if destination.is_file() and sha256(destination) == expected:
        return str(destination)
    partial = destination.with_suffix(destination.suffix+'.part')
    if partial.is_file() and partial.stat().st_size == size and sha256(partial) == expected:
        partial.replace(destination)
        return str(destination)

    def response(start, end):
        request = urllib.request.Request(url, headers={'User-Agent':'FlowSub/0.2', 'Range':f'bytes={start}-{end}'})
        reply = (opener or urllib.request.urlopen)(request, timeout=45)
        actual = reply.headers.get('Content-Range','')
        if reply.status != 206 or actual != f'bytes {start}-{end}/{size}':
            reply.close()
            return None
        return reply

    # Probe support before touching an existing sequential partial download.
    try:
        probe = response(0, 0)
    except OSError:
        return None
    if probe is None:
        return None
    probe.close()
    if partial.is_file() and partial.stat().st_size > size:
        partial.unlink()
    offset = partial.stat().st_size if partial.is_file() else 0
    directory = destination.with_name(destination.name+'.chunks')
    directory.mkdir(exist_ok=True)
    ranges = [(start,min(size-1,start+chunk_size-1)) for start in range(offset,size,chunk_size)]
    paths = {start: directory/f'{start}-{end}.part' for start,end in ranges}
    counts = {}
    for start,end in ranges:
        path = paths[start]
        if path.is_file() and path.stat().st_size > end-start+1:
            path.unlink()
        counts[start] = path.stat().st_size if path.is_file() else 0
    lock = threading.Lock()
    last_report = [0.0]

    def report(start, count):
        with lock:
            counts[start] = count
            if time.monotonic()-last_report[0] >= 1:
                done = offset+sum(counts.values())
                print(f'FLOWSUB_DOWNLOAD|Downloaded {done//1048576} / {size//1048576} MB',flush=True)
                last_report[0] = time.monotonic()

    def part(bounds):
        start,end = bounds
        path = paths[start]
        length = end-start+1
        for attempt in range(4):
            written = path.stat().st_size if path.is_file() else 0
            if written == length:
                return path
            try:
                reply = response(start+written,end)
                if reply is None:
                    raise ValueError('Server did not honor the requested byte range')
                with reply, path.open('ab') as output:
                    while written < length:
                        data = reply.read(min(1024*1024,length-written))
                        if not data:
                            raise EOFError('Incomplete download range')
                        output.write(data)
                        written += len(data)
                        report(start,written)
                if written == length:
                    return path
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2**attempt)
        raise RuntimeError('Range download failed')

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(part,ranges))
    with partial.open('ab') as output:
        for start,end in ranges:
            with paths[start].open('rb') as source:
                shutil.copyfileobj(source,output,1024*1024)
    if partial.stat().st_size != size or sha256(partial) != expected:
        partial.unlink()
        # Failed bytes must not be reused on the next retry.
        for path in paths.values():
            path.unlink(missing_ok=True)
        raise ValueError('Downloaded file failed SHA-256 verification')
    partial.replace(destination)
    # Remove only files created for this named download, confined to its directory.
    for path in directory.iterdir():
        if path.is_file() and re.fullmatch(r'\d+-\d+\.part',path.name):
            path.unlink()
    if not any(directory.iterdir()):
        directory.rmdir()
    print(f'Ready: {destination.name}',flush=True)
    return str(destination)

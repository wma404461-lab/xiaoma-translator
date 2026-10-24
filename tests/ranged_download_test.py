"""Exercise real HTTP ranges, prefix resume, bad bytes and non-range fallback."""
import hashlib
import http.server
import pathlib
import random
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from ranged_download import download_verified

DATA = random.Random(1031).randbytes(64*1024*1024+1)
DIGEST = hashlib.sha256(DATA).hexdigest()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        bounds=self.headers['Range'].removeprefix('bytes=').split('-')
        start,end=map(int,bounds)
        if self.path=='/ignored':
            self.send_response(200);self.send_header('Content-Length',str(len(DATA)));self.end_headers()
            return
        self.send_response(206)
        self.send_header('Content-Range',f'bytes {start}-{end}/{len(DATA)}')
        self.send_header('Content-Length',str(end-start+1));self.end_headers()
        chunk=DATA[start:end+1]
        if self.path=='/corrupted' and len(chunk)>1:
            chunk=bytes([chunk[0]^1])+chunk[1:]
        with self.server.count_lock:
            self.server.active+=1;self.server.peak=max(self.server.peak,self.server.active)
        try:
            time.sleep(.02)
            self.wfile.write(chunk)
        except OSError: pass
        finally:
            with self.server.count_lock:self.server.active-=1

class DownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        cls.server.active=cls.server.peak=0;cls.server.count_lock=threading.Lock()
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
        cls.url=f'http://127.0.0.1:{cls.server.server_port}'
    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close();cls.thread.join()
    def test_resumes_existing_prefix_and_downloads_in_parallel(self):
        with tempfile.TemporaryDirectory() as temp:
            path=pathlib.Path(temp)/'model.bin'
            path.with_suffix('.bin.part').write_bytes(DATA[:12345])
            download_verified(self.url+'/good',path,DIGEST,len(DATA),chunk_size=4*1024*1024)
            self.assertEqual(path.read_bytes(),DATA)
            self.assertGreaterEqual(self.server.peak,2)
            self.assertFalse(path.with_suffix('.bin.part').exists())
    def test_corruption_never_publishes_or_reuses_bad_parts(self):
        with tempfile.TemporaryDirectory() as temp:
            path=pathlib.Path(temp)/'model.bin'
            with self.assertRaises(ValueError):
                download_verified(self.url+'/corrupted',path,DIGEST,len(DATA),chunk_size=4*1024*1024)
            self.assertFalse(path.exists())
            self.assertFalse(path.with_suffix('.bin.part').exists())
            self.assertFalse(list(path.with_name('model.bin.chunks').glob('*.part')))
    def test_server_without_ranges_keeps_sequential_prefix_for_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            path=pathlib.Path(temp)/'model.bin';partial=path.with_suffix('.bin.part')
            partial.write_bytes(DATA[:12345])
            self.assertIsNone(download_verified(self.url+'/ignored',path,DIGEST,len(DATA)))
            self.assertEqual(partial.read_bytes(),DATA[:12345])
if __name__=='__main__':unittest.main()

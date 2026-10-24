import importlib.util
import pathlib
import unittest
from unittest.mock import patch, MagicMock
import urllib.error
import urllib.request
import http.client
import ssl

spec=importlib.util.spec_from_file_location('model_mirror', pathlib.Path(__file__).parents[1]/'scripts/model-mirror.py')
mirror=importlib.util.module_from_spec(spec);spec.loader.exec_module(mirror)
NAME='Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf'

class MirrorTests(unittest.TestCase):
    def test_unrelated_file_keeps_official_source(self):
        self.assertEqual(mirror.mirror_source('https://official/file','other.bin')[0], 'https://official/file')

    def test_wrong_length_falls_back(self):
        opener=MagicMock(); reply=opener.open.return_value.__enter__.return_value
        reply.status=200;reply.headers={'Content-Length':'7'}
        with patch.object(urllib.request,'build_opener',return_value=opener):
            self.assertEqual(mirror.mirror_source('https://official/file',NAME)[0],'https://official/file')

    def test_tls_failure_falls_back(self):
        opener=MagicMock();opener.open.side_effect=urllib.error.URLError('certificate mismatch')
        with patch.object(urllib.request,'build_opener',return_value=opener):
            self.assertEqual(mirror.mirror_source('https://official/file',NAME)[0],'https://official/file')

    def test_redirect_and_other_origin_rejected(self):
        handlers=[];opener=MagicMock();opener.open.side_effect=OSError('offline')
        def capture(*values): handlers.extend(values);return opener
        with patch.object(urllib.request,'build_opener',side_effect=capture): mirror.mirror_source('https://official/file',NAME)
        with self.assertRaises(urllib.error.URLError): handlers[0].https_open(urllib.request.Request('https://other.example/file'))
        with self.assertRaises(urllib.error.URLError): handlers[1].redirect_request(None,None,None,None,None,None)

    def test_renewed_certificates_require_ca_and_hostname(self):
        handlers=[];opener=MagicMock();opener.open.side_effect=OSError('offline')
        def capture(*values): handlers.extend(values);return opener
        with patch.object(urllib.request,'build_opener',side_effect=capture): mirror.mirror_source('https://official/file',NAME)
        self.assertTrue(handlers[0]._context.check_hostname)
        self.assertEqual(handlers[0]._context.verify_mode,ssl.CERT_REQUIRED)

if __name__=='__main__': unittest.main()

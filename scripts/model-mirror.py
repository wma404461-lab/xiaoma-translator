"""Authenticated file mirror only. Computation and caches stay on the PC."""
import hashlib
import http.client
import pathlib
import ssl
import urllib.error
import urllib.parse
import urllib.request

ORIGIN = 'https://154.9.26.140:8443'
CERTIFICATE = pathlib.Path(__file__).resolve().parents[1] / 'assets/model-server.pem'


def mirror_source(original, filename):
    if filename != 'Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf' or not CERTIFICATE.is_file():
        return original, urllib.request.urlopen
    # The public CA verifies the IP SAN and chain, including future renewals.
    # Model contents additionally require the immutable SHA-256 in prepare-local.
    context = ssl.create_default_context()

    class Handler(urllib.request.HTTPSHandler):
        def https_open(self, request):
            if urllib.parse.urlsplit(request.full_url).netloc != '154.9.26.140:8443':
                raise urllib.error.URLError('Model mirror origin changed')
            return self.do_open(http.client.HTTPSConnection, request, context=context)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise urllib.error.URLError('Model mirror must not redirect')

    opener = urllib.request.build_opener(Handler(context=context), NoRedirect())
    url = ORIGIN + '/tools/flowsub/files/' + filename
    try:
        with opener.open(urllib.request.Request(url, method='HEAD'), timeout=5) as response:
            if response.status != 200 or response.headers.get('Content-Length') != '2497280736':
                return original, urllib.request.urlopen
    except (OSError, urllib.error.URLError):
        return original, urllib.request.urlopen
    return url, opener.open

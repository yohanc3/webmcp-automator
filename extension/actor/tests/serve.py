"""Serve the repository for actor tests, without stale browser script caches."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    print('Actor tests: http://127.0.0.1:4317/extension/actor/tests/index.html', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 4317), Handler).serve_forever()

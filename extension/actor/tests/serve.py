"""Serve the repository for actor tests, without stale browser script caches."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(os.environ.get('WEBMCP_ACTOR_TEST_PORT', '4317'))
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(
        f'Actor tests: http://127.0.0.1:{server.server_port}/extension/actor/tests/index.html',
        flush=True,
    )
    server.serve_forever()

"""Serve docs/ locally the way GitHub Pages does (correct MIME type for ES modules; Windows' http.server sends .js as text/plain).

    python tools/serve.py [port]      # default 8080 -> http://127.0.0.1:8080/
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DOCS = Path(__file__).resolve().parents[1] / "docs"
class H(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript",
                      ".json": "application/json", ".css": "text/css", ".webp": "image/webp", ".md": "text/markdown; charset=utf-8", ".ots": "application/octet-stream"}
    def end_headers(self): self.send_header("Cache-Control", "no-store"); super().end_headers()
    def log_message(self, *a): pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
print(f"serving {DOCS} on http://127.0.0.1:{port}/", flush=True)
ThreadingHTTPServer(("127.0.0.1", port), partial(H, directory=str(DOCS))).serve_forever()

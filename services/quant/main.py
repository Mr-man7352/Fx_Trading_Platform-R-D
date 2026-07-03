"""Quant service — Step 1.2 placeholder (BE-004).

Healthcheck-only stub so the compose stack passes BE-004 acceptance criteria.
QN-001 (Step 1.5) replaces this with the real FastAPI + gRPC scaffold.
Deliberately stdlib-only: no venv or pip install needed for `pnpm dev`.
"""

import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("QUANT_PORT", "5000"))
COMMIT = os.environ.get("GIT_COMMIT", "dev")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 — http.server API
        if self.path == "/healthz":
            body = json.dumps(
                {"status": "ok", "service": "quant-stub", "commit": COMMIT}
            ).encode()
            self.send_response(200)
        else:
            body = json.dumps(
                {"error": {"code": "NOT_FOUND", "message": "Not found"}}
            ).encode()
            self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"quant-stub: {fmt % args}")


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)

    def shutdown(signum, frame):
        print("quant-stub: shutting down")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    print(f"quant-stub listening on :{PORT} (replaced by QN-001 in Step 1.5)")
    server.serve_forever()


if __name__ == "__main__":
    main()

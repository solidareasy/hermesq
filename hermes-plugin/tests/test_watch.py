"""Tests for `hermes hermesq watch` (the monitor the host cron runs, no LLM).

The plugin is copied to a temp dir first (the layout `hermes plugins install` leaves, with no package.json
above it) and the command registered by `cli.register_cli` runs the real `node watch.ts` against a local
server that applies the Worker's admin rules (Bearer token and a non-default user-agent). Needs Node >= 22.18.
"""

import argparse
import contextlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

PLUGIN_DIR = Path(__file__).resolve().parent.parent
TOKEN = "test-admin-token"


def iso(minutes_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")


class FakeWorker(BaseHTTPRequestHandler):
    health_status = 200
    deliveries: list = []

    def log_message(self, format, *args):  # noqa: A002 - silence the per-request log
        pass

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(self.health_status, {"ok": self.health_status == 200})
        if self.path.startswith("/admin/deliveries"):
            if self.headers.get("authorization") != f"Bearer {TOKEN}" or "curl" in self.headers.get("user-agent", "curl"):
                return self._send(403, {"error": "forbidden"})
            return self._send(200, {"deliveries": self.deliveries})
        return self._send(404, {})


class WatchCommand(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="hermesq-watch-test-")
        installed = Path(cls.tmp) / "hermesq"
        shutil.copytree(PLUGIN_DIR, installed, ignore=shutil.ignore_patterns("tests", "__pycache__"))
        spec = importlib.util.spec_from_file_location("hermesq_cli_under_test", installed / "cli.py")
        assert spec and spec.loader
        cls.cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.cli)
        token_file = Path(cls.tmp) / "admin_token"
        token_file.write_text(TOKEN + "\n")
        cls.token_file = str(token_file)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeWorker)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        FakeWorker.health_status = 200
        FakeWorker.deliveries = []

    def run_command(self, url=None, token_file=None):
        """`hermes hermesq watch` as the Hermes CLI wires it: register_cli → setup_fn on a subparser → func."""
        registered = {}

        class Ctx:
            def register_cli_command(self, **kw):
                registered.update(kw)

        self.cli.register_cli(Ctx())
        self.assertEqual(registered["name"], "hermesq")
        parser = argparse.ArgumentParser(prog="hermes")
        sub = parser.add_subparsers(dest="command")
        registered["setup_fn"](sub.add_parser(registered["name"], help=registered["help"]))
        args = parser.parse_args(["hermesq", "watch"])
        env = {"HERMESQ_URL": url or self.url, "HERMESQ_ADMIN_TOKEN_FILE": token_file or self.token_file}
        out = io.StringIO()
        with mock.patch.dict(os.environ, env), contextlib.redirect_stdout(out):
            rc = args.func(args)
        return rc, out.getvalue()

    def test_healthy_is_silent_and_exits_0(self):
        FakeWorker.deliveries = [
            {"subscriptionName": "github", "status": "delivered", "createdAt": iso(90)},
            {"subscriptionName": "github", "status": "pending", "createdAt": iso(3)},
        ]
        self.assertEqual(self.run_command(), (0, ""))

    def test_health_down_reports_and_exits_nonzero(self):
        FakeWorker.health_status = 503
        rc, out = self.run_command()
        self.assertNotEqual(rc, 0)
        self.assertIn("/health", out)

    def test_unreachable_worker_reports_and_exits_nonzero(self):
        rc, out = self.run_command(url="http://127.0.0.1:9")
        self.assertNotEqual(rc, 0)
        self.assertIn("/health", out)

    def test_failed_dead_letter_and_stuck_deliveries_report_and_exit_nonzero(self):
        for status, age, expected in [
            ("failed", 1, "linear failed"),
            ("dead-letter", 5, "linear dead-letter"),
            ("pending", 30, "linear pending (30 min)"),
            ("processing", 45, "linear processing (45 min)"),
        ]:
            with self.subTest(status=status):
                FakeWorker.deliveries = [{"subscriptionName": "linear", "status": status, "createdAt": iso(age)}]
                rc, out = self.run_command()
                self.assertNotEqual(rc, 0)
                self.assertIn(expected, out)

    def test_admin_api_refused_reports_and_exits_nonzero(self):
        wrong = Path(self.tmp) / "wrong_token"
        wrong.write_text("wrong")
        rc, out = self.run_command(token_file=str(wrong))
        self.assertNotEqual(rc, 0)
        self.assertIn("/admin/deliveries", out)


if __name__ == "__main__":
    unittest.main()

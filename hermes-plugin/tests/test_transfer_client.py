"""Stdlib tests for transfer_client: signing contract, HTTP shape against a local server that applies the
Worker's verification rules, and the poll loop (ack on handler failure, backoff, fatal stop).
The same client is also run against the real Worker (wrangler dev) by test/integration/poller.test.ts."""

import asyncio
import hashlib
import hmac
import json
import os
import sys
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import transfer_client as tc  # noqa: E402

SECRET = "hermes-contract-secret"


class SigningContract(unittest.TestCase):
    """Same vectors as test/unit/hermes-contract.test.ts (TypeScript side of the Worker)."""

    def test_poll_vector(self):
        self.assertEqual(
            tc.sign(SECRET, "1700000000", "GET", "/hermes/poll?limit=10&wait=5000", ""),
            "sha256=9ec00d9c7ae8cf46b983493cbfcc359316565d3a7d06ac3990d047d48812691c",
        )

    def test_ack_vector(self):
        body = '{"deliveryId":"d-1","status":"delivered","result":null}'
        self.assertEqual(
            tc.sign(SECRET, "1700000000", "POST", "/hermes/ack", body),
            "sha256=bee039a7485c955fd2c6af601d40b60479be184b953f3e295d61bf13b3603577",
        )


class FakeWorker(BaseHTTPRequestHandler):
    """Verifies requests exactly like src/routes/hermes.ts and serves a scripted queue."""

    deliveries: list = []
    acks: list = []
    seen_consumers: list = []

    def log_message(self, format, *args):  # noqa: A002 (silence the default stderr log)
        pass

    def _verify(self, body: str) -> bool:
        ts = self.headers.get("x-hermes-timestamp", "")
        sig = self.headers.get("x-hermes-signature", "")
        if not ts or abs(time.time() - int(ts)) > 300:
            return False
        expected = "sha256=" + hmac.new(SECRET.encode(), f"{ts}.{self.command}.{self.path}.{body}".encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, expected)

    def _send(self, status: int, payload):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if not self._verify(""):
            return self._send(401, {"error": "unauthorized", "reason": "bad_signature"})
        FakeWorker.seen_consumers.append(self.headers.get("x-hermes-consumer"))
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        limit = int(q.get("limit", ["10"])[0])
        out, FakeWorker.deliveries = FakeWorker.deliveries[:limit], FakeWorker.deliveries[limit:]
        self._send(200, {"deliveries": out, "cursor": out[-1]["deliveryId"] if out else q.get("lastDeliveryId", [None])[0]})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", "0"))).decode()
        if not self._verify(body):
            return self._send(401, {"error": "unauthorized", "reason": "bad_signature"})
        payload = json.loads(body)
        FakeWorker.acks.append(payload)
        self._send(200, {"deliveryId": payload["deliveryId"], "status": payload["status"]})


class ClientAgainstFakeWorker(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeWorker)
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeWorker.deliveries = [{"deliveryId": f"d-{i}", "prompt": f"p{i}"} for i in range(3)]
        FakeWorker.acks = []
        FakeWorker.seen_consumers = []

    def test_poll_and_ack_are_accepted_by_the_worker_rules(self):
        client = tc.TransferClient(self.url, SECRET, consumer="host-1")
        page = client.poll(limit=2, wait_ms=0)
        self.assertEqual([d["deliveryId"] for d in page["deliveries"]], ["d-0", "d-1"])
        self.assertEqual(page["cursor"], "d-1")
        self.assertEqual(client.ack("d-0", "delivered", {"ok": True}), {"deliveryId": "d-0", "status": "delivered"})
        self.assertEqual(FakeWorker.acks, [{"deliveryId": "d-0", "status": "delivered", "result": {"ok": True}}])
        self.assertEqual(FakeWorker.seen_consumers, ["host-1"])

    def test_wrong_secret_is_a_fatal_transfer_error(self):
        client = tc.TransferClient(self.url, "wrong")
        with self.assertRaises(tc.TransferError) as ctx:
            client.poll(wait_ms=0)
        self.assertEqual(ctx.exception.status, 401)
        self.assertTrue(ctx.exception.fatal)

    def test_ack_status_is_validated_before_sending(self):
        with self.assertRaises(ValueError):
            tc.TransferClient(self.url, SECRET).ack("d-0", "done")

    def test_cli_poll_once_acks_and_reads_the_secret_from_env(self):
        os.environ["WT_TEST_SECRET"] = SECRET
        try:
            from io import StringIO
            from contextlib import redirect_stdout

            buf = StringIO()
            with redirect_stdout(buf):
                code = tc._cli(["poll-once", "--url", self.url, "--secret-env", "WT_TEST_SECRET", "--wait", "0", "--ack", "delivered"])
            self.assertEqual(code, 0)
            out = json.loads(buf.getvalue())
            self.assertEqual(len(out["deliveries"]), 3)
            self.assertEqual([a["deliveryId"] for a in FakeWorker.acks], ["d-0", "d-1", "d-2"])
        finally:
            del os.environ["WT_TEST_SECRET"]
        self.assertEqual(tc._cli(["poll-once", "--url", self.url, "--secret-env", "WT_UNSET_SECRET"]), 2)


class StubClient:
    def __init__(self, pages):
        self.pages = list(pages)
        self.acks = []

    def poll(self, limit, wait_ms, cursor):
        item = self.pages.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def ack(self, delivery_id, status, result=None):
        self.acks.append((delivery_id, status, result))
        return {}


class PollLoop(unittest.TestCase):
    def test_handler_failure_acks_failed_and_the_loop_continues(self):
        stop = asyncio.Event()
        client = StubClient([{"deliveries": [{"deliveryId": "a"}, {"deliveryId": "b"}], "cursor": "b"}])
        handled = []

        async def handle(d):
            handled.append(d["deliveryId"])
            if d["deliveryId"] == "a":
                raise RuntimeError("agent crashed")
            stop.set()

        asyncio.run(tc.run_loop(client, handle, stop))
        self.assertEqual(handled, ["a", "b"])
        self.assertEqual(client.acks, [("a", "failed", {"error": "agent crashed"})])

    def test_network_errors_back_off_and_a_fatal_status_stops(self):
        stop = asyncio.Event()
        client = StubClient([OSError("down"), OSError("down"), tc.TransferError(500, {"error": "x"}), tc.TransferError(401, {"reason": "bad_signature"})])
        sleeps, fatal = [], []

        async def fake_sleep(s):
            sleeps.append(s)

        async def handle(_):
            raise AssertionError("no deliveries expected")

        asyncio.run(tc.run_loop(client, handle, stop, sleep=fake_sleep, on_fatal=fatal.append))
        self.assertEqual(sleeps, [1, 2, 5])
        self.assertEqual(fatal[0].status, 401)


if __name__ == "__main__":
    unittest.main()

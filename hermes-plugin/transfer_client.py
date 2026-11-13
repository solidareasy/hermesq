"""Outbound client for the hermesQ Worker. Standard library only.

The Worker never calls the host: the host long-polls ``GET /hermes/poll`` and confirms with
``POST /hermes/ack``. Both requests carry an HMAC-SHA256 signature with a shared secret
(``HERMES_WEBHOOK_SECRET`` on the Worker side):

    X-Hermes-Timestamp: <unix seconds>
    X-Hermes-Signature: sha256=hex(HMAC(secret, f"{ts}.{METHOD}.{path?query}.{body}"))
    X-Hermes-Consumer:  <stable id of this host>   (deliveries are leased to it)

CLI (smoke tests, cron, debugging); the secret is read from an environment variable, never argv:

    HERMESQ_SECRET=... python3 transfer_client.py poll-once --url https://x.workers.dev --ack delivered
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import logging
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

DEFAULT_WAIT_MS = 5000
DEFAULT_LIMIT = 10
RETRY_BACKOFF_SECONDS = (1, 2, 5, 10, 30)


class TransferError(Exception):
    """HTTP error from the Worker. ``fatal`` = retrying cannot help (bad secret, not configured)."""

    def __init__(self, status: int, body: Any):
        self.status = status
        self.body = body
        reason = body.get("reason") or body.get("error") if isinstance(body, dict) else body
        super().__init__(f"HTTP {status}: {reason}")

    @property
    def fatal(self) -> bool:
        return self.status in (401, 403, 503)


def signing_string(ts: str, method: str, path_with_query: str, body: str) -> str:
    return f"{ts}.{method.upper()}.{path_with_query}.{body}"


def sign(secret: str, ts: str, method: str, path_with_query: str, body: str) -> str:
    digest = hmac.new(secret.encode(), signing_string(ts, method, path_with_query, body).encode(), hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def default_consumer_id() -> str:
    return f"hermes-{socket.gethostname()}"


class TransferClient:
    def __init__(self, base_url: str, secret: str, consumer: Optional[str] = None, timeout: float = 30.0,
                 opener: Optional[Callable[..., Any]] = None):
        if not base_url or not secret:
            raise ValueError("base_url and secret are required")
        self.base_url = base_url.rstrip("/")
        self.secret = secret
        self.consumer = consumer or default_consumer_id()
        self.timeout = timeout
        self._open = opener or urllib.request.urlopen

    def _request(self, method: str, path_with_query: str, body: str = "", *, timeout: Optional[float] = None) -> Any:
        ts = str(int(time.time()))
        headers = {
            "x-hermes-timestamp": ts,
            "x-hermes-signature": sign(self.secret, ts, method, path_with_query, body),
            "x-hermes-consumer": self.consumer,
            "accept": "application/json",
            "user-agent": "hermesq/0.1",
        }
        data = None
        if method != "GET":
            headers["content-type"] = "application/json"
            data = body.encode()
        req = urllib.request.Request(self.base_url + path_with_query, data=data, method=method, headers=headers)
        try:
            with self._open(req, timeout=timeout or self.timeout) as resp:
                return json.loads(resp.read().decode() or "null")
        except urllib.error.HTTPError as err:
            raw = err.read().decode(errors="replace")
            try:
                parsed: Any = json.loads(raw)
            except ValueError:
                parsed = raw
            raise TransferError(err.code, parsed) from None

    def poll(self, limit: int = DEFAULT_LIMIT, wait_ms: int = DEFAULT_WAIT_MS, last_delivery_id: Optional[str] = None) -> dict:
        params = {"limit": str(limit), "wait": str(wait_ms)}
        if last_delivery_id:
            params["lastDeliveryId"] = last_delivery_id
        path = "/hermes/poll?" + urllib.parse.urlencode(params)
        # The Worker may hold the request for wait_ms; give the socket that much more.
        return self._request("GET", path, timeout=self.timeout + wait_ms / 1000)

    def ack(self, delivery_id: str, status: str, result: Any = None) -> dict:
        if status not in ("delivered", "failed"):
            raise ValueError("status must be delivered or failed")
        body = json.dumps({"deliveryId": delivery_id, "status": status, "result": result}, separators=(",", ":"))
        return self._request("POST", "/hermes/ack", body)


Handler = Callable[[dict], Awaitable[None]]


async def run_loop(client: TransferClient, handle: Handler, stop: asyncio.Event, *, limit: int = DEFAULT_LIMIT,
                   wait_ms: int = DEFAULT_WAIT_MS, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                   on_fatal: Optional[Callable[[TransferError], None]] = None) -> None:
    """Long-poll until ``stop`` is set. Each delivery goes to ``handle`` (which must ack it).

    A failing ``handle`` acks ``failed`` so the Worker applies its retry/dead-letter policy. Network
    errors back off 1, 2, 5, 10, 30 s; a fatal HTTP status (401/403/503) stops the loop.
    """
    cursor: Optional[str] = None
    failures = 0
    while not stop.is_set():
        try:
            page = await asyncio.to_thread(client.poll, limit, wait_ms, cursor)
            failures = 0
        except TransferError as err:
            if err.fatal:
                logger.error("[hermesq] poll refused, stopping: %s", err)
                if on_fatal:
                    on_fatal(err)
                return
            failures += 1
            logger.warning("[hermesq] poll failed (%s), retrying", err)
            await sleep(RETRY_BACKOFF_SECONDS[min(failures, len(RETRY_BACKOFF_SECONDS)) - 1])
            continue
        except Exception as err:  # network, DNS, timeouts
            failures += 1
            logger.warning("[hermesq] poll error (%s), retrying", err)
            await sleep(RETRY_BACKOFF_SECONDS[min(failures, len(RETRY_BACKOFF_SECONDS)) - 1])
            continue
        cursor = page.get("cursor") or cursor
        for delivery in page.get("deliveries") or []:
            if stop.is_set():
                return  # unacked claims go back to the queue when their lease ends
            try:
                await handle(delivery)
            except Exception as err:
                logger.exception("[hermesq] handler failed for %s", delivery.get("deliveryId"))
                try:
                    await asyncio.to_thread(client.ack, delivery["deliveryId"], "failed", {"error": str(err)[:500]})
                except Exception:
                    logger.exception("[hermesq] ack(failed) did not reach the Worker; the lease will expire")


def _cli(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="transfer_client.py", description=(__doc__ or "").split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    once = sub.add_parser("poll-once", help="poll once, print the deliveries as JSON, optionally ack them")
    once.add_argument("--url", required=True)
    once.add_argument("--secret-env", default="HERMESQ_SECRET", help="env var holding the shared secret")
    once.add_argument("--consumer", default=None)
    once.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    once.add_argument("--wait", type=int, default=DEFAULT_WAIT_MS, help="long-poll hold in ms")
    once.add_argument("--ack", choices=["none", "delivered", "failed"], default="none")
    args = p.parse_args(argv)
    secret = os.environ.get(args.secret_env, "")
    if not secret:
        print(f"{args.secret_env} is not set", file=sys.stderr)
        return 2
    client = TransferClient(args.url, secret, args.consumer)
    try:
        page = client.poll(args.limit, args.wait)
        acks = []
        if args.ack != "none":
            for d in page.get("deliveries") or []:
                acks.append(client.ack(d["deliveryId"], args.ack, {"by": "transfer_client.py"}))
    except TransferError as err:
        print(json.dumps({"error": str(err), "status": err.status, "body": err.body}), file=sys.stderr)
        return 1
    print(json.dumps({"deliveries": page.get("deliveries") or [], "cursor": page.get("cursor"), "acks": acks}))
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))

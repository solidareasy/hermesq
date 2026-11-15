"""`hermes hermesq watch`: the hermesQ monitor for a host cron (no LLM).

Prints nothing and exits 0 when healthy; prints one line and exits non-zero when /health fails or a
delivery is failed, dead-lettered or stuck for more than 10 minutes. The check itself is watch.ts, run by
Node (>= 22.18, type stripping, no build). It stays outside the gateway on purpose: if the gateway is down,
the cron still runs it.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

WATCH_TS = Path(__file__).resolve().parent / "watch.ts"
DEFAULT_TOKEN_FILE = "~/.config/hermesq/admin_token"


def watch(_args) -> int:
    node = shutil.which("node")
    if not node:
        print("hermesQ: node not found in PATH (needs Node >= 22.18)")
        return 2
    env = dict(os.environ)
    env.setdefault("HERMESQ_ADMIN_TOKEN_FILE", os.path.expanduser(DEFAULT_TOKEN_FILE))
    proc = subprocess.run([node, str(WATCH_TS)], env=env, capture_output=True, text=True, timeout=120)
    sys.stdout.write(proc.stdout)
    sys.stderr.write(proc.stderr)
    return proc.returncode


def setup(parser) -> None:
    sub = parser.add_subparsers(dest="hermesq_command", required=True)
    sub.add_parser(
        "watch",
        help="check /health and the last 50 deliveries; silent and exit 0 when healthy",
        description=f"Env: HERMESQ_URL, HERMESQ_ADMIN_TOKEN or HERMESQ_ADMIN_TOKEN_FILE (default {DEFAULT_TOKEN_FILE}).",
    ).set_defaults(func=watch)


def register_cli(ctx) -> None:
    ctx.register_cli_command(name="hermesq", help="hermesQ tools (watch: monitor for a host cron)", setup_fn=setup)

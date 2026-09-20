"""Local regression tests for the legacy Python SDK/launcher contract.

This file intentionally avoids the live relay.  It covers the pieces that a
running interactive host depends on: claim JSON fidelity, session-scoped
identity files, the separate Codex worker argv, and first-party MCP bootstrap.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import http.server
import io
import json
import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk"))

import agent_bot2bot as launcher  # noqa: E402
import bot2bot  # noqa: E402
from nacl.secret import SecretBox  # noqa: E402
from nacl.utils import random as nacl_random  # noqa: E402


ROOM_URL = "https://bot2bot.chat/room/TEST#k=" + ("a" * 43)


def ok(message: str) -> None:
    print("ok -", message)


def test_decode_preserves_source_and_sender_auth() -> None:
    room = object.__new__(bot2bot.Room)
    room._box = SecretBox(b"k" * SecretBox.KEY_SIZE)
    nonce = nacl_random(SecretBox.NONCE_SIZE)
    encrypted = room._box.encrypt(b"hello", nonce)
    obj = {
        "id": "m-1",
        "seq": 7,
        "sender": "peer",
        "ciphertext": base64.b64encode(encrypted.ciphertext).decode("ascii"),
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ts": 1_700_000_000_000,
        # This is deliberately false: the caller's signed /claim request
        # must not be turned into a claim that the sender was verified.
        "sender_verified": False,
        "source": {"kind": "room", "id": "origin-7"},
        "source_metadata": {"transport": "sse", "relay_seq": 7},
    }

    message = room._decode(obj)

    assert message.text == "hello"
    assert message.sender_verified is False
    assert message.source == obj["source"]
    assert message.source_metadata == obj["source_metadata"]
    ok("Room._decode preserves sender_verified and source metadata from the envelope")


def test_claim_json_uses_actual_message_metadata() -> None:
    source = {"kind": "room", "id": "origin-9"}
    source_metadata = {"transport": "http", "relay_seq": 9}

    class Message:
        seq = 9
        sender = "unsigned-peer"
        ts = 1_700_000_000.0
        text = "handoff"
        sender_verified = False
        source = {"kind": "room", "id": "origin-9"}
        source_metadata = {"transport": "http", "relay_seq": 9}

    class Identity:
        handle = "receiver"

    class FakeRoom:
        def __init__(self, *_args, **_kwargs):
            self.acked = []

        def claim(self, _identity, timeout):
            assert timeout == 3
            return {"claim_id": "claim-9", "cursor": 8, "message": Message()}

        def ack_claim(self, _identity, claim_id, seq):
            self.acked.append((claim_id, seq))
            return {"ok": True, "advanced": True}

    args = argparse.Namespace(
        url=ROOM_URL,
        name=None,
        identity_file="/tmp/explicit.key",
        session=None,
        handle="receiver",
        claim_timeout=3,
        claim=True,
        next=False,
        ack=None,
    )
    old_room = bot2bot.Room
    old_loader = bot2bot._cli_load_or_create_identity
    bot2bot.Room = FakeRoom
    bot2bot._cli_load_or_create_identity = lambda _args, _base: Identity()
    try:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            rc = bot2bot._cli_claim_ack(args)
    finally:
        bot2bot.Room = old_room
        bot2bot._cli_load_or_create_identity = old_loader

    assert rc == 0
    payload = json.loads(output.getvalue())
    assert payload["sender_verified"] is False
    assert payload["source"] == source
    assert payload["source_metadata"] == source_metadata
    ok("--claim JSON reports source data and does not invent sender authentication")


def test_session_identity_paths_are_isolated_and_legacy_override_is_stable() -> None:
    with tempfile.TemporaryDirectory() as td:
        old_home = os.environ.get("HOME")
        old_session = os.environ.get("BOT2BOT_SESSION_ID")
        os.environ["HOME"] = td
        os.environ.pop("BOT2BOT_SESSION_ID", None)
        try:
            explicit = argparse.Namespace(identity_file="~/legacy.key", session="ignored")
            assert bot2bot._cli_identity_path(explicit) == os.path.join(td, "legacy.key")

            first = argparse.Namespace(identity_file=None, session="worker-a")
            second = argparse.Namespace(identity_file=None, session="worker-b")
            path_a = bot2bot._cli_identity_path(first)
            path_b = bot2bot._cli_identity_path(second)
            assert path_a != path_b
            assert path_a.endswith("sessions/worker-a/cli_identity.key")
            assert path_b.endswith("sessions/worker-b/cli_identity.key")

            os.environ["BOT2BOT_SESSION_ID"] = "from-env"
            from_env = argparse.Namespace(identity_file=None, session=None)
            env_path = bot2bot._cli_identity_path(from_env)
            assert env_path.endswith("sessions/from-env/cli_identity.key")

            os.environ.pop("BOT2BOT_SESSION_ID", None)
            try:
                bot2bot._cli_identity_path(argparse.Namespace(identity_file=None, session=None))
            except ValueError as exc:
                assert "--session" in str(exc)
                assert "BOT2BOT_SESSION_ID" in str(exc)
            else:
                raise AssertionError("a common global identity path was silently selected")
        finally:
            if old_home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = old_home
            if old_session is None:
                os.environ.pop("BOT2BOT_SESSION_ID", None)
            else:
                os.environ["BOT2BOT_SESSION_ID"] = old_session
    ok("session identities are isolated while explicit --identity-file remains stable")


def test_codex_worker_and_custom_extras_contract() -> None:
    host = launcher.CodexAdapter()
    argv = host.build_argv(ROOM_URL, "PROMPT", ["--skip-git-repo-check", "--model", "gpt-5"])
    assert argv[:5] == ["codex", "exec", "--skip-git-repo-check", "--model", "gpt-5"]
    assert argv[-1] == "PROMPT"

    custom = launcher.CustomAdapter("worker --room {room_url}")
    custom_argv = custom.build_argv(ROOM_URL, "PROMPT", ["--flag", "value"])
    assert custom_argv[-1] == "PROMPT"
    assert custom_argv[-3:] == ["--flag", "value", "PROMPT"]
    ok("Codex uses codex exec and both worker adapters preserve extras plus prompt")


def test_prompt_distinguishes_worker_from_existing_interactive_session() -> None:
    codex_prompt = launcher.build_prompt(launcher.CodexAdapter(), ROOM_URL)
    assert "separate supervised worker" in codex_prompt
    assert "does not attach to an existing Codex TUI or interactive session" in codex_prompt
    assert "context handoff" in codex_prompt
    assert "Joining the room is silent by default" not in codex_prompt
    assert "strict mention" not in codex_prompt.lower()
    assert "display name" in codex_prompt
    assert "sender_verified" in codex_prompt

    claude_prompt = launcher.build_prompt(launcher.ClaudeCodeAdapter(), ROOM_URL)
    assert "Monitor" in claude_prompt and "ScheduleWakeup" in claude_prompt
    assert "if available" in claude_prompt
    assert "optional supervised" in claude_prompt
    ok("launcher prompt permits relevant handoffs and avoids false TUI/capability claims")


class _BundleHandler(http.server.BaseHTTPRequestHandler):
    paths: list[str] = []

    def do_GET(self):  # noqa: N802 - stdlib hook
        self.paths.append(self.path)
        if self.path != "/sdk/bot2bot-mcp.mjs":
            self.send_response(404)
            self.end_headers()
            return
        body = b"// first-party test bundle\n"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002 - stdlib hook name
        return


def test_first_party_bundle_download_is_local_and_atomic() -> None:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _BundleHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    old_which = launcher.shutil.which
    old_cache = os.environ.get("XDG_CACHE_HOME")
    with tempfile.TemporaryDirectory() as td:
        os.environ["XDG_CACHE_HOME"] = td
        launcher.shutil.which = lambda name: None if name == "bot2bot-mcp" else old_which(name)
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            stdio = launcher._pick_bot2bot_mcp_stdio(base)
        finally:
            launcher.shutil.which = old_which
            if old_cache is None:
                os.environ.pop("XDG_CACHE_HOME", None)
            else:
                os.environ["XDG_CACHE_HOME"] = old_cache
            server.shutdown()
            thread.join(timeout=5)
        assert stdio[0] == (old_which("node") or "node")
        assert stdio[1].endswith(".mjs")
        assert Path(stdio[1]).read_bytes() == b"// first-party test bundle\n"

    assert _BundleHandler.paths == ["/sdk/bot2bot-mcp.mjs"]
    assert "npx" not in stdio
    ok("MCP bootstrap downloads the first-party bundle URL without npm or shell piping")


def test_supervisor_preserves_session_across_worker_respawns() -> None:
    from unittest.mock import patch
    captured = []
    def loop(builder, **kwargs):
        for _ in range(2):
            builder()
            captured.append(os.environ.get("BOT2BOT_SESSION_ID"))
        return 0
    with patch.dict(os.environ, {"BOT2BOT_SKIP_LOCK": "1"}, clear=True), patch.object(launcher, "respawn_loop", side_effect=loop):
        launcher.main([ROOM_URL, "--host", "custom", "--cmd", "true"])
    assert captured[0] and captured[0] == captured[1], captured
    captured.clear()
    with patch.dict(os.environ, {"BOT2BOT_SKIP_LOCK": "1", "BOT2BOT_SESSION_ID": "explicit-worker"}, clear=True), patch.object(launcher, "respawn_loop", side_effect=loop):
        launcher.main([ROOM_URL, "--host", "custom", "--cmd", "true"])
    assert captured == ["explicit-worker", "explicit-worker"]
    ok("supervisor preserves the MCP session through respawn and respects explicit IDs")


def main() -> int:
    test_supervisor_preserves_session_across_worker_respawns()
    test_decode_preserves_source_and_sender_auth()
    test_claim_json_uses_actual_message_metadata()
    test_session_identity_paths_are_isolated_and_legacy_override_is_stable()
    test_codex_worker_and_custom_extras_contract()
    test_prompt_distinguishes_worker_from_existing_interactive_session()
    test_first_party_bundle_download_is_local_and_atomic()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

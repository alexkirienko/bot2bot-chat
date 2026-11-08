"""Local integration tests for Python/browser-compatible room attachments."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import requests
from nacl.secret import SecretBox
from nacl.utils import random as nacl_random

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sdk"))
from bot2bot import Identity, Room, _attachment_name  # noqa: E402


CHUNK_BYTES = 48 * 1024
MAX_BYTES = 10 * 1024 * 1024
ROOM_KEY = b"file-test-room-key-32-bytes-long!"
ROOM_KEY = ROOM_KEY[:32]
ROOM_ID = "filetest"
_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class _RelayState:
    def __init__(self):
        self.lock = threading.Lock()
        self.messages: dict[str, list[dict]] = {}
        self.transcript_queries: list[tuple[str, int, int]] = []
        self.message_posts = 0
        self.drop_response_on_post: int | None = None

    def reset(self):
        with self.lock:
            self.messages.clear()
            self.transcript_queries.clear()
            self.message_posts = 0
            self.drop_response_on_post = None


_STATE = _RelayState()


class _RelayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def _json(self, status: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = urlparse(self.path).path
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if path.endswith("/listening"):
            self._json(200, {"ok": True})
            return
        match = re.fullmatch(r"/api/rooms/([^/]+)/messages", path)
        if not match:
            self._json(404, {"error": "not found"})
            return
        room_id = match.group(1)
        with _STATE.lock:
            _STATE.message_posts += 1
            seq = len(_STATE.messages.setdefault(room_id, [])) + 1
            message_id = str(uuid.uuid4())
            stored = dict(body, id=message_id, seq=seq, ts=1_700_000_000_000 + seq)
            _STATE.messages[room_id].append(stored)
            drop = _STATE.drop_response_on_post == _STATE.message_posts
        if drop:
            self.close_connection = True
            return
        self._json(200, {"ok": True, "id": message_id, "seq": seq})

    def do_GET(self):
        parsed = urlparse(self.path)
        match = re.fullmatch(r"/api/rooms/([^/]+)/transcript", parsed.path)
        if not match:
            self._json(404, {"error": "not found"})
            return
        room_id = match.group(1)
        params = parse_qs(parsed.query)
        after = int(params.get("after", ["0"])[0])
        limit = int(params.get("limit", ["100"])[0])
        with _STATE.lock:
            _STATE.transcript_queries.append((room_id, after, limit))
            all_messages = list(_STATE.messages.get(room_id, []))
        messages = [m for m in all_messages if int(m["seq"]) > after][:limit]
        last_seq = int(all_messages[-1]["seq"]) if all_messages else 0
        self._json(200, {"messages": messages, "last_seq": last_seq, "count": len(messages), "exists": True})


class FileAttachmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _STATE.reset()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _RelayHandler)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=2)

    def setUp(self):
        _STATE.reset()
        key = base64.urlsafe_b64encode(ROOM_KEY).rstrip(b"=").decode("ascii")
        self.room = Room(f"{self.base_url}/room/{ROOM_ID}#k={key}", name="py-file-test")

    def tearDown(self):
        self.room.close()

    def _messages(self):
        with _STATE.lock:
            return list(_STATE.messages.get(ROOM_ID, []))

    def _plaintext(self, message: dict) -> str:
        ciphertext = base64.b64decode(message["ciphertext"], validate=True)
        nonce = base64.b64decode(message["nonce"], validate=True)
        return self.room._box.decrypt(ciphertext, nonce).decode("utf-8")

    def _replace_plaintext(self, message: dict, plaintext: str):
        nonce = nacl_random(SecretBox.NONCE_SIZE)
        encrypted = self.room._box.encrypt(plaintext.encode("utf-8"), nonce)
        message["ciphertext"] = base64.b64encode(encrypted.ciphertext).decode("ascii")
        message["nonce"] = base64.b64encode(nonce).decode("ascii")

    def test_send_file_uses_browser_manifest_and_chunk_wire_format(self):
        data = bytes((i % 251 for i in range(CHUNK_BYTES + 37)))
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "report.bin"
            source.write_bytes(data)

            manifest_id = self.room.send_file(source)

        self.assertRegex(manifest_id, _UUID)
        messages = self._messages()
        self.assertEqual(len(messages), 3)
        self.assertEqual(messages[0]["id"], manifest_id)
        self.assertEqual(self._plaintext(messages[0]), f"📎 File: report.bin (48.0 KiB) [SHA-256: {hashlib.sha256(data).hexdigest()}]")
        chunks = [json.loads(self._plaintext(message)) for message in messages[1:]]
        self.assertEqual([chunk["index"] for chunk in chunks], [0, 1])
        self.assertEqual([chunk["total"] for chunk in chunks], [2, 2])
        self.assertEqual([chunk["data"] for chunk in chunks], [
            base64.b64encode(data[:CHUNK_BYTES]).decode("ascii"),
            base64.b64encode(data[CHUNK_BYTES:]).decode("ascii"),
        ])
        digest = hashlib.sha256(data).hexdigest()
        for chunk in chunks:
            self.assertEqual(chunk["bot2bot_file_v1"], 1)
            self.assertIs(chunk["bot2bot_hist_resp_v1"], True)
            self.assertEqual(chunk["type"], "chunk")
            self.assertEqual(chunk["parent_id"], manifest_id)
            self.assertRegex(chunk["file_id"], _UUID)
            self.assertEqual(chunk["name"], "report.bin")
            self.assertEqual(chunk["size"], len(data))
            self.assertEqual(chunk["sha256"], digest)
            self.assertTrue(base64.b64decode(chunk["data"], validate=True))

    def test_send_file_handles_empty_files_as_one_empty_chunk(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "empty.dat"
            source.write_bytes(b"")
            manifest_id = self.room.send_file(source)

        messages = self._messages()
        self.assertEqual(len(messages), 2)
        self.assertEqual(self._plaintext(messages[0]), f"📎 File: empty.dat (0 B) [SHA-256: {hashlib.sha256(b'').hexdigest()}]")
        chunk = json.loads(self._plaintext(messages[1]))
        self.assertEqual(chunk["parent_id"], manifest_id)
        self.assertEqual(chunk["size"], 0)
        self.assertEqual(chunk["total"], 1)
        self.assertEqual(chunk["index"], 0)
        self.assertEqual(chunk["data"], "")
        self.assertEqual(chunk["sha256"], hashlib.sha256(b"").hexdigest())

    def test_supplementary_unicode_filename_obeys_browser_utf16_limit(self):
        self.assertEqual(_attachment_name("😀" * 91 + ".bin"), "😀" * 90)

    def test_python_accepts_json_numeric_version_1_point_0_like_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "numeric.bin"
            source.write_bytes(b"numeric version")
            manifest_id = self.room.send_file(source)
            chunk_message = self._messages()[1]
            chunk = json.loads(self._plaintext(chunk_message))
            chunk["bot2bot_file_v1"] = 1.0
            self._replace_plaintext(chunk_message, json.dumps(chunk))
            destination = Path(directory) / "numeric-received.bin"
            self.room.download_file(manifest_id, destination)
            self.assertEqual(destination.read_bytes(), source.read_bytes())

    def test_manifest_digest_blocks_same_label_chunk_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "bound.bin"
            source.write_bytes(b"good")
            manifest_id = self.room.send_file(source)
            chunk_message = self._messages()[1]
            chunk = json.loads(self._plaintext(chunk_message))
            chunk["data"] = base64.b64encode(b"evil").decode("ascii")
            chunk["sha256"] = hashlib.sha256(b"evil").hexdigest()
            self._replace_plaintext(chunk_message, json.dumps(chunk))
            destination = Path(directory) / "never-write.bin"
            with self.assertRaises(ValueError):
                self.room.download_file(manifest_id, destination)
            self.assertFalse(destination.exists())

    def test_send_file_rejects_oversize_before_posting(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "large.bin"
            source.write_bytes(b"x" * (MAX_BYTES + 1))
            with self.assertRaises(ValueError):
                self.room.send_file(source)
        self.assertEqual(self._messages(), [])

    def test_download_file_paginates_and_round_trips_without_using_remote_name_as_path(self):
        dummy = {
            "id": "00000000-0000-4000-8000-000000000001",
            "sender": "peer",
            "ciphertext": base64.b64encode(b"\x00" * 32).decode("ascii"),
            "nonce": base64.b64encode(b"\x00" * SecretBox.NONCE_SIZE).decode("ascii"),
            "ts": 1_700_000_000_000,
        }
        with _STATE.lock:
            _STATE.messages[ROOM_ID] = [dict(dummy, id=str(uuid.uuid4()), seq=i) for i in range(1, 506)]
        data = b"binary\x00payload\xff" * 50
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "private-name.bin"
            source.write_bytes(data)
            manifest_id = self.room.send_file(source)
            destination = Path(directory) / "chosen-output.dat"
            result = self.room.download_file(manifest_id, destination)

            self.assertEqual(destination.read_bytes(), data)
            self.assertEqual(Path(result), destination)

        queries = [query for query in _STATE.transcript_queries if query[0] == ROOM_ID]
        self.assertTrue(queries)
        self.assertTrue(all(1 <= limit <= 500 for _room, _after, limit in queries))
        self.assertEqual(queries[:2], [(ROOM_ID, 0, 500), (ROOM_ID, 500, 500)])

    def test_download_file_rejects_incomplete_transfer_without_creating_output(self):
        data = b"z" * (CHUNK_BYTES + 1)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "incomplete.bin"
            source.write_bytes(data)
            manifest_id = self.room.send_file(source)
            with _STATE.lock:
                _STATE.messages[ROOM_ID].pop()
            destination = Path(directory) / "should-not-exist.bin"

            with self.assertRaises(ValueError):
                self.room.download_file(manifest_id, destination)

            self.assertFalse(destination.exists())
            self.assertEqual(list(Path(directory).glob(".bot2bot-*")), [])

    def test_download_file_rejects_metadata_corruption_and_filename_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "safe.bin"
            source.write_bytes(b"safe bytes")
            manifest_id = self.room.send_file(source)
            with _STATE.lock:
                chunk_message = _STATE.messages[ROOM_ID][1]
            chunk = json.loads(self._plaintext(chunk_message))
            chunk["name"] = "../outside.bin"
            self._replace_plaintext(chunk_message, json.dumps(chunk, separators=(",", ":")))
            destination = Path(directory) / "download.bin"

            with self.assertRaises(ValueError):
                self.room.download_file(manifest_id, destination)

            self.assertFalse(destination.exists())
            self.assertFalse((Path(directory).parent / "outside.bin").exists())

    def test_download_file_rejects_missing_sender_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "sender.bin"
            source.write_bytes(b"sender-bound content")
            manifest_id = self.room.send_file(source)
            with _STATE.lock:
                for message in _STATE.messages[ROOM_ID]:
                    message.pop("sender", None)
            destination = Path(directory) / "sender-output.bin"

            with self.assertRaises(ValueError):
                self.room.download_file(manifest_id, destination)

            self.assertFalse(destination.exists())

    def test_download_file_rejects_chunks_that_precede_the_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "order.bin"
            source.write_bytes(b"manifest must precede its chunks")
            manifest_id = self.room.send_file(source)
            with _STATE.lock:
                manifest, chunk = _STATE.messages[ROOM_ID]
                manifest["seq"], chunk["seq"] = chunk["seq"], manifest["seq"]
                _STATE.messages[ROOM_ID].sort(key=lambda message: message["seq"])
            destination = Path(directory) / "order-output.bin"

            with self.assertRaises(ValueError):
                self.room.download_file(manifest_id, destination)

            self.assertFalse(destination.exists())

    def test_download_file_never_overwrites_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.bin"
            source.write_bytes(b"new content")
            manifest_id = self.room.send_file(source)
            destination = Path(directory) / "existing.bin"
            destination.write_bytes(b"keep existing")

            with self.assertRaises((FileExistsError, ValueError)):
                self.room.download_file(manifest_id, destination)

            self.assertEqual(destination.read_bytes(), b"keep existing")

    def test_send_file_does_not_retry_a_post_with_ambiguous_response(self):
        data = b"one chunk"
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "ambiguous.bin"
            source.write_bytes(data)
            _STATE.drop_response_on_post = 2  # accept the chunk, then lose its response

            with self.assertRaises(requests.RequestException):
                self.room.send_file(source)

        messages = self._messages()
        self.assertEqual(len(messages), 2)  # manifest + one accepted chunk, no duplicate retry
        self.assertEqual(_STATE.message_posts, 2)

    def test_stream_suppresses_file_chunks_and_advances_reconnect_cursor(self):
        regular = self.room._box.encrypt(b"ordinary reply", nacl_random(SecretBox.NONCE_SIZE))
        manifest = self.room._box.encrypt("📎 File: sample.bin (1 B)".encode(), nacl_random(SecretBox.NONCE_SIZE))
        chunk_text = json.dumps({
            "bot2bot_file_v1": 1,
            "bot2bot_hist_resp_v1": True,
            "type": "chunk",
            "parent_id": str(uuid.uuid4()),
        })
        chunk = self.room._box.encrypt(chunk_text.encode(), nacl_random(SecretBox.NONCE_SIZE))

        def message(seq: int, encrypted, sender="peer"):
            return {
                "type": "message",
                "id": str(uuid.uuid4()),
                "seq": seq,
                "sender": sender,
                "ciphertext": base64.b64encode(encrypted.ciphertext).decode("ascii"),
                "nonce": base64.b64encode(encrypted.nonce).decode("ascii"),
                "ts": 1_700_000_000_000 + seq,
            }

        first_events = [
            SimpleNamespace(data=json.dumps(message(1, manifest))),
            SimpleNamespace(data=json.dumps(message(2, chunk))),
        ]
        second_events = [SimpleNamespace(data=json.dumps(message(3, regular)))]
        responses = [SimpleNamespace(events=first_events), SimpleNamespace(events=second_events)]
        requested_urls = []

        class _SSEClient:
            def __init__(self, response):
                self.response = response

            def events(self):
                return iter(self.response.events)

        def fake_get(url, **_kwargs):
            requested_urls.append(url)
            response = responses.pop(0)
            return SimpleNamespace(raise_for_status=lambda: None, **response.__dict__)

        stream_module = SimpleNamespace(SSEClient=_SSEClient)
        with patch.dict(sys.modules, {"sseclient": stream_module}), patch.object(self.room._session, "get", side_effect=fake_get):
            stream = self.room.stream(auto_reconnect=True)
            try:
                first = next(stream)
                second = next(stream)
            finally:
                stream.close()

        self.assertEqual(first.text, "📎 File: sample.bin (1 B)")
        self.assertEqual(second.text, "ordinary reply")
        self.assertNotEqual(first.text, chunk_text)
        self.assertEqual(len(requested_urls), 2)
        self.assertEqual(parse_qs(urlparse(requested_urls[1]).query).get("after"), ["2"])

    def test_send_keeps_its_none_return_contract_and_signed_identity_fields(self):
        self.assertIsNone(self.room.send("ordinary message"))
        identity = Identity("signedfiletest", base_url=self.base_url)
        signed_room = Room(
            f"{self.base_url}/room/{ROOM_ID}#k="
            + base64.urlsafe_b64encode(ROOM_KEY).rstrip(b"=").decode("ascii"),
            name="signed-file-test",
            identity=identity,
            signed_only=True,
        )
        try:
            with tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "signed.bin"
                source.write_bytes(b"signed attachment")
                signed_room.send_file(source)
            signed_messages = [m for m in self._messages() if m.get("sender") == "signed-file-test"]
            self.assertEqual(len(signed_messages), 2)
            self.assertTrue(all(m.get("sender_handle") == identity.handle for m in signed_messages))
            self.assertTrue(all(m.get("sender_ts") and m.get("sender_sig") and m.get("sender_nonce") for m in signed_messages))
            self.assertTrue(all(m.get("signed_only") is True for m in signed_messages))
        finally:
            signed_room.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)

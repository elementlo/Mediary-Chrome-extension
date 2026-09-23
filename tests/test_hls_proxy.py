import json
import socket
import threading
import unittest
import urllib.parse
import urllib.request
import zlib
from unittest.mock import patch

from hls_proxy import PNG_SIGNATURE, ThreadingHTTPServer, byte_range, make_handler, probe_media, resolve_media_url, rewrite_manifest, unwrap_roud


def wrapped(payload, compressed=True):
    content = bytes([1 if compressed else 0]) + (zlib.compress(payload) if compressed else payload)
    return PNG_SIGNATURE + len(content).to_bytes(4, "big") + b"roUd" + content + b"\0\0\0\0"


class ProxyTests(unittest.TestCase):
    def test_extracts_deflated_roud_manifest_and_segment(self):
        self.assertEqual(unwrap_roud(wrapped(b"#EXTM3U\n")), b"#EXTM3U\n")
        self.assertEqual(unwrap_roud(wrapped(b"\x47segment", False)), b"\x47segment")
        with self.assertRaises(ValueError):
            unwrap_roud(PNG_SIGNATURE + b"invalid")

    def test_rewrites_segments_variants_and_key_uris(self):
        source = (b'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n'
                  b'#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8\n'
                  b'#EXTINF:4,\nseg.png?auth=abc\n')
        with patch("hls_proxy.safe_remote_url", side_effect=lambda url: url):
            result = rewrite_manifest(source, "https://cdn.example.com/path/master.png", "tok", 8765).decode()
        self.assertIn("/hls/tok/resource?url=https%3A%2F%2Fcdn.example.com%2Fpath%2Fkey.bin", result)
        self.assertIn("variant.m3u8", urllib.parse.unquote(result))
        self.assertIn("seg.png?auth=abc", urllib.parse.unquote(result))

    def test_inherits_cdn_signature_on_relative_media_urls(self):
        base = "https://cdn.example.com/path/index.png?v=1&exp=123&auth=secret"
        self.assertEqual(
            resolve_media_url(base, "segment.png"),
            "https://cdn.example.com/path/segment.png?v=1&exp=123&auth=secret"
        )
        self.assertEqual(
            resolve_media_url(base, "segment.png?auth=other"),
            "https://cdn.example.com/path/segment.png?auth=other"
        )
        self.assertEqual(
            resolve_media_url(base, "https://other.example.com/segment.png"),
            "https://other.example.com/segment.png"
        )

    def test_byte_ranges_are_applied_after_unwrapping(self):
        self.assertEqual(byte_range("bytes=1-3", 10), (1, 3))
        self.assertEqual(byte_range("bytes=-3", 10), (7, 9))
        with self.assertRaises(ValueError):
            byte_range("bytes=20-", 10)

    def test_does_not_issue_url_for_unreachable_first_segment(self):
        with patch("hls_proxy.fetch_media", side_effect=OSError("segment unavailable")):
            with self.assertRaisesRegex(OSError, "segment unavailable"):
                probe_media(b"#EXTM3U\n#EXTINF:4,\nsegment.png\n",
                            "https://cdn.example.com/master.png", "", "")

    def test_serves_verified_m3u8_and_unwrapped_segment(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        sources = {}
        server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(sources, port))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()

        def fake_fetch(url, referer="", user_agent=""):
            if urllib.parse.urlsplit(url).path.endswith("master.png"):
                return unwrap_roud(wrapped(b"#EXTM3U\n#EXTINF:4,\nsegment.png\n")), url
            return unwrap_roud(wrapped(b"\x47segment-data")), url

        try:
            with patch("hls_proxy.fetch_media", side_effect=fake_fetch), patch(
                "hls_proxy.safe_remote_url", side_effect=lambda url: url
            ):
                body = json.dumps({"url": "https://cdn.example.com/master.png?exp=123&auth=secret"}).encode()
                request = urllib.request.Request(
                    f"http://127.0.0.1:{port}/sources", body,
                    {"Content-Type": "application/json"}, method="POST"
                )
                with urllib.request.urlopen(request) as response:
                    address = json.load(response)["url"]
                with urllib.request.urlopen(address) as response:
                    self.assertEqual(response.headers.get_content_type(), "application/vnd.apple.mpegurl")
                    playlist = response.read().decode()
                segment_url = playlist.splitlines()[-1]
                self.assertIn("auth%3Dsecret", segment_url)
                with urllib.request.urlopen(segment_url) as response:
                    self.assertEqual(response.read(), b"\x47segment-data")
                request = urllib.request.Request(segment_url, headers={"Range": "bytes=1-7"})
                with urllib.request.urlopen(request) as response:
                    self.assertEqual(response.status, 206)
                    self.assertEqual(response.read(), b"segment")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()

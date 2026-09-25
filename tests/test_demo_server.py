"""Verify that the local fixture really serves signed PNG-wrapped HLS."""

import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

from demo.server import MEDIA, ensure_media, make_handler
from hls_proxy import unwrap_roud


class DemoServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ensure_media()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler())
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def test_redirect_and_wrapped_playlist(self):
        with urllib.request.urlopen(self.base + "/api/hls/demo") as response:
            self.assertEqual(response.url, self.base + "/cdn/master.png?sig=demo-token")
            self.assertEqual(response.headers.get_content_type(), "image/png")
            self.assertIn(b"media.png", unwrap_roud(response.read()))
        with urllib.request.urlopen(self.base + "/cdn/media.png?sig=demo-token") as response:
            manifest = unwrap_roud(response.read())
        self.assertIn(b'URI="init.png"', manifest)
        self.assertIn(b"segment000.png", manifest)
        self.assertIn(b"#EXT-X-ENDLIST", manifest)

    def test_wrapped_segment_matches_generated_media(self):
        with urllib.request.urlopen(self.base + "/cdn/segment000.png?sig=demo-token") as response:
            self.assertEqual(unwrap_roud(response.read()), (MEDIA / "segment000.m4s").read_bytes())
        with self.assertRaises(urllib.error.HTTPError) as missing_signature:
            urllib.request.urlopen(self.base + "/cdn/segment000.png")
        self.assertEqual(missing_signature.exception.code, 404)
        missing_signature.exception.close()


if __name__ == "__main__":
    unittest.main()

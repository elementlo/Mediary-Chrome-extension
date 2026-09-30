"""Verify that the local fixture serves every detection scenario."""

import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from demo.server import MEDIA, ensure_media, make_handler, plain_png
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

    def get(self, path):
        return urllib.request.urlopen(self.base + path)

    def test_redirect_and_wrapped_playlist(self):
        with self.get("/api/hls/demo") as response:
            self.assertEqual(response.url, self.base + "/cdn/master.png?sig=demo-token")
            self.assertEqual(response.headers.get_content_type(), "image/png")
            self.assertIn(b"media.png", unwrap_roud(response.read()))
        with self.get("/cdn/media.png?sig=demo-token") as response:
            manifest = unwrap_roud(response.read())
        self.assertIn(b'URI="init.png"', manifest)
        self.assertIn(b"segment000.png", manifest)
        self.assertIn(b"#EXT-X-ENDLIST", manifest)

    def test_wrapped_segment_matches_generated_media(self):
        with self.get("/cdn/segment000.png?sig=demo-token") as response:
            self.assertEqual(unwrap_roud(response.read()), (MEDIA / "segment000.m4s").read_bytes())
        with self.assertRaises(urllib.error.HTTPError) as missing_signature:
            urllib.request.urlopen(self.base + "/cdn/segment000.png")
        self.assertEqual(missing_signature.exception.code, 404)
        missing_signature.exception.close()

    def test_plain_hls(self):
        with self.get("/media/plain/index.m3u8") as response:
            self.assertEqual(response.headers.get_content_type(), "application/vnd.apple.mpegurl")
            body = response.read().decode()
        self.assertIn("#EXTM3U", body)
        self.assertIn(".ts", body)

    def test_master_playlist_lists_variants(self):
        with self.get("/media/master/master.m3u8") as response:
            body = response.read().decode()
        self.assertIn("v360/index.m3u8", body)
        self.assertIn("v240/index.m3u8", body)
        with self.get("/media/master/v360/index.m3u8") as response:
            self.assertIn(b"#EXTM3U", response.read())

    def test_direct_mp4(self):
        with self.get("/media/movie.mp4") as response:
            self.assertEqual(response.headers.get_content_type(), "video/mp4")
            self.assertGreater(len(response.read()), 1024)

    def test_mini_clip_is_a_detectable_mp4(self):
        # The per-card clip must be recognized as a video candidate so the
        # overlay button appears; it is served as a real http MP4.
        with self.get("/media/mini.mp4") as response:
            self.assertEqual(response.headers.get_content_type(), "video/mp4")
            self.assertGreater(len(response.read()), 1024)

    def test_dash_manifest(self):
        with self.get("/media/dash/manifest.mpd") as response:
            self.assertEqual(response.headers.get_content_type(), "application/dash+xml")
            body = response.read().decode()
        self.assertIn("<MPD", body)

    def test_query_param_hls_entry(self):
        with self.get("/api/query-hls?format=m3u8") as response:
            self.assertEqual(response.headers.get_content_type(), "application/vnd.apple.mpegurl")
            self.assertIn(b"#EXTM3U", response.read())

    def test_noise_png_redirect_has_no_roud(self):
        with self.get("/api/icon-redirect") as response:
            self.assertEqual(response.url, self.base + "/noise/icon.png")
            self.assertEqual(response.headers.get_content_type(), "image/png")
            data = response.read()
        self.assertEqual(data, plain_png())
        with self.assertRaises(Exception):
            unwrap_roud(data)

    def test_scenario_pages(self):
        for path in ("/", "/v/demo"):
            with self.get(path) as response:
                self.assertEqual(response.headers.get_content_type(), "text/html")
                self.assertIn(b"<html", response.read()[:200].lower())
        with self.get("/scenarios.js") as response:
            self.assertIn(b"scenarios", response.read())

    def test_media_path_traversal_is_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(self.base + "/media/../server.py")
        self.assertIn(context.exception.code, (400, 404))
        context.exception.close()


if __name__ == "__main__":
    unittest.main()

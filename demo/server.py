"""Local PNG-wrapped HLS playback fixture. Run: python3 demo/server.py"""

from __future__ import annotations

import argparse
import binascii
import re
import subprocess
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
MEDIA = ROOT / ".generated"
SIGNATURE = b"\x89PNG\r\n\x1a\n"
TOKEN = "demo-token"


def chunk(kind: bytes, data: bytes) -> bytes:
    checksum = binascii.crc32(kind + data) & 0xFFFFFFFF
    return len(data).to_bytes(4, "big") + kind + data + checksum.to_bytes(4, "big")


def wrap_roud(payload: bytes) -> bytes:
    """A valid 1x1 PNG containing a private, zlib-compressed roUd chunk."""
    ihdr = b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
    scanline = b"\x00\x00\x00\x00\x00"
    return b"".join((
        SIGNATURE,
        chunk(b"IHDR", ihdr),
        chunk(b"IDAT", zlib.compress(scanline)),
        chunk(b"roUd", b"\x01" + zlib.compress(payload)),
        chunk(b"IEND", b""),
    ))


def ensure_media() -> None:
    playlist = MEDIA / "playlist.m3u8"
    if playlist.exists() and (MEDIA / "init.mp4").exists() and list(MEDIA.glob("segment*.m4s")):
        return
    MEDIA.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
        "-t", "8", "-an", "-c:v", "libx264", "-preset", "veryfast",
        "-profile:v", "baseline", "-level", "3.0", "-pix_fmt", "yuv420p",
        "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
        "-b:v", "500k", "-maxrate", "500k", "-bufsize", "1000k",
        "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
        "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", str(MEDIA / "segment%03d.m4s"),
        str(playlist),
    ]
    try:
        subprocess.run(command, check=True)
    except FileNotFoundError as error:
        raise SystemExit("请先安装 ffmpeg，再启动演示站点。") from error


def media_manifest() -> bytes:
    text = (MEDIA / "playlist.m3u8").read_text(encoding="utf-8")
    return text.replace("init.mp4", "init.png").replace(".m4s", ".png").encode()


def make_handler():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self._serve()

        def do_HEAD(self):
            self._serve()

        def _reply(self, code: int, data: bytes, mime: str, *, location: str = ""):
            self.send_response(code)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            if location:
                self.send_header("Location", location)
            self.end_headers()
            if self.command == "GET":
                self.wfile.write(data)

        def _serve(self):
            parsed = urlsplit(self.path)
            path = parsed.path
            if path in ("/", "/v/demo"):
                return self._reply(200, (ROOT / "index.html").read_bytes(), "text/html; charset=utf-8")
            if path == "/player.js":
                return self._reply(200, (ROOT / "player.js").read_bytes(), "text/javascript; charset=utf-8")
            if path == "/style.css":
                return self._reply(200, (ROOT / "style.css").read_bytes(), "text/css; charset=utf-8")
            if path == "/api/hls/demo":
                return self._reply(302, b"", "text/plain", location=f"/cdn/master.png?sig={TOKEN}")
            if not path.startswith("/cdn/") or parse_qs(parsed.query) != {"sig": [TOKEN]}:
                return self._reply(404, b"not found", "text/plain")
            if path == "/cdn/master.png":
                data = b'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.42E01E"\nmedia.png\n'
            elif path == "/cdn/media.png":
                data = media_manifest()
            elif path == "/cdn/init.png":
                data = (MEDIA / "init.mp4").read_bytes()
            elif re.fullmatch(r"/cdn/segment\d{3}\.png", path):
                source = MEDIA / (Path(path).stem + ".m4s")
                if not source.exists():
                    return self._reply(404, b"missing segment", "text/plain")
                data = source.read_bytes()
            else:
                return self._reply(404, b"not found", "text/plain")
            return self._reply(200, wrap_roud(data), "image/png")

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8090)
    args = parser.parse_args()
    ensure_media()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler())
    print(f"演示站点: http://127.0.0.1:{server.server_port}/v/demo", flush=True)
    print("按 Ctrl+C 停止服务。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

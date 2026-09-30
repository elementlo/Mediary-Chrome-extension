"""Local multi-scenario media fixture for testing the detector extension.

Serves: PNG-wrapped HLS (roUd), plain HLS, multi-variant HLS, direct MP4,
DASH, a query-parameter HLS entry, and a PNG redirect that carries no roUd
chunk (noise that must be dropped silently). Run: python3 demo/server.py
"""

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

MEDIA_MIME = {
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts": "video/mp2t",
    ".mp4": "video/mp4",
    ".m4s": "video/iso.segment",
    ".mpd": "application/dash+xml",
    ".png": "image/png",
}


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


def plain_png() -> bytes:
    """A valid 1x1 PNG *without* a roUd chunk (noise candidate)."""
    ihdr = b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
    scanline = b"\x00\x00\x00\x00\x00"
    return b"".join((
        SIGNATURE,
        chunk(b"IHDR", ihdr),
        chunk(b"IDAT", zlib.compress(scanline)),
        chunk(b"IEND", b""),
    ))


def _ffmpeg(*args: str) -> None:
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args]
    try:
        subprocess.run(command, check=True)
    except FileNotFoundError as error:
        raise SystemExit("请先安装 ffmpeg，再启动演示站点。") from error


def _testsrc(duration: str, size: str = "640x360") -> list[str]:
    return [
        "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=24",
        "-t", duration, "-an", "-c:v", "libx264", "-preset", "veryfast",
        "-profile:v", "baseline", "-level", "3.0", "-pix_fmt", "yuv420p",
        "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
    ]


def ensure_media() -> None:
    MEDIA.mkdir(parents=True, exist_ok=True)

    # --- PNG-wrapped HLS (fMP4 segments), the original fixture ---
    playlist = MEDIA / "playlist.m3u8"
    if not (playlist.exists() and (MEDIA / "init.mp4").exists()
            and list(MEDIA.glob("segment*.m4s"))):
        _ffmpeg(
            *_testsrc("8"),
            "-b:v", "500k", "-maxrate", "500k", "-bufsize", "1000k",
            "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
            "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
            "-hls_segment_filename", str(MEDIA / "segment%03d.m4s"),
            str(playlist),
        )

    # --- Plain HLS (MPEG-TS segments) ---
    plain_dir = MEDIA / "plain"
    if not (plain_dir / "index.m3u8").exists():
        plain_dir.mkdir(parents=True, exist_ok=True)
        _ffmpeg(
            *_testsrc("4"),
            "-b:v", "400k",
            "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
            "-hls_segment_filename", str(plain_dir / "seg%03d.ts"),
            str(plain_dir / "index.m3u8"),
        )

    # --- Multi-variant HLS (master + 360p/240p, fMP4) ---
    master_dir = MEDIA / "master"
    if not (master_dir / "master.m3u8").exists():
        for name, size, bitrate in (("v360", "640x360", "500k"), ("v240", "426x240", "250k")):
            variant_dir = master_dir / name
            variant_dir.mkdir(parents=True, exist_ok=True)
            _ffmpeg(
                *_testsrc("4", size),
                "-b:v", bitrate,
                "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
                "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
                "-hls_segment_filename", str(variant_dir / "seg%03d.m4s"),
                str(variant_dir / "index.m3u8"),
            )
        (master_dir / "master.m3u8").write_text(
            "#EXTM3U\n"
            '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.42E01E"\n'
            "v360/index.m3u8\n"
            '#EXT-X-STREAM-INF:BANDWIDTH=250000,RESOLUTION=426x240,CODECS="avc1.42E01E"\n'
            "v240/index.m3u8\n",
            encoding="utf-8",
        )

    # --- Direct MP4 file ---
    if not (MEDIA / "movie.mp4").exists():
        _ffmpeg(*_testsrc("4"), "-b:v", "400k", str(MEDIA / "movie.mp4"))

    # --- Tiny clip used as the visible <video> on every scenario card ---
    # A real http MP4 so the detector recognizes it (network MIME + DOM media
    # sniffing) and the overlay "视频链接" button appears on hover.
    if not (MEDIA / "mini.mp4").exists():
        _ffmpeg(
            "-f", "lavfi", "-i", "testsrc2=size=192x108:rate=15",
            "-t", "2", "-an", "-c:v", "libx264", "-preset", "veryfast",
            "-profile:v", "baseline", "-level", "3.0", "-pix_fmt", "yuv420p",
            "-b:v", "40k", "-maxrate", "40k", "-bufsize", "80k",
            str(MEDIA / "mini.mp4"),
        )

    # --- DASH manifest ---
    dash_dir = MEDIA / "dash"
    if not (dash_dir / "manifest.mpd").exists():
        dash_dir.mkdir(parents=True, exist_ok=True)
        _ffmpeg(
            *_testsrc("4"),
            "-b:v", "400k",
            "-f", "dash", "-seg_duration", "2",
            "-init_seg_name", "init.m4s", "-media_seg_name", "seg$Number%03d$.m4s",
            str(dash_dir / "manifest.mpd"),
        )

    # --- Noise: a plain PNG without roUd ---
    icon = MEDIA / "icon.png"
    if not icon.exists():
        icon.write_bytes(plain_png())


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

        def _serve_media(self, relative: str):
            target = (MEDIA / relative).resolve()
            if not str(target).startswith(str(MEDIA.resolve())) or not target.is_file():
                return self._reply(404, b"not found", "text/plain")
            mime = MEDIA_MIME.get(target.suffix, "application/octet-stream")
            return self._reply(200, target.read_bytes(), mime)

        def _serve(self):
            parsed = urlsplit(self.path)
            path = parsed.path

            # Pages and static assets.
            if path == "/":
                return self._reply(200, (ROOT / "index.html").read_bytes(), "text/html; charset=utf-8")
            if path == "/v/demo":
                return self._reply(200, (ROOT / "wrapped.html").read_bytes(), "text/html; charset=utf-8")
            if path == "/player.js":
                return self._reply(200, (ROOT / "player.js").read_bytes(), "text/javascript; charset=utf-8")
            if path == "/scenarios.js":
                return self._reply(200, (ROOT / "scenarios.js").read_bytes(), "text/javascript; charset=utf-8")
            if path == "/style.css":
                return self._reply(200, (ROOT / "style.css").read_bytes(), "text/css; charset=utf-8")

            # Scenario endpoints.
            if path == "/api/hls/demo":
                return self._reply(302, b"", "text/plain", location=f"/cdn/master.png?sig={TOKEN}")
            if path == "/api/query-hls" and parse_qs(parsed.query).get("format") == ["m3u8"]:
                return self._serve_media("plain/index.m3u8")
            if path == "/api/icon-redirect":
                return self._reply(302, b"", "text/plain", location="/noise/icon.png")
            if path == "/noise/icon.png":
                return self._reply(200, (MEDIA / "icon.png").read_bytes(), "image/png")
            if path.startswith("/media/"):
                return self._serve_media(path[len("/media/"):])

            # PNG-wrapped HLS CDN (signed).
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
    print(f"演示站点: http://127.0.0.1:{server.server_port}/", flush=True)
    print("按 Ctrl+C 停止服务。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

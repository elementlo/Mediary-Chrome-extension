"""Local HLS proxy for PNG-wrapped roUd media. Run with: python3 hls_proxy.py"""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import secrets
import socket
import urllib.error
import urllib.parse
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
URI_ATTRIBUTE = re.compile(r'(URI=")([^"]+)(")', re.IGNORECASE)


def unwrap_roud(data: bytes) -> bytes:
    """Extract the private roUd PNG chunk and inflate it when flag bit 0 is set."""
    if not data.startswith(PNG_SIGNATURE):
        return data
    offset = len(PNG_SIGNATURE)
    while offset + 12 <= len(data):
        size = int.from_bytes(data[offset:offset + 4], "big")
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + size
        if end > len(data):
            raise ValueError("truncated PNG chunk")
        if kind == b"roUd":
            chunk = data[offset + 8:offset + 8 + size]
            if not chunk:
                raise ValueError("empty roUd chunk")
            payload = chunk[1:]
            if chunk[0] & 1:
                try:
                    return zlib.decompress(payload)
                except zlib.error:
                    return zlib.decompress(payload, -zlib.MAX_WBITS)
            return payload
        offset = end
    raise ValueError("PNG has no roUd chunk")


def safe_remote_url(raw: str) -> str:
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("only HTTP(S) media URLs are supported")
    if parsed.username or parsed.password:
        raise ValueError("credentials in media URLs are unsupported")
    # A playlist must never turn this localhost proxy into a local network reader.
    for result in socket.getaddrinfo(parsed.hostname, None):
        address = ipaddress.ip_address(result[4][0])
        if not address.is_global:
            raise ValueError("private or local media host blocked")
    return raw


def fetch_media(raw: str, referer: str = "", user_agent: str = "") -> tuple[bytes, str]:
    safe_remote_url(raw)
    if "\n" in referer or "\r" in referer or "\n" in user_agent or "\r" in user_agent:
        raise ValueError("invalid HTTP header")
    headers = {"User-Agent": user_agent or "Mozilla/5.0 HLS-Stream-Link-Detector/1.0"}
    if referer:
        headers["Referer"] = referer
        origin = urllib.parse.urlsplit(referer)
        if origin.scheme in ("http", "https") and origin.netloc:
            headers["Origin"] = f"{origin.scheme}://{origin.netloc}"
    request = urllib.request.Request(raw, headers=headers)

    class SafeRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            safe_remote_url(newurl)
            return super().redirect_request(request, fp, code, msg, headers, newurl)

    opener = urllib.request.build_opener(SafeRedirect)
    with opener.open(request, timeout=20) as response:
        final_url = response.geturl()
        safe_remote_url(final_url)
        content_length = response.headers.get("Content-Length")
        if content_length and int(content_length) > MAX_RESPONSE_BYTES:
            raise ValueError("media response too large")
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise ValueError("media response too large")
        return unwrap_roud(body), final_url


def resolve_media_url(base_url: str, value: str) -> str:
    """Preserve an inherited CDN signature for relative HLS references."""
    if urllib.parse.urlsplit(value).scheme:
        return value
    absolute = urllib.parse.urljoin(base_url, value)
    if "?" not in value and not urllib.parse.urlsplit(absolute).query:
        signature = urllib.parse.urlsplit(base_url).query
        if signature:
            parts = list(urllib.parse.urlsplit(absolute))
            parts[3] = signature
            absolute = urllib.parse.urlunsplit(parts)
    return absolute


def rewrite_manifest(data: bytes, base_url: str, token: str, port: int) -> bytes:
    text = data.decode("utf-8-sig")
    if not text.lstrip().startswith("#EXTM3U"):
        raise ValueError("resource is not an HLS manifest")

    def proxy_url(value: str) -> str:
        if value.startswith("data:"):
            return value
        absolute = resolve_media_url(base_url, value)
        safe_remote_url(absolute)
        query = urllib.parse.urlencode({"url": absolute})
        return f"http://127.0.0.1:{port}/hls/{token}/resource?{query}"

    lines = []
    for line in text.splitlines():
        if line.startswith("#"):
            line = URI_ATTRIBUTE.sub(lambda match: match[1] + proxy_url(match[2]) + match[3], line)
        elif line.strip():
            line = proxy_url(line.strip())
        lines.append(line)
    return ("\n".join(lines) + "\n").encode("utf-8")


def probe_media(data: bytes, base_url: str, referer: str, user_agent: str, depth: int = 0) -> None:
    """Confirm one referenced media resource can be decoded before issuing a URL."""
    if depth > 3:
        raise ValueError("too many nested HLS playlists")
    text = data.decode("utf-8-sig")
    references = [line.strip() for line in text.splitlines()
                  if line.strip() and not line.lstrip().startswith("#")]
    if not references:
        raise ValueError("HLS playlist has no media references")
    next_url = resolve_media_url(base_url, references[0])
    payload, final_url = fetch_media(next_url, referer, user_agent)
    if payload.lstrip().startswith(b"#EXTM3U"):
        probe_media(payload, final_url, referer, user_agent, depth + 1)
    elif not payload:
        raise ValueError("first media segment is empty")


def byte_range(header: str, size: int) -> tuple[int, int]:
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not match or not size or not (match[1] or match[2]):
        raise ValueError("invalid byte range")
    if match[1]:
        start = int(match[1])
        end = int(match[2]) if match[2] else size - 1
    else:
        count = int(match[2])
        start, end = max(0, size - count), size - 1
    if start >= size or start > end:
        raise ValueError("byte range outside resource")
    return start, min(end, size - 1)


def make_handler(sources: dict[str, dict], port: int):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            # URLs can contain short-lived auth tokens. Never log them.
            pass

        def send_body(self, status: int, body: bytes, content_type: str, extra_headers=None):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for name, value in (extra_headers or {}).items():
                self.send_header(name, value)
            origin = self.headers.get("Origin", "")
            if origin.startswith("chrome-extension://"):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_OPTIONS(self):
            origin = self.headers.get("Origin", "")
            if not origin.startswith("chrome-extension://"):
                return self.send_body(403, b"forbidden", "text/plain")
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_POST(self):
            if self.path != "/sources":
                return self.send_body(404, b"not found", "text/plain")
            origin = self.headers.get("Origin", "")
            if origin and not origin.startswith("chrome-extension://"):
                return self.send_body(403, b"forbidden", "text/plain")
            if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                return self.send_body(415, b"JSON required", "text/plain")
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length < 16_384:
                    raise ValueError("invalid request size")
                options = json.loads(self.rfile.read(length))
                if not isinstance(options, dict):
                    raise ValueError("JSON object required")
                entry = options["url"]
                wrapped = options.get("wrappedUrl")
                referer = options.get("pageUrl", "")
                user_agent = options.get("userAgent", "")
                candidates = [candidate for candidate in (wrapped, entry) if candidate]
                failure = None
                for candidate in candidates:
                    try:
                        payload, final_url = fetch_media(candidate, referer, user_agent)
                        if payload.lstrip().startswith(b"#EXTM3U"):
                            break
                        failure = ValueError("entry did not return an HLS manifest")
                    except (ValueError, urllib.error.URLError, OSError) as error:
                        failure = error
                else:
                    raise failure or ValueError("no HLS entry")
                token = secrets.token_urlsafe(24)
                manifest = rewrite_manifest(payload, final_url, token, port)
                probe_media(payload, final_url, referer, user_agent)
                sources[token] = {"manifest": manifest, "referer": referer, "user_agent": user_agent}
                address = f"http://127.0.0.1:{port}/hls/{token}/index.m3u8"
                self.send_body(200, json.dumps({"url": address}).encode(), "application/json")
            except (KeyError, ValueError, urllib.error.URLError, OSError) as error:
                self.send_body(400, json.dumps({"error": str(error)}).encode(), "application/json")

        def do_GET(self):
            parsed = urllib.parse.urlsplit(self.path)
            parts = parsed.path.strip("/").split("/")
            if len(parts) != 3 or parts[0] != "hls" or parts[1] not in sources:
                return self.send_body(404, b"not found", "text/plain")
            source = sources[parts[1]]
            if parts[2] == "index.m3u8":
                return self.send_body(200, source["manifest"], "application/vnd.apple.mpegurl")
            if parts[2] != "resource":
                return self.send_body(404, b"not found", "text/plain")
            try:
                query = urllib.parse.parse_qs(parsed.query)
                payload, final_url = fetch_media(query["url"][0], source["referer"], source["user_agent"])
                if payload.lstrip().startswith(b"#EXTM3U"):
                    body = rewrite_manifest(payload, final_url, parts[1], port)
                    mime = "application/vnd.apple.mpegurl"
                else:
                    body = payload
                    if payload[:1] == b"\x47":
                        mime = "video/mp2t"
                    elif payload[4:8] in (b"ftyp", b"moof", b"styp"):
                        mime = "video/mp4"
                    else:
                        mime = "application/octet-stream"
                range_header = self.headers.get("Range")
                if range_header:
                    try:
                        start, end = byte_range(range_header, len(body))
                    except ValueError:
                        return self.send_body(416, b"", "text/plain", {"Content-Range": f"bytes */{len(body)}"})
                    return self.send_body(206, body[start:end + 1], mime,
                                          {"Content-Range": f"bytes {start}-{end}/{len(body)}", "Accept-Ranges": "bytes"})
                self.send_body(200, body, mime, {"Accept-Ranges": "bytes"})
            except (KeyError, IndexError, ValueError, urllib.error.URLError, OSError) as error:
                self.send_body(502, str(error).encode(), "text/plain")

        def do_HEAD(self):
            self.do_GET()

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    sources: dict[str, dict] = {}
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(sources, args.port))
    print(f"HLS proxy listening at http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

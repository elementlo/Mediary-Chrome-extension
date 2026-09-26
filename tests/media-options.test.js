import assert from "node:assert/strict";
import test from "node:test";
import {
  applyResolution,
  formatSize,
  inspectEntry,
  normalizeOptions,
  parsePlaylist,
  resolveReference,
  responseSize,
  unwrapRoud
} from "../extension/media-options.js";

test("parses HLS variants and preserves a signed base query", () => {
  const playlist = parsePlaylist(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080/media.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720
720/media.m3u8`, "https://cdn.example/master.png?sig=abc", true);
  assert.equal(playlist.type, "master");
  assert.equal(playlist.variants[0].height, 1080);
  assert.equal(playlist.variants[0].url, "https://cdn.example/1080/media.m3u8?sig=abc");
  assert.equal(playlist.variants[0].codecs, "avc1.640028,mp4a.40.2");
});

test("parses media duration and exact byte ranges", () => {
  const playlist = parsePlaylist(`#EXTM3U
#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@100
media.mp4
#EXTINF:6,
#EXT-X-BYTERANGE:2000@1100
media.mp4
#EXT-X-ENDLIST`, "https://cdn.example/media.m3u8");
  assert.equal(playlist.type, "media");
  assert.equal(playlist.totalDuration, 10);
  assert.equal(playlist.exactBytes, 3100);
});

test("unwraps an uncompressed roUd PNG chunk", async () => {
  const payload = new TextEncoder().encode("#EXTM3U\n#EXT-X-ENDLIST");
  const bytes = new Uint8Array(8 + 12 + 1 + payload.length);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  new DataView(bytes.buffer).setUint32(8, payload.length + 1);
  bytes.set([114, 111, 85, 100], 12);
  bytes[16] = 0;
  bytes.set(payload, 17);
  const decoded = await unwrapRoud(bytes);
  assert.equal(decoded.wrapped, true);
  assert.equal(new TextDecoder().decode(decoded.bytes), "#EXTM3U\n#EXT-X-ENDLIST");
});

test("expands a master playlist into selectable variants with estimated sizes", async () => {
  const bodies = new Map([
    ["https://cdn.example/master.m3u8", `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720
720.m3u8`],
    ["https://cdn.example/720.m3u8", `#EXTM3U
#EXTINF:10,
a.ts
#EXTINF:10,
b.ts
#EXT-X-ENDLIST`]
  ]);
  const fetcher = async url => {
    const response = new Response(bodies.get(url), { status: bodies.has(url) ? 200 : 404 });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const options = await inspectEntry({
    kind: "hls",
    url: "https://cdn.example/master.m3u8",
    pageUrl: "https://site.example/watch"
  }, fetcher);
  assert.equal(options.length, 1);
  assert.equal(options[0].spec, "720p");
  assert.equal(options[0].size, 2_000_000);
  assert.equal(options[0].approximate, true);
});

test("shows resolution and size for a direct video file", async () => {
  const [option] = await inspectEntry({
    kind: "video",
    url: "https://cdn.example/movie.1920x1080.mp4",
    size: 1048576
  });
  assert.equal(option.kind, "video");
  assert.equal(option.format, "MP4");
  assert.equal(option.spec, "1080p");
  assert.equal(option.details, "1920×1080");
  assert.equal(option.size, 1048576);
});

test("fills missing resolution from the page video size", () => {
  const base = { id: "a", spec: "原始规格", details: "原始媒体", height: 0, width: null };
  const filled = applyResolution(base, 1920, 1080);
  assert.equal(filled.spec, "1080p");
  assert.equal(filled.details, "1920×1080");
  const kept = applyResolution({ ...base, details: "4.5 Mbps · H.264" }, 1920, 1080);
  assert.equal(kept.details, "1920×1080 · 4.5 Mbps · H.264");
  assert.equal(applyResolution({ ...base, height: 720 }, 1920, 1080).height, 720);
});

test("normalizes duplicate options and formats sizes", () => {
  const base = { downloadUrl: "https://cdn.example/video.mp4", id: "a", height: 720, bandwidth: 1, seenAt: 1, details: "原始媒体", size: null };
  const options = normalizeOptions([[base], [{ ...base, id: "b", details: "1280×720", size: 1024 }]]);
  assert.equal(options.length, 1);
  assert.equal(options[0].size, 1024);
  assert.equal(options[0].details, "1280×720");
  assert.equal(formatSize(1024, true), "约 1.0 KB");
  assert.equal(resolveReference("v.m3u8", "https://cdn.example/a/master.m3u8?q=1", true), "https://cdn.example/a/v.m3u8?q=1");
  assert.equal(responseSize([{ name: "Content-Range", value: "bytes 0-99/999" }]), 999);
});

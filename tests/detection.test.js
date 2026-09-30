import test from "node:test";
import assert from "node:assert/strict";
import { classifyUrl, classifyHeaders, isPngRedirect } from "../extension/detection.js";

test("url classification is fully generic (no site-specific paths)", () => {
  // The former /api/hls/<id> pattern is no longer special-cased; wrapped HLS
  // is discovered via the generic PNG-redirect probe instead.
  assert.equal(classifyUrl("https://example.com/api/hls/cmjx962zb0000s6uwc8qtfr2h"), null);
  assert.equal(classifyUrl("https://example.com/api/hls/id?kind=thumbs"), null);
  assert.equal(classifyUrl("https://example.com/api/v/id/play"), null);
  assert.equal(classifyUrl("blob:https://example.com/id"), null);
});

test("recognizes ordinary HLS by extension and MIME", () => {
  assert.equal(classifyUrl("https://cdn.example.com/master.m3u8?token=abc"), "hls");
  assert.equal(classifyUrl("https://cdn.example.com/play?format=m3u8"), "hls");
  assert.equal(classifyUrl("https://cdn.example.com/proxy?url=https%3A%2F%2Fmedia.example%2Fmaster.m3u8%3Ftoken%3Dabc"), "hls");
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "application/vnd.apple.mpegurl; charset=utf-8" }]), "hls");
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "application/x-m3u8" }]), "hls");
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "application/octet-stream" }, { name: "Content-Disposition", value: 'attachment; filename="master.m3u8"' }]), "hls");
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "image/png" }]), null);
});

test("recognizes direct video addresses and MIME types", () => {
  assert.equal(classifyUrl("https://cdn.example.com/movie.mp4?sig=abc"), "video");
  assert.equal(classifyUrl("https://cdn.example.com/segment.ts"), null);
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "video/mp4; charset=binary" }]), "video");
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "image/png" }]), null);
});

test("recognizes the extended set of direct video containers", () => {
  for (const ext of ["3gp", "3g2", "wmv", "mpg", "mpeg", "m2ts", "mts", "vob", "ogv", "f4v", "divx"]) {
    assert.equal(classifyUrl(`https://cdn.example.com/movie.${ext}`), "video", ext);
  }
  for (const mime of ["video/3gpp", "video/x-ms-wmv", "video/x-ms-asf", "video/mpeg", "video/x-flv", "video/ogg"]) {
    assert.equal(classifyHeaders([{ name: "Content-Type", value: mime }]), "video", mime);
  }
});

test("never treats HLS/DASH segments as standalone videos", () => {
  // .ts / .m4s segments and video/mp2t would otherwise flood the candidate
  // list with one entry per segment.
  assert.equal(classifyUrl("https://cdn.example.com/seg00001.ts"), null);
  assert.equal(classifyUrl("https://cdn.example.com/init.m4s"), null);
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "video/mp2t" }]), null);
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "audio/mp2t" }]), null);
});

test("recognizes DASH manifests by extension, query param and MIME", () => {
  assert.equal(classifyUrl("https://cdn.example.com/manifest.mpd?token=abc"), "dash");
  assert.equal(classifyUrl("https://cdn.example.com/play?format=mpd"), "dash");
  assert.equal(classifyUrl("https://cdn.example.com/play?type=dash"), "dash");
  assert.equal(classifyUrl("https://cdn.example.com/proxy?url=https%3A%2F%2Fmedia.example%2Fmanifest.mpd"), "dash");
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "application/dash+xml" }]), "dash");
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "video/vnd.mpeg.dash.mpd" }]), "dash");
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "application/octet-stream" }, { name: "Content-Disposition", value: 'attachment; filename="manifest.mpd"' }]), "dash");
});

test("any redirect to a .png is a wrapped-HLS probe candidate", () => {
  // Generic: the entry URL shape no longer matters; roUd verification during
  // inspection drops plain images later.
  assert.equal(isPngRedirect("https://cdn.example.com/media.png?v=1&exp=2&auth=3"), true);
  assert.equal(isPngRedirect("https://cdn.example.com/media.png"), true);
  assert.equal(isPngRedirect("https://cdn.example.com/media.jpg"), false);
  assert.equal(isPngRedirect("https://cdn.example.com/media.PNG"), true);
  assert.equal(isPngRedirect("not-a-url"), false);
  assert.equal(isPngRedirect("file:///tmp/media.png"), false);
});

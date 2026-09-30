import assert from "node:assert/strict";
import test from "node:test";
import { buildDownloadLink } from "../extension/launch.js";

test("passes HLS entry, referer and browser user agent to Mediary", () => {
  const deepLink = new URL(buildDownloadLink({
    url: "https://site.test/api/hls/abc?token=x%2By",
    pageUrl: "https://site.test/v/abc",
    kind: "wrapped-hls"
  }, "Chrome/1"));
  assert.equal(deepLink.protocol, "stream-mediary:");
  assert.equal(deepLink.host, "download");
  assert.equal(deepLink.searchParams.get("url"), "https://site.test/api/hls/abc?token=x%2By");
  assert.equal(deepLink.searchParams.get("referer"), "https://site.test/v/abc");
  assert.equal(deepLink.searchParams.get("userAgent"), "Chrome/1");
});

test("rejects a non-HTTP source", () => {
  assert.throws(() => buildDownloadLink({ kind: "hls", url: "file:///tmp/movie" }));
});

test("does not offer a Mediary launch for direct MP4 files", () => {
  assert.throws(() => buildDownloadLink({ kind: "video", url: "https://cdn.example/video.mp4" }));
});

test("opens the captured signed PNG instead of refetching the HLS entry", () => {
  const deepLink = new URL(buildDownloadLink({
    url: "https://site.test/api/hls/abc",
    wrappedUrl: "https://cdn.example/master.png?sig=abc",
    pageUrl: "https://site.test/v/abc",
    kind: "wrapped-hls"
  }, "Chrome/1"));
  assert.equal(deepLink.searchParams.get("url"), "https://cdn.example/master.png?sig=abc");
  assert.equal(deepLink.searchParams.get("referer"), "https://site.test/v/abc");
});

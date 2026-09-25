import assert from "node:assert/strict";
import test from "node:test";
import { buildDownloadLink } from "../extension/launch.js";

test("passes HLS entry, referer and browser user agent to Mediary", () => {
  const deepLink = new URL(buildDownloadLink({
    url: "https://rou.video/api/hls/abc?token=x%2By",
    pageUrl: "https://rou.video/v/abc",
    kind: "wrapped-hls"
  }, "Chrome/1"));
  assert.equal(deepLink.protocol, "stream-mediary:");
  assert.equal(deepLink.host, "download");
  assert.equal(deepLink.searchParams.get("url"), "https://rou.video/api/hls/abc?token=x%2By");
  assert.equal(deepLink.searchParams.get("referer"), "https://rou.video/v/abc");
  assert.equal(deepLink.searchParams.get("userAgent"), "Chrome/1");
});

test("rejects a non-HTTP source", () => {
  assert.throws(() => buildDownloadLink({ url: "file:///tmp/movie" }));
});

test("opens the captured signed PNG instead of refetching the HLS entry", () => {
  const deepLink = new URL(buildDownloadLink({
    url: "https://rou.video/api/hls/abc",
    wrappedUrl: "https://cdn.example/master.png?sig=abc",
    pageUrl: "https://rou.video/v/abc",
    kind: "wrapped-hls"
  }, "Chrome/1"));
  assert.equal(deepLink.searchParams.get("url"), "https://cdn.example/master.png?sig=abc");
  assert.equal(deepLink.searchParams.get("referer"), "https://rou.video/v/abc");
});

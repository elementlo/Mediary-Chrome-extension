import test from "node:test";
import assert from "node:assert/strict";
import { classifyUrl, classifyHeaders, isSignedPngRedirect } from "../extension/detection.js";

test("recognizes wrapped HLS entry but excludes thumbnails and playback reports", () => {
  assert.equal(classifyUrl("https://example.com/api/hls/cmjx962zb0000s6uwc8qtfr2h"), "wrapped-hls");
  assert.equal(classifyUrl("https://example.com/api/hls/id?kind=thumbs"), null);
  assert.equal(classifyUrl("https://example.com/api/v/id/play"), null);
  assert.equal(classifyUrl("blob:https://example.com/id"), null);
});

test("recognizes ordinary HLS by extension and MIME", () => {
  assert.equal(classifyUrl("https://cdn.example.com/master.m3u8?token=abc"), "hls");
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "application/vnd.apple.mpegurl; charset=utf-8" }]), "hls");
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "image/png" }]), null);
});

test("recognizes direct video addresses and MIME types", () => {
  assert.equal(classifyUrl("https://cdn.example.com/movie.mp4?sig=abc"), "video");
  assert.equal(classifyUrl("https://cdn.example.com/segment.ts"), null);
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "video/mp4; charset=binary" }]), "video");
  assert.equal(classifyHeaders([{ name: "Content-Type", value: "image/png" }]), null);
});

test("only links PNG redirect to a wrapped HLS entry", () => {
  const entry = "https://example.com/api/hls/id";
  assert.equal(isSignedPngRedirect(entry, "https://cdn.example.com/media.png?v=1&exp=2&auth=3"), true);
  assert.equal(isSignedPngRedirect("https://example.com/logo.png", "https://cdn.example.com/media.png"), false);
  assert.equal(isSignedPngRedirect(entry, "https://cdn.example.com/media.jpg"), false);
});

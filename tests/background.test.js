import test from "node:test";
import assert from "node:assert/strict";

test("captures wrapped HLS redirect and clears results after navigation", async () => {
  const listeners = {};
  const event = name => ({ addListener(listener) { listeners[name] = listener; } });
  const data = new Map();
  globalThis.chrome = {
    webRequest: {
      onBeforeRequest: event("request"),
      onBeforeRedirect: event("redirect"),
      onHeadersReceived: event("headers"),
      onCompleted: event("completed"),
      onErrorOccurred: event("error")
    },
    tabs: { onRemoved: event("removed"), onUpdated: event("updated") },
    runtime: { onMessage: event("message") },
    storage: { session: {
      async get(key) { return { [key]: data.get(key) }; },
      async set(items) { for (const [key, value] of Object.entries(items)) data.set(key, value); },
      async remove(key) { data.delete(key); }
    } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
  };
  await import("../extension/background.js");

  const entry = "https://example.com/api/hls/video123";
  const cdn = "https://cdn.example.com/a.png?exp=123&auth=secret";
  listeners.request({ tabId: 7, requestId: "r1", url: entry, initiator: "https://example.com" });
  listeners.redirect({ tabId: 7, requestId: "r1", url: entry, redirectUrl: cdn });
  listeners.request({ tabId: 7, requestId: "r2", url: `${entry}?kind=thumbs` });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(data.get("tab:7").map(item => item.url), [entry]);
  assert.equal(data.get("tab:7")[0].wrappedUrl, cdn);

  const video = "https://cdn.example.com/movie.mp4?signature=abc";
  listeners.request({ tabId: 7, requestId: "r3", url: video, initiator: "https://example.com" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(data.get("tab:7")[0].kind, "video");

  listeners.updated(7, { url: "https://example.com/another-video" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(data.has("tab:7"), false);
  delete globalThis.chrome;
});

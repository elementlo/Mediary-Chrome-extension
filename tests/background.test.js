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
    storage: {
      onChanged: { addListener() {} },
      session: {
        async get(key) { return { [key]: data.get(key) }; },
        async set(items) { for (const [key, value] of Object.entries(items)) data.set(key, value); },
        async remove(keys) { for (const key of [].concat(keys)) data.delete(key); }
      },
      local: {
        async get(key) { return { [key]: data.get(key) }; },
        async set(items) { for (const [key, value] of Object.entries(items)) data.set(key, value); },
        async remove(keys) { for (const key of [].concat(keys)) data.delete(key); }
      }
    },
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
  listeners.headers({
    tabId: 7,
    requestId: "r3",
    url: video,
    initiator: "https://example.com",
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Length", value: "100" },
      { name: "Content-Range", value: "bytes 0-99/4096" }
    ]
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(data.get("tab:7")[0].kind, "video");
  assert.equal(data.get("tab:7")[0].size, 4096);
  assert.equal(data.get("tab:7")[0].contentType, "video/mp4");

  listeners.updated(7, { url: "https://example.com/another-video" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(data.has("tab:7"), false);
  delete globalThis.chrome;
});

test("persists the reported video size so it survives a worker restart", async () => {
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
    storage: {
      onChanged: { addListener() {} },
      session: {
        async get(key) { return { [key]: data.get(key) }; },
        async set(items) { for (const [key, value] of Object.entries(items)) data.set(key, value); },
        async remove(keys) { for (const key of [].concat(keys)) data.delete(key); }
      },
      local: {
        async get(key) { return { [key]: data.get(key) }; },
        async set(items) { for (const [key, value] of Object.entries(items)) data.set(key, value); },
        async remove(keys) { for (const key of [].concat(keys)) data.delete(key); }
      }
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
  };
  // Cache-buster: the first test already imported the module, and a cached
  // ES module would not register its listeners on this test's chrome mock.
  await import("../extension/background.js?v=size");

  // The content script reports the playing <video> size.
  listeners.message(
    { type: "reportVideoSize", width: 1920, height: 1080 },
    { tab: { id: 11 } },
    () => {}
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  // It must be written to session storage, not just an in-memory Map, so a
  // suspended service worker does not lose it before the popup opens.
  assert.deepEqual(data.get("size:11"), { width: 1920, height: 1080 });

  // A wrapped-HLS candidate whose playlist carries no RESOLUTION.
  data.set("tab:11", [{
    url: "https://cdn.example/master.png?sig=a",
    kind: "wrapped-hls",
    wrappedUrl: "https://cdn.example/master.png?sig=a",
    pageUrl: "https://site.test/v/x",
    seenAt: Date.now()
  }]);
  const bodies = new Map([
    ["https://cdn.example/master.png?sig=a", `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.42E01E"
media.png?sig=a`],
    ["https://cdn.example/media.png?sig=a", `#EXTM3U
#EXTINF:10,
seg.png?sig=a
#EXT-X-ENDLIST`]
  ]);
  globalThis.fetch = async url => {
    const response = new Response(bodies.get(url), { status: bodies.has(url) ? 200 : 404 });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };

  const response = await new Promise(resolve => {
    listeners.message(
      { type: "getOptions", tabId: 11, pageUrl: "https://site.test/v/x" },
      { tab: { id: 11 } },
      resolve
    );
  });
  const [option] = response.options;
  assert.equal(option.height, 1080);
  assert.equal(option.spec, "1080p");
  assert.match(option.details, /1920×1080/);

  delete globalThis.fetch;
  delete globalThis.chrome;
});

test("site rules provide a fallback entry when nothing was captured", async () => {
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
    storage: {
      onChanged: { addListener() {} },
      session: {
        async get(key) { return { [key]: data.get(key) }; },
        async set(items) { for (const [key, value] of Object.entries(items)) data.set(key, value); },
        async remove(keys) { for (const key of [].concat(keys)) data.delete(key); }
      },
      local: {
        async get(key) { return { [key]: data.get(key) }; },
        async set(items) { for (const [key, value] of Object.entries(items)) data.set(key, value); },
        async remove(keys) { for (const key of [].concat(keys)) data.delete(key); }
      }
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
  };
  await import("../extension/background.js?v=rules");

  // The popup writes validated rules straight into chrome.storage.local.
  data.set("rules", [{
    hostname: "site.test",
    pagePath: "^/v/([^/]+)/?$",
    entryPath: "/api/hls/$1",
    kind: "wrapped-hls"
  }]);

  // With no captured entries, the rule builds the fallback candidate. The
  // fetch mock serves the constructed entry as a minimal media playlist.
  const bodies = new Map([
    ["https://site.test/api/hls/xyz", "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg0.ts\n#EXT-X-ENDLIST"]
  ]);
  globalThis.fetch = async url => {
    const response = new Response(bodies.get(url), { status: bodies.has(url) ? 200 : 404 });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const response = await new Promise(resolve => {
    listeners.message(
      { type: "getOptions", tabId: 21, pageUrl: "https://site.test/v/xyz" },
      { tab: { id: 21 } },
      resolve
    );
  });
  assert.equal(response.options.length, 1);

  // Without a matching page URL there is no fallback and no options.
  const emptyResponse = await new Promise(resolve => {
    listeners.message(
      { type: "getOptions", tabId: 22, pageUrl: "https://other.test/v/xyz" },
      { tab: { id: 22 } },
      resolve
    );
  });
  assert.equal(emptyResponse.options.length, 0);

  delete globalThis.fetch;
  delete globalThis.chrome;
});

test("DOM-reported media urls become classified candidates", async () => {
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
    storage: {
      onChanged: { addListener() {} },
      session: {
        async get(key) { return { [key]: data.get(key) }; },
        async set(items) { for (const [key, value] of Object.entries(items)) data.set(key, value); },
        async remove(keys) { for (const key of [].concat(keys)) data.delete(key); }
      },
      local: {
        async get(key) { return { [key]: data.get(key) }; },
        async set(items) { for (const [key, value] of Object.entries(items)) data.set(key, value); },
        async remove(keys) { for (const key of [].concat(keys)) data.delete(key); }
      }
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
  };
  await import("../extension/background.js?v=dom");

  // The content script reports media element sources it found in the DOM.
  listeners.message({
    type: "reportDomMedia",
    urls: [
      "https://cdn.example/movie.mp4",
      "https://cdn.example/master.m3u8",
      "https://cdn.example/manifest.mpd",
      "https://cdn.example/poster.png",
      "blob:https://site.test/abc"
    ]
  }, { tab: { id: 31, url: "https://site.test/watch" } }, () => {});
  await new Promise(resolve => setTimeout(resolve, 0));

  const saved = (data.get("tab:31") || []).map(item => `${item.kind}:${item.url}`).sort();
  assert.deepEqual(saved, [
    "dash:https://cdn.example/manifest.mpd",
    "hls:https://cdn.example/master.m3u8",
    "video:https://cdn.example/movie.mp4"
  ]);

  delete globalThis.chrome;
});

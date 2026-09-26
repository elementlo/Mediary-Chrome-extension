import { classifyUrl, classifyHeaders, isSignedPngRedirect } from "./detection.js";
import { inspectEntry, normalizeOptions, fallbackOption, applyResolution } from "./media-options.js";

const pending = new Map();
const writes = new Map();
const videoSizes = new Map();
const key = tabId => `tab:${tabId}`;

function enrichResolution(options, tabId) {
  const size = videoSizes.get(tabId);
  if (!size?.height) return options;
  return options.map(option => applyResolution(option, size.width, size.height));
}

function rouPageCandidate(pageUrl) {
  try {
    const page = new URL(pageUrl);
    if (page.hostname !== "rou.video") return null;
    const match = page.pathname.match(/^\/v\/([^/]+)\/?$/);
    if (!match) return null;
    return {
      url: `${page.origin}/api/hls/${match[1]}`,
      kind: "wrapped-hls",
      pageUrl: page.href,
      seenAt: Date.now()
    };
  } catch { return null; }
}

function save(tabId, candidate) {
  if (tabId < 0) return Promise.resolve();
  const previous = writes.get(tabId) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const storageKey = key(tabId);
    const entries = (await chrome.storage.session.get(storageKey))[storageKey] || [];
    const index = entries.findIndex(item => item.url === candidate.url);
    if (index >= 0) entries[index] = { ...entries[index], ...candidate };
    else entries.unshift(candidate);
    entries.sort((a, b) => b.seenAt - a.seenAt);
    entries.length = Math.min(entries.length, 30);
    await chrome.storage.session.set({ [storageKey]: entries });
    await chrome.action.setBadgeText({ tabId, text: String(entries.length) });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#147d61" });
    void chrome.tabs.sendMessage?.(tabId, { type: "candidatesChanged" }).catch(() => {});
  });
  writes.set(tabId, write);
  void write.then(
    () => { if (writes.get(tabId) === write) writes.delete(tabId); },
    () => { if (writes.get(tabId) === write) writes.delete(tabId); }
  );
  return write;
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  const kind = classifyUrl(details.url);
  if (!kind || details.tabId < 0) return;
  if (kind === "wrapped-hls") pending.set(details.requestId, details.url);
  void save(details.tabId, {
    url: details.url,
    kind,
    pageUrl: details.initiator || "",
    seenAt: Date.now()
  });
}, { urls: ["http://*/*", "https://*/*"] });

chrome.webRequest.onBeforeRedirect.addListener(details => {
  const entryUrl = pending.get(details.requestId) || details.url;
  if (!isSignedPngRedirect(entryUrl, details.redirectUrl)) return;
  void save(details.tabId, {
    url: entryUrl,
    kind: "wrapped-hls",
    wrappedUrl: details.redirectUrl,
    pageUrl: details.initiator || "",
    seenAt: Date.now()
  });
}, { urls: ["http://*/*", "https://*/*"] });

chrome.webRequest.onHeadersReceived.addListener(details => {
  const headers = details.responseHeaders || [];
  const kind = classifyHeaders(headers);
  if (details.tabId < 0 || !kind) return;
  const value = name => headers.find(header => header.name.toLowerCase() === name)?.value;
  const rangeTotal = value("content-range")?.match(/\/(\d+)\s*$/)?.[1];
  const size = Number(rangeTotal || value("content-length"));
  const contentType = value("content-type")?.split(";", 1)[0].trim().toLowerCase();
  void save(details.tabId, {
    url: details.url,
    kind,
    pageUrl: details.initiator || "",
    seenAt: Date.now(),
    ...(Number.isFinite(size) && size > 0 ? { size } : {}),
    ...(contentType ? { contentType } : {})
  });
}, { urls: ["http://*/*", "https://*/*"] }, ["responseHeaders"]);

function forgetRequest(details) { pending.delete(details.requestId); }
chrome.webRequest.onCompleted.addListener(forgetRequest, { urls: ["http://*/*", "https://*/*"] });
chrome.webRequest.onErrorOccurred.addListener(forgetRequest, { urls: ["http://*/*", "https://*/*"] });

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove(key(tabId));
  writes.delete(tabId);
  videoSizes.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const previous = writes.get(tabId) || Promise.resolve();
  const clear = previous.catch(() => {}).then(async () => {
    await chrome.storage.session.remove(key(tabId));
    await chrome.action.setBadgeText({ tabId, text: "" });
    void chrome.tabs.sendMessage?.(tabId, { type: "candidatesChanged" }).catch(() => {});
  });
  writes.set(tabId, clear);
  void clear.then(
    () => { if (writes.get(tabId) === clear) writes.delete(tabId); },
    () => { if (writes.get(tabId) === clear) writes.delete(tabId); }
  );
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "getCandidates" && Number.isInteger(message.tabId)) {
    const storageKey = key(message.tabId);
    chrome.storage.session.get(storageKey).then(data => {
      sendResponse({ entries: data[storageKey] || [] });
    }).catch(error => sendResponse({ error: String(error) }));
    return true;
  }
  if (message?.type === "reportVideoSize") {
    const tabId = _sender.tab?.id;
    if (Number.isInteger(tabId) && message.height) {
      videoSizes.set(tabId, { width: Number(message.width) || 0, height: Number(message.height) || 0 });
    }
    return;
  }
  if (message?.type === "getFrameOptions") {
    const tabId = _sender.tab?.id;
    if (!Number.isInteger(tabId)) return;
    const storageKey = key(tabId);
    chrome.storage.session.get(storageKey).then(async data => {
      const entries = data[storageKey] || [];
      const fallback = rouPageCandidate(_sender.tab?.url || "");
      if (!entries.length && fallback) entries.push(fallback);
      const results = await Promise.allSettled(entries.map(entry => inspectEntry(entry)));
      const groups = results.map((result, index) => result.status === "fulfilled"
        ? result.value
        : [fallbackOption(entries[index])]);
      sendResponse({ options: enrichResolution(normalizeOptions(groups), tabId) });
    }).catch(error => sendResponse({ error: String(error) }));
    return true;
  }
  if (message?.type === "getOptions" && Number.isInteger(message.tabId)) {
    const tabId = message.tabId;
    const storageKey = key(tabId);
    chrome.storage.session.get(storageKey).then(async data => {
      const entries = data[storageKey] || [];
      const fallback = rouPageCandidate(message.pageUrl || "");
      if (!entries.length && fallback) entries.push(fallback);
      const results = await Promise.allSettled(entries.map(entry => inspectEntry(entry)));
      const groups = results.map((result, index) => result.status === "fulfilled"
        ? result.value
        : [fallbackOption(entries[index])]);
      sendResponse({ options: enrichResolution(normalizeOptions(groups), tabId) });
    }).catch(error => sendResponse({ error: String(error) }));
    return true;
  }
  if (message?.type === "getFrameCandidates") {
    const tabId = _sender.tab?.id;
    if (!Number.isInteger(tabId)) return;
    const storageKey = key(tabId);
    chrome.storage.session.get(storageKey).then(data => {
      sendResponse({ entries: data[storageKey] || [] });
    }).catch(error => sendResponse({ error: String(error) }));
    return true;
  }
});

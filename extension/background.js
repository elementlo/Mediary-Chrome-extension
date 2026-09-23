import { classifyUrl, classifyHeaders, isSignedPngRedirect } from "./detection.js";

const pending = new Map();
const writes = new Map();
const key = tabId => `tab:${tabId}`;

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
  const kind = classifyHeaders(details.responseHeaders);
  if (details.tabId < 0 || !kind) return;
  void save(details.tabId, {
    url: details.url,
    kind,
    pageUrl: details.initiator || "",
    seenAt: Date.now()
  });
}, { urls: ["http://*/*", "https://*/*"] }, ["responseHeaders"]);

function forgetRequest(details) { pending.delete(details.requestId); }
chrome.webRequest.onCompleted.addListener(forgetRequest, { urls: ["http://*/*", "https://*/*"] });
chrome.webRequest.onErrorOccurred.addListener(forgetRequest, { urls: ["http://*/*", "https://*/*"] });

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove(key(tabId));
  writes.delete(tabId);
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
  if (message?.type === "getFrameCandidates") {
    const tabId = _sender.tab?.id;
    if (!Number.isInteger(tabId)) return;
    const storageKey = key(tabId);
    chrome.storage.session.get(storageKey).then(data => {
      sendResponse({ entries: data[storageKey] || [] });
    }).catch(error => sendResponse({ error: String(error) }));
    return true;
  }
  if (message?.type === "resolveAddress") {
    const entry = message.entry;
    if (!entry || typeof entry.url !== "string") return;
    if (entry.kind !== "wrapped-hls") {
      sendResponse({ url: entry.url });
      return;
    }
    fetch("http://127.0.0.1:8765/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...entry, userAgent: message.userAgent || "" })
    }).then(async response => {
      const result = await response.json();
      if (!response.ok || !result.url) throw new Error(result.error || "解析失败");
      sendResponse({ url: result.url });
    }).catch(error => sendResponse({ error: String(error) }));
    return true;
  }
});

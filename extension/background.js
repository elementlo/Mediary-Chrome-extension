import { classifyUrl, classifyHeaders, isPngRedirect } from "./detection.js";
import { inspectEntry, normalizeOptions, fallbackOption, applyResolution } from "./media-options.js";
import { RULES_STORAGE_KEY, rulesForPage, candidateAllowed, matchPageRule } from "./site-rules.js";

const writes = new Map();
const key = tabId => `tab:${tabId}`;
const sizeKey = tabId => `size:${tabId}`;

// The page <video> size is the only resolution source for PNG-disguised
// streams (their playlists carry no RESOLUTION and the signed URLs hold no
// hint). It must survive a Manifest V3 service-worker restart, so it lives
// in chrome.storage.session rather than an in-memory Map that Chrome wipes
// when the worker is suspended.
async function readVideoSize(tabId) {
  try {
    const data = await chrome.storage.session.get(sizeKey(tabId));
    return data[sizeKey(tabId)] || null;
  } catch {
    return null;
  }
}

async function enrichResolution(options, tabId) {
  const size = await readVideoSize(tabId);
  if (!size?.height) return options;
  return options.map(option => applyResolution(option, size.width, size.height));
}

// Inspects captured entries into selectable options. A wrapped-hls candidate
// that fails inspection is dropped silently: the generic PNG-redirect probe
// captures every .png (icons, sprites, …), and a PNG without a roUd chunk is
// simply not a disguised stream. Other kinds keep a fallback card so a
// transient fetch error still leaves the entry selectable.
async function buildOptions(entries, tabId) {
  const results = await Promise.allSettled(entries.map(entry => inspectEntry(entry)));
  const groups = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      groups.push(result.value);
    } else if (entries[index].kind !== "wrapped-hls") {
      groups.push([fallbackOption(entries[index])]);
    }
  });
  return enrichResolution(normalizeOptions(groups), tabId);
}

// Site rules are an optional extra filter imported as JSON; the extension
// itself ships without any site data. Cached in memory and refreshed via a
// storage listener so webRequest handlers stay cheap.
let cachedRules = [];
let rulesLoaded = null;

function loadRules() {
  rulesLoaded ??= chrome.storage.local.get(RULES_STORAGE_KEY).then(data => {
    const rules = data[RULES_STORAGE_KEY];
    cachedRules = Array.isArray(rules) ? rules : [];
    return cachedRules;
  }).catch(() => {
    cachedRules = [];
    return cachedRules;
  });
  return rulesLoaded;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[RULES_STORAGE_KEY]) {
    const rules = changes[RULES_STORAGE_KEY].newValue;
    cachedRules = Array.isArray(rules) ? rules : [];
  }
});

async function pageRulesFor(pageUrl) {
  return rulesForPage(pageUrl, await loadRules());
}

async function pageRuleCandidate(pageUrl) {
  if (!pageUrl) return null;
  return matchPageRule(pageUrl, await loadRules());
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
  const pageUrl = details.initiator || "";
  void pageRulesFor(pageUrl).then(pageRules => {
    if (!candidateAllowed(details.url, pageRules)) return;
    void save(details.tabId, {
      url: details.url,
      kind,
      pageUrl,
      seenAt: Date.now()
    });
  });
}, { urls: ["http://*/*", "https://*/*"] });

chrome.webRequest.onBeforeRedirect.addListener(details => {
  // Generic wrapped-HLS probe: any redirect to a .png is a candidate. Plain
  // images are dropped later when the roUd unwrap fails during inspection.
  if (!isPngRedirect(details.redirectUrl) || details.tabId < 0) return;
  const entryUrl = details.url;
  const pageUrl = details.initiator || "";
  void pageRulesFor(pageUrl).then(pageRules => {
    if (!candidateAllowed(entryUrl, pageRules)) return;
    void save(details.tabId, {
      url: entryUrl,
      kind: "wrapped-hls",
      wrappedUrl: details.redirectUrl,
      pageUrl,
      seenAt: Date.now()
    });
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
  const pageUrl = details.initiator || "";
  void pageRulesFor(pageUrl).then(pageRules => {
    if (!candidateAllowed(details.url, pageRules)) return;
    void save(details.tabId, {
      url: details.url,
      kind,
      pageUrl,
      seenAt: Date.now(),
      ...(Number.isFinite(size) && size > 0 ? { size } : {}),
      ...(contentType ? { contentType } : {})
    });
  });
}, { urls: ["http://*/*", "https://*/*"] }, ["responseHeaders"]);

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove([key(tabId), sizeKey(tabId)]);
  writes.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "loading") return;
  const previous = writes.get(tabId) || Promise.resolve();
  const clear = previous.catch(() => {}).then(async () => {
    await chrome.storage.session.remove([key(tabId), sizeKey(tabId)]);
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
      void chrome.storage.session.set({
        [sizeKey(tabId)]: {
          width: Number(message.width) || 0,
          height: Number(message.height) || 0
        }
      }).catch(() => {});
    }
    return;
  }
  if (message?.type === "reportDomMedia" && Array.isArray(message.urls)) {
    const tabId = _sender.tab?.id;
    if (!Number.isInteger(tabId)) return;
    const pageUrl = _sender.tab?.url || "";
    void pageRulesFor(pageUrl).then(pageRules => {
      for (const url of message.urls) {
        const kind = classifyUrl(url);
        if (!kind || !candidateAllowed(url, pageRules)) continue;
        void save(tabId, { url, kind, pageUrl, seenAt: Date.now() });
      }
    });
    return;
  }
  if (message?.type === "getFrameOptions") {
    const tabId = _sender.tab?.id;
    if (!Number.isInteger(tabId)) return;
    const storageKey = key(tabId);
    chrome.storage.session.get(storageKey).then(async data => {
      const entries = data[storageKey] || [];
      const fallback = await pageRuleCandidate(_sender.tab?.url || "");
      if (!entries.length && fallback) entries.push(fallback);
      sendResponse({ options: await buildOptions(entries, tabId) });
    }).catch(error => sendResponse({ error: String(error) }));
    return true;
  }
  if (message?.type === "getOptions" && Number.isInteger(message.tabId)) {
    const tabId = message.tabId;
    const storageKey = key(tabId);
    chrome.storage.session.get(storageKey).then(async data => {
      const entries = data[storageKey] || [];
      const fallback = await pageRuleCandidate(message.pageUrl || "");
      if (!entries.length && fallback) entries.push(fallback);
      sendResponse({ options: await buildOptions(entries, tabId) });
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

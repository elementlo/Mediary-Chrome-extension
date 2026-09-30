const overlays = new Map();
let overlaySeq = 0;
let options = [];
let pointer = null;
let updateQueued = false;

function scheduleOverlayUpdate() {
  if (updateQueued) return;
  updateQueued = true;
  requestAnimationFrame(() => {
    updateQueued = false;
    updateOverlays();
  });
}

function containsPoint(rect, point) {
  return point && point.x >= rect.left && point.x < rect.right &&
    point.y >= rect.top && point.y < rect.bottom;
}

let reportedSize = null;
function reportVideoSize(width, height) {
  if (!width || !height) return;
  if (reportedSize && reportedSize.width === width && reportedSize.height === height) return;
  reportedSize = { width, height };
  try {
    void chrome.runtime.sendMessage({ type: "reportVideoSize", width, height }).catch(() => {});
  } catch { /* The extension may be reloading. */ }
}

// DOM media sniffing. Some players set a media element's src directly (or via
// <source>/<object>/<embed>) without a separately observable request, so
// webRequest alone misses them. Scan the DOM for http(s) media sources and
// report them; the background classifies and filters them like any other
// candidate. blob:/data:/relative URLs are skipped (not directly fetchable).
let reportedMediaSignature = null;
function collectDomMediaUrls() {
  const urls = new Set();
  const push = value => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) urls.add(trimmed);
  };
  for (const el of document.querySelectorAll("video,audio,source,object,embed")) {
    const tag = el.localName;
    if (tag === "object" || tag === "embed") {
      push(el.data);
      push(el.getAttribute("data"));
      push(el.src);
      push(el.getAttribute("src"));
    } else {
      push(el.currentSrc);
      push(el.src);
      push(el.getAttribute("src"));
    }
  }
  return [...urls];
}

function reportDomMedia() {
  const urls = collectDomMediaUrls();
  const signature = urls.join("|");
  if (signature === reportedMediaSignature) return;
  reportedMediaSignature = signature;
  if (!urls.length) return;
  try {
    void chrome.runtime.sendMessage({ type: "reportDomMedia", urls }).catch(() => {});
  } catch { /* The extension may be reloading. */ }
}

function hideOverlay(overlay) {
  overlay.panel.classList.remove("open");
  overlay.host.style.display = "none";
}

function formatSize(bytes, approximate = false) {
  if (!bytes || bytes <= 0) return "大小未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${approximate ? "约 " : ""}${value.toFixed(digits)} ${units[unit]}`;
}

function matchingOptions() {
  return options.filter(option => {
    const pageUrl = option.entry?.pageUrl;
    if (!pageUrl) return true;
    try { return new URL(pageUrl).origin === location.origin; }
    catch { return true; }
  });
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch { /* Some HTTP pages do not expose the Clipboard API. */ }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.cssText = "position:fixed;left:-10000px;top:0";
  document.documentElement.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器拒绝写入剪贴板");
}

function copyBeforeLaunch(value) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.cssText = "position:fixed;left:-10000px;top:0";
  document.documentElement.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) void navigator.clipboard.writeText(value).catch(() => {});
}

async function copyOption(option, button) {
  if (!option) return;
  button.disabled = true;
  button.textContent = "复制中…";
  try {
    await copyText(preferredDownloadUrl(option.entry));
    button.textContent = "已复制";
  } catch (error) {
    button.textContent = "复制失败";
  } finally {
    button.disabled = false;
  }
}

function downloadLink(entry) {
  const source = new URL(preferredDownloadUrl(entry));
  if (!["http:", "https:"].includes(source.protocol)) throw new Error("无效的视频地址");
  const link = new URL("stream-mediary://download");
  link.searchParams.set("url", source.href);
  if (entry.pageUrl) {
    const page = new URL(entry.pageUrl);
    if (["http:", "https:"].includes(page.protocol)) link.searchParams.set("referer", page.href);
  }
  link.searchParams.set("userAgent", navigator.userAgent);
  return link.href;
}

function preferredDownloadUrl(entry) {
  return entry.kind === "wrapped-hls" && entry.wrappedUrl ? entry.wrappedUrl : entry.url;
}

function createOverlay(video) {
  const host = document.createElement("div");
  host.dataset.videoLinkDetector = "";
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;display:none";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    * { box-sizing: border-box; }
    .toggle { border:1px solid #ffffff40; border-radius:999px; background:#1d2335e8;
      color:white; cursor:pointer; font:600 12px system-ui,sans-serif; padding:7px 11px;
      box-shadow:0 3px 14px #0005; backdrop-filter:blur(8px); }
    .toggle:hover { background:#303954; }
    .panel { display:none; width:210px; max-height:320px; overflow:auto; margin-top:6px;
      padding:4px; background:#fff; border:1px solid #e3e7ef; border-radius:12px;
      box-shadow:0 10px 32px #1018283d; color:#18212f; font:12px system-ui,sans-serif; }
    .panel.open { display:block; }
    .option { display:block; position:relative; padding:6px 7px; border:1px solid #e3e7ef;
      border-radius:9px; background:#fff; cursor:pointer; margin-bottom:4px; }
    .option:last-of-type { margin-bottom:0; }
    .option.selected { border-color:#4f46e5; box-shadow:0 0 0 2px #4f46e51a; }
    .option input { position:absolute; width:1px; height:1px; opacity:0; }
    .head { display:flex; align-items:center; justify-content:space-between; gap:6px; min-width:0; }
    .kind { flex:none; padding:1px 5px; border-radius:5px; background:#eef0ff;
      color:#4338ca; font-size:9px; font-weight:700; }
    .kind.video { background:#edf7f3; color:#147d61; }
    .check { display:grid; place-items:center; width:13px; height:13px;
      border:1.5px solid #cbd2df; border-radius:50%; color:transparent; font-size:9px; font-weight:800; }
    .option.selected .check { border-color:#4f46e5; background:#4f46e5; color:#fff; }
    .spec { margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; font-weight:750; }
    .meta { margin-top:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#344054; font-size:10px; font-weight:650; }
    .panel-actions { display:flex; gap:5px; margin-top:6px; padding-top:6px; border-top:1px solid #eef0f4; }
    .actions { display:flex; justify-content:flex-end; gap:5px; }
    .copy, .launch { display:inline-flex; align-items:center; justify-content:center; min-height:26px;
      padding:3px 8px; border:1px solid #dce1ec; border-radius:6px; background:#fff;
      color:#344054; cursor:pointer; font:11px system-ui,sans-serif; text-decoration:none; }
    .copy:hover { background:#f8f9fc; }
    .launch { border-color:#4f46e5; background:#4f46e5; color:#fff; }
    .launch:hover { background:#4338ca; }
    .copy:disabled { opacity:.65; cursor:default; }
    .copy[hidden], .launch[hidden] { display:none; }
    .toggle:focus-visible, .copy:focus-visible, .launch:focus-visible { outline:2px solid #4f46e5; outline-offset:2px; }
  `;
  const toggle = document.createElement("button");
  toggle.className = "toggle";
  toggle.textContent = "视频链接";
  toggle.type = "button";
  const panel = document.createElement("div");
  panel.className = "panel";
  toggle.addEventListener("click", () => panel.classList.toggle("open"));
  shadow.append(style, toggle, panel);
  document.documentElement.append(host);
  const overlay = { video, host, panel, selected: null, radioName: `media-option-${++overlaySeq}` };
  overlays.set(video, overlay);
  return overlay;
}

function selectOption(overlay, option) {
  overlay.selected = option;
  for (const card of overlay.panel.querySelectorAll(".option")) {
    const input = card.querySelector("input");
    const active = input.value === option.id;
    card.classList.toggle("selected", active);
    input.checked = active;
  }
  overlay.copyButton.disabled = false;
  const canLaunch = option.kind === "hls" || option.kind === "wrapped-hls";
  overlay.launchButton.hidden = !canLaunch;
  if (!canLaunch) {
    overlay.launchButton.removeAttribute("href");
    return;
  }
  try {
    overlay.launchButton.href = downloadLink(option.entry);
  } catch {
    overlay.launchButton.hidden = true;
  }
}

function renderPanel(overlay, candidates) {
  const { panel } = overlay;
  panel.replaceChildren();
  overlay.selected = null;

  for (const option of candidates) {
    const card = document.createElement("label");
    card.className = "option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = overlay.radioName;
    radio.value = option.id;
    radio.addEventListener("change", () => selectOption(overlay, option));

    const head = document.createElement("div");
    head.className = "head";
    const kind = document.createElement("span");
    kind.className = `kind${option.kind === "video" ? " video" : ""}`;
    kind.textContent = option.format;
    const check = document.createElement("span");
    check.className = "check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";
    head.append(kind, check);

    let specText = option.spec;
    let detailsText = option.details;
    if (!option.height) {
      const width = overlay.video?.videoWidth || 0;
      const height = overlay.video?.videoHeight || 0;
      if (height) {
        const resolution = width ? `${width}×${height}` : `${height}p`;
        specText = `${height}p`;
        detailsText = option.details && option.details !== "原始媒体"
          ? `${resolution} · ${option.details}`
          : resolution;
      }
    }
    const spec = document.createElement("div");
    spec.className = "spec";
    spec.textContent = specText;
    spec.title = specText;
    const extra = detailsText && detailsText !== "原始媒体" ? ` · ${detailsText}` : "";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${formatSize(option.size, option.approximate)}${extra}`;
    meta.title = meta.textContent;

    card.append(radio, head, spec, meta);
    panel.append(card);
  }

  const actions = document.createElement("div");
  actions.className = "panel-actions";
  const copy = document.createElement("button");
  copy.className = "copy";
  copy.type = "button";
  copy.textContent = "复制链接";
  copy.style.flex = "1";
  copy.disabled = true;
  copy.addEventListener("click", () => void copyOption(overlay.selected, copy));
  const launch = document.createElement("a");
  launch.className = "launch";
  launch.textContent = "Mediary 下载";
  launch.style.flex = "1";
  launch.hidden = true;
  launch.addEventListener("click", () => {
    if (overlay.selected) copyBeforeLaunch(preferredDownloadUrl(overlay.selected.entry));
  });
  actions.append(copy, launch);
  panel.append(actions);
  overlay.copyButton = copy;
  overlay.launchButton = launch;

  // Default-select a downloadable candidate (HLS / wrapped-HLS) when one
  // exists, so the primary "Mediary 下载" action is visible without the user
  // having to pick past copy-only entries (e.g. a decorative MP4). Fall back
  // to the first candidate otherwise.
  if (candidates.length) {
    const preferred = candidates.find(
      option => option.kind === "hls" || option.kind === "wrapped-hls"
    ) || candidates[0];
    selectOption(overlay, preferred);
  }
}

function updateOverlays() {
  const candidates = matchingOptions();
  const videos = new Set(document.querySelectorAll("video"));
  let maxWidth = 0;
  let maxHeight = 0;
  for (const video of videos) {
    if (video.videoWidth > maxWidth) {
      maxWidth = video.videoWidth;
      maxHeight = video.videoHeight;
    }
  }
  reportVideoSize(maxWidth, maxHeight);
  reportDomMedia();
  for (const [video, overlay] of overlays) {
    if (!videos.has(video)) {
      overlay.host.remove();
      overlays.delete(video);
    }
  }
  if (!candidates.length) {
    for (const overlay of overlays.values()) hideOverlay(overlay);
    return;
  }
  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    const visible = rect.width >= 160 && rect.height >= 90 &&
      rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    let overlay = overlays.get(video);
    if (!visible) {
      if (overlay) hideOverlay(overlay);
      continue;
    }
    const hoveringVideo = containsPoint(rect, pointer);
    const hoveringMenu = overlay && overlay.host.style.display !== "none" &&
      containsPoint(overlay.host.getBoundingClientRect(), pointer);
    if (!hoveringVideo && !hoveringMenu) {
      if (overlay) hideOverlay(overlay);
      continue;
    }
    if (!overlay) overlay = createOverlay(video);
    overlay.host.style.display = "block";
    overlay.host.style.left = `${Math.max(4, Math.min(innerWidth - 270, rect.right - 112))}px`;
    overlay.host.style.top = `${Math.max(4, rect.top + 8)}px`;
    const signature = candidates.map(option => `${option.id}|${option.size}`).join(",");
    if (overlay.signature !== signature) {
      renderPanel(overlay, candidates);
      overlay.signature = signature;
    }
  }
}

async function refreshEntries() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "getFrameOptions" });
    options = result?.options || [];
    updateOverlays();
  } catch { /* The extension may be reloading. */ }
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "candidatesChanged") void refreshEntries();
});
document.addEventListener("pointermove", event => {
  if (event.pointerType !== "mouse") return;
  pointer = { x: event.clientX, y: event.clientY };
  scheduleOverlayUpdate();
}, true);
document.addEventListener("pointerdown", event => {
  const path = event.composedPath();
  for (const overlay of overlays.values()) {
    if (!path.includes(overlay.host)) overlay.panel.classList.remove("open");
  }
}, true);
document.documentElement.addEventListener("mouseleave", () => {
  pointer = null;
  scheduleOverlayUpdate();
});
window.addEventListener("blur", () => {
  pointer = null;
  scheduleOverlayUpdate();
});
void refreshEntries();
setInterval(updateOverlays, 750);

const overlays = new Map();
let entries = [];

function matchingEntries() {
  return entries.filter(entry => {
    if (!entry.pageUrl) return true;
    try { return new URL(entry.pageUrl).origin === location.origin; }
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

async function copyEntry(entry, button) {
  button.disabled = true;
  button.textContent = entry.kind === "wrapped-hls" ? "正在解包…" : "正在复制…";
  try {
    if (entry.kind === "wrapped-hls") {
      const result = await chrome.runtime.sendMessage({
        type: "resolveAddress", entry, userAgent: navigator.userAgent
      });
      if (!result?.url) throw new Error(result?.error || "未能生成地址");
      await copyText(result.url);
    } else {
      await copyText(entry.url);
    }
    button.textContent = "已复制";
  } catch (error) {
    button.textContent = `失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function createOverlay(video) {
  const host = document.createElement("div");
  host.dataset.videoLinkDetector = "";
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;display:none";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    * { box-sizing: border-box; }
    .toggle, .copy { border:0; border-radius:6px; background:#147d61; color:white;
      cursor:pointer; font:13px system-ui,sans-serif; padding:8px 11px; box-shadow:0 2px 10px #0005; }
    .toggle:hover, .copy:hover { background:#0f624b; }
    .panel { display:none; width:270px; max-height:240px; overflow:auto; margin-top:5px;
      padding:9px; background:#fff; border:1px solid #cad9d3; border-radius:8px;
      box-shadow:0 4px 18px #0005; color:#18252b; font:12px system-ui,sans-serif; }
    .panel.open { display:block; }
    .item { padding:7px 2px; border-bottom:1px solid #e7eeeb; }
    .item:last-child { border-bottom:0; }
    .kind { font-weight:650; margin-bottom:3px; }
    .url { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-bottom:5px; color:#56636a; }
    .copy { padding:5px 8px; box-shadow:none; }
    .copy:disabled { opacity:.65; }
    .hint { line-height:1.4; color:#52616a; padding:5px 2px; }
  `;
  const toggle = document.createElement("button");
  toggle.className = "toggle";
  toggle.textContent = "视频地址";
  toggle.type = "button";
  const panel = document.createElement("div");
  panel.className = "panel";
  toggle.addEventListener("click", () => panel.classList.toggle("open"));
  shadow.append(style, toggle, panel);
  document.documentElement.append(host);
  const overlay = { video, host, panel };
  overlays.set(video, overlay);
  return overlay;
}

function renderPanel(overlay, candidates) {
  const { panel } = overlay;
  panel.replaceChildren();
  for (const entry of candidates) {
    const item = document.createElement("div");
    item.className = "item";
    const kind = document.createElement("div");
    kind.className = "kind";
    kind.textContent = entry.kind === "wrapped-hls" ? "PNG 包装的 HLS" :
      entry.kind === "hls" ? "HLS 清单" : "视频文件";
    const url = document.createElement("div");
    url.className = "url";
    url.textContent = entry.url;
    url.title = entry.url;
    const copy = document.createElement("button");
    copy.className = "copy";
    copy.type = "button";
    copy.textContent = "复制可下载地址";
    copy.addEventListener("click", () => void copyEntry(entry, copy));
    item.append(kind, url, copy);
    panel.append(item);
  }
  if (candidates.some(entry => entry.kind === "wrapped-hls")) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "PNG 包装的 HLS 复制为本机 m3u8 地址，下载期间需保持 hls_proxy.py 运行。";
    panel.append(hint);
  }
}

function updateOverlays() {
  const candidates = matchingEntries();
  const videos = new Set(document.querySelectorAll("video"));
  for (const [video, overlay] of overlays) {
    if (!videos.has(video)) {
      overlay.host.remove();
      overlays.delete(video);
    }
  }
  if (!candidates.length) {
    for (const overlay of overlays.values()) overlay.host.style.display = "none";
    return;
  }
  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    const visible = rect.width >= 160 && rect.height >= 90 &&
      rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    let overlay = overlays.get(video);
    if (!visible) {
      if (overlay) overlay.host.style.display = "none";
      continue;
    }
    if (!overlay) overlay = createOverlay(video);
    overlay.host.style.display = "block";
    overlay.host.style.left = `${Math.max(4, Math.min(innerWidth - 120, rect.right - 112))}px`;
    overlay.host.style.top = `${Math.max(4, rect.top + 8)}px`;
    const signature = JSON.stringify(candidates);
    if (overlay.signature !== signature) {
      renderPanel(overlay, candidates);
      overlay.signature = signature;
    }
  }
}

async function refreshEntries() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "getFrameCandidates" });
    entries = result?.entries || [];
    if (!entries.length && location.hostname === "rou.video") {
      const match = location.pathname.match(/^\/v\/([^/]+)\/?$/);
      if (match) entries = [{
        url: `${location.origin}/api/hls/${match[1]}`,
        kind: "wrapped-hls",
        pageUrl: location.href
      }];
    }
    updateOverlays();
  } catch { /* The extension may be reloading. */ }
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "candidatesChanged") void refreshEntries();
});
void refreshEntries();
setInterval(updateOverlays, 750);

import { buildDownloadLink } from "./launch.js";

const status = document.querySelector("#status");
const container = document.querySelector("#entries");
const hint = document.querySelector("#hint");

function copyBeforeLaunch(value) {
  const field = document.createElement("textarea");
  field.value = value;
  field.style.cssText = "position:fixed;left:-10000px;top:0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) void navigator.clipboard.writeText(value).catch(() => {});
}

function render(entry) {
  const card = document.createElement("article");
  card.className = "card";
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = entry.kind === "wrapped-hls" ? "PNG 包装的 HLS" : entry.kind === "video" ? "视频文件" : "HLS 清单";
  const url = document.createElement("div");
  url.className = "url";
  url.textContent = entry.url;
  const actions = document.createElement("div");
  actions.className = "actions";
  const button = document.createElement("button");
  button.textContent = "复制源地址";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "正在复制…";
    try {
      await navigator.clipboard.writeText(entry.url);
      button.textContent = "已复制（点击可再次复制）";
    } catch (error) {
      button.textContent = `失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  actions.append(button);
  if (entry.kind !== "video") {
    const launch = document.createElement("a");
    launch.className = "button";
    launch.textContent = "在 Mediary 中下载";
    try {
      launch.href = buildDownloadLink(entry, navigator.userAgent);
      launch.addEventListener("click", () => {
        // Keep the source usable when the desktop app is absent.
        copyBeforeLaunch(entry.url);
      });
      actions.append(launch);
    } catch { /* Ignore an invalid detected address. */ }
  }
  card.append(label, url, actions);
  container.append(card);
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
      pageUrl: page.href
    };
  } catch { return null; }
}

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("无法读取当前标签页");
  const response = await chrome.runtime.sendMessage({ type: "getCandidates", tabId: tab.id });
  if (response?.error) throw new Error(response.error);
  const entries = response?.entries || [];
  const fallback = rouPageCandidate(tab.url);
  if (!entries.length && fallback) entries.push(fallback);
  status.textContent = entries.length
    ? `找到 ${entries.length} 个视频或流。`
    : "尚未检测到视频。请开始播放后重新打开。";
  if (entries.some(entry => entry.kind === "wrapped-hls")) {
    hint.textContent = "PNG 包装的 HLS 由 Mediary 直接解包下载，无需本地代理。打开下载器时也会复制源地址；未安装时可粘贴该地址。";
  } else {
    hint.remove();
  }
  entries.forEach(render);
} catch (error) {
  status.textContent = `读取失败：${error.message}`;
}

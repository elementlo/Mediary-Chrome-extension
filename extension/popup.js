const status = document.querySelector("#status");
const container = document.querySelector("#entries");
const isMac = navigator.platform.toLowerCase().includes("mac");

function copyButton(label, value) {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "已复制";
    } catch {
      button.textContent = "复制失败";
    }
  });
  return button;
}

function render(entry) {
  const card = document.createElement("article");
  card.className = "card";
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = entry.kind === "wrapped-hls" ? "PNG 包装的 HLS" : "HLS 清单";
  const url = document.createElement("div");
  url.className = "url";
  url.textContent = entry.url;
  const actions = document.createElement("div");
  actions.className = "actions";
  const button = document.createElement("button");
  button.textContent = "生成并复制 m3u8 地址";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "正在解包…";
    try {
      const response = await fetch("http://127.0.0.1:8765/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...entry, userAgent: navigator.userAgent })
      });
      const result = await response.json();
      if (!response.ok || !result.url) throw new Error(result.error || "解析失败");
      await navigator.clipboard.writeText(result.url);
      url.textContent = result.url;
      button.textContent = "已复制可下载的 m3u8 地址";
      actions.append(copyButton("再次复制", result.url));
    } catch (error) {
      button.textContent = `失败：${error.message}`;
      button.disabled = false;
    }
  });
  actions.append(button);
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
    ? `${isMac ? "macOS：" : ""}找到 ${entries.length} 个流，可生成 m3u8 地址。`
    : "尚未检测到 HLS。请开始播放视频后重新打开。";
  entries.forEach(render);
} catch (error) {
  status.textContent = `读取失败：${error.message}`;
}

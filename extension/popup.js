const status = document.querySelector("#status");
const container = document.querySelector("#entries");
const hint = document.querySelector("#hint");
const isWindows = /win/i.test(navigator.userAgentData?.platform || navigator.platform);

async function copyAddress(entry) {
  if (entry.kind !== "wrapped-hls") return entry.url;
  let response;
  try {
    response = await fetch("http://127.0.0.1:8765/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...entry, userAgent: navigator.userAgent })
    });
  } catch {
    throw new Error("无法连接本机 HLS 代理");
  }
  const result = await response.json();
  if (!response.ok || !result.url) throw new Error(result.error || "解析失败");
  return result.url;
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
  button.textContent = entry.kind === "wrapped-hls" ? "生成并复制可下载地址" : "复制可下载地址";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = entry.kind === "wrapped-hls" ? "正在解包…" : "正在复制…";
    try {
      const address = await copyAddress(entry);
      await navigator.clipboard.writeText(address);
      url.textContent = address;
      button.textContent = "已复制（点击可再次复制）";
    } catch (error) {
      button.textContent = `失败：${error.message}`;
    } finally {
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
    ? `找到 ${entries.length} 个视频或流。`
    : "尚未检测到视频。请开始播放后重新打开。";
  if (entries.some(entry => entry.kind === "wrapped-hls")) {
    hint.textContent = `PNG 包装的 HLS 需先运行 ${isWindows ? "start_proxy_windows.cmd" : "python3 hls_proxy.py"}；复制出的 127.0.0.1 地址仅在代理运行时有效。`;
  } else {
    hint.remove();
  }
  entries.forEach(render);
} catch (error) {
  status.textContent = `读取失败：${error.message}`;
}

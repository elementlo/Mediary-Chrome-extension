import { buildDownloadLink, preferredDownloadUrl } from "./launch.js";
import { formatSize } from "./media-options.js";

const status = document.querySelector("#status");
const container = document.querySelector("#entries");
const empty = document.querySelector("#empty");
const copyButton = document.querySelector("#copy");
const downloadButton = document.querySelector("#download");
const cards = new Map();
let selected = null;

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

function selectOption(option) {
  selected = option;
  for (const [id, card] of cards) {
    const active = id === option.id;
    card.classList.toggle("selected", active);
    card.querySelector("input").checked = active;
  }
  copyButton.disabled = false;
  const canLaunch = option.kind === "hls" || option.kind === "wrapped-hls";
  downloadButton.hidden = !canLaunch;
  if (!canLaunch) {
    downloadButton.removeAttribute("href");
    return;
  }
  try {
    downloadButton.href = buildDownloadLink(option.entry, navigator.userAgent);
    downloadButton.classList.remove("disabled");
    downloadButton.setAttribute("aria-disabled", "false");
  } catch {
    downloadButton.removeAttribute("href");
    downloadButton.classList.add("disabled");
    downloadButton.setAttribute("aria-disabled", "true");
  }
}

function renderOption(option, index) {
  const card = document.createElement("label");
  card.className = "option";
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "media-option";
  radio.value = option.id;
  radio.addEventListener("change", () => selectOption(option));

  const head = document.createElement("div");
  head.className = "option-head";
  const kind = document.createElement("span");
  kind.className = `kind${option.kind === "video" ? " video" : ""}`;
  kind.textContent = option.format;
  const check = document.createElement("span");
  check.className = "check";
  check.setAttribute("aria-hidden", "true");
  check.textContent = "✓";
  head.append(kind, check);

  const spec = document.createElement("div");
  spec.className = "spec";
  spec.textContent = option.spec;
  const details = document.createElement("div");
  details.className = "details";
  details.textContent = option.details;
  details.title = option.details;
  const size = document.createElement("div");
  size.className = "size";
  size.textContent = formatSize(option.size, option.approximate);

  card.append(radio, head, spec, details, size);
  cards.set(option.id, card);
  container.append(card);
  if (index === 0) selectOption(option);
}

async function copySelected() {
  if (!selected) return;
  copyButton.disabled = true;
  copyButton.textContent = "复制中…";
  try {
    await navigator.clipboard.writeText(preferredDownloadUrl(selected.entry));
    copyButton.textContent = "已复制";
  } catch {
    copyButton.textContent = "复制失败";
  } finally {
    window.setTimeout(() => {
      copyButton.textContent = "复制链接";
      copyButton.disabled = !selected;
    }, 900);
  }
}

copyButton.addEventListener("click", () => void copySelected());
downloadButton.addEventListener("click", event => {
  if (!selected) {
    event.preventDefault();
    return;
  }
  copyBeforeLaunch(preferredDownloadUrl(selected.entry));
});

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("无法读取当前标签页");
  const response = await chrome.runtime.sendMessage({
    type: "getOptions",
    tabId: tab.id,
    pageUrl: tab.url || ""
  });
  if (response?.error) throw new Error(response.error);
  const options = response?.options || [];
  if (!options.length) {
    status.textContent = "未检测到媒体";
    empty.hidden = false;
  } else {
    options.forEach(renderOption);
    status.textContent = `已找到 ${options.length} 个可下载规格`;
    empty.hidden = true;
  }
} catch {
  status.textContent = "读取失败，请重试";
  empty.textContent = "无法读取当前页面的媒体信息";
  empty.hidden = false;
}

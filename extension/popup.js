import { buildDownloadLink, preferredDownloadUrl } from "./launch.js";
import { formatSize } from "./media-options.js";
import { RULES_STORAGE_KEY, normalizeRules } from "./site-rules.js";

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

function renderOption(option) {
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
  spec.title = option.spec;
  const extra = option.details && option.details !== "原始媒体" ? option.details : "";
  const details = document.createElement("div");
  details.className = "details";
  details.textContent = extra;
  details.title = extra;
  const size = document.createElement("div");
  size.className = "size";
  size.textContent = formatSize(option.size, option.approximate);

  card.append(radio, head, spec);
  if (extra) card.append(details);
  card.append(size);
  cards.set(option.id, card);
  container.append(card);
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
    // Default-select a downloadable candidate (HLS / wrapped-HLS) when one
    // exists, so the primary "Mediary 下载" action is visible without picking
    // past copy-only entries (e.g. a decorative MP4).
    const preferred = options.find(
      option => option.kind === "hls" || option.kind === "wrapped-hls"
    ) || options[0];
    selectOption(preferred);
    status.textContent = `已找到 ${options.length} 个可下载规格`;
    empty.hidden = true;
  }
} catch {
  status.textContent = "读取失败，请重试";
  empty.textContent = "无法读取当前页面的媒体信息";
  empty.hidden = false;
}

// ---------------------------------------------------------------------------
// Site rules panel (in-popup; JSON import only, no editing form)
// ---------------------------------------------------------------------------

const viewMain = document.querySelector("#view-main");
const viewRules = document.querySelector("#view-rules");
const ruleList = document.querySelector("#rule-list");
const rulesEmpty = document.querySelector("#rules-empty");
const ruleError = document.querySelector("#rule-error");

let rules = [];

function showRulesError(message) {
  ruleError.textContent = message || "";
  ruleError.hidden = !message;
}

function describeRule(rule) {
  const parts = [rule.hostname];
  if (rule.urlFilter) parts.push(rule.urlFilter);
  if (rule.pagePath && rule.entryPath) parts.push(`${rule.pagePath} → ${rule.entryPath}`);
  parts.push(rule.kind);
  return parts.join("   ");
}

function renderRules() {
  ruleList.replaceChildren();
  rulesEmpty.hidden = rules.length > 0;
  for (const rule of rules) {
    const row = document.createElement("div");
    row.className = "rule-row";

    const info = document.createElement("div");
    info.className = "rule-info";
    const name = document.createElement("div");
    name.className = "rule-name";
    name.textContent = rule.hostname;
    const detail = document.createElement("div");
    detail.className = "rule-detail";
    detail.textContent = describeRule(rule);
    detail.title = detail.textContent;
    info.append(name, detail);

    row.append(info);
    ruleList.append(row);
  }
}

async function loadRules() {
  const data = await chrome.storage.local.get(RULES_STORAGE_KEY);
  const stored = data[RULES_STORAGE_KEY];
  rules = Array.isArray(stored) ? stored : [];
  renderRules();
}

async function persistRules(next) {
  try {
    rules = normalizeRules(next);
  } catch (error) {
    showRulesError(error.message);
    return false;
  }
  await chrome.storage.local.set({ [RULES_STORAGE_KEY]: rules });
  renderRules();
  showRulesError("");
  return true;
}

document.querySelector("#open-rules").addEventListener("click", () => {
  viewMain.hidden = true;
  viewRules.hidden = false;
  void loadRules();
});

document.querySelector("#close-rules").addEventListener("click", () => {
  viewRules.hidden = true;
  viewMain.hidden = false;
});

document.querySelector("#rules-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(rules, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "mediary-rules.json";
  anchor.click();
  URL.revokeObjectURL(url);
});

document.querySelector("#rules-import").addEventListener("click", () => {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "application/json,.json";
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        void persistRules(JSON.parse(String(reader.result)));
      } catch (error) {
        showRulesError(`导入失败：${error.message}`);
      }
    };
    reader.readAsText(file);
  });
  picker.click();
});

document.querySelector("#rules-clear").addEventListener("click", () => {
  void persistRules([]);
});

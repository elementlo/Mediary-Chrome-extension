// Scenario runner for the detector extension. Each card triggers one class of
// media request so a specific detection path can be verified in the popup /
// overlay. All media is generated locally by demo/server.py.
//
// Every card carries a small visible <video> playing a real http MP4
// (/media/mini.mp4). The detector recognizes it (network MIME + DOM media
// sniffing), so the overlay's "视频链接" button appears on hover and the popup
// always has at least this video candidate. Scenario "触发" buttons add their
// own candidate type on top.

const status = document.querySelector("#status");
const container = document.querySelector("#scenarios");

function setStatus(text) { status.textContent = text; }

// A real, detectable http MP4 used as the visible per-card clip.
const MINI_CLIP = "/media/mini.mp4";

async function fetchProbe(url) {
  const response = await fetch(url, { cache: "no-store" });
  await response.arrayBuffer();
  return response.status;
}

const scenarios = [
  {
    title: "PNG 包装 HLS（roUd）",
    kind: "wrapped-hls",
    desc: "跳转到独立播放页：入口 302 到带签名的 .png，清单与分片都藏在 roUd 数据块中。插件特有功能。",
    expect: "弹窗显示 PNG-HLS 规格，可「Mediary 下载」。",
    action: () => { window.location.href = "/v/demo"; },
    actionLabel: "打开播放页"
  },
  {
    title: "普通 HLS（.m3u8 + .ts 分片）",
    kind: "hls",
    desc: "请求一个标准 m3u8 清单（MPEG-TS 分片）。验证按后缀/MIME 的 HLS 检测。",
    expect: "弹窗显示 HLS 规格，可「Mediary 下载」。",
    action: async () => { await fetchProbe("/media/plain/index.m3u8"); }
  },
  {
    title: "多清晰度 HLS（master 清单）",
    kind: "hls",
    desc: "请求含 360p/240p 两个变体的 master 清单。验证变体展开为多张规格卡片。",
    expect: "弹窗显示 360p 与 240p 两张卡片，均可下载。",
    action: async () => { await fetchProbe("/media/master/master.m3u8"); }
  },
  {
    title: "直链视频（MP4）",
    kind: "video",
    desc: "把本卡片的视频切换为另一个 http 直链 .mp4。验证网络 MIME 检测与 DOM 媒体元素嗅探（其实每张卡片的小视频本身已是可识别的直链 MP4）。",
    expect: "弹窗显示 MP4 规格，仅「复制链接」，无「Mediary 下载」。",
    action: (_card, video) => {
      video.src = "/media/movie.mp4";
      void video.play().catch(() => {});
    }
  },
  {
    title: "DASH 清单（.mpd）",
    kind: "dash",
    desc: "请求一个 MPEG-DASH 清单。Mediary 只下载 HLS，DASH 仅可复制链接。",
    expect: "弹窗显示 DASH 规格，仅「复制链接」，无「Mediary 下载」。",
    action: async () => { await fetchProbe("/media/dash/manifest.mpd"); }
  },
  {
    title: "查询参数 HLS（?format=m3u8）",
    kind: "hls",
    desc: "入口 URL 无 .m3u8 后缀，靠 format=m3u8 查询参数识别。验证参数嗅探。",
    expect: "弹窗显示 HLS 规格，可「Mediary 下载」。",
    action: async () => { await fetchProbe("/api/query-hls?format=m3u8"); }
  },
  {
    title: "噪声：无 roUd 的 PNG 重定向",
    kind: "noise",
    desc: "入口 302 到一个普通 .png（图标），不含 roUd 数据块。验证伪 PNG 被静默丢弃。",
    expect: "弹窗不应出现该 PNG（解包验证失败被丢弃）。",
    action: async () => { await fetchProbe("/api/icon-redirect"); }
  }
];

function render() {
  container.replaceChildren();
  for (const scenario of scenarios) {
    const card = document.createElement("section");
    card.className = "card";

    const head = document.createElement("div");
    head.className = "card-head";
    const title = document.createElement("h2");
    title.textContent = scenario.title;
    const badge = document.createElement("span");
    badge.className = `badge ${scenario.kind}`;
    badge.textContent = scenario.kind;
    head.append(title, badge);

    const desc = document.createElement("p");
    desc.className = "desc";
    desc.textContent = scenario.desc;

    const expect = document.createElement("p");
    expect.className = "expect";
    const label = document.createElement("strong");
    label.textContent = "预期：";
    expect.append(label, document.createTextNode(scenario.expect));

    // A small visible video so the overlay button can anchor to this card.
    const video = document.createElement("video");
    video.className = "card-video";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.controls = true;
    video.width = 192;
    video.height = 108;

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = scenario.actionLabel || "触发";
    button.addEventListener("click", async () => {
      button.disabled = true;
      setStatus(`正在触发「${scenario.title}」…`);
      try {
        await scenario.action(card, video);
        setStatus(`已触发「${scenario.title}」。悬停下方视频或打开插件弹窗核对：${scenario.expect}`);
      } catch (error) {
        setStatus(`触发失败：${error.message}`);
      } finally {
        button.disabled = false;
      }
    });

    card.append(head, desc, expect, video, button);
    container.append(card);
  }
}

async function init() {
  render();
  for (const video of container.querySelectorAll("video.card-video")) {
    // A real http MP4 so the detector recognizes it and the overlay button
    // appears on hover.
    video.src = MINI_CLIP;
    void video.play().catch(() => {});
  }
  // Seed a downloadable (wrapped-HLS) candidate on load. The decorative card
  // clips are plain MP4 — copy-only by design — so without this the overlay
  // would never offer "Mediary 下载" until a scenario is triggered. Fetching
  // the wrapped-HLS entry gives every video an HLS candidate to select.
  try {
    await fetchProbe("/api/hls/demo");
  } catch { /* The scenario cards still work without the seed. */ }
  setStatus("就绪。悬停任意小视频可唤出「视频链接」悬浮按钮（默认已选中可下载的 HLS）；点击各场景「触发」按钮可追加对应类型的候选。");
}

void init();

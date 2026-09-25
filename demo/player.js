const video = document.querySelector("#video");
const playButton = document.querySelector("#play");
const copyButton = document.querySelector("#copy");
const status = document.querySelector("#status");
const entry = new URL("/api/hls/demo", location.origin).href;
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

function setStatus(value) { status.textContent = value; }

async function unwrapPng(bytes) {
  if (!pngSignature.every((value, index) => bytes[index] === value)) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("PNG 数据块不完整");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "roUd") {
      if (!length) throw new Error("roUd 数据块为空");
      const flags = bytes[offset + 8];
      const payload = bytes.subarray(offset + 9, offset + 8 + length);
      if (!(flags & 1)) return payload;
      const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("deflate"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    offset = end;
  }
  throw new Error("PNG 中没有 roUd 数据块");
}

async function fetchResource(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return { bytes: await unwrapPng(new Uint8Array(await response.arrayBuffer())), finalUrl: response.url };
}

function resolveReference(reference, baseUrl) {
  const resolved = new URL(reference, baseUrl);
  const base = new URL(baseUrl);
  if (!new URL(reference, baseUrl).search && !reference.includes("?") &&
      !/^[a-z][\w+.-]*:/i.test(reference) && base.search) {
    resolved.search = base.search;
  }
  return resolved.href;
}

async function playlist(url) {
  const { bytes, finalUrl } = await fetchResource(url);
  const lines = new TextDecoder().decode(bytes).trim().split(/\r?\n/).map(line => line.trim());
  if (lines[0] !== "#EXTM3U") throw new Error("解包结果不是 HLS 清单");
  return { lines, finalUrl };
}

function waitFor(target, name) {
  return new Promise((resolve, reject) => {
    target.addEventListener(name, resolve, { once: true });
    target.addEventListener("error", () => reject(new Error(`${name} 失败`)), { once: true });
  });
}

async function append(buffer, bytes) {
  buffer.appendBuffer(bytes);
  await waitFor(buffer, "updateend");
}

async function play() {
  playButton.disabled = true;
  try {
    if (!window.MediaSource || !window.DecompressionStream) {
      throw new Error("此浏览器不支持本页所需的 MediaSource / DecompressionStream");
    }
    setStatus("正在读取 PNG 包装的主清单…");
    const master = await playlist(entry);
    const variant = master.lines.find(line => line && !line.startsWith("#"));
    if (!variant) throw new Error("主清单没有视频流");
    const media = await playlist(resolveReference(variant, master.finalUrl));
    const map = media.lines.find(line => line.startsWith("#EXT-X-MAP:"));
    const init = map?.match(/URI="([^"]+)"/)?.[1];
    const segments = media.lines.filter(line => line && !line.startsWith("#"));
    if (!init || !segments.length) throw new Error("媒体清单缺少初始化片段或视频分片");

    const mime = 'video/mp4; codecs="avc1.42E01E"';
    if (!MediaSource.isTypeSupported(mime)) throw new Error(`浏览器不支持 ${mime}`);
    const source = new MediaSource();
    video.src = URL.createObjectURL(source);
    await waitFor(source, "sourceopen");
    const buffer = source.addSourceBuffer(mime);
    setStatus(`解包并追加 ${segments.length} 个 PNG 视频分片…`);
    const first = await fetchResource(resolveReference(init, media.finalUrl));
    await append(buffer, first.bytes);
    for (let index = 0; index < segments.length; index++) {
      const resource = await fetchResource(resolveReference(segments[index], media.finalUrl));
      await append(buffer, resource.bytes);
      if (index === 0) void video.play().catch(() => {});
      setStatus(`已加载 ${index + 1}/${segments.length} 个视频分片`);
    }
    source.endOfStream();
    setStatus("视频已加载。现在可以打开插件，测试 Mediary 联动下载。");
  } catch (error) {
    setStatus(`播放失败：${error.message}`);
  } finally {
    playButton.disabled = false;
  }
}

playButton.addEventListener("click", play);
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(entry);
    setStatus(`已复制 HLS 入口：${entry}`);
  } catch (error) {
    setStatus(`复制失败：${error.message}`);
  }
});

import { preferredDownloadUrl } from "./launch.js";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const DIRECT_EXTENSIONS = new Set([
  "mp4", "m4v", "webm", "mkv", "mov", "avi", "flv", "f4v",
  "3gp", "3g2", "wmv", "mpg", "mpeg", "m2ts", "mts", "vob", "ogv", "divx"
]);

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  return headers?.find(header => header.name?.toLowerCase() === name.toLowerCase())?.value || null;
}

export function responseSize(headers) {
  const range = headerValue(headers, "content-range");
  const total = range?.match(/\/(\d+)\s*$/)?.[1];
  return positiveInteger(total) || positiveInteger(headerValue(headers, "content-length"));
}

export function resolveReference(reference, baseUrl, inheritQuery = false) {
  const trimmed = reference.trim();
  const resolved = new URL(trimmed, baseUrl);
  const base = new URL(baseUrl);
  const absolute = /^[a-z][\w+.-]*:/i.test(trimmed) || trimmed.startsWith("//");
  if (inheritQuery && !absolute && !trimmed.includes("?") && !resolved.search && base.search) {
    resolved.search = base.search;
  }
  return resolved.href;
}

export function parseAttributes(value = "") {
  const attributes = {};
  const pattern = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
  for (const match of value.matchAll(pattern)) {
    const raw = match[2].trim();
    attributes[match[1].toUpperCase()] = raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1).replace(/\\"/g, '"')
      : raw;
  }
  return attributes;
}

function rangeLength(value) {
  const length = Number.parseInt(value?.split("@", 1)[0] || "", 10);
  return Number.isFinite(length) && length > 0 ? length : null;
}

export function parsePlaylist(text, baseUrl, inheritQuery = false) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines[0]?.startsWith("#EXTM3U")) throw new Error("不是有效的 HLS 清单");

  const variants = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith("#EXT-X-STREAM-INF:")) continue;
    const attributes = parseAttributes(lines[index].slice(lines[index].indexOf(":") + 1));
    let uri = null;
    for (let next = index + 1; next < lines.length; next++) {
      if (!lines[next].startsWith("#")) {
        uri = lines[next];
        index = next;
        break;
      }
    }
    if (!uri) continue;
    const resolution = attributes.RESOLUTION || null;
    const dimensions = resolution?.match(/^(\d+)x(\d+)$/i);
    variants.push({
      url: resolveReference(uri, baseUrl, inheritQuery),
      bandwidth: positiveInteger(attributes["AVERAGE-BANDWIDTH"] || attributes.BANDWIDTH),
      width: positiveInteger(dimensions?.[1]),
      height: positiveInteger(dimensions?.[2]),
      codecs: attributes.CODECS || null,
      name: attributes.NAME || null
    });
  }
  if (variants.length) {
    variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
    return { type: "master", variants };
  }

  const segments = [];
  let duration = null;
  let byteRange = null;
  let initializationBytes = 0;
  let initializationSized = true;
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      duration = Number.parseFloat(line.slice(8).split(",", 1)[0]);
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      byteRange = rangeLength(line.slice(line.indexOf(":") + 1));
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attributes = parseAttributes(line.slice(line.indexOf(":") + 1));
      const length = rangeLength(attributes.BYTERANGE);
      if (attributes.BYTERANGE && length) initializationBytes += length;
      else if (attributes.URI) initializationSized = false;
    } else if (!line.startsWith("#")) {
      segments.push({
        url: resolveReference(line, baseUrl, inheritQuery),
        duration: Number.isFinite(duration) ? duration : 0,
        byteRange
      });
      duration = null;
      byteRange = null;
    }
  }
  if (!segments.length) throw new Error("HLS 清单中没有媒体分片");
  const totalDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);
  const allSegmentsSized = segments.every(segment => segment.byteRange);
  const exactBytes = allSegmentsSized && initializationSized
    ? initializationBytes + segments.reduce((sum, segment) => sum + segment.byteRange, 0)
    : null;
  return { type: "media", segments, totalDuration, exactBytes };
}

export async function unwrapRoud(bytes) {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    return { bytes, wrapped: false };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = PNG_SIGNATURE.length; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("PNG 数据块不完整");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "roUd") {
      if (!length) throw new Error("roUd 数据块为空");
      const flags = bytes[offset + 8];
      const payload = bytes.subarray(offset + 9, offset + 8 + length);
      if (!(flags & 1)) return { bytes: payload, wrapped: true };
      if (typeof DecompressionStream === "undefined") throw new Error("浏览器不支持解压 PNG 流");
      const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("deflate"));
      return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), wrapped: true };
    }
    offset = end;
  }
  throw new Error("PNG 中没有 roUd 数据块");
}

async function fetchPlaylist(url, fetcher) {
  const response = await fetcher(url, { cache: "no-store", credentials: "include" });
  if (!response.ok) throw new Error(`读取媒体清单失败 (${response.status})`);
  const decoded = await unwrapRoud(new Uint8Array(await response.arrayBuffer()));
  const finalUrl = response.url || url;
  return {
    playlist: parsePlaylist(new TextDecoder().decode(decoded.bytes), finalUrl, decoded.wrapped),
    finalUrl,
    wrapped: decoded.wrapped
  };
}

async function probeSize(url, fetcher) {
  try {
    const response = await fetcher(url, { method: "HEAD", cache: "no-store", credentials: "include" });
    return response.ok ? responseSize(response.headers) : null;
  } catch {
    return null;
  }
}

async function estimateMediaSize(media, bandwidth, fetcher, wrapped) {
  if (media.exactBytes) return { bytes: media.exactBytes, approximate: false };
  if (bandwidth && media.totalDuration > 0) {
    return { bytes: Math.round(bandwidth * media.totalDuration / 8), approximate: true };
  }
  if (wrapped) return { bytes: null, approximate: false };
  const indexes = [...new Set([0, Math.floor(media.segments.length / 2), media.segments.length - 1])];
  const samples = await Promise.all(indexes.map(async index => ({
    duration: media.segments[index].duration,
    bytes: await probeSize(media.segments[index].url, fetcher)
  })));
  const usable = samples.filter(sample => sample.bytes && sample.duration > 0);
  const sampledDuration = usable.reduce((sum, sample) => sum + sample.duration, 0);
  if (!sampledDuration || media.totalDuration <= 0) return { bytes: null, approximate: false };
  const sampledBytes = usable.reduce((sum, sample) => sum + sample.bytes, 0);
  return { bytes: Math.round(sampledBytes * media.totalDuration / sampledDuration), approximate: true };
}

function extensionOf(url) {
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return match?.[1]?.toLowerCase() || null;
  } catch {
    return null;
  }
}

function inferredResolution(url) {
  try {
    const value = decodeURIComponent(new URL(url).pathname);
    const explicit = value.match(/(?:^|[^\d])(\d{3,4})x(\d{3,4})(?:[^\d]|$)/i);
    if (explicit) {
      return { width: positiveInteger(explicit[1]), height: positiveInteger(explicit[2]) };
    }
    const named = value.match(/(?:^|[^\d])(2160|1440|1080|720|540|480|360|240)p(?:[^\d]|$)/i);
    if (named) return { width: null, height: positiveInteger(named[1]) };
    const bare = value.match(/(?:^|[^\d])(2160|1440|1080|720|540|480|360|240)(?:[^\d]|$)/);
    if (bare) return { width: null, height: positiveInteger(bare[1]) };
  } catch { /* Keep the resolution unknown. */ }
  return { width: null, height: null };
}

function inferredHeight(url) {
  try {
    const value = decodeURIComponent(new URL(url).pathname);
    return positiveInteger(value.match(/(?:^|[^\d])(2160|1440|1080|720|540|480|360|240)p(?:[^\d]|$)/i)?.[1]);
  } catch {
    return null;
  }
}

function defaultFormat(kind) {
  if (kind === "video") return "VIDEO";
  if (kind === "dash") return "DASH";
  return "HLS";
}

function makeOption(entry, values) {
  const height = values.height || inferredHeight(values.downloadUrl);
  const resolution = values.width && height ? `${values.width}×${height}` : null;
  const spec = values.name || (height ? `${height}p` : values.format || "原始画质");
  return {
    id: `${values.downloadUrl}#${spec}`,
    entry: {
      ...entry,
      url: values.downloadUrl,
      wrappedUrl: values.wrapped ? values.downloadUrl : undefined,
      kind: values.wrapped ? "wrapped-hls" : entry.kind
    },
    downloadUrl: values.downloadUrl,
    kind: values.wrapped ? "wrapped-hls" : entry.kind,
    format: values.format || defaultFormat(entry.kind),
    spec,
    details: resolution || "原始媒体",
    size: values.size ?? null,
    approximate: Boolean(values.approximate),
    height: height || 0,
    bandwidth: values.bandwidth || 0,
    seenAt: entry.seenAt || 0
  };
}

export async function inspectEntry(entry, fetcher = fetch) {
  if (entry.kind === "video") {
    const extension = extensionOf(entry.url);
    const size = positiveInteger(entry.size) || await probeSize(entry.url, fetcher);
    const resolution = inferredResolution(entry.url);
    return [makeOption(entry, {
      downloadUrl: entry.url,
      format: extension && DIRECT_EXTENSIONS.has(extension) ? extension.toUpperCase() : "视频",
      width: resolution.width,
      height: resolution.height,
      size,
      wrapped: false
    })];
  }

  // A DASH manifest is XML, not an HLS playlist, so it cannot be parsed or
  // size-estimated here. Surface it as a copy-only candidate (Mediary
  // downloads HLS, not DASH); the user can still copy the manifest URL.
  if (entry.kind === "dash") {
    return [makeOption(entry, {
      downloadUrl: entry.url,
      format: "DASH",
      size: positiveInteger(entry.size),
      wrapped: false
    })];
  }

  const sourceUrl = entry.kind === "wrapped-hls" && entry.wrappedUrl ? entry.wrappedUrl : entry.url;
  const resource = await fetchPlaylist(sourceUrl, fetcher);
  if (resource.playlist.type === "media") {
    const estimate = await estimateMediaSize(resource.playlist, null, fetcher, resource.wrapped);
    return [makeOption(entry, {
      downloadUrl: resource.finalUrl,
      format: resource.wrapped ? "PNG-HLS" : "HLS",
      size: estimate.bytes,
      approximate: estimate.approximate,
      wrapped: resource.wrapped || entry.kind === "wrapped-hls"
    })];
  }

  return Promise.all(resource.playlist.variants.map(async variant => {
    let child = null;
    try { child = await fetchPlaylist(variant.url, fetcher); } catch { /* Keep the variant selectable. */ }
    const estimate = child?.playlist.type === "media"
      ? await estimateMediaSize(child.playlist, variant.bandwidth, fetcher, child.wrapped)
      : { bytes: null, approximate: false };
    return makeOption(entry, {
      downloadUrl: child?.finalUrl || variant.url,
      format: child?.wrapped || resource.wrapped ? "PNG-HLS" : "HLS",
      name: variant.name,
      width: variant.width,
      height: variant.height,
      bandwidth: variant.bandwidth,
      codecs: variant.codecs,
      size: estimate.bytes,
      approximate: estimate.approximate,
      wrapped: Boolean(child?.wrapped || resource.wrapped || entry.kind === "wrapped-hls")
    });
  }));
}

const VOLATILE_PARAM = /^(?:exp|expires|expire|signature|sig|sign|token|auth|auth_key|access_key|policy|nonce|session|st|e|sp|sv|se|sr|ts|x-amz-.*|x-oss-.*)$/i;

export function stableUrl(url) {
  try {
    const parsed = new URL(url);
    const kept = new URLSearchParams();
    for (const [name, value] of parsed.searchParams) {
      if (!VOLATILE_PARAM.test(name)) kept.append(name, value);
    }
    const query = kept.toString();
    return `${parsed.origin}${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch { return url; }
}

export function optionKey(option) {
  return `${option.kind}|${option.height || 0}|${option.bandwidth || 0}|${option.spec}|${stableUrl(option.downloadUrl)}`;
}

export function normalizeOptions(groups) {
  const unique = new Map();
  for (const option of groups.flat()) {
    const id = optionKey(option);
    const current = unique.get(id);
    if (!current) unique.set(id, option);
    else unique.set(id, {
      ...current,
      ...option,
      size: current.size || option.size,
      details: current.details !== "原始媒体" ? current.details : option.details,
      height: Math.max(current.height, option.height),
      bandwidth: Math.max(current.bandwidth, option.bandwidth),
      seenAt: Math.max(current.seenAt, option.seenAt)
    });
  }
  return [...unique.values()].sort((a, b) =>
    b.height - a.height || b.bandwidth - a.bandwidth || b.seenAt - a.seenAt
  );
}

export function applyResolution(option, width, height) {
  if (!height || option.height) return option;
  const resolution = width && height ? `${width}×${height}` : `${height}p`;
  const details = option.details && option.details !== "原始媒体"
    ? `${resolution} · ${option.details}`
    : resolution;
  return { ...option, width, height, spec: `${height}p`, details };
}

export function fallbackOption(entry) {
  let format = entry.kind === "video" ? "视频"
    : entry.kind === "wrapped-hls" ? "PNG-HLS"
    : entry.kind === "dash" ? "DASH"
    : "HLS";
  try {
    const extension = new URL(entry.url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1];
    if (entry.kind === "video" && extension) format = extension.toUpperCase();
  } catch { /* Keep the generic format. */ }
  const downloadUrl = preferredDownloadUrl(entry);
  return {
    id: `${downloadUrl}#fallback`,
    entry: {
      ...entry,
      url: downloadUrl,
      wrappedUrl: entry.kind === "wrapped-hls" ? downloadUrl : undefined
    },
    downloadUrl,
    kind: entry.kind,
    format,
    spec: "原始规格",
    details: "媒体信息暂不可读取",
    size: entry.size || null,
    approximate: false,
    height: 0,
    bandwidth: 0,
    seenAt: entry.seenAt || 0
  };
}

export function formatSize(bytes, approximate = false) {
  if (!positiveInteger(bytes)) return "大小未知";
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

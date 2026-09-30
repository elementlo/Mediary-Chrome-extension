const HLS_MIME = new Set([
  "application/vnd.apple.mpegurl",
  "application/mpegurl",
  "application/x-m3u8",
  "application/x-hls",
  "application/octet-stream-m3u8",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
  "video/mpegurl",
  "video/x-mpegurl"
]);

const DASH_MIME = new Set([
  "application/dash+xml",
  "video/vnd.mpeg.dash.mpd"
]);

// Direct video containers recognized by file extension. `.ts`/`.m4s` are
// deliberately excluded: they are HLS/DASH *segments*, and treating every
// segment as a standalone video would flood the candidate list.
const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "webm", "mkv", "mov", "avi", "flv", "f4v",
  "3gp", "3g2", "wmv", "mpg", "mpeg", "m2ts", "mts", "vob", "ogv", "divx"
]);

// Response MIME types that identify a direct video file. `video/mp2t` and
// `audio/mp2t` are excluded for the same segment-flooding reason as `.ts`.
const VIDEO_MIME = new Set([
  "video/mp4", "video/x-mp4", "video/mpg4", "video/x-mpg4",
  "video/webm", "video/x-matroska",
  "video/quicktime", "video/x-msvideo", "video/avi", "video/msvideo",
  "video/x-flv", "video/flv", "video/x-flash-video", "video/f4v",
  "video/3gpp", "video/3gpp2",
  "video/x-ms-wmv", "video/x-ms-asf",
  "video/mpeg", "video/ogg", "video/x-ogm"
]);

export function classifyUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const path = url.pathname.toLowerCase();
  if (/\.m3u8$/.test(path)) return "hls";
  if (/\.mpd$/.test(path)) return "dash";

  for (const [name, value] of url.searchParams) {
    if (/^(?:format|type)$/i.test(name)) {
      if (/^(?:hls|m3u8)$/i.test(value)) return "hls";
      if (/^(?:dash|mpd)$/i.test(value)) return "dash";
    }
    if (/^(?:url|src|source|file|playlist|manifest)$/i.test(name)) {
      if (/\.m3u8(?:[?#]|$)/i.test(value)) return "hls";
      if (/\.mpd(?:[?#]|$)/i.test(value)) return "dash";
    }
  }

  const extension = path.match(/\.([a-z0-9]{2,5})$/)?.[1];
  if (extension && VIDEO_EXTENSIONS.has(extension)) return "video";
  return null;
}

export function classifyHeaders(headers = []) {
  const type = headers.find(header => header.name.toLowerCase() === "content-type")?.value;
  const mime = type?.split(";", 1)[0].trim().toLowerCase();
  if (HLS_MIME.has(mime)) return "hls";
  if (DASH_MIME.has(mime)) return "dash";

  const disposition = headers.find(header => header.name.toLowerCase() === "content-disposition")?.value;
  if (/filename\*?\s*=.*\.m3u8(?:["';\s]|$)/i.test(disposition || "")) return "hls";
  if (/filename\*?\s*=.*\.mpd(?:["';\s]|$)/i.test(disposition || "")) return "dash";

  return VIDEO_MIME.has(mime) ? "video" : null;
}

// Generic wrapped-HLS probe: any request that redirects to a `.png` is a
// candidate, regardless of its URL shape. Whether the PNG actually carries a
// `roUd` chunk is verified later when the popup inspects the candidate;
// plain images fail verification and are dropped silently.
export function isPngRedirect(targetUrl) {
  try {
    const target = new URL(targetUrl);
    return ["http:", "https:"].includes(target.protocol) &&
      target.pathname.toLowerCase().endsWith(".png");
  } catch { return false; }
}

const HLS_MIME = new Set([
  "application/vnd.apple.mpegurl",
  "application/octet-stream-m3u8",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
  "video/mpegurl",
  "video/x-mpegurl"
]);

export function classifyUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (/\/api\/hls\/[^/]+\/?$/i.test(url.pathname) &&
      url.searchParams.get("kind") !== "thumbs") return "wrapped-hls";
  if (/\.m3u8$/i.test(url.pathname)) return "hls";
  if (/\.(?:mp4|m4v|webm|mkv|mov|avi|flv)$/i.test(url.pathname)) return "video";
  return null;
}

export function classifyHeaders(headers = []) {
  const type = headers.find(header => header.name.toLowerCase() === "content-type")?.value;
  const mime = type?.split(";", 1)[0].trim().toLowerCase();
  if (HLS_MIME.has(mime)) return "hls";
  return ["video/mp4", "video/webm", "video/x-matroska", "video/quicktime", "video/x-msvideo", "video/x-flv"].includes(mime) ? "video" : null;
}

export function isSignedPngRedirect(entryUrl, targetUrl) {
  if (classifyUrl(entryUrl) !== "wrapped-hls") return false;
  try {
    const target = new URL(targetUrl);
    return ["http:", "https:"].includes(target.protocol) &&
      target.pathname.toLowerCase().endsWith(".png");
  } catch { return false; }
}

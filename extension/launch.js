export function preferredDownloadUrl(entry) {
  return entry.kind === "wrapped-hls" && entry.wrappedUrl ? entry.wrappedUrl : entry.url;
}

export function buildDownloadLink(entry, userAgent = "") {
  const source = new URL(preferredDownloadUrl(entry));
  if (!["http:", "https:"].includes(source.protocol)) throw new Error("无效的视频地址");
  const link = new URL("stream-mediary://download");
  link.searchParams.set("url", source.href);
  if (entry.pageUrl) {
    const page = new URL(entry.pageUrl);
    if (["http:", "https:"].includes(page.protocol)) {
      link.searchParams.set("referer", page.href);
    }
  }
  if (userAgent) link.searchParams.set("userAgent", userAgent);
  return link.href;
}

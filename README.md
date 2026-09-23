# HLS Stream Link Detector

This workspace contains a locally extracted IDM Integration Module CRX, a Chrome Manifest V3 extension, and a local HLS proxy for macOS.

## Source analysis

- `source-crx/IDMGCExt.crx` is a public mirror of the 2021 Chrome package, from [Bang1338/idm-extension](https://github.com/Bang1338/idm-extension), commit `9f233ea`. SHA-256: `0f6b76f90f1aebbd365fd3b6e7a3690745289c486ac9374398d560ecbced3eb0`.
- `legacy-source/` is the CRX ZIP payload, extracted without changing its minified JavaScript. The package declares Manifest V2 in `manifest.json` and uses a persistent `background.js`.
- The original background script recognizes media primarily through URL extensions and response MIME. It lists M3U8 MIME types, but maps `image/png` to images. It communicates with IDM through a localhost WebSocket or the `com.tonec.idm` native messaging host. Its video element inspection cannot reveal an HLS URL when playback uses `blob:` and MSE.
- The extraction is for local inspection. The original package is proprietary; this project does not claim its code as open source. `extension/` is a separate implementation and does not contain copied IDM JavaScript.

## Added detection

The local analysis in `/Users/element/Documents/网页播放机制分析.md` identifies a playback route: `GET /api/hls/<id>` redirects to a signed CDN `.png`; the PNG contains a private `roUd` chunk with an HLS manifest or segment. `extension/` detects the entry request and associates its `.png` redirect with that entry. It also detects ordinary `.m3u8` URLs and HLS response MIME types. It intentionally ignores `/api/hls/<id>?kind=thumbs` and `/api/v/<id>/play`.

Chrome `webRequest` does not expose response bodies. The extension therefore sends the detected entry and CDN URL to `hls_proxy.py`, which fetches the source, parses PNG chunks, extracts `roUd`, and inflates payloads whose flag bit 0 is set. It verifies the payload starts with `#EXTM3U` and probes one media segment before returning a local `http://127.0.0.1:8765/hls/<token>/index.m3u8` address. The proxy rewrites playlist, segment, and key URLs to itself and unwraps subsequent PNG responses on request. Relative CDN paths inherit the playlist's signature query when they have no query of their own. It also passes through normal HLS resources and handles byte range requests after decoding. On a `rou.video/v/<id>` page, the popup can construct the documented API entry if it missed the initial request; that entry is still validated by the proxy before copying a URL.

This is a genuine HTTP `.m3u8` URL that media players and downloaders can request while the proxy runs. It is local to this Mac, and source signatures can expire. If the CDN requires additional browser-only authentication, the proxy reports a failure rather than returning an unusable URL. This implementation has not been verified against the live Rou site because the analysis document contains no reusable test media URL.

## Install and use

1. In a terminal from this workspace, run `python3 hls_proxy.py`. Keep it running during playback or download. Python's standard library is sufficient.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `extension/` directory.
3. Play a video on the page, then click the extension icon and choose **生成并复制 m3u8 地址**. The popup only copies an address after the proxy has fetched and validated an HLS manifest.
4. Paste the resulting localhost `.m3u8` URL into the media player or downloader on the same Mac. The proxy must remain running until the download finishes.

Chrome asks for access to HTTP/HTTPS sites because the stream host is not known in advance. The extension stores detected URLs in `chrome.storage.session`, per tab, and removes them when the tab navigates or closes. The proxy binds only to `127.0.0.1`, keeps source URLs in memory, and never logs their signed query strings.

The extracted IDM package is Manifest V2 and cannot be relied on in current Chrome. The new extension provides the macOS copy workflow; it does not download files through IDM or reproduce the proprietary Windows integration.

Run `npm test` and `python3 -m unittest discover -s tests -p 'test_*.py' -v` for detection and local proxy tests.

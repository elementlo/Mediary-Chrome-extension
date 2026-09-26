# Video Stream Link Detector

This workspace contains a locally extracted IDM Integration Module CRX, a Chrome Manifest V3 extension, and an optional legacy HLS proxy. The extension integrates with [Stream Mediary](https://github.com/elementlo/stream-mediary) on macOS and Windows.

## Source analysis

- `source-crx/IDMGCExt.crx` is a public mirror of the 2021 Chrome package, from [Bang1338/idm-extension](https://github.com/Bang1338/idm-extension), commit `9f233ea`. SHA-256: `0f6b76f90f1aebbd365fd3b6e7a3690745289c486ac9374398d560ecbced3eb0`.
- `legacy-source/` is the CRX ZIP payload, extracted without changing its minified JavaScript. The package declares Manifest V2 in `manifest.json` and uses a persistent `background.js`.
- The original background script recognizes media primarily through URL extensions and response MIME. It lists M3U8 MIME types, but maps `image/png` to images. It communicates with IDM through a localhost WebSocket or the `com.tonec.idm` native messaging host. Its video element inspection cannot reveal an HLS URL when playback uses `blob:` and MSE.
- The extraction is for local inspection. The original package is proprietary; this project does not claim its code as open source. `extension/` is a separate implementation and does not contain copied IDM JavaScript.

## Added detection

The local analysis in `/Users/element/Documents/网页播放机制分析.md` identifies a playback route: `GET /api/hls/<id>` redirects to a signed CDN `.png`; the PNG contains a private `roUd` chunk with an HLS manifest or segment. `extension/` detects the entry request and associates its `.png` redirect with that entry. It also detects ordinary `.m3u8` URLs, HLS URLs in common query parameters, HLS response MIME types and playlist filenames, and common video file URLs/MIME types. It intentionally ignores `/api/hls/<id>?kind=thumbs` and `/api/v/<id>/play`.

Chrome `webRequest` does not expose response bodies. When it captures the redirect, the extension passes the signed PNG URL to Stream Mediary through the `stream-mediary://download` desktop protocol, avoiding another request to the HLS entry. If no redirect was captured, it passes the original HTTP(S) entry. It includes the page URL as `Referer` and the browser User-Agent. Mediary extracts `roUd` from PNG manifests, segments and keys, inherits the CDN signature for relative references, and merges the decoded media. No local proxy is needed. On a `rou.video/v/<id>` page, the toolbar popup can construct the API entry if it missed the initial request.

The popup expands a captured source into selectable specs: it fetches the playlist, unwraps PNG `roUd` payloads, resolves relative variant URIs with the inherited signature, and estimates each size. Card labels show the format and spec (for example `1080p`) plus the size; approximate sizes are prefixed with 约. No menu shows the download address. Clicking a card selects it; **复制链接** copies the address of the selection (variant playlist, signed PNG URL when captured, or direct media URL). **Mediary 下载** appears only for HLS and PNG-wrapped HLS selections and passes the same address through `stream-mediary://download`, also copying it for manual use; direct video files such as MP4 are copy-only because Mediary downloads HLS playlists. Neither form is necessarily an ordinary `.m3u8` URL for generic downloaders. The old `hls_proxy.py` remains available for those downloaders. Source signatures can expire, and a site requiring browser-only authentication may still reject Mediary's requests. The implementation has been verified with a synthetic wrapped HLS server, not a live Rou session.

## Install and use

For a reproducible local playback test, run `python3 demo/server.py --port 8090` (requires ffmpeg) and open [the demo page](http://127.0.0.1:8090/v/demo) in Chrome. Click **加载并播放**, then use the extension's **在 Mediary 中下载** action. See [demo instructions](demo/README.md).

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `extension/` directory.
2. Install and launch the current Stream Mediary desktop build once so `stream-mediary://` is registered. On Windows, registration is written to the current user's registry at startup; on macOS, it comes from the app bundle's Info.plist.
3. Play a video and move the mouse over it. A **视频链接** button appears over the video and disappears when the pointer leaves. Click it to open the menu; clicking outside closes the menu. The toolbar popup and the in-video menu show every selectable stream as a card with its spec and size instead of its address; click a card to select it, then use **复制链接**, or **Mediary 下载** when the selection is HLS or PNG-wrapped HLS. Direct video files such as MP4 offer **复制链接** only.
4. If the desktop app is unavailable, the open action also copies the address it would pass to Mediary. Chrome may still display its own external-protocol prompt or missing-handler error; extensions cannot reliably detect desktop app installation. For PNG-wrapped streams, paste the copied address into the updated Mediary app. Signed source URLs may expire.

Chrome asks for access to HTTP/HTTPS sites because the stream host is not known in advance. The extension stores detected URLs in `chrome.storage.session`, per tab, and removes them when the tab navigates or closes. No local service is contacted by the extension.

The extracted IDM package is Manifest V2 and cannot be relied on in current Chrome. This separate extension copies links on Windows and macOS; it does not download files through IDM or reproduce the proprietary IDM integration.

Run `npm test` for extension tests. The optional legacy proxy has Python tests under `tests/`.

# Video Stream Link Detector

A Chrome (Manifest V3) extension that sniffs **HLS / PNG-wrapped stream** entries on video pages and hands them off to the desktop downloader [Mediary](https://github.com/elementlo/stream-mediary) in one click.

<p>
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

---

## Why this extension

A lot of people have used IDM's browser extension — it does sniff streaming media out of web pages, but **it only works with IDM itself**, and IDM is **paid** software (once the trial ends you have to buy a license).

This extension takes the "sniffing" half on its own and pairs it with [Mediary](https://github.com/elementlo/stream-mediary), which is **free and open source**. In other words: the browser finds the link, the desktop app downloads and merges it — no money, no purchase nag. A sniffed link can also just be copied without downloading, entirely up to you.

> By the way: the original IDM extension is Manifest V2 and no longer runs on current Chrome. This extension is a **fully independent rewrite** and contains none of IDM's proprietary code.

## What it detects

Detection is **generic and site-agnostic** — it targets no specific website:

- **Ordinary HLS** — by `.m3u8` extension, common query parameters (`format=hls`, …) and HLS response MIME types.
- **PNG-wrapped HLS (`roUd`)** — any request that 302-redirects to a `.png` becomes a candidate; when the popup inspects it, the PNG is unwrapped and kept only if it really carries an HLS manifest. Plain images (icons, sprites) are dropped silently.
- **Direct video files** — mp4 / webm / mkv / mov / avi / flv, etc. (by extension and MIME). These are **copy-only**, because Mediary downloads HLS playlists.
- **DASH manifests** — `.mpd` / `application/dash+xml`, also **copy-only**.
- **DOM media sniffing** — scans `video/audio/source` elements for http(s) sources, covering players that set `src` directly with no observable request.

> Limitations: `blob:` / MSE streams cannot be sniffed (same as the original IDM); `.ts` / `.m4s` segments are not treated as standalone videos, so the candidate list stays clean.

## Install

The extension is not on the Chrome Web Store yet; install it via "Load unpacked":

1. Clone or download this repository and note the location of the `extension/` directory.
2. Open `chrome://extensions` and enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` directory.
4. Install and **launch at least once** the [Mediary](https://github.com/elementlo/stream-mediary/releases) desktop app so the `stream-mediary://` protocol gets registered.
   - Windows: written to the current user's registry on first launch;
   - macOS: registered by the `.app` bundle.

> Chrome may warn "disable developer mode extensions" on startup — just dismiss/keep it. That is normal for an extension not installed from the store.

## Usage

1. Open a video page and play it, then **hover over the video**. A **"Video Link"** button appears on the picture (and disappears when the pointer leaves). You can also click the extension icon in the toolbar to open the popup.
2. The button/popup lists every detected stream as a **card** showing format, spec (e.g. `1080p`) and estimated size — **not** a raw address. Click a card to select it.
3. Once selected there are two actions:
   - **Copy link** — copies the stream address to the clipboard (available for any type).
   - **Mediary Download** — available only for HLS / PNG-wrapped HLS; opens desktop Mediary through the `stream-mediary://` deep link, automatically carrying the source page (Referer) and browser UA.
4. If the desktop app is missing or failed to register, "Mediary Download" also copies the address to the clipboard so you can paste it into Mediary manually. Chrome may still show its own "open external app" prompt — that is expected.

> Signed CDN URLs can expire; some sites require browser-only authorization and may still reject Mediary's requests. When that happens, just trigger detection again on the page to get a fresh address.

## Optional: site rules (JSON import only)

For the vast majority of sites the generic detection above is enough. **Rules are an extra filter on top of generic detection**, only needed when a particular site requires special handling, and can only be configured by importing a JSON file (popup → ⚙ → Import JSON; there is no editing form). The extension ships **without any rules**.

- When the page hostname matches a rule, only candidates passing `urlFilter` are kept; when no rule matches, generic detection passes everything.
- A rule can also reconstruct a fallback entry URL for pages whose stream request cannot be observed at all.

```json
[{
  "hostname": "example.com",
  "urlFilter": "^https://example\\.com/api/",
  "pagePath": "^/v/([^/]+)/?$",
  "entryPath": "/api/hls/$1",
  "kind": "wrapped-hls"
}]
```

| Field | Required | Meaning |
| --- | --- | --- |
| `hostname` | yes | exact page hostname the rule applies to |
| `urlFilter` | no | RegExp source; on this host only candidates whose URL matches are kept. Omit to keep everything |
| `pagePath` | with `entryPath` | RegExp source matched against the page pathname |
| `entryPath` | no | entry pathname template (`$1..$n` reference `pagePath` capture groups); used as a fallback when nothing was captured |
| `kind` | no | fallback kind: `wrapped-hls` (default) or `hls` |

The file is a plain JSON array of rule objects; it is validated at import (regexes must compile, `$n` must have matching groups, etc.) and invalid rules are rejected with a reason. Rules are stored only in the local `chrome.storage.local` and can be exported/cleared from the same panel.

## Implementation (brief)

- Native ES modules, **no build step, no framework**; after editing, just refresh the extension in `chrome://extensions`.
- `background.js` (service worker) captures candidates via `webRequest` and stores them per tab in `chrome.storage.session` (an MV3 worker can be suspended, so an in-memory Map won't do); cleared on navigation/tab close.
- `detection.js` does generic URL/MIME classification and PNG-redirect probing; `media-options.js` fetches playlists, unwraps `roUd`, and estimates spec/size; `launch.js` builds the `stream-mediary://` deep link.
- Privacy: candidates live only in session storage, rules only on this machine, and **the extension contacts no self-hosted service**.

See [`AGENTS.md`](AGENTS.md) for the full directory layout, key mechanisms and development conventions.

## Local demo

Want to try it in a reproducible environment? The repo ships a synthetic demo site:

```bash
python3 demo/server.py --port 8090   # requires ffmpeg
```

Then open <http://127.0.0.1:8090/v/demo> in Chrome, click **Load & Play**, and use the extension's **Mediary Download** action. See the [demo instructions](demo/README.md).

## Tests

```bash
npm test                              # extension unit tests (node:test)
python3 -m unittest tests.test_demo_server   # demo server tests (optional)
```

## About the IDM source

`source-crx/` and `legacy-source/` hold the 2021 IDM Integration Module CRX extracted from a public mirror, **for local research/comparison only**. The original package is proprietary; this project does not claim its code as open source. `extension/` is an independent implementation containing no JavaScript copied from IDM.

## Disclaimer

This extension and Mediary are for personal, educational and legitimate use only. You are responsible for ensuring you have the rights to download any content. Do not use them to infringe copyright or violate terms of service. DRM-protected streams are not supported.

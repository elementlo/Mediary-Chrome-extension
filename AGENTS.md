# AGENTS.md

本文件为 AI 编码助手提供项目上下文。Video Stream Link Detector 是一个 Chrome Manifest V3 扩展，检测网页中的 HLS / PNG 包装流媒体入口，通过 `stream-mediary://download` 深链唤起 Mediary 下载器（主项目仓库：https://github.com/elementlo/stream-mediary）。

## 项目概要

- **形态**：Chrome MV3 扩展（原生 JS，无构建步骤、无框架）
- **核心能力**：
  - 通用流检测：`.m3u8` 后缀 / 常见查询参数 / HLS MIME / 直链视频（mp4/webm/mkv/mov/avi/flv/f4v/3gp/wmv/mpg/mpeg/m2ts/vob/ogv 等）
  - DASH 清单检测（`.mpd` / `application/dash+xml`）——仅可复制链接，Mediary 不下载 DASH
  - DOM 媒体嗅探：content script 扫描 `video/audio/source/object/embed` 的 http(s) src 上报（覆盖无独立请求的播放器）
  - PNG 包装 HLS（roUd）结构探测：任何 302 到 `.png` 的请求都是候选，弹窗检查时解包验证 `roUd` 块，普通图片静默丢弃
  - 视频页悬浮按钮（overlay）+ 工具栏弹窗（popup）双入口
  - 深链唤起桌面版 Mediary，携带 url / referer（来源网页）/ userAgent
- **刻意排除**：`.ts`/`.m4s` 分片与 `video/mp2t` 不分类为独立视频（避免 HLS 分片刷屏候选列表）；blob:/MSE 流无法嗅探（与 IDM 原版相同的局限）
- **测试**：`npm test`（node:test，30 个用例）；demo 服务器测试 `python3 -m unittest tests.test_demo_server`
- **本地演示**：`python3 demo/server.py --port 8090`（需 ffmpeg），打开 `http://127.0.0.1:8090/v/demo`

## 目录结构

```
extension/
├── manifest.json      MV3 清单（webRequest/storage/tabs/clipboardWrite）
├── background.js      service worker：webRequest 监听、候选存储、规则筛选、选项聚合
├── detection.js       通用 URL/MIME 分类 + PNG 重定向探测（isPngRedirect）
├── media-options.js   清单抓取/解析、roUd 解包、清晰度/大小估算、选项去重
├── launch.js          stream-mediary:// 深链构造
├── overlay.js         视频悬浮按钮 content script（所有 frame）
├── popup.html/js/css  工具栏弹窗：规格选择 + 规则面板（仅 JSON 导入）
└── site-rules.js      规则 schema 校验与匹配（rulesForPage/candidateAllowed/matchPageRule）
tests/                 node:test 单测 + demo 服务器 Python 测试
demo/                  本地 PNG 包装 HLS 演示站（server.py 生成 fMP4 HLS 并包 roUd）
```

## 关键机制

- **候选捕获**：`background.js` 用 webRequest 三个监听器（onBeforeRequest / onBeforeRedirect / onHeadersReceived）捕获候选，按 tab 存 `chrome.storage.session`（MV3 worker 会被挂起，不能用内存 Map），导航/关标签时清空。
- **DOM 嗅探上报**：content script（`overlay.js`）定时扫描媒体元素的 http(s) src，经 `reportDomMedia` 消息上报；background 用同一套 `classifyUrl` + 规则筛选后存为候选，与网络捕获去重合并。
- **kind 体系**：`hls` / `wrapped-hls`（PNG 包装，可下载）/ `dash`（仅复制）/ `video`（仅复制）。`launch.js` 与 popup/overlay 的 `canLaunch` 只对 hls/wrapped-hls 放行"Mediary 下载"。
- **规则筛选**：规则存 `chrome.storage.local`（键 `rules`），background 内存缓存 + `storage.onChanged` 实时刷新。页面 hostname 命中规则时按 `urlFilter` 过滤候选；无规则命中则通用检测全放行。
- **roUd 验证后置**：PNG 探测宁滥勿缺（所有 .png 重定向都收），真伪在 popup/overlay 请求选项时由 `inspectEntry` 解包验证，失败的 wrapped-hls 候选静默丢弃（`buildOptions`），其他类型保留 fallback 卡片。
- **分辨率来源**：PNG 包装流的清单不带 RESOLUTION，靠 content script 上报 `<video>` 实际尺寸（`reportVideoSize`，存 session storage）。

## 规则 JSON 格式（用户导入，扩展不内置任何规则）

规则文件是一个 JSON 数组，每个对象只有技术字段，**不含名称/说明性字段**：

```json
[{
  "hostname": "example.com",
  "urlFilter": "^https://example\\.com/api/",
  "pagePath": "^/v/([^/]+)/?$",
  "entryPath": "/api/hls/$1",
  "kind": "wrapped-hls"
}]
```

| 字段 | 必填 | 含义 |
|---|---|---|
| `hostname` | 是 | 规则生效的页面域名（精确匹配，小写） |
| `urlFilter` | 否 | 正则源码；该域名下只有 URL 匹配的候选被保留。省略则该域名候选全保留 |
| `pagePath` | 与 entryPath 配对 | 正则源码，匹配页面 pathname |
| `entryPath` | 否 | 入口路径模板，`$1..$n` 引用 pagePath 分组；当页面没有捕获到任何候选时用于构造 fallback 入口 |
| `kind` | 否 | fallback 类型：`wrapped-hls`（默认）或 `hls` |

书写要点：
- 正则字段是**字符串形式的正则源码**，JSON 里反斜杠要双写（`\\.`）。
- 导入时校验：正则必须可编译、`entryPath` 的 `$n` 必须有对应分组、`entryPath` 必须配 `pagePath`、`kind` 只能是两个合法值；未知字段丢弃、完全重复的规则合并。
- 校验逻辑在 `site-rules.js` 的 `normalizeRule/normalizeRules`，改 schema 必须同步改这里和测试。

## 开发约定

- **回复语言**：中文。
- **无构建步骤**：原生 ES modules，改完在 `chrome://extensions` 手动刷新扩展生效。
- **提交前校验**：`npm test` 全绿；改过 JS 用 `node --check` 过一遍语法。
- **站点中立**：扩展代码、测试数据、文档示例**不得出现具体站点名**（用 `example.com` / `site.test` 等中性域名）；站点适配一律走规则 JSON，由用户自行导入。
- **检测保持通用**：不要在 `detection.js` 里加任何站点特定的 URL 路径模式；新站点支持 = 写一条规则，不是改代码。
- **隐私**：候选只存 `chrome.storage.session`（按 tab，导航即清）；规则只存本机 `chrome.storage.local`；扩展不联系任何自建服务。

## 与主项目（Mediary）的契约

- 深链格式：`stream-mediary://download?url=<流地址>&referer=<来源网页>&userAgent=<UA>`（构造在 `launch.js`，解析在主项目 `DownloadLink.parse`）。
- `referer` 会被主项目持久化为任务的 `refererUrl`，用于下载任务的"复制来源网页"菜单。
- 只有 `hls` / `wrapped-hls` 类型提供"Mediary 下载"；直链视频（mp4 等）仅支持复制链接。
- 改深链参数时须同步改主项目的解析端。

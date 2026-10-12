# Video Stream Link Detector

一个 Chrome（Manifest V3）扩展，在视频网页上自动嗅探 **HLS / PNG 包装流**入口，一键唤起桌面下载器 [Mediary](https://github.com/elementlo/stream-mediary) 完成下载。

<p>
  <strong>简体中文</strong> | <a href="README.en.md">English</a>
</p>

---

## 为什么做这个扩展

很多人用过 IDM 的那枚浏览器扩展——它确实能嗅探网页里的流媒体，但**它必须搭配 IDM 本体**，而 IDM 是一款**付费**软件（试用期一过就得掏钱买授权）。

这个扩展把"嗅探"这一半单独拎了出来，对接的是**免费、开源**的 [Mediary](https://github.com/elementlo/stream-mediary)。也就是说：浏览器里负责发现链接，桌面端负责下载合并，全程不花钱、不弹购买提示。 sniff 到的链接也可以只复制、不下载，随你处置。

> 顺带一提：IDM 原版扩展是 Manifest V2，在当前 Chrome 上已经跑不起来了。本扩展是**完全独立的重写**，不含任何 IDM 的专有代码。

## 它能检测什么

检测是**通用、站点中立**的，不针对任何具体网站：

- **普通 HLS** — 按 `.m3u8` 后缀、常见查询参数（`format=hls` 等）、HLS 响应 MIME 识别。
- **PNG 包装 HLS（`roUd`）** — 任何 302 跳转到 `.png` 的请求都是候选；弹窗检查时解包验证是否真的藏了 HLS 清单，普通图片（图标、雪碧图）会被静默丢弃。
- **直链视频** — mp4 / webm / mkv / mov / avi / flv 等（按后缀与 MIME）。这类**只能复制链接**，因为 Mediary 下载的是 HLS 播放列表。
- **DASH 清单** — `.mpd` / `application/dash+xml`，同样**只能复制**。
- **DOM 媒体嗅探** — 扫描页面 `video/audio/source` 等元素的 http(s) 源，覆盖那些直接设 `src`、抓不到独立请求的播放器。

> 局限：`blob:` / MSE 流无法嗅探（这一点和 IDM 原版一样）；`.ts` / `.m4s` 分片不会被当成独立视频，免得候选列表被刷屏。

## 安装

扩展尚未上架 Chrome 商店，用「加载已解压的扩展程序」方式安装：

1. 克隆或下载本仓库，记住 `extension/` 目录的位置。
2. 打开 `chrome://extensions`，右上角开启 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择 `extension/` 目录。
4. 安装并**至少启动一次** [Mediary](https://github.com/elementlo/stream-mediary/releases) 桌面版，让 `stream-mediary://` 协议完成注册。
   - Windows：首次启动时写入当前用户注册表；
   - macOS：由 `.app` bundle 注册。

> Chrome 每次启动可能提示"停用开发者模式扩展"，点忽略/保留即可，这是未上架商店扩展的正常现象。

## 使用

1. 打开一个视频网页并播放，把鼠标**悬停在视频上**，画面会出现一个 **「视频链接」** 按钮（移开鼠标即消失）。也可以点浏览器工具栏的扩展图标打开弹窗。
2. 按钮/弹窗会把检测到的每个流列成**卡片**，显示格式、清晰度（如 `1080p`）和估算大小，而**不是**直接甩一个地址给你。点卡片选中它。
3. 选中后有两个动作：
   - **复制链接** — 把该流的地址复制到剪贴板（任何类型都可用）。
   - **Mediary 下载** — 仅 HLS / PNG 包装流可用，通过 `stream-mediary://` 深链唤起桌面 Mediary，并自动带上来源网页（Referer）与浏览器 UA。
4. 如果桌面应用没装或没注册成功，「Mediary 下载」也会把地址一并复制到剪贴板，你可以手动粘贴到 Mediary 里。Chrome 可能仍会弹自己的"打开外部应用"确认框，属正常现象。

> 签名 CDN 地址可能过期；某些站点要求浏览器专属鉴权，Mediary 的请求仍可能被拒。遇到这种情况，重新在页面上触发一次检测即可拿到新地址。

## 可选：站点规则（JSON 导入）

绝大多数站点靠上面的通用检测就够了。**规则是通用检测之上的额外筛选**，仅在某个站点需要特殊处理时才用，且只能通过导入 JSON 配置（弹窗 → ⚙ → 导入 JSON，没有编辑表单）。扩展本身**不内置任何规则**。

- 当页面域名命中规则时，只保留 `urlFilter` 匹配的候选；没有规则命中则通用检测全放行。
- 规则还能为"完全观察不到流请求"的页面构造一个 fallback 入口。

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
| --- | --- | --- |
| `hostname` | 是 | 规则生效的页面域名（精确匹配） |
| `urlFilter` | 否 | 正则源码；该域名下只有 URL 匹配的候选被保留，省略则全保留 |
| `pagePath` | 与 `entryPath` 配对 | 正则源码，匹配页面 pathname |
| `entryPath` | 否 | 入口路径模板，`$1..$n` 引用 `pagePath` 的分组；无候选时用于构造 fallback |
| `kind` | 否 | fallback 类型：`wrapped-hls`（默认）或 `hls` |

规则文件是一个 JSON 数组；导入时会校验（正则可编译、`$n` 有对应分组等），非法规则会被拒绝并给出原因。规则只存本机 `chrome.storage.local`，可在同一面板导出/清空。

## 技术实现（简述）

- 原生 ES modules，**无构建步骤、无框架**；改完在 `chrome://extensions` 手动刷新即可生效。
- `background.js`（service worker）用 `webRequest` 监听捕获候选，按 tab 存 `chrome.storage.session`（MV3 worker 会被挂起，不能用内存 Map），导航/关标签即清空。
- `detection.js` 负责通用 URL/MIME 分类与 PNG 重定向探测；`media-options.js` 抓取清单、解包 `roUd`、估算清晰度与大小；`launch.js` 构造 `stream-mediary://` 深链。
- 隐私：候选只存会话级 storage，规则只存本机，**扩展不联系任何自建服务**。

目录结构、关键机制与开发约定的完整说明见 [`AGENTS.md`](AGENTS.md)。

## 本地演示

想在一个可复现的环境里试一遍？仓库自带一个合成演示站：

```bash
python3 demo/server.py --port 8090   # 需要 ffmpeg
```

然后在 Chrome 打开 <http://127.0.0.1:8090/v/demo>，点 **加载并播放**，再用扩展的 **Mediary 下载** 动作。详见 [demo 说明](demo/README.md)。

## 测试

```bash
npm test                              # 扩展单测（node:test）
python3 -m unittest tests.test_demo_server   # demo 服务器测试（可选）
```

## 关于 IDM 源码

`source-crx/` 与 `legacy-source/` 是从公开镜像提取的 2021 版 IDM 集成模块 CRX，**仅用于本地研究对照**。原包为专有软件，本项目不主张其代码开源；`extension/` 是独立实现，不含任何复制自 IDM 的 JavaScript。

## 免责声明

本扩展与 Mediary 仅供个人、学习与合法用途。请自行确保拥有所下载内容的合法权利，勿用于侵犯版权或违反服务条款。DRM 保护的流不受支持。

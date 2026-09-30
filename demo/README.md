# 本地多场景联动演示

此站点用本机 ffmpeg 生成多种测试媒体，覆盖 Chrome 插件的各类检测能力。首页是场景卡片列表，每个场景触发一类媒体请求：

| 场景 | 媒体 | 验证的插件能力 |
|---|---|---|
| PNG 包装 HLS（roUd） | `/api/hls/demo` → 签名 `.png` | 插件特有的 roUd 解包 + Mediary 联动下载 |
| 普通 HLS | `/media/plain/index.m3u8`（.ts 分片） | 后缀/MIME 的 HLS 检测 |
| 多清晰度 HLS | `/media/master/master.m3u8`（360p/240p） | master 清单变体展开 |
| 直链视频 | `/media/movie.mp4`（`<video>` 播放） | 视频 MIME 检测 + DOM 媒体元素嗅探；仅可复制链接 |
| DASH | `/media/dash/manifest.mpd` | .mpd 检测；仅可复制链接（Mediary 不下载 DASH） |
| 查询参数 HLS | `/api/query-hls?format=m3u8` | 无后缀、靠查询参数识别 |
| 噪声 PNG | `/api/icon-redirect` → 无 roUd 的 `.png` | 伪 PNG 候选被静默丢弃 |

## 启动

需要 Python 3 和 ffmpeg。第一次启动时会自动生成全部媒体，输出放在被 Git 忽略的 `demo/.generated/`。

```bash
python3 demo/server.py --port 8090
```

在 Chrome 打开 <http://127.0.0.1:8090/>，逐个点击场景卡片的「触发」按钮，然后打开插件弹窗（或悬停视频点「视频链接」）核对每张卡片下方的「预期」结果。

PNG 包装 HLS 场景会跳转到独立播放页 <http://127.0.0.1:8090/v/demo>，点击「加载并播放」后可测试完整的 Mediary 联动下载。

演示服务只监听 `127.0.0.1`。按 `Ctrl+C` 停止服务。若 8090 端口已被占用，可修改启动命令的 `--port`。

可运行 `python3 -m unittest tests.test_demo_server -v` 验证各场景路由、重定向、签名参数、PNG 解包及媒体分片。

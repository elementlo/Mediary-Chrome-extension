# 本地 PNG HLS 联动演示

此站点把本机生成的 8 秒 H.264 视频切成 fMP4 HLS。`/api/hls/demo` 跳转到带签名参数的 `.png`；主清单、媒体清单、初始化片段和每个视频分片都放在 PNG 的 `roUd` 数据块中。页面自身解包并用 MediaSource 播放，Chrome 扩展可以检测同一请求。

## 启动

需要 Python 3 和 ffmpeg。第一次启动时会自动生成视频，输出放在被 Git 忽略的 `demo/.generated/`。

```bash
cd /Users/element/workspace/ai/fdm-extension
python3 demo/server.py --port 8090
```

在 Chrome 打开 <http://127.0.0.1:8090/v/demo>，点击“加载并播放”。画面开始变化后，打开插件弹窗，选择“在 Mediary 中下载”。下载器应能预览一个约 8 秒、4 个分片的视频。确认下载后，输出应能播放同一段测试画面。

演示服务只监听 `127.0.0.1`，不需要 `hls_proxy.py`。按 `Ctrl+C` 停止服务。若 8090 端口已被占用，可同时修改启动命令的 `--port`；页面和播放逻辑会自动使用当前端口。

可运行 `python3 -m unittest tests.test_demo_server -v` 验证重定向、签名参数、PNG 解包及媒体分片。

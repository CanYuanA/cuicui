# 催催｜会中干预型会议助手

催催不是会后才整理纪要的工具，而是在会议进行中识别偏题、时间风险和观点僵持，并给出可追溯的主持建议。

公网体验：<https://cuicui.iotaceti.top>

## 为什么这个 Demo 可信

- 115 秒会议录音由 MiniMax Speech 2.8 HD 的五种音色逐句生成并混音，不是浏览器里的文字定时器。
- 完整 master 与 15 段分句均实际通过科大讯飞 IAT；每帧 40ms / 1280 bytes，并保存终态响应。
- 讯飞转写再进入本项目 `/api/analyze` 和 `/api/report`；已验证运行的 11 项检查全部通过。
- 当前音频 SHA-256：`6ed60fdd3258ff6bbf0cf81b40976ed93c9bfa62ca6d3faabaec80d2384f77d1`。
- 浏览器可直接查看 `/demo/verified-run.json`，追溯转写、模型来源、检查项与费用用量。

## 三条体验路径

1. **真实实跑会议**：点击首页主按钮，播放真实录音；用“跳到下个触发点”快速查看干预，再生成报告。
2. **真实多人会场**：创建会议并复制六位加入码；另一台设备用姓名/角色加入。说话人标签来自独立参与身份，不猜声纹。
3. **单麦克风体验**：讯飞 WebSocket 实时听写；直连失败会切换到 OpenRouter HTTP STT。

公开接口使用两小时、IP 绑定的签名体验会话，并有单会话与全局额度；房间最多 12 人、240 段发言、6 小时后失效。OpenRouter 密钥与讯飞 APISecret 不下发；单麦克风直连模式只会收到限时的讯飞签名 WebSocket URL。

## 本地运行

依赖通过 `mise` 隔离，不需要全局安装 Node/npm 包。

```powershell
$env:MISE_DATA_DIR = Join-Path $PWD '.mise-data'
mise trust
mise install
mise run install
mise run dev
```

访问 <http://localhost:3000>。配置文件从 `.env.example` 复制为 `.env.local`；不要提交真实密钥。开发服务会持续占用当前终端，下面的检查请在另一个终端执行。

```powershell
mise run check
mise run build
mise run smoke
```

真实证据生成是显式任务，且会消耗受限额度：

```powershell
mise run audio-generate
mise run audio-verify
```

`mise run smoke` 和 `mise run audio-verify` 都要求另一个终端中的本地 3000 端口服务保持运行。

## 部署

推送 `main` 后，GitHub Actions 会：

1. 在 GitHub 托管 runner 上类型检查、构建并发布不可变 SHA 镜像到阿里云 ACR；
2. 由名称/标签为 `cuicui-deploy` 的专用自托管 runner 登录 ACR、同步版本化 Compose 配置并拉取镜像；
3. 在 `/srv/docker/cuicui` 启动容器，并只映射 `127.0.0.1:8476`；
4. 同时验证容器健康和公网 TLS/反向代理链路；失败时自动尝试回滚；
5. 只清理同一 Cuicui ACR 仓库的旧镜像，并保留最近一个健康版本作为回滚点。

仓库只需配置 `ACR_USERNAME`、`ACR_PASSWORD` 两个 Actions Secrets，值与向阳岛仓库现有的 Registry 登录名和专用密码一致；Cuicui 的 Registry 地址和独立镜像名是非敏感的版本化配置。服务器目录只保留不入库的 `.env`（ACR 镜像坐标）和 `app.env`（运行时密钥）；流水线不会改动该目录之外的业务文件。

完整两分钟讲解词见 [DEMO_GUIDE.md](./DEMO_GUIDE.md)。

## 主要目录

```text
app/
├─ api/                    # 受控 AI、讯飞、房间与健康接口
├─ meeting-app.tsx         # 主持端：会前、会中、会后
├─ participant-view.tsx    # 独立参与端
├─ live-transcriber.ts     # 讯飞 40ms 流与 HTTP 兜底
└─ server/demo-access.ts   # 签名体验会话与额度控制
public/demo/               # 真实录音、manifest、verified-run
scripts/                   # 音频生成、实证与公开 API 冒烟测试
```

接口依据：[科大讯飞流式语音听写](https://www.xfyun.cn/doc/asr/voicedictation/API.html)、[OpenRouter TTS](https://openrouter.ai/docs/guides/overview/multimodal/tts)、[OpenRouter STT](https://openrouter.ai/docs/guides/overview/multimodal/stt)。

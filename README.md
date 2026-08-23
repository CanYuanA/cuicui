# 催催｜会中干预型会议助手

催催不是等会议结束才写纪要，而是在会议进行中理解已经说完的内容，识别跑题、分歧和时间风险，再给出可执行、可追溯的主持建议。

公网演示：<https://cuicui.iotaceti.top>

访问站点时会先进入全站密码页。密码由演示负责人单独提供，不写入仓库或文档。验证通过后，当前浏览器会话可直接使用演示功能，不设置额外的体验次数或时长限额。

## 当前演示主线

首页的“开始演示会议”会进入一场 100 秒的“催催助手现场演示方案会”。会议里的团队正在讨论催催本身该怎么演给评委看，不需要额外解释业务背景。

- 约 `00:21`：会议厅温度引出短暂闲聊，催催在相关发言转写完成后才提醒拉回议题。
- 约 `00:57`：“多人模式要不要进本次演示”出现明确支持与反对，现场干预卡给出分歧依据。
- 约 `01:14–01:15`：同一观点重复、范围仍未收敛，会议尚未到计划截止时间，催催已预测将超时并要求立即拍板。
- `01:22` 之后：拍板单人链路、暂不开放多人入口，并明确讯飞直连、字幕时序和验收责任。

字幕只在对应发言结束后出现，干预只在所需证据已经出现后触发。会议结束后，动态报告根据本次转写、干预和最终决策生成，而不是在开场时展示预写结果。

## 可选的实时体验

“使用麦克风实时体验”仅使用科大讯飞 IAT WebSocket 直连听写。如果浏览器权限、网络或讯飞连接失败，页面会明确告知失败原因，不会改用 HTTP 转写或伪造字幕兜底。

多人协作链路暂未列入当前评审版。首页保留不可点击的“多人协作模式 · 即将开放”状态，演示时不要尝试创建房间或分享加入码。

## 会议数据如何流动

1. 稳定的会议录音按发言时间轴播放。
2. 已完成的语音识别结果按每句真实结束时间逐条显示。
3. 每次新转写都会连同议题和剩余时间进入会中分析。
4. 只有证据足够时才新增干预，并显示“观察—影响—建议—判断依据”。
5. 结束时使用完整转写和干预记录生成会议报告。

为保持公网演示稳定，录音、转写和已验证分析可以按来源音频哈希缓存；缓存只复用同一份输入的实际运行结果。只要台词、TTS 文本或音色变化，录音生成就不会复用旧片段。

## 本地运行

依赖通过 `mise` 隔离，不需要全局安装 Node/npm 包。

```powershell
$env:MISE_DATA_DIR = Join-Path $PWD '.mise-data'
mise trust
mise install
mise run install
mise run dev
```

访问 <http://localhost:3000>。将 `.env.example` 复制为 `.env.local`，并设置本地的 `SITE_ACCESS_PASSWORD`、会话签名参数和所需服务凭据；不要提交真实密钥。

```powershell
mise run check
mise run build
mise run smoke
```

重建录音和验证证据是显式任务，会调用外部服务，仅在会议数据变更时执行：

```powershell
mise run audio-generate
mise run audio-verify
```

`mise run smoke` 和 `mise run audio-verify` 都要求另一个终端中的本地 3000 端口服务保持运行。

## 部署

推送 `main` 后，GitHub Actions 会：

1. 在 GitHub 托管 runner 上类型检查、构建并发布不可变 SHA 镜像到阿里云 ACR；
2. 由名称/标签为 `cuicui-deploy` 的专用自托管 runner 校验服务器预置 Compose 配置，并使用服务器已有 ACR 凭据拉取镜像；
3. 在 `/srv/docker/cuicui` 启动容器，并只映射 `127.0.0.1:8476`；
4. 验证容器健康与公网 TLS/反向代理链路，失败时自动尝试回滚；
5. 只清理同一 Cuicui ACR 仓库的旧镜像，并保留最近一个健康版本作为回滚点。

演示讲解词见 [DEMO_GUIDE.md](./DEMO_GUIDE.md)。

## 主要目录

```text
app/
├─ access/                 # 全站访问密码页
├─ api/                    # 讯飞、会中分析、报告与访问验证
├─ meeting-app.tsx         # 单人演示、实时体验与会后报告
├─ live-transcriber.ts     # 讯飞 40ms 音频帧直连，失败明确报错
└─ server/                 # 全站 Cookie 验证与服务端访问控制
public/demo/               # 演示录音、manifest 与已验证运行记录
scripts/                   # 音频生成、证据验证与公开 API 检查
```

接口依据：[科大讯飞流式语音听写](https://www.xfyun.cn/doc/asr/voicedictation/API.html)、[OpenRouter TTS](https://openrouter.ai/docs/guides/overview/multimodal/tts)。

# 幻想时刻（HuanXiangShiKe）

对话式 AI 视频生成桌面软件。上传图片 + 文字描述即可生成视频；智能模型路由自动挑选最合适的模型；应用内多通道并行检测更新。

**当前版本：1.0**

## 功能

- **对话式生成**：像和 AI 聊天一样下达任务，支持上传图片做图生视频
- **双轨生成**
  - A 轨 云端接口：阿里云百炼（通义万相 Wan3.0 / HappyHorse 1.1 / Wan2.7 / Wan2.2 系列）、SiliconFlow（Wan2.2 A14B）
  - B 轨 本地免密钥：LTX-Video 2B v0.9.1（Apache-2.0），完全离线、数据不出本机。**v1.1 起已实装**——在「本地模型」页一键下载 Python 运行时 + torch cu124 + 模型权重（约 9GB），装好后无需任何 API Key 即可离线生成
- **智能路由**：识别 14 类意图（人像动态 / 有声视频 / 写实 / 动漫 / 风景空镜 / 产品广告 / 微动效循环 / 极速竖版 / 首尾帧 / 长时长 / 动作迁移 / 视频编辑 / 文档生视频 / 离线隐私），按「意图命中 × 通道可达 × 显存/额度可行性 × 成本」打分选型，失败自动沿降级链切换，决策理由全程可见
- **多模型搭配**：分镜模式下多模型各出一段，自动拼接成片（内置 ffmpeg）
- **多通道并行更新**：GitHub API / Releases HTML / Tags 三通道探测竞速，下载三通道竞速，SHA512 完整性校验，静默升级免 UAC，失败给手动下载直链
- **自检模式**：无 Key 无本地模型时，用 ffmpeg 真实合成带水印样例视频跑通全链路，界面明确标注「非真实 AI 生成」

## 下载与安装

见 [Releases](https://github.com/sml1145/AIshipin/releases)。下载 `HuanXiangShiKe-Setup-x.y.0.exe`，并可用同目录 `SHA256SUMS.txt` 独立核验哈希。

> 安装包未做代码签名，首次运行 Windows SmartScreen 可能提示风险，请选择「仍要运行」。更新完整性由 latest.yml 的 SHA512 + Ed25519 manifest 校验保证，不依赖代码签名。

安装位置为 `%LOCALAPPDATA%\Programs\幻想时刻`（per-user），升级不弹管理员框。

## API Key（真实生成所需）

软件**不内置任何额度、不代付**。要得到真实 AI 视频，请在「设置」中填入任一通道密钥：

| 通道 | 获取方式 | 特点 |
|---|---|---|
| 阿里云百炼 DashScope | 百炼控制台创建 API Key | 通义万相全系，质量最优，支持 2–30 秒、1080P、原生有声 |
| SiliconFlow | 控制台创建 API Key | 支持本地图片 base64 直传，注册有代金券 |

密钥用 Windows DPAPI（Electron safeStorage）加密存本机，明文不落盘、不入仓库。若系统加密能力不可用，软件会拒绝保存而非降级为明文。

## 模型与许可证

- 云端模型清单以 `models.json` 为准（schemaVersion 2，经官方文档核实，可远程热更新）
- 本地模型权重均为 Apache-2.0：LTX-Video 2B、Wan2.1-1.3B、CogVideoX-2b（来源 ModelScope / 官方仓库）
- ffmpeg：`@ffmpeg-installer/ffmpeg`（LGPL 静态构建，随包分发）
- 不复制任何 GPL/AGPL 项目代码（ComfyUI 等仅作架构参考；如作为可选外部后端由用户自装，与本软件经 HTTP 通信，保持聚合关系）

## 版本号规则（十进制进位）

按用户指定：`1.0 → 1.1 → … → 1.9 → 2.0 → 2.1 …`，**永不出现 1.10**。

- `package.json` 的 `version` 为合法 semver 三段（如 `1.0.0`）
- 界面与 Release tag 显示两段（如 `1.0`）
- 每次优化发布新版本：先 `npm run bump`，再 `npm run dist`，最后 `gh release create v<新两段版本>` 上传安装包 + latest.yml + SHA256SUMS.txt

## 开发

```bash
npm install          # 安装依赖
npm test             # 无头全量单元测试（205+ 项，真实断言，含真实 ffmpeg 合成视频）
npm start            # 开发态启动（需交互式桌面会话）
npm run smoke        # GUI 冒烟自检（窗口/沙箱/核心 IPC），结果写 smoke-result.json
npm run dist         # 打包 Windows 安装包到 release/
```

### 环境说明（重要）

在无交互桌面会话的环境（如部分远程桌面/虚拟显示环境）中，Chromium 渲染提交可能无法完成，窗口会卡在加载。这是**环境限制而非软件缺陷**：同机 Edge 正常、Electron 33/44 均复现、无崩溃无注入无代理干扰。请在正常桌面会话运行 `npm run smoke` 或安装后启动验证；全部业务逻辑均可通过 `npm test` 无头验证。

## 能力边界（如实说明）

- 真实生成需自备 API Key；无 Key 且未装本地模型时仅自检模式
- 海外模型通道（Hugging Face / Replicate / fal.ai）在部分网络下不可达，仅保留接口位并自动探测启用
- 本地轨受显存限制：8GB 显存约 480p / 5 秒 / 单条数分钟；LTXV-13B、HunyuanVideo 13B、Mochi 10B、Wan2.2-A14B 在 8GB 显存下跑不动
- ModelScope 的视频生成端点官方文档未获取，v1.0 不将其作为视频通道（不编造端点）
- 不含账号体系、不含支付、不含模型微调训练

## License

MIT（应用软件）。第三方组件与模型权重许可证见上文。

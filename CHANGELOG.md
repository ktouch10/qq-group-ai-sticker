# 更新日志

版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 0.1.0 — 2026-10-26

首个开源版本：把一套在 QQ 机器人上长期使用的表情包能力，整理成不依赖特定框架的独立插件。

### 新增

- **收藏表情知识库**（`sticker-store.js`）：从 QQ 账号同步收藏表情；AI 记录含义 / 情绪标签 / 适用场景 / 使用次数；
  跨会话共享并持久化；库文件损坏时只读降级，不覆盖原数据。
- **联网梗图库**（`web-stickers.js`）：两个固定来源、只接受 1~16 字公共短词、查询缓存、负缓存、
  每小时/每天限额、32MB / 120 项 / 30 天缓存淘汰、串行队列上限 4。
- **预览生成**（`preview.js`）：sharp 进程内完成，静图缩到 384 内、动图取首中尾三帧拼成 768×256，
  输出 JPEG ≤160KB；不依赖任何外部可执行文件。
- **OneBot v11 适配**（`onebot.js`）：发图（base64、单气泡、可引用/@）、收藏列表、收藏表情、改备注、取消息；
  统一超时与错误归一化（含 HTTP 426 端口填错的提示）。
- **编排层**（`service.js`）：白名单（allow/deny/空白名单默认拒绝）、同会话发送节流、
  发送前二次校验、看新图许可、收藏失败不误报。
- **提示词层**（`policy.js`）：表情包策略 + 可用表情摘要 + 按会话的「连发几条文字没配图」节奏提示（软上限）。
- **MCP server**（`mcp-server.js`）：6 个工具（`sticker_list` / `sticker_find` / `sticker_preview` /
  `sticker_send` / `sticker_note` / `sticker_collect`），改官方备注的工具在未开启时**不注册**。
- **CLI**（`cli.js`）：status / sync / list / find / preview / send / note / collect / prompt，不接 AI 也能验证整条链路。
- **56 个测试**：数据层、联网库限额与缓存、预览、OneBot 适配、编排层白名单与限流、配置、MCP 端到端。

### 设计取舍

- 直连 OneBot HTTP API，不绑定任何 AI 框架或宿主；MCP 只是可选的一层壳。
- 预览用 sharp 在进程内生成，不引入外部二进制依赖，Windows / Linux / macOS 行为一致。
- 只做「表情包」这一件事：AI 生图、语音、文件发送都不在本插件范围内。
- 安全默认值优先：空白名单不放行、写操作默认关闭、图片字节自己下载而不是把 URL 交给网关。

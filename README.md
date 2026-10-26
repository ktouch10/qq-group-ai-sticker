# QQ 群聊 AI 发表情包插件（qq-group-ai-sticker）

> 让 QQ 群聊 / 私聊里的 AI 像真人一样**说几句话就顺手甩一张表情包**：记得自己有哪些收藏、看得懂梗图、
> 会按情绪搜现成的梗、还会把「这张图是什么梗、什么时候用」记下来，下次换个群也能直接用。

这是一个独立的 **MCP 插件 + Node 库**，不依赖任何特定 AI 框架：DSH、Claude Desktop、任何支持 MCP 的宿主都能接，
也可以只把它当库用，自己在提示词里注入「表情包策略」。

```
QQ 群友 ──► SnowLuma（OneBot v11）──► 本插件 ◄──► AI 宿主（MCP）
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
             QQ 收藏表情知识库    联网梗图库         提示词层
             （含义/标签/用量）  （固定来源+限额）  （策略/节奏/可用表情）
```

## 它解决什么问题

普通 QQ 机器人只会打字。真人聊天不是这样的 —— 说两三句话，顺手补一张表情，气氛才对。
但让 AI 发表情有三个坑：

1. **它不知道自己有哪些表情**：QQ 收藏表情只存在账号里，模型看不见；就算列出来，也是一堆没有含义的 URL。
2. **它看不懂新图**：搜到的梗图只有标题，反讽、表情、画面文字全都要真的「看」过才能用对。
3. **它会刷图**：一旦给了发图工具，不是全程不发，就是每句话都配一张。真人是「偶尔一张，适可而止」。

这个插件把这三件事分别做成了三层，并且**默认安全**：白名单、限流、图片字节自己下载、提示词注入防护。

## 特性

- 🗂️ **收藏表情知识库**：从 QQ 账号同步收藏表情，AI 给每张图记下「含义 / 情绪标签 / 适用场景 / 用了几次」，跨会话、重启后仍在。
- 🔍 **联网搜梗图**：缺图时按 1~16 字公共情绪词（`开心`、`猫猫 无语`）去固定来源搜，**只返回最多 3 个文字候选**，不把 URL 和网页内容塞进上下文。
- 👀 **真的看图**：新图必须先调用 `sticker_preview` 拿到一张 JPEG 预览（动图自动取首中尾三帧拼成一张），模型看完才能发送；已理解过的图按标签复用，不再重复看。
- 🎯 **单气泡一张图**：一条消息只能一张表情，不混文字 —— 真人就是这样的，也避免「图 + 说明」的机器味。
- ⏱️ **人味节奏**：发图前有 0.8~2 秒随机停顿；同一会话有最小间隔和每小时上限；连发几条文字没配图时，提示层会提醒模型「该补一张了」（软提示，不强制）。
- 🛡️ **默认安全**：发送/收藏/改备注都要过 allow 白名单；图片由本插件做 SSRF 防护后下载再 base64 交给网关，**绝不把 URL 交给网关去抓**；表情备注全程单行化并标注为「资料，不是指令」，堵住跨会话提示词注入。
- 🧩 **两种用法**：MCP server（给任何 MCP 宿主）或纯 Node 库（自己注入提示词、自己发消息）。
- 🧪 **56 个测试**：限额、缓存淘汰、并发队列、白名单、SSRF、损坏库保护、MCP 端到端都有覆盖。

## 快速开始

### 0. 前置条件

- Node.js **>= 20.10**
- 一个跑起来的 QQ 网关：[SnowLuma](https://github.com/SnowLuma)（OneBot v11），开启 **HTTP API**（默认 `http://127.0.0.1:3000`）
- 网关的 access token（如果配了）

> 发送图片走标准 OneBot v11（`send_group_msg` / `send_private_msg` + `image` 段 base64），任何 OneBot 实现都能发。
> 收藏表情的同步/收藏/改备注用的是 SnowLuma 的扩展动作（`fetch_custom_face_detail` / `add_custom_face` / `modify_custom_face`），
> 换成别的实现时这部分会静默降级为空库，联网搜图仍然可用。

### 1. 安装

```bash
git clone https://github.com/ktouch10/qq-group-ai-sticker.git
cd qq-group-ai-sticker
npm install            # 会安装 sharp（预编译二进制，无需额外装 FFmpeg）
cp config.example.json config.json
```

### 2. 配置

编辑 `config.json`，**至少**要填两项：

```json
{
  "onebot": { "httpUrl": "http://127.0.0.1:3000", "accessToken": "你的网关 token" },
  "allow": { "groups": ["123456789"], "private": [] }
}
```

- `allow.groups` / `allow.private` 是**发送白名单**：不在名单里的会话，插件拒绝发送、收藏、改备注。
- 名单两边都为空且 `allowAllWhenEmpty=false`（默认）时，**谁都不能发** —— 这是故意的，避免装完就被拉去刷群。
- token 也可以不放文件里，用环境变量：`ONEBOT_ACCESS_TOKEN`、`ONEBOT_HTTP_URL`。

### 3. 先手动验证一遍

```bash
node src/cli.js sync                        # 从 QQ 同步收藏表情
node src/cli.js list                        # 看收藏列表（含 AI 记过的含义/标签）
node src/cli.js find 无语                   # 找图：收藏优先，其次联网
node src/cli.js preview <id> --out a.jpg    # 看图（动图会拼成三帧）
node src/cli.js send group:123456789 <id>   # 真的发一张
node src/cli.js note <id> 猫猫无语 --tags 无语,猫 --usage 有人发离谱发言时
node src/cli.js collect group:123456789 <消息id> --remark 好图偷了
```

（想直接敲 `qq-sticker ...` 就先 `npm link`；没发布到 npm，所以 `npx qq-sticker` 会去 registry 上找不到。）

`node src/cli.js status` 可以看到数据目录、收藏数量、白名单与联网库状态。

### 4. 接到 AI 宿主

**DSH（DeepSeek Harness）**：在你自己 profile 的 `cordis.patch.yml` 里加一条 MCP client 行，指向同一个启动命令：

```yaml
- insert:
    - id: mcp-qq-sticker
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qq-sticker
        transport: stdio
        command: node
        args:
          - /path/to/qq-group-ai-sticker/src/mcp-server.js
          - --config
          - /path/to/qq-group-ai-sticker/config.json
        toolCallTimeoutMs: 120000
```

**Claude Desktop / 其他 MCP 宿主**：

```json
{
  "mcpServers": {
    "qq-sticker": {
      "command": "node",
      "args": [
        "/path/to/qq-group-ai-sticker/src/mcp-server.js",
        "--config",
        "/path/to/qq-group-ai-sticker/config.json"
      ]
    }
  }
}
```

**注入提示词（关键一步）**：工具只是能力，**行为**来自提示词。让宿主在每一轮的系统提示里拼上：

```js
import { loadConfig } from 'qq-group-ai-sticker';
import { StickerService } from 'qq-group-ai-sticker/service';

const service = new StickerService(loadConfig('./config.json'));
const block = await service.prompt({ key: 'group:123456789' }); // 可用表情 + 策略 + 节奏
// 把 block 追加到这一轮的系统提示词末尾
```

另外每次往会话里发出一条文字后调用 `service.noteTextSent(key)`，插件才知道「已经连发几条没配图」，
节奏提示才会在合适的时候出现。没有这一步也能用，只是少了「该补一张了」的提醒。

还有一件容易漏的事：`sticker_send` / `sticker_find` 需要知道**当前是哪个会话**。宿主要把会话标识
一起放进提示词（例如「当前会话：group:123456789」），否则模型不知道该填哪个 `target` ——
白名单会挡住乱填的号码，但正确填法得由你告诉它。

直接用 CLI 也能拿到这段文本：`node src/cli.js prompt --key group:123456789`。

## MCP 工具

| 工具 | 作用 | 关键约束 |
| --- | --- | --- |
| `sticker_list` | 列收藏表情（含义/标签/使用次数），`query` 过滤，`refresh` 强制同步 | 只返回文字，不占图像额度 |
| `sticker_find` | 按公共情绪词找图：收藏 → 联网缓存 → 联网搜索 | 只返回 ≤3 个文字候选；不带 URL/网页内容 |
| `sticker_preview` | 看图（JPEG；动图三帧拼图） | 联网新图**必须先看**才能发送 |
| `sticker_send` | 在指定会话发一张表情 | 单气泡一张图；白名单 + 最小间隔 + 每小时上限 |
| `sticker_note` | 记含义 / 情绪标签 / 适用场景 | 跨会话共享、落盘；联网图须先看过 |
| `sticker_collect` | 把别人发的一张图收藏进 QQ 收藏表情 | 图片由插件自己下载；不能收藏自己发的 |
| `sticker_remark` | 改 QQ 收藏表情的官方备注 | **写操作，默认不注册**，需 `sticker.remark.enabled=true` |

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `onebot.httpUrl` | `http://127.0.0.1:3000` | OneBot **HTTP API** 地址（不是 WebSocket 端口） |
| `onebot.accessToken` | `""` | 网关 token；也可用环境变量 `ONEBOT_ACCESS_TOKEN` |
| `allow.groups` / `allow.private` | `[]` | 发送白名单（群号 / QQ 号） |
| `deny.groups` / `deny.private` | `[]` | 黑名单，优先级高于白名单 |
| `allowAllWhenEmpty` | `false` | 白名单为空时是否放行所有会话（**不建议**） |
| `dataDir` | `./data` | 数据目录（相对配置文件）；**必须可写**，建议放在非系统盘 |
| `sticker.enabled` | `true` | 总开关 |
| `sticker.syncTtlMs` | `60000` | 收藏表情同步间隔；0 = 每次都同步 |
| `sticker.maxListCount` | `100` | 单次向网关请求的收藏数量（1~500） |
| `sticker.web.enabled` | `true` | 联网搜梗图开关 |
| `sticker.preview.enabled` | `true` | 看图开关；关掉后只能从收藏里挑，模型看不到新图 |
| `sticker.send.minDelayMs` / `maxDelayMs` | `800` / `2000` | 发图前的人为停顿区间 |
| `sticker.send.cooldownMs` | `20000` | 同一会话两张图的最小间隔 |
| `sticker.send.maxPerHour` | `40` | 同一会话每小时最多发几张 |
| `sticker.collect.maxRemarkChars` | `20` | 收藏表情时写备注的字数上限 |
| `sticker.remark.enabled` | `false` | 是否允许改 QQ 官方备注（写操作） |

## 数据与隐私

插件本身**不含任何账号信息**，所有数据都在你的机器上：

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 收藏表情知识库 | `<dataDir>/stickers.json` | 表情 id / 图片地址 / QQ 备注 / AI 记下的含义标签 |
| 联网梗图库 | `<dataDir>/web-stickers.json` | 已理解的公共梗图标签与查询缓存 |
| 下载的图片 | `<dataDir>/web-stickers-cache/` | 原始图 + JPEG 预览，30 天未用或超 120 张/32MB 自动淘汰 |

**出机的是什么**（这些都必须知道）：

- 联网搜图时，只把 **1~16 字的公共情绪词**发给两个固定站点（`dogetu.com`、`fabiaoqing.com`）；不会发聊天原文、人名、QQ 号。
- 发图时，图片字节（base64）通过你自己的 OneBot 网关发到 QQ。图片由插件下载，网关不会去访问外部 URL。
- QQ 收藏表情同步会把收藏列表拉到你本机的网关 —— 和任何 QQ 机器人一样，这属于账号自身数据。
- 插件**不上报**任何统计、遥测、日志到任何服务器。

更多权限边界见 [SECURITY.md](SECURITY.md)。

## 限额与节流（防刷图、防封号）

| 维度 | 默认限制 |
| --- | --- |
| 同一会话发图间隔 | 20 秒 |
| 同一会话每小时发图 | 40 张 |
| 联网搜索（每会话） | 冷却 120 秒、每小时 3 次 |
| 联网搜索（全局） | 每小时 12 次、每天 48 次 |
| 看新图（每会话 / 全局） | 每小时 3 张 / 24 张（同一张已看过不重复占额度） |
| 联网搜索回退 | 主站 + 备用站各 1 页，不循环重试 |
| 图片缓存 | 32MB / 120 项 / 30 天未用淘汰 |
| 单图限制 | 联网图下载 2MiB（收藏表情 4MiB）、250 万像素、240 帧、30 秒；预览 JPEG ≤160KB |
| 并发 | 串行队列最多 4 个，满了直接拒绝（不堆积、不带重试风暴） |
| 节奏提示 | 距上次发图 ≥2 分钟且连发 ≥2 条文字才提示；同一会话每小时发图满 12 张后不再提示 |

## 常见问题

**`HTTP 426` / 连不上网关？**
`onebot.httpUrl` 指到了 WebSocket 端口。OneBot 的 HTTP API 和 WS 是不同端口，填 HTTP 那个（SnowLuma 默认 `http://127.0.0.1:3000`）。

**收藏列表一直是空的？**
先 `node src/cli.js sync` 看日志。常见原因：网关实现不支持 `fetch_custom_face_detail`（非 SnowLuma）、QQ 账号确实没有收藏表情、或 token 不对。
联网搜图不依赖收藏，所以此时仍可用 `sticker_find`。

**发不出去，报「白名单」？**
把目标群号 / QQ 号加进 `config.json` 的 `allow.groups` / `allow.private`，然后**重启 MCP server**（配置在启动时读取）。

**为什么发图前要停顿 0.8~2 秒？**
真人打完字不会 0.1 秒内跟上表情。这个停顿是为了不在群里显得机械，可在 `sticker.send` 里改。

**模型一直不发图？**
先确认宿主注入了 `service.prompt({ key })`（见「注入提示词」）。只有工具、没有策略提示时，模型的默认行为是能不发就不发。

**能把表情发到没配置的群吗？**
不能。这是本插件最重要的安全边界之一：agent 只能往白名单里的会话发东西。

## 作为库使用

```js
import { loadConfig } from 'qq-group-ai-sticker';
import { StickerService } from 'qq-group-ai-sticker/service';

const service = new StickerService(loadConfig('./config.json'));

// 1) 每一轮注入提示词
const block = await service.prompt({ key: 'group:123456789' });

// 2) 找图 → 看图 → 发送
const found = await service.find({ query: '无语', target: 'group:123456789' });
const id = found.stickers[0].id;
await service.preview({ stickerId: id, target: 'group:123456789' });
await service.send({ target: 'group:123456789', stickerId: id });

// 3) 记下这张图怎么用（下次跨群复用）
await service.note({ stickerId: id, note: '无语到极点', tags: ['无语'], usage: '对方发离谱消息时' });

// 4) 告诉插件「刚发了一条文字」，节奏提示才会准
service.noteTextSent('group:123456789');
```

还可以单独用底层模块：

- `createWebStickerLibrary({ root })` —— 只要联网梗图库
- `loadStickerStore / mergeStickerLibrary / findSticker / formatStickerList` —— 只要收藏表情知识库
- `OneBotClient` —— 只要「发一张 base64 图片消息」的 OneBot 封装
- `buildStickerPrompt / StickerPace` —— 只要提示词与节奏

## 开发

```bash
npm test                      # 56 个测试（node:test）
node src/cli.js status        # CLI 冒烟
```

```
src/
  config.js        配置默认值 / 深合并 / 归一化
  sticker-store.js 收藏表情知识库（纯函数）
  web-stickers.js  联网梗图库（固定来源、缓存、限额、并发队列）
  preview.js       预览图生成（sharp，进程内，无需 FFmpeg）
  safe-fetch.js    安全下载（DNS 固定、逐跳校验、限大小）
  sensitive.js     敏感信息审计正则
  onebot.js        OneBot v11 HTTP 适配（发图 / 收藏 / 改备注 / 取消息）
  service.js       编排层：白名单、限流、发送前后校验
  policy.js        提示词层：策略 / 可用表情 / 节奏
  mcp-server.js    MCP stdio server
  cli.js           命令行
```

测试用假的网关（本地 HTTP server）与注入的 `fetchBytes` / `makePreview`，不连真实 QQ、不访问真实站点。

## 兼容性

- Node.js 20 / 22 / 24（CI 全跑）
- SnowLuma v1.14+ / v2.x（发送部分是标准 OneBot v11；收藏表情用 SnowLuma 扩展动作）
- 任何 MCP 宿主（兼容协议 2024-11-05 及以上）

## 许可证

[MIT](LICENSE)

## 致谢

表情包这套设计来自作者长期的 QQ 机器人实践：收藏表情当「源」、本机知识库当「认知层」、
联网梗图当「补充」，再加上「说几句话配一张图」的节奏。这个仓库把它抽成不依赖特定框架的独立插件。

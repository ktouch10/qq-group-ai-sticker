# QQ Group AI Sticker

[![ci](https://github.com/ktouch10/qq-group-ai-sticker/actions/workflows/ci.yml/badge.svg)](https://github.com/ktouch10/qq-group-ai-sticker/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.10-339933.svg)](package.json)

[中文说明](README.md) | **English**

> An **MCP plugin + Node library** that lets an AI in QQ group chats / DMs send stickers like a human:
> it remembers which custom stickers the account owns, actually *looks* at a meme before sending it,
> searches public meme sites when it lacks one, and records what each sticker means so it can be reused
> in another chat later.

```
QQ chat ──► SnowLuma (OneBot v11) ──► this plugin ◄──► AI host (MCP)
                                        │
                      ┌─────────────────┼─────────────────┐
                      ▼                 ▼                 ▼
              QQ sticker knowledge   Web meme library   Prompt layer
              (meaning/tags/usage)   (fixed sources)    (policy / pace / list)
```

## Why

A chatbot that only types text does not feel like a person. Real people drop one sticker every few messages.
Three things make that hard for an LLM:

1. **It does not know what it owns.** QQ custom stickers live in the account, invisible to the model.
2. **It cannot read a new meme.** A title is not enough — sarcasm, facial expression and in-image text must be seen.
3. **It overdoes it.** Give a model a "send sticker" tool and it either never uses it or spams every turn.

This plugin answers each with a separate layer — and ships safe defaults: allowlist, rate limits,
self-downloaded image bytes, and prompt-injection hardening.

## Features

- **Sticker knowledge base** synced from the QQ account; the AI records meaning / mood tags / usage / use count per sticker. Shared across chats and persisted.
- **Web meme search** by 1–16 character public mood words, fixed sources, at most 3 text-only candidates per call.
- **Real visual inspection**: a new sticker must be previewed first (`sticker_preview` returns JPEG; animated GIFs become a 3-frame tile).
- **One sticker per bubble** — never mixed with text, like a real person.
- **Humanized pacing**: 0.8–2 s random delay before sending, per-chat cooldown and hourly cap, plus a soft "you have not sent a sticker in a while" hint.
- **Secure by default**: allowlist for send/collect/remark; image bytes are fetched in-process behind SSRF protection and sent as base64 (URLs are never handed to the gateway); sticker notes are flattened to one line and explicitly framed as *data, not instructions*.
- **Two ways to use it**: MCP server for any MCP host, or a plain Node library.
- **84 tests**: quotas, cache eviction, concurrency, allowlist, SSRF (`isPrivateIp` / DNS / redirects / decompression caps), corrupt-store protection, MCP end-to-end.

## Quick start

Requirements: Node.js **>= 20.10**, a running [SnowLuma](https://github.com/SnowLuma) OneBot v11 gateway with **HTTP API** enabled
(default `http://127.0.0.1:3000`).

```bash
git clone https://github.com/ktouch10/qq-group-ai-sticker.git
cd qq-group-ai-sticker
npm install
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "onebot": { "httpUrl": "http://127.0.0.1:3000", "accessToken": "your-gateway-token" },
  "allow": { "groups": ["123456789"], "private": [] }
}
```

The allowlist is mandatory for a reason: with an empty allowlist and `allowAllWhenEmpty=false` (default),
**nothing can be sent anywhere**.

Verify manually:

```bash
node src/cli.js sync
node src/cli.js list
node src/cli.js find 无语
node src/cli.js preview <id> --out a.jpg
node src/cli.js send group:123456789 <id>
node src/cli.js note <id> "猫猫无语" --tags 无语,猫 --usage "someone says something absurd"
node src/cli.js collect group:123456789 <messageId> --remark "nice one"
```

(`npx qq-sticker` works only after `npm link` — the package is not published to npm yet.)

Wire it into an MCP host (DSH / Claude Desktop / anything):

```json
{
  "mcpServers": {
    "qq-sticker": {
      "command": "node",
      "args": ["/path/to/qq-group-ai-sticker/src/mcp-server.js", "--config", "/path/to/config.json"]
    }
  }
}
```

**Inject the prompt.** Tools are capability; behaviour comes from the prompt. Each turn, append:

```js
import { loadConfig } from 'qq-group-ai-sticker';
import { StickerService } from 'qq-group-ai-sticker/service';

const service = new StickerService(loadConfig('./config.json'));
const block = await service.prompt({ key: 'group:123456789' });
// append `block` to this turn's system prompt
service.noteTextSent('group:123456789'); // after you send a text message
```

CLI equivalent: `node src/cli.js prompt --key group:123456789`.

One more thing that is easy to miss: `sticker_send` / `sticker_find` need to know **which chat** they are in.
Tell the model the current chat key in the prompt (e.g. `current chat: group:123456789`), otherwise it cannot
fill `target` — the allowlist blocks wrong numbers, but only you can tell it the right one.

> ⚠️ **Two writers will overwrite each other.** If you already run the plugin as an MCP server (a child process),
> do **not** instantiate a default `new StickerService(...)` in the host process against the same `dataDir` —
> both processes read and write `stickers.json`, and the last write wins. Build the prompt in read-only mode:
> `new StickerService(loadConfig(), { writeStore: false })`, or just use `node src/cli.js prompt`.
> Read-only mode never creates or modifies the store file.

## MCP tools

| Tool | Purpose | Constraint |
| --- | --- | --- |
| `sticker_list` | List owned stickers with learned meaning/tags/usage | text only, no image quota |
| `sticker_find` | Find by public mood word: owned → cache → web | ≤3 text candidates, no URLs |
| `sticker_preview` | Look at a sticker (JPEG; 3-frame tile for GIF) | required before sending a new web meme |
| `sticker_send` | Send one sticker to a chat | one per bubble; allowlist + cooldown + hourly cap |
| `sticker_note` | Record meaning / mood tags / usage | shared across chats, persisted |
| `sticker_collect` | Add someone else's image to QQ custom stickers | image downloaded by the plugin, not the gateway |
| `sticker_remark` | Edit the official QQ sticker remark | **write operation, disabled by default**; when enabled it still needs `target` + allowlist |

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `onebot.httpUrl` | `http://127.0.0.1:3000` | OneBot **HTTP API** (not the WebSocket port) |
| `onebot.accessToken` | `""` | or `ONEBOT_ACCESS_TOKEN` |
| `allow.groups` / `allow.private` | `[]` | send allowlist |
| `deny.groups` / `deny.private` | `[]` | deny list, takes precedence |
| `allowAllWhenEmpty` | `false` | allow everything when the allowlist is empty (not recommended) |
| `dataDir` | `./data` | writable data directory, relative to the config file |
| `sticker.enabled` | `true` | master switch |
| `sticker.syncTtlMs` | `60000` | custom-sticker sync interval |
| `sticker.maxListCount` | `100` | owned stickers requested per sync (1–500) |
| `sticker.web.enabled` | `true` | web meme search |
| `sticker.preview.enabled` | `true` | visual inspection |
| `sticker.send.cooldownMs` / `maxPerHour` | `20000` / `40` | per-chat sending pace |
| `sticker.send.minDelayMs` / `maxDelayMs` | `800` / `2000` | pre-send humanized delay |
| `sticker.collect.maxRemarkChars` | `20` | remark length cap when collecting |
| `sticker.remark.enabled` | `false` | allow editing official QQ remarks |

## Privacy & limits

- Only **1–16 character public mood words** leave the machine when searching two fixed sites (`dogetu.com`, `fabiaoqing.com`). Never chat text, names or QQ numbers.
- Image bytes are downloaded by the plugin behind SSRF protection (DNS pinning, per-hop validation, size caps) and sent to QQ as `base64://` through your own gateway.
- No telemetry, no analytics, no reporting.
- Defaults: 1 sticker / 20 s and 40 / hour per chat; web search 3 / hour per chat and 12 / hour globally; preview 3 / hour per chat; 32 MB / 120-item / 30-day image cache; max 4 queued jobs; concurrent syncs are coalesced and a forced sync hits the gateway at most once per 3 s.

See [SECURITY.md](SECURITY.md) for the full boundary list.

## Compatibility

- Node.js 20 / 22 / 24
- SnowLuma v1.14+ / v2.x. Sending is standard OneBot v11; custom-sticker sync/collect/remark use SnowLuma extension actions and degrade gracefully (empty library) on other implementations.
- Any MCP host compatible with protocol `2024-11-05` or newer.

## License

[MIT](LICENSE)

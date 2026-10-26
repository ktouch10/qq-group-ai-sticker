// MCP stdio server：把表情包能力暴露给任意支持 MCP 的 AI 宿主。
//
// 只暴露 6 个工具，全部围绕「找图 → 看图 → 发送 → 记含义」这条最短链路；
// 不包含任何账号管理动作（禁言、踢人、改群设置…），也不提供任意 URL 下载或任意文件发送。
//
// 启动：node src/mcp-server.js --config ./config.json
// 也可以把配置放在环境变量 STICKER_CONFIG 指向的路径。
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { StickerService } from './service.js';

function argValue(argv, name, fallback) {
  const idx = argv.indexOf(name);
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  const prefixed = argv.find((a) => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  return fallback;
}

const configFile = argValue(process.argv.slice(2), '--config', process.env.STICKER_CONFIG || path.resolve('config.json'));
const config = loadConfig(configFile);
// 注意：stdio 传输下 stdout 属于协议通道，日志只能走 stderr。
const service = new StickerService(config, { log: (message) => console.error(`[qq-sticker] ${message}`) });

const server = new McpServer({ name: 'qq-group-ai-sticker', version: '0.1.0' });

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const fail = (error) => ({ content: [{ type: 'text', text: `失败：${error?.message ?? error}` }], isError: true });

/** 把库里的表情压缩成模型看的最小字段：id / 标签 / 标签组 / 是否还没看过。 */
function compact(entry) {
  return {
    id: entry.id,
    label: entry.localNote || entry.desc || '（无备注，可先看图）',
    ...(entry.tags?.length ? { tags: entry.tags.slice(0, 3) } : {}),
    ...(entry.useCount ? { useCount: entry.useCount } : {}),
    needsPreview: !(entry.localNote || entry.desc)
  };
}

server.tool(
  'sticker_list',
  '查看这个 QQ 账号收藏的表情包（含 AI 记下的含义/标签/使用次数）。query 可按备注、标签、用途过滤；refresh=true 立即从网关重新同步。返回文字清单，不占图像额度；没有备注的表情先用 sticker_preview 看图，再用 sticker_note 记下含义。',
  {
    query: z.string().max(64).optional().describe('按备注/标签/用途过滤的关键词，可省略'),
    limit: z.number().int().min(1).max(100).optional().describe('最多返回几个，默认 12'),
    refresh: z.boolean().optional().describe('true = 立即从 QQ 网关强制重新同步收藏')
  },
  async ({ query, limit, refresh }) => {
    try {
      const data = await service.list({ query: query ?? '', limit: Math.min(100, Number(limit) || 12), refresh: Boolean(refresh) });
      return text({
        ok: true,
        total: data.total,
        matched: data.matched,
        truncated: data.truncated,
        stickers: data.stickers.map(compact)
      });
    } catch (error) { return fail(error); }
  }
);

server.tool(
  'sticker_find',
  '按 1~16 字公共情绪/动作词找表情：先查 QQ 收藏，再查已理解的联网梗图缓存，最后才去固定站点搜。返回最多 3 个文字候选。query 只写公共词（如“开心”“猫猫无语”），不传聊天原文、人名、QQ号；没有结果或冷却时本轮用文字，不要连续重试。',
  {
    query: z.string().min(1).max(32).describe('1~16 字公共情绪/动作词，如 开心、无语、猫猫 无语'),
    target: z.string().optional().describe('可选：会话标识 group:123456 / private:7890，用于额度与看图许可的归属')
  },
  async ({ query, target }) => {
    try {
      const data = await service.find({ query, target });
      return text({ ok: true, ...data });
    } catch (error) { return fail(error); }
  }
);

server.tool(
  'sticker_preview',
  '看一张表情/梗图（联网新图必须先看）：动图会取首中尾三帧拼成一张 JPEG。结合画面、表情、文字和反讽理解梗意，再用 sticker_note 记录含义。已标注过含义的图不必重复看。stickerId 用 sticker_list / sticker_find 返回的 id。',
  {
    stickerId: z.string().min(1).max(128).describe('表情标识，来自 sticker_list / sticker_find'),
    target: z.string().optional().describe('可选：会话标识，用于看图额度的归属')
  },
  async ({ stickerId, target }) => {
    try {
      const data = await service.preview({ stickerId, target });
      return {
        content: [
          {
            type: 'text',
            text: `表情 ${data.sticker.id}${data.sticker.label ? '（标签：' + data.sticker.label + '）' : ''} 的图片内容：动图已取三帧拼成一张。`
          },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ]
      };
    } catch (error) { return fail(error); }
  }
);

server.tool(
  'sticker_send',
  '在指定会话发一张表情：一条消息只能一张图，不能在同一气泡里附带文字；想说的话请用文字消息单独发。target 形如 group:123456 或 private:7890，必须在 allow 白名单里。发出前插件会校验白名单、最小间隔与每小时上限，越权或过频会被拒绝。',
  {
    target: z.string().min(1).max(64).describe('会话标识 group:123456 / private:7890'),
    stickerId: z.string().min(1).max(128).describe('表情标识，来自 sticker_list / sticker_find'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('可选：要引用的消息 id（非零整数，可为负数）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('可选：要 @ 的 QQ 号（仅群聊）')
  },
  async ({ target, stickerId, replyToMessageId, atUserId }) => {
    try {
      const data = await service.send({ target, stickerId, replyToMessageId, atUserId });
      return text({ ok: true, target: data.target, stickerId: data.stickerId, messageId: data.messageId });
    } catch (error) { return fail(error); }
  }
);

server.tool(
  'sticker_note',
  '记录这张表情的含义（note）、情绪 tags 和适用场景（usage）。这是本机记忆、跨会话复用，不会改 QQ 官方备注。联网新图必须先 sticker_preview 看过才能记；note/usage 各 ≤60 字，tags ≤6 个、每个 ≤12 字。',
  {
    stickerId: z.string().min(1).max(128).describe('表情标识'),
    note: z.string().min(1).max(60).describe('短梗意，如“猫猫得意偷笑”'),
    tags: z.array(z.string().max(12)).max(6).optional().describe('情绪/动作标签，如 ["得意","笑"]'),
    usage: z.string().max(60).optional().describe('适用场景，如“赢下比赛时接梗”'),
    target: z.string().optional().describe('可选：会话标识')
  },
  async ({ stickerId, note, tags, usage, target }) => {
    try {
      const data = await service.note({ stickerId, note, tags, usage, target });
      return text({ ok: true, ...data });
    } catch (error) { return fail(error); }
  }
);

server.tool(
  'sticker_collect',
  '把会话里别人发的一张表情收藏到 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用收到的消息 id；只能收藏别人发的图，不能收藏自己发的。图片由插件自己安全下载后再交给网关，不会让网关抓任意 URL。',
  {
    target: z.string().min(1).max(64).describe('会话标识 group:123456 / private:7890'),
    messageId: z.union([z.number(), z.string()]).describe('要收藏的那条消息的 id'),
    remark: z.string().max(50).optional().describe('可选：收藏表情的简短备注（超过配置里的 sticker.collect.maxRemarkChars 会被截断，实际写入值见返回值）')
  },
  async ({ target, messageId, remark }) => {
    try {
      const data = await service.collect({ target, messageId, remark });
      return text({ ok: true, emojiId: data.emojiId, remark: data.remark, label: data.entry?.localNote || data.entry?.desc || '' });
    } catch (error) { return fail(error); }
  }
);

if (config.sticker.remark.enabled === true) {
  server.tool(
    'sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（写操作，默认关闭）。一般应优先用 sticker_note 记本机理解，不要随意改动账号里的官方备注。',
    {
      stickerId: z.string().min(1).max(128).describe('表情标识，来自 sticker_list'),
      remark: z.string().max(50).describe('新的官方备注（≤50 字）')
    },
    async ({ stickerId, remark }) => {
      try {
        return text({ ok: true, ...(await service.remark({ stickerId, remark })) });
      } catch (error) { return fail(error); }
    }
  );
}

await server.connect(new StdioServerTransport());
console.error(`[qq-sticker] MCP server ready（配置：${configFile}，数据目录：${config.dataDir}）`);

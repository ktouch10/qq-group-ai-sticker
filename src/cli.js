#!/usr/bin/env node
// 命令行工具：不接 AI 也能直接验证整条链路（同步收藏、搜图、看图、发图、记含义）。
//
// 用法：qq-sticker [--config ./config.json] <命令> [...]
//   status                         显示数据目录、收藏数量、白名单与联网库状态
//   sync                           立即从网关同步收藏表情
//   list [--query 词] [--limit 12] 列出收藏表情
//   find <情绪词>                  找表情（收藏优先，其次联网库）
//   preview <id> [--out a.jpg]     生成一张预览图（动图三帧拼图）
//   send <group:123> <id>          发一张表情
//   note <id> <含义> [--tags a,b] [--usage 场景]
//   collect <group:123> <消息id> [--remark 备注]
//   prompt [--key group:123] [--out prompt.txt]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { StickerService } from './service.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[name] = next; i += 1; }
      else args[name] = true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const configFile = args.config && args.config !== true ? String(args.config) : (process.env.STICKER_CONFIG || path.resolve('config.json'));
const command = args._[0] || 'status';
const config = loadConfig(configFile);
// prompt 只读：它常被宿主的「拼提示词」流程顺手调用，不能和正在跑的 MCP 进程抢写同一个库文件。
const service = new StickerService(config, {
  ...(command === 'prompt' ? { writeStore: false } : {}),
  log: (message) => console.error(`[qq-sticker] ${message}`)
});

function out(value) {
  process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
}

try {
  switch (command) {
    case 'status':
      out(service.status());
      break;
    case 'sync': {
      const synced = await service.syncFavorites(true);
      out(synced ? { ok: true, syncedAt: synced.syncedAt, count: synced.entries.length } : { ok: false, note: '同步失败，详见日志；本地缓存仍可用' });
      break;
    }
    case 'list': {
      const data = await service.list({ query: args.query ?? '', limit: Number(args.limit) || 48, refresh: Boolean(args.refresh) });
      out(data);
      break;
    }
    case 'find': {
      const query = args._[1];
      if (!query) throw new Error('用法：find <1~16 字情绪/动作词>');
      out(await service.find({ query, target: args.target }));
      break;
    }
    case 'preview': {
      const stickerId = args._[1];
      if (!stickerId) throw new Error('用法：preview <id> [--out preview.jpg]');
      const data = await service.preview({ stickerId, target: args.target });
      if (args.out) {
        fs.writeFileSync(path.resolve(String(args.out)), Buffer.from(data.image.data, 'base64'));
        out({ ok: true, sticker: data.sticker, savedTo: path.resolve(String(args.out)) });
      } else {
        out({ ok: true, sticker: data.sticker, imageBase64Length: data.image.data.length, note: '加 --out 文件名 可保存到本地查看' });
      }
      break;
    }
    case 'send': {
      const target = args._[1], stickerId = args._[2];
      if (!target || !stickerId) throw new Error('用法：send <group:123|private:456> <id> [--reply 消息id] [--at QQ号]');
      out(await service.send({ target, stickerId, replyToMessageId: args.reply, atUserId: args.at }));
      break;
    }
    case 'note': {
      const stickerId = args._[1], note = args._[2];
      if (!stickerId || !note) throw new Error('用法：note <id> <含义> [--tags a,b] [--usage 场景]');
      out(await service.note({
        stickerId,
        note,
        tags: args.tags ? String(args.tags).split(/[,，]/) : undefined,
        usage: args.usage,
        target: args.target
      }));
      break;
    }
    case 'collect': {
      const target = args._[1], messageId = args._[2];
      if (!target || !messageId) throw new Error('用法：collect <group:123|private:456> <消息id> [--remark 备注]');
      out(await service.collect({ target, messageId, remark: args.remark }));
      break;
    }
    case 'prompt': {
      const block = await service.prompt({ key: args.key });
      if (args.out) {
        fs.writeFileSync(path.resolve(String(args.out)), block, 'utf8');
        out({ ok: true, savedTo: path.resolve(String(args.out)), chars: block.length });
      } else out(block || '（当前没有可注入的内容）');
      break;
    }
    default:
      throw new Error(`未知命令：${command}\n可用：status / sync / list / find / preview / send / note / collect / prompt`);
  }
} catch (error) {
  console.error(`失败：${error?.message ?? error}`);
  process.exitCode = 1;
}

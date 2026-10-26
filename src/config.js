// 配置读取：默认值 + 深合并 + 归一化。
//
// 原则：配置文件只描述「连哪个网关、允许发给谁、数据放哪」，
// 不在配置里出现任何凭据以外的私密信息；敏感项（accessToken）只从文件/环境变量读，不打印。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  onebot: {
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: ''
  },
  // 发送白名单：只有这里列出的群/私聊可以收到表情。空列表 + allowAllWhenEmpty=false 时谁都不能发。
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 数据目录（stickers.json / web-stickers.json / web-stickers-cache）。相对路径以配置文件所在目录为准。
  dataDir: './data',
  sticker: {
    enabled: true,
    // 收藏表情同步间隔；0 = 每次都同步
    syncTtlMs: 60000,
    // 单次向网关请求的收藏数量上限
    maxListCount: 100,
    web: {
      // 联网搜梗图（固定来源，受每小时/每天限额约束）
      enabled: true
    },
    send: {
      // 发图前的人为停顿，避免「文字刚发完图立刻跟上」的机械感
      minDelayMs: 800,
      maxDelayMs: 2000,
      // 同一个会话两张图之间的最小间隔
      cooldownMs: 20000,
      // 同一个会话每小时最多发几张
      maxPerHour: 40
    },
    collect: {
      maxRemarkChars: 20
    },
    remark: {
      // 修改 QQ 账号里收藏表情的官方备注：写操作，默认关闭
      enabled: false
    },
    preview: {
      // 看图（返回 JPEG 预览）默认开启；关掉后只能从收藏里挑，模型看不到新图
      enabled: true
    }
  }
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? merge(base[key], value) : value;
  }
  return out;
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => v !== null && v !== undefined)
    .map((v) => String(v).trim())
    .filter(Boolean);
}

/** 把任意来源的配置归一化成插件内部使用的形状。 */
export function normalizeConfig(raw = {}, { baseDir = process.cwd(), env = process.env } = {}) {
  const cfg = merge(DEFAULTS, raw);
  // 环境变量优先，方便不把 token 写进文件。
  if (env.ONEBOT_HTTP_URL) cfg.onebot.httpUrl = env.ONEBOT_HTTP_URL;
  if (env.ONEBOT_ACCESS_TOKEN !== undefined && env.ONEBOT_ACCESS_TOKEN !== '') cfg.onebot.accessToken = env.ONEBOT_ACCESS_TOKEN;
  if (!String(cfg.onebot.httpUrl || '').trim()) cfg.onebot.httpUrl = DEFAULTS.onebot.httpUrl;
  cfg.allow = { groups: idList(cfg.allow?.groups), private: idList(cfg.allow?.private) };
  cfg.deny = { groups: idList(cfg.deny?.groups), private: idList(cfg.deny?.private) };
  cfg.allowAllWhenEmpty = cfg.allowAllWhenEmpty === true;
  const dataDir = String(cfg.dataDir || DEFAULTS.dataDir).trim() || DEFAULTS.dataDir;
  cfg.dataDir = path.resolve(baseDir, dataDir);
  cfg.sticker.syncTtlMs = Math.max(0, Number(cfg.sticker.syncTtlMs) || 0);
  cfg.sticker.maxListCount = Math.min(500, Math.max(1, Number(cfg.sticker.maxListCount) || 100));
  const send = cfg.sticker.send;
  send.minDelayMs = Math.max(0, Number(send.minDelayMs) || 0);
  send.maxDelayMs = Math.max(send.minDelayMs, Number(send.maxDelayMs) || 0);
  send.cooldownMs = Math.max(0, Number(send.cooldownMs) || 0);
  send.maxPerHour = Math.max(1, Number(send.maxPerHour) || 40);
  cfg.sticker.collect.maxRemarkChars = Math.max(1, Number(cfg.sticker.collect.maxRemarkChars) || 20);
  return cfg;
}

/** 从文件加载配置；文件不存在时用默认值（此时只适合本机试用，发送会被白名单挡住）。 */
export function loadConfig(file, { env = process.env } = {}) {
  const resolved = path.resolve(file);
  let raw = {};
  try {
    let text = fs.readFileSync(resolved, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    raw = JSON.parse(text);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`配置文件读取失败（${resolved}）：${error?.message ?? error}`);
  }
  const cfg = normalizeConfig(raw, { baseDir: path.dirname(resolved), env });
  cfg.configFile = resolved;
  return cfg;
}

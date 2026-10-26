// 提示词层：把「有哪些表情 / 该怎么用 / 该不该现在发」拼成一段给模型看的资料。
//
// 这一层不调用任何工具，也不决定发不发 —— 只负责让模型在每一轮都能看到：
//   1) 表情包策略（说几句话配一张图，别刷图）
//   2) 手里有哪些表情（只列最常用的几个，完整列表靠 sticker_list）
//   3) 表情包节奏（连发了几条文字还没配图，该补一张了）
import { buildStickerContext, buildStickerStrategyHint } from './sticker-store.js';

const HOUR = 3600000;
const DEFAULTS = { afterTexts: 2, minGapMs: 2 * 60 * 1000, maxPerHour: 12 };

/**
 * 按会话记录「连发了几条文字还没配图」。
 *
 * 为什么要有节奏提示：模型默认只会「被问到才说话」，不会主动补表情；
 * 真人则是「说两三句顺手甩一张图」。这里只给软提示与软上限（每小时最多提示 N 次），
 * 发不发仍由模型按语境判断 —— 插件不做任何强制。
 */
export class StickerPace {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.sessions = new Map();
  }

  #of(key) {
    let p = this.sessions.get(key);
    if (!p) {
      p = { textSince: 0, lastStickerAt: 0, stickerTimes: [] };
      this.sessions.set(key, p);
    }
    if (!Array.isArray(p.stickerTimes)) p.stickerTimes = [];
    return p;
  }

  /** 发出一条文字后调用：累计「没配图的文字条数」。 */
  noteText(key) {
    this.#of(key).textSince += 1;
  }

  /** 成功发出一张表情后调用：清零累计，并记录时间用于软节流。 */
  noteSticker(key, at = Date.now()) {
    const p = this.#of(key);
    p.textSince = 0;
    p.lastStickerAt = at;
    p.stickerTimes = p.stickerTimes.filter((t) => Number(t) > at - HOUR);
    p.stickerTimes.push(at);
  }

  /** 生成注入提示：只在确实需要提醒时返回非空字符串。 */
  hint(key, { now = Date.now() } = {}) {
    const p = this.sessions.get(key);
    if (!p || p.textSince < this.options.afterTexts) return '';
    if (p.lastStickerAt && now - p.lastStickerAt < this.options.minGapMs) return '';
    const recent = (p.stickerTimes ?? []).filter((t) => Number(t) > now - HOUR).length;
    if (recent >= this.options.maxPerHour) return '';
    const gapMin = p.lastStickerAt ? Math.round((now - p.lastStickerAt) / 60000) : null;
    const gap = gapMin === null ? '这一轮还没发过图' : `上次发图 ${gapMin} 分钟前`;
    return `【表情包节奏】你已经连发 ${p.textSince} 条文字没配图了（${gap}）。真人这时候会甩一张图。如果语境合适——接梗、吐槽、赞同、无语、卖萌、打招呼、吃饭、睡觉、游戏——现在就从 sticker_list 或 sticker_find 里挑一张，直接 sticker_send 发出去：不发文字、一条一张、不连发两张。严肃话题、有人认真求助、正在争执时不发；没有合适的图就继续打字，不要硬凑。`;
  }

  snapshot(key, { now = Date.now() } = {}) {
    const p = this.sessions.get(key);
    if (!p) return { textSince: 0, lastStickerAt: 0, stickersLastHour: 0, hint: '' };
    return {
      textSince: p.textSince,
      lastStickerAt: p.lastStickerAt,
      stickersLastHour: (p.stickerTimes ?? []).filter((t) => Number(t) > now - HOUR).length,
      hint: this.hint(key, { now })
    };
  }

  reset(key) {
    if (key === undefined) this.sessions.clear();
    else this.sessions.delete(key);
  }
}

/**
 * 拼出一整段注入用的资料块。
 *
 * @param {object} options
 * @param {Array} options.entries 本地表情库（可传最近的同步结果）
 * @param {string} [options.key] 会话标识（群/私聊），用于节奏提示
 * @param {StickerPace} [options.pace] 节奏记录器
 * @param {boolean} [options.online] 是否启用联网搜图
 * @param {number} [options.max] 列表里最多展示几个表情
 * @returns {string} 可直接拼进系统提示词的文本；没有内容时返回空串
 */
export function buildStickerPrompt({ entries = [], key, pace, online = true, preview = true, max = 4 } = {}) {
  const parts = [];
  const context = buildStickerContext(entries, max);
  if (context) parts.push(context);
  parts.push(buildStickerStrategyHint(online, { preview }));
  if (key && pace) {
    const hint = pace.hint(key);
    if (hint) parts.push(hint);
  }
  return parts.join('\n');
}

// 表情包服务：把「收藏表情库 + 联网梗图库 + OneBot 网关」编排成插件对外的一组动作。
//
// 分层：
//   sticker-store.js   纯数据（本地库读写、合并、检索、认知字段）
//   web-stickers.js    联网搜图（固定来源、缓存、限额）
//   onebot.js          QQ 网关（发图、收藏、备注）
//   service.js（本文件）编排 + 权限/限流 + 发送前后的安全校验
//
// 安全边界（对宿主/模型承诺的部分）：
// - 发送、收藏、改备注都要先过白名单（allow.deny），不在白名单的会话一律拒绝；
// - 图片字节由本进程下载后转 base64 交给网关，绝不把 URL 交给网关去抓；
// - 表情备注是「跨会话共享」的文本，从读取到注入提示词全程单行化 + 明确标注为资料。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OneBotClient, parseTarget } from './onebot.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  applyStickerNote,
  markStickerUsed
} from './sticker-store.js';
import { createWebStickerLibrary, isWebStickerId } from './web-stickers.js';
import { createPreview } from './preview.js';
import { safeFetchBytes } from './safe-fetch.js';
import { SENSITIVE_RE } from './sensitive.js';
import { StickerPace, buildStickerPrompt } from './policy.js';

const BYTE_CACHE_TTL_MS = 10 * 60 * 1000;
const BYTE_CACHE_MAX = 20;

function randInt(min, max) {
  const lo = Math.ceil(min), hi = Math.floor(max);
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export class StickerService {
  constructor(config, deps = {}) {
    this.config = config;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = deps.log ?? (() => {});
    this.fetchBytes = deps.fetchBytes ?? safeFetchBytes;
    this.makePreview = deps.makePreview ?? createPreview;
    this.client = deps.client ?? new OneBotClient({ ...config.onebot });

    // 同一次进程启动内有效的随机会话标识：用来限制「看过的图」的许可范围。
    // 不持久化 —— 重启后未标注含义的联网新图需要重新看一遍。
    this.sessionToken = deps.sessionToken ?? crypto.randomBytes(8).toString('hex');

    this.dataDir = config.dataDir;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.stickersFile = path.join(this.dataDir, 'stickers.json');

    this.entries = [];
    this.storeWritable = true;
    try {
      this.entries = loadStickerStore(this.stickersFile);
    } catch (error) {
      this.storeWritable = false; // 读坏了就绝不回写，避免把「损坏」当成「空库」落盘
      this.log(`表情库读取失败，本次以只读方式运行：${error?.message ?? error}`);
    }
    this.syncedAt = 0;

    this.webLibrary = config.sticker.enabled && config.sticker.web?.enabled
      ? createWebStickerLibrary({
          root: this.dataDir,
          fetchBytes: this.fetchBytes,
          makePreview: this.makePreview,
          now: this.now
        })
      : null;

    this.pace = deps.pace ?? new StickerPace(deps.paceOptions);
    this.sendTimes = new Map(); // key -> number[]
    this.byteCache = new Map(); // stickerId -> { buffer, at }
  }

  // ── 基础 ────────────────────────────────────────────────────────────────

  assertStickerEnabled() {
    if (this.config.sticker.enabled === false) throw new Error('表情包功能已在配置里关闭（sticker.enabled=false）');
  }

  saveStore() {
    if (!this.storeWritable) return false;
    try {
      saveStickerStore(this.stickersFile, this.entries);
      return true;
    } catch (error) {
      this.log(`保存表情库失败：${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 判断一个会话是否允许被操作。
   * deny 优先于 allow；allow 为空时按 allowAllWhenEmpty 决定（默认谁都不许）。
   */
  assertAllowed(target, action = '操作') {
    const { kind, id, key } = parseTarget(target);
    const list = kind === 'group' ? this.config.allow.groups : this.config.allow.private;
    const denyList = kind === 'group' ? this.config.deny.groups : this.config.deny.private;
    if (denyList.includes(id)) throw new Error(`${action}被拒绝：${key} 在 deny 名单里`);
    if (list.length > 0 && !list.includes(id)) {
      throw new Error(`${action}被拒绝：${key} 不在 allow 白名单里（改配置里的 allow.${kind === 'group' ? 'groups' : 'private'} 后重试）`);
    }
    if (list.length === 0 && !this.config.allowAllWhenEmpty) {
      throw new Error(`${action}被拒绝：allow 白名单为空，插件默认不允许向任何会话发送（确认风险后可在配置里设 allowAllWhenEmpty=true）`);
    }
    return { kind, id, key };
  }

  /** 同一个会话的发送限流：最小间隔 + 每小时上限。 */
  assertSendBudget(key) {
    const now = this.now();
    const { cooldownMs, maxPerHour } = this.config.sticker.send;
    const times = (this.sendTimes.get(key) ?? []).filter((t) => t > now - 60 * 60 * 1000);
    const last = times[times.length - 1] ?? 0;
    if (last && now - last < cooldownMs) {
      const wait = Math.ceil((cooldownMs - (now - last)) / 1000);
      throw new Error(`发送太频繁：${key} 距上一条表情不到 ${Math.round(cooldownMs / 1000)} 秒，请 ${wait} 秒后再发`);
    }
    if (times.length >= maxPerHour) {
      throw new Error(`${key} 这一小时已经发过 ${times.length} 张表情，达到上限；先用文字聊天`);
    }
    return times;
  }

  recordSend(key) {
    const now = this.now();
    const times = (this.sendTimes.get(key) ?? []).filter((t) => t > now - 60 * 60 * 1000);
    times.push(now);
    this.sendTimes.set(key, times);
  }

  // ── QQ 收藏表情 ─────────────────────────────────────────────────────────

  /**
   * 从网关同步收藏表情并合并进本地库。
   * 失败时返回 null（调用方决定用缓存还是报错），绝不用空数组清空本地库。
   */
  async syncFavorites(force = false) {
    if (this.config.sticker.enabled === false) return null;
    const ttl = this.config.sticker.syncTtlMs;
    if (!force && this.syncedAt && this.now() - this.syncedAt < ttl) {
      return { entries: this.entries, syncedAt: this.syncedAt, fromCache: true };
    }
    try {
      const fetched = await this.client.fetchCustomFaces(this.config.sticker.maxListCount);
      this.entries = mergeStickerLibrary(this.entries, fetched, { complete: fetched.length < this.config.sticker.maxListCount });
      this.syncedAt = this.now();
      this.saveStore();
      this.log(`已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${this.entries.length} 条）`);
      return { entries: this.entries, syncedAt: this.syncedAt, fromCache: false };
    } catch (error) {
      this.log(`同步收藏表情失败：${error?.message ?? error}`);
      return null;
    }
  }

  /** 列出收藏表情（可按备注/标签/用途过滤）。 */
  async list({ query = '', limit = 48, refresh = false, sync = true } = {}) {
    this.assertStickerEnabled();
    if (sync) await this.syncFavorites(refresh);
    return formatStickerList(this.entries, query, limit);
  }

  /** 下载并缓存一个收藏表情的原始字节（发图/看图都用它）。 */
  async bytesOf(entry) {
    const hit = this.byteCache.get(entry.id);
    if (hit && this.now() - hit.at < BYTE_CACHE_TTL_MS) return hit.buffer;
    if (!entry.url) throw new Error(`表情 ${entry.id} 没有可下载的图片地址`);
    const { buffer } = await this.fetchBytes(entry.url, 4 * 1024 * 1024, { timeoutMs: 12000 });
    if (this.byteCache.size >= BYTE_CACHE_MAX) {
      const oldest = [...this.byteCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.byteCache.delete(oldest[0]);
    }
    this.byteCache.set(entry.id, { buffer, at: this.now() });
    return buffer;
  }

  // ── 搜索 / 看图 / 记录含义 ──────────────────────────────────────────────

  /**
   * 找表情：先看 QQ 收藏，再看联网梗图库。
   * 返回值只含短文字候选（不含 URL），由模型决定用哪一张。
   */
  async find({ query, target, owner } = {}) {
    this.assertStickerEnabled();
    const q = String(query ?? '').trim();
    if (!q) throw new Error('需要一个 1~16 字的情绪/动作词，例如“开心”“猫猫无语”');
    const scope = target ? parseTarget(target).key : (owner || 'local');
    // 收藏表情优先：命中就不用联网，也更快。
    await this.syncFavorites(false);
    const local = formatStickerList(this.entries, q, 3);
    if (local.matched > 0) {
      return {
        source: 'favorites',
        stickers: local.stickers.map((e) => ({
          id: e.id,
          label: e.localNote || e.desc || '（无备注，可先看图）',
          tags: (e.tags || []).slice(0, 3),
          needsPreview: !(e.localNote || e.desc)
        }))
      };
    }
    if (!this.webLibrary) {
      return { source: 'disabled', stickers: [], note: '联网搜图已关闭，且收藏里没有匹配的表情；换一个词或用文字回复' };
    }
    return this.webLibrary.find(q, { owner: scope });
  }

  /** 看图：返回一张 JPEG 预览（动图取三帧拼图），供多模态模型理解梗意。 */
  async preview({ stickerId, target, owner } = {}) {
    this.assertStickerEnabled();
    if (this.config.sticker.preview.enabled === false) throw new Error('看图功能已在配置里关闭（sticker.preview.enabled=false）');
    const id = String(stickerId ?? '').trim();
    if (!id) throw new Error('缺少 stickerId');
    const scope = target ? parseTarget(target).key : (owner || 'local');
    if (isWebStickerId(id)) {
      if (!this.webLibrary) throw new Error('联网搜图已关闭，这张图不可用');
      return this.webLibrary.preview(id, { owner: scope, token: this.sessionToken });
    }
    const entry = await this.resolveFavorite(id);
    const buffer = await this.bytesOf(entry);
    const jpeg = await this.makePreview(buffer, {});
    return {
      sticker: {
        id: entry.id,
        label: entry.localNote || entry.desc || '（无备注）',
        tags: (entry.tags || []).slice(0, 3),
        source: 'qq',
        needsPreview: false
      },
      image: { mimeType: 'image/jpeg', data: jpeg.toString('base64') }
    };
  }

  /** 记录这张表情的含义 / 情绪标签 / 适用场景（跨会话共享，重启后仍在）。 */
  async note({ stickerId, note, tags, usage, target, owner } = {}) {
    this.assertStickerEnabled();
    const id = String(stickerId ?? '').trim();
    if (!id) throw new Error('缺少 stickerId');
    const scope = target ? parseTarget(target).key : (owner || 'local');
    if (isWebStickerId(id)) {
      if (!this.webLibrary) throw new Error('联网搜图已关闭，这张图不可用');
      return this.webLibrary.note(id, { note, tags, usage }, { owner: scope, token: this.sessionToken });
    }
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const text = [patch.note, patch.usage, ...(Array.isArray(patch.tags) ? patch.tags : [])].filter(Boolean).join(' ');
    if (text && SENSITIVE_RE.test(text)) throw new Error('表情备注不能包含本机路径或凭据');
    let updated = applyStickerNote(this.entries, id, patch);
    if (!updated.entry) {
      // 本地还没同步过（或收藏是刚加的）：同步一次再试，避免模型拿到「找不到」而放弃记录。
      await this.syncFavorites(true);
      updated = applyStickerNote(this.entries, id, patch);
    }
    if (!updated.entry) throw new Error(`找不到表情 ${id}，请先用 sticker_list 获取有效 id`);
    this.entries = updated.entries;
    this.saveStore();
    return { id: updated.entry.id, label: updated.entry.localNote || updated.entry.desc, tags: updated.entry.tags, usage: updated.entry.usage };
  }

  // ── 发送 ────────────────────────────────────────────────────────────────

  async resolveFavorite(stickerId) {
    const id = String(stickerId ?? '').trim();
    let entry = findSticker(this.entries, id);
    if (!entry) {
      // 收藏可能在会话过程中新增：强制同步一次再找。
      await this.syncFavorites(true);
      entry = findSticker(this.entries, id);
    }
    if (!entry) throw new Error(`找不到表情 ${id}，请先用 sticker_list / sticker_find 获取有效 id`);
    return entry;
  }

  /**
   * 发一张表情。
   *
   * 顺序上刻意是「先校验权限 → 再下载 → 再人为停顿 → 最后才出站」：
   * 漫长下载期间如果白名单/开关被改，会在出站前再次校验，避免延迟发出的越权消息。
   */
  async send({ target, stickerId, replyToMessageId, atUserId } = {}) {
    this.assertStickerEnabled();
    const { key } = this.assertAllowed(target, '发表情');
    this.assertSendBudget(key);
    const id = String(stickerId ?? '').trim();
    if (!id) throw new Error('缺少 stickerId');

    let buffer, entry;
    if (isWebStickerId(id)) {
      if (!this.webLibrary) throw new Error('联网搜图已关闭，这张图不可用');
      const image = await this.webLibrary.image(id, { owner: key, token: this.sessionToken });
      buffer = image.buffer;
      entry = image.entry;
    } else {
      await this.syncFavorites(true);
      entry = await this.resolveFavorite(id);
      buffer = await this.bytesOf(entry);
    }

    const { minDelayMs, maxDelayMs } = this.config.sticker.send;
    if (maxDelayMs > 0) await this.sleep(randInt(minDelayMs, maxDelayMs));
    // 出站前再校验一次：下载+延迟期间配置可能已经变了。
    this.assertAllowed(target, '发表情');

    const data = await this.client.sendImage({ target: key, buffer, replyToMessageId, atUserId });
    this.recordSend(key);
    this.pace.noteSticker(key);
    if (isWebStickerId(id)) this.webLibrary.used(id);
    else {
      const updated = markStickerUsed(this.entries, entry.id, 'sticker');
      this.entries = updated.entries;
      this.saveStore();
    }
    return { target: key, stickerId: id, messageId: data?.message_id ?? null };
  }

  // ── 收藏群友的表情 ──────────────────────────────────────────────────────

  /** 从一条消息里取第一张图的 URL（OneBot v11 的 image 段）。 */
  #firstImageUrl(message) {
    const segments = Array.isArray(message) ? message : [];
    for (const segment of segments) {
      if (segment?.type !== 'image') continue;
      const data = segment.data ?? {};
      const url = String(data.url || data.file || '').trim();
      if (/^https?:\/\//i.test(url)) return url;
    }
    return '';
  }

  /**
   * 把会话里别人发的一张表情收藏到 QQ 账号。
   * 图片由本进程下载（SSRF 防护）后以 base64 交给网关；不让网关去抓消息里的 URL。
   */
  async collect({ target, messageId, remark } = {}) {
    this.assertStickerEnabled();
    const { key } = this.assertAllowed(target, '收藏表情');
    const mid = String(messageId ?? '').trim();
    if (!/^-?[1-9]\d*$/.test(mid)) throw new Error('messageId 必须是消息 id（非零整数）');
    const message = await this.client.getMsg(mid);
    if (message?.sender?.user_id && message?.self_id && Number(message.sender.user_id) === Number(message.self_id)) {
      throw new Error('不能收藏自己发的表情，只能收藏别人发的');
    }
    const url = this.#firstImageUrl(message?.message);
    if (!url) throw new Error('这条消息里没有可收藏的图片/表情');
    const { buffer } = await this.fetchBytes(url, 4 * 1024 * 1024, { timeoutMs: 12000 });
    this.assertAllowed(target, '收藏表情');
    const added = await this.client.addCustomFace('base64://' + buffer.toString('base64'));
    const emojiId = String(added?.emoji_id ?? '');
    if (!emojiId) throw new Error('add_custom_face 没有返回 emoji_id，收藏可能失败');
    const cleanRemark = String(remark ?? '').trim().slice(0, this.config.sticker.collect.maxRemarkChars);
    if (cleanRemark) {
      if (SENSITIVE_RE.test(cleanRemark)) throw new Error('备注不能包含本机路径或凭据');
      try {
        await this.client.modifyCustomFace(emojiId, cleanRemark);
      } catch (error) {
        this.log(`收藏成功但写备注失败（${emojiId}）：${error?.message ?? error}`);
      }
    }
    await this.syncFavorites(true);
    return { emojiId, remark: cleanRemark, entry: findSticker(this.entries, emojiId) ?? null, target: key };
  }

  // ── 修改收藏表情的官方备注（默认关闭） ──────────────────────────────────

  async remark({ stickerId, remark } = {}) {
    this.assertStickerEnabled();
    if (this.config.sticker.remark.enabled !== true) {
      throw new Error('修改收藏表情的官方备注是写操作，默认关闭；确认需要后把配置里的 sticker.remark.enabled 设为 true');
    }
    const entry = await this.resolveFavorite(stickerId);
    const clean = String(remark ?? '').trim().slice(0, 50);
    if (SENSITIVE_RE.test(clean)) throw new Error('备注不能包含本机路径或凭据');
    await this.client.modifyCustomFace(entry.id, clean);
    const idx = this.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      this.entries[idx] = { ...this.entries[idx], desc: clean, updatedAt: new Date().toISOString() };
      this.saveStore();
    }
    return { id: entry.id, desc: clean };
  }

  // ── 提示词 / 状态 ───────────────────────────────────────────────────────

  /** 拼一段可以塞进系统提示词的资料（可用表情 + 策略 + 节奏）。 */
  async prompt({ key, max = 8 } = {}) {
    if (this.config.sticker.enabled === false) return '';
    if (this.entries.length === 0) await this.syncFavorites(false);
    return buildStickerPrompt({
      entries: this.entries,
      key,
      pace: this.pace,
      online: Boolean(this.webLibrary),
      max
    });
  }

  /** 记录一条已经发出去的文字（供节奏提示用）。 */
  noteTextSent(key) {
    if (key) this.pace.noteText(key);
  }

  status() {
    return {
      dataDir: this.dataDir,
      stickerCount: this.entries.length,
      storeWritable: this.storeWritable,
      syncedAt: this.syncedAt,
      web: this.webLibrary ? this.webLibrary.summary() : { enabled: false },
      allow: this.config.allow,
      deny: this.config.deny,
      allowAllWhenEmpty: this.config.allowAllWhenEmpty,
      remarkEnabled: this.config.sticker.remark.enabled === true
    };
  }
}

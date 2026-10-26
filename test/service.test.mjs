import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StickerService } from '../src/service.js';
import { normalizeConfig } from '../src/config.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const imageUrl = (n) => 'https://www.dogetu.com/data/doutula/' + n.toString(16).padStart(32, '0') + '.png';
const searchHtml = (q = '开心') => '<div class="pic-list">' + [1, 2, 3, 4].map((n) => '<img src="' + imageUrl(n) + '" title="' + q + '">').join('') + '</div>';

class FakeClient {
  constructor() {
    this.faces = [
      { emoji_id: 'a', resId: 'a', url: 'https://cdn.example.com/a.png', md5: 'AA', desc: '笑死' },
      { emoji_id: 'b', resId: 'b', url: 'https://cdn.example.com/b.png', md5: 'BB', desc: '' }
    ];
    this.sent = [];
    this.added = [];
    this.modified = [];
    this.msg = null;
    this.failFetch = false;
    this.botId = 1;
    this.fetchCalls = 0;
  }
  async fetchCustomFaces() {
    this.fetchCalls += 1;
    if (this.failFetch) throw new Error('gateway down');
    return this.faces;
  }
  async getLoginInfo() { return { user_id: this.botId }; }
  async sendImage(args) { this.sent.push(args); return { message_id: 900 + this.sent.length }; }
  async addCustomFace(file) { this.added.push(file); return { emoji_id: 'new1', desc: '' }; }
  async modifyCustomFace(id, desc) { this.modified.push({ id, desc }); return {}; }
  async getMsg() { return this.msg; }
}

function setup(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-svc-'));
  const config = normalizeConfig(
    {
      allow: { groups: ['123'], private: ['456'] },
      dataDir,
      sticker: {
        send: { minDelayMs: 0, maxDelayMs: 0, cooldownMs: 0, maxPerHour: 40 },
        ...(overrides.sticker || {})
      },
      ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'sticker'))
    },
    { baseDir: dataDir, env: {} }
  );
  const client = new FakeClient();
  const calls = [];
  const fetchText = async (url) => { calls.push({ kind: 'text', url }); return { body: searchHtml() }; };
  const fetchBytes = async (url) => { calls.push({ kind: 'image', url }); return { buffer: PNG }; };
  const service = new StickerService(config, { client, fetchText, fetchBytes, makePreview: async () => JPEG, sleep: async () => {}, log: () => {} });
  return { service, client, config, dataDir, calls, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('白名单：未列出的会话、deny 优先、空白名单默认拒绝', async () => {
  const { service, cleanup } = setup();
  try {
    await assert.rejects(service.send({ target: 'group:999', stickerId: 'a' }), /不在 allow 白名单/);
    await assert.rejects(service.send({ target: 'private:999', stickerId: 'a' }), /不在 allow 白名单/);
    const denied = setup({ deny: { groups: ['123'], private: [] } });
    try {
      await assert.rejects(denied.service.send({ target: 'group:123', stickerId: 'a' }), /deny/);
    } finally { denied.cleanup(); }
    const empty = setup({ allow: { groups: [], private: [] }, allowAllWhenEmpty: false });
    try {
      await assert.rejects(empty.service.send({ target: 'group:123', stickerId: 'a' }), /allow 白名单为空/);
    } finally { empty.cleanup(); }
  } finally { cleanup(); }
});

test('发送收藏表情：一条 base64 图消息、下发目标是会话 key、并记录使用次数', async () => {
  const { service, client, dataDir, cleanup } = setup();
  try {
    const result = await service.send({ target: 'group:123', stickerId: 'a', replyToMessageId: -5 });
    assert.equal(result.messageId, 901);
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].target, 'group:123');
    assert.equal(client.sent[0].replyToMessageId, -5);
    assert.deepEqual(client.sent[0].buffer, PNG);
    const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'stickers.json'), 'utf8'));
    const entry = store.find((e) => e.id === 'a');
    assert.equal(entry.useCount, 1);
  } finally { cleanup(); }
});

test('发送限流：最小间隔与每小时上限', async () => {
  const cool = setup({ sticker: { send: { minDelayMs: 0, maxDelayMs: 0, cooldownMs: 60000, maxPerHour: 40 } } });
  try {
    await cool.service.send({ target: 'group:123', stickerId: 'a' });
    await assert.rejects(cool.service.send({ target: 'group:123', stickerId: 'a' }), /太频繁/);
  } finally { cool.cleanup(); }
  const cap = setup({ sticker: { send: { minDelayMs: 0, maxDelayMs: 0, cooldownMs: 0, maxPerHour: 1 } } });
  try {
    await cap.service.send({ target: 'group:123', stickerId: 'a' });
    await assert.rejects(cap.service.send({ target: 'group:123', stickerId: 'a' }), /达到上限/);
  } finally { cap.cleanup(); }
});

test('联网新图：必须先看图才能发送，看过之后可发', async () => {
  const { service, client, cleanup } = setup();
  try {
    const found = await service.find({ query: '开心', target: 'group:123' });
    assert.equal(found.source, 'web');
    const id = found.stickers[0].id;
    await assert.rejects(service.send({ target: 'group:123', stickerId: id }), /sticker_preview/);
    const preview = await service.preview({ stickerId: id, target: 'group:123' });
    assert.equal(preview.image.mimeType, 'image/jpeg');
    const sent = await service.send({ target: 'group:123', stickerId: id });
    assert.equal(sent.stickerId, id);
    assert.equal(client.sent.length, 1);
  } finally { cleanup(); }
});

test('记录的含义落盘，重启后仍在（跨会话复用）', async () => {
  const { service, config, dataDir, cleanup } = setup();
  try {
    const noted = await service.note({ stickerId: 'a', note: '嘲讽用', tags: ['怼人'], usage: '别人犯蠢时' });
    assert.equal(noted.label, '嘲讽用');
    const again = new StickerService(config, { client: new FakeClient(), fetchBytes: async () => ({ buffer: PNG }), makePreview: async () => JPEG, sleep: async () => {}, log: () => {} });
    const list = await again.list({ query: '怼人' });
    assert.equal(list.matched, 1);
    assert.equal(list.stickers[0].localNote, '嘲讽用');
    assert.ok(fs.existsSync(path.join(dataDir, 'stickers.json')));
  } finally { cleanup(); }
});

test('收藏别人的表情：自己下载后 base64 上传，可写备注；不能收藏自己发的', async () => {
  const { service, client, cleanup } = setup();
  try {
    client.msg = { self_id: 1, message_type: 'group', group_id: 123, sender: { user_id: 2 }, message: [{ type: 'image', data: { url: 'https://cdn.example.com/x.png' } }] };
    const result = await service.collect({ target: 'group:123', messageId: 77, remark: '好图偷了' });
    assert.equal(result.emojiId, 'new1');
    assert.equal(client.added.length, 1);
    assert.equal(client.added[0], 'base64://' + PNG.toString('base64'));
    assert.deepEqual(client.modified[0], { id: 'new1', desc: '好图偷了' });

    client.msg = { self_id: 1, message_type: 'group', group_id: 123, sender: { user_id: 1 }, message: [{ type: 'image', data: { url: 'https://cdn.example.com/x.png' } }] };
    await assert.rejects(service.collect({ target: 'group:123', messageId: 78 }), /自己发的/);

    client.msg = { self_id: 1, message_type: 'group', group_id: 123, sender: { user_id: 2 }, message: [{ type: 'text', data: { text: 'hi' } }] };
    await assert.rejects(service.collect({ target: 'group:123', messageId: 79 }), /没有可收藏/);
    await assert.rejects(service.collect({ target: 'group:999', messageId: 80 }), /白名单/);
  } finally { cleanup(); }
});

test('跨会话收藏被拒绝：get_msg 能读任意消息，但必须属于目标会话', async () => {
  const { service, client, cleanup } = setup();
  try {
    // 白名单里的群 123，但拿到的是一条属于群 999 的消息
    client.msg = { self_id: 1, message_type: 'group', group_id: 999, sender: { user_id: 2 }, message: [{ type: 'image', data: { url: 'https://cdn.example.com/x.png' } }] };
    await assert.rejects(service.collect({ target: 'group:123', messageId: 88 }), /不属于/);
    assert.equal(client.added.length, 0);
    // 私聊：拿群消息 / 别人的私聊都拒绝
    client.msg = { self_id: 1, message_type: 'group', group_id: 123, sender: { user_id: 2 }, message: [{ type: 'image', data: { url: 'https://cdn.example.com/x.png' } }] };
    await assert.rejects(service.collect({ target: 'private:456', messageId: 89 }), /不属于/);
    client.msg = { self_id: 1, message_type: 'private', sender: { user_id: 777 }, message: [{ type: 'image', data: { url: 'https://cdn.example.com/x.png' } }] };
    await assert.rejects(service.collect({ target: 'private:456', messageId: 90 }), /不属于/);
    // 私聊对端发来的图可以收藏
    client.msg = { self_id: 1, message_type: 'private', sender: { user_id: 456 }, message: [{ type: 'image', data: { url: 'https://cdn.example.com/x.png' } }] };
    assert.equal((await service.collect({ target: 'private:456', messageId: 91 })).emojiId, 'new1');
  } finally { cleanup(); }
});

test('并发发送时预算只放行一个（预占名额，不是发完才记账）', async () => {
  const { service, client, cleanup } = setup({ sticker: { send: { minDelayMs: 0, maxDelayMs: 0, cooldownMs: 60000, maxPerHour: 1 } } });
  try {
    const results = await Promise.allSettled([
      service.send({ target: 'group:123', stickerId: 'a' }),
      service.send({ target: 'group:123', stickerId: 'b' })
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(client.sent.length, 1, '同时发两张时必须只出去一张');
  } finally { cleanup(); }
});

test('发送失败会回滚预算，不会把额度白吃掉', async () => {
  const { service, client, cleanup } = setup({ sticker: { send: { minDelayMs: 0, maxDelayMs: 0, cooldownMs: 60000, maxPerHour: 1 } } });
  try {
    await assert.rejects(service.send({ target: 'group:123', stickerId: '不存在的表情' }), /找不到表情/);
    assert.equal(client.sent.length, 0);
    const ok = await service.send({ target: 'group:123', stickerId: 'a' });
    assert.ok(ok.messageId);
    assert.equal(client.sent.length, 1);
  } finally { cleanup(); }
});

test('网关返回空收藏列表时不清空本地已有表情（坏响应不能抹掉 AI 记忆）', async () => {
  const { service, client, cleanup } = setup();
  try {
    await service.syncFavorites(true);
    const before = (await service.list({})).total;
    assert.ok(before > 0);
    client.faces = [];
    await service.syncFavorites(true);
    assert.equal((await service.list({})).total, before);
  } finally { cleanup(); }
});

test('发送成功后统计失败不报错（否则调用方会重发一张）', async () => {
  const { service, client, cleanup } = setup();
  try {
    await service.syncFavorites(true);
    // 模拟统计数据落盘失败
    service.saveStore = () => { throw new Error('disk full'); };
    const sent = await service.send({ target: 'group:123', stickerId: 'a' });
    assert.equal(sent.messageId, 901);
    assert.equal(client.sent.length, 1);
  } finally { cleanup(); }
});

test('提示词：包含可用表情与策略，连发文字后出现节奏提示', async () => {
  const { service, cleanup } = setup();
  try {
    await service.syncFavorites(true);
    const plain = await service.prompt({ key: 'group:123' });
    assert.match(plain, /可用表情包/);
    assert.match(plain, /表情包策略/);
    assert.match(plain, /sticker_send/);
    assert.doesNotMatch(plain, /表情包节奏/);
    service.noteTextSent('group:123');
    service.noteTextSent('group:123');
    const paced = await service.prompt({ key: 'group:123' });
    assert.match(paced, /表情包节奏/);
    const sent = await service.send({ target: 'group:123', stickerId: 'a' });
    assert.ok(sent.messageId);
    assert.doesNotMatch(await service.prompt({ key: 'group:123' }), /表情包节奏/, '发图后节奏计数应清零');
  } finally { cleanup(); }
});

test('收藏表情库损坏时只读运行，不覆盖损坏文件，写操作如实报错', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-corrupt-'));
  const file = path.join(dataDir, 'stickers.json');
  fs.writeFileSync(file, '{broken');
  const config = normalizeConfig({ allow: { groups: ['123'] }, dataDir }, { baseDir: dataDir, env: {} });
  const service = new StickerService(config, { client: new FakeClient(), fetchText: async () => ({ body: searchHtml() }), fetchBytes: async () => ({ buffer: PNG }), makePreview: async () => JPEG, sleep: async () => {}, log: () => {} });
  try {
    assert.equal(service.status().storeWritable, false);
    await service.syncFavorites(true);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    // 只读时不能「假装保存成功」：否则调用方以为记下来了，重启后全丢。
    await assert.rejects(service.note({ stickerId: 'a', note: '嘲讽用' }), /只读模式/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('网关同步失败时继续用本地缓存', async () => {
  const { service, client, cleanup } = setup();
  try {
    await service.syncFavorites(true);
    client.failFetch = true;
    const list = await service.list({ query: '笑死' });
    assert.equal(list.matched, 1);
  } finally { cleanup(); }
});

test('冷却从「真实发出时刻」算，而不是从开始下载那一刻算', async () => {
  // 用可控时钟 + 会推进时钟的 sleep 模拟「下载+停顿花了 2 秒」
  let clock = 1700000000000;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-clock-'));
  const config = normalizeConfig({ allow: { groups: ['123'] }, dataDir, sticker: { send: { minDelayMs: 2000, maxDelayMs: 2000, cooldownMs: 20000, maxPerHour: 40 } } }, { baseDir: dataDir, env: {} });
  const client = new FakeClient();
  const service = new StickerService(config, {
    client,
    fetchText: async () => ({ body: searchHtml() }),
    fetchBytes: async () => ({ buffer: PNG }),
    makePreview: async () => JPEG,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: () => {}
  });
  try {
    await service.send({ target: 'group:123', stickerId: 'a' }); // 预占 t0，真实发出 t0+2000
    clock = 1700000000000 + 21000; // 距离预占 21 秒、距离真实发出 19 秒
    await assert.rejects(service.send({ target: 'group:123', stickerId: 'a' }), /太频繁/);
    clock = 1700000000000 + 23000; // 距离真实发出 21 秒
    assert.ok((await service.send({ target: 'group:123', stickerId: 'a' })).messageId);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('收藏备注在做任何账号写操作之前就校验', async () => {
  const { service, client, cleanup } = setup();
  try {
    client.msg = { self_id: 1, message_type: 'group', group_id: 123, sender: { user_id: 2 }, message: [{ type: 'image', data: { url: 'https://cdn.example.com/x.png' } }] };
    await assert.rejects(service.collect({ target: 'group:123', messageId: 77, remark: 'C:\secret\token' }), /本机路径或凭据/);
    assert.equal(client.added.length, 0, '备注非法时不应该先执行 add_custom_face');
  } finally { cleanup(); }
});

test('识别「自己发的」不依赖 self_id（标准 OneBot get_msg 不返回它）', async () => {
  const { service, client, cleanup } = setup();
  try {
    client.botId = 999;
    client.msg = { message_type: 'group', group_id: 123, sender: { user_id: 999 }, message: [{ type: 'image', data: { url: 'https://cdn.example.com/x.png' } }] };
    await assert.rejects(service.collect({ target: 'group:123', messageId: 66 }), /自己发的/);
    assert.equal(client.added.length, 0);
  } finally { cleanup(); }
});

test('强制同步有节流：连续用不存在的 id 不会反复打网关', async () => {
  const { service, client, cleanup } = setup();
  try {
    await service.syncFavorites(true);
    const base = client.fetchCalls;
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(service.send({ target: 'group:123', stickerId: '不存在' + i }), /找不到表情/);
    }
    assert.ok(client.fetchCalls - base <= 1, `连续 3 次失败最多只应同步 1 次，实际 ${client.fetchCalls - base}`);
  } finally { cleanup(); }
});

test('改官方备注：必须带 target 且过白名单；只读模式下先拒绝再动账号', async () => {
  const { service, client, cleanup } = setup({ sticker: { remark: { enabled: true } } });
  try {
    await service.syncFavorites(true);
    await assert.rejects(service.remark({ stickerId: 'a', remark: '新备注' }), /会话标识/);
    await assert.rejects(service.remark({ target: 'group:999', stickerId: 'a', remark: '新备注' }), /白名单/);
    assert.equal(client.modified.length, 0);
    const ok = await service.remark({ target: 'group:123', stickerId: 'a', remark: '新备注' });
    assert.equal(ok.localSaved, true);
    assert.deepEqual(client.modified[0], { id: 'a', desc: '新备注' });
  } finally { cleanup(); }

  // 只读模式：不能先改账号再报错
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-ro-'));
  fs.writeFileSync(path.join(dataDir, 'stickers.json'), '{broken');
  const config = normalizeConfig({ allow: { groups: ['123'] }, dataDir, sticker: { remark: { enabled: true } } }, { baseDir: dataDir, env: {} });
  const client2 = new FakeClient();
  const svc = new StickerService(config, { client: client2, fetchText: async () => ({ body: searchHtml() }), fetchBytes: async () => ({ buffer: PNG }), makePreview: async () => JPEG, sleep: async () => {}, log: () => {} });
  try {
    await svc.syncFavorites(true);
    await assert.rejects(svc.remark({ target: 'group:123', stickerId: 'a', remark: '新备注' }), /只读模式/);
    assert.equal(client2.modified.length, 0);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('看图关闭时联网搜图也一起关闭（不再返回看不了也发不了的候选）', async () => {
  const { service, cleanup } = setup({ sticker: { preview: { enabled: false } } });
  try {
    const found = await service.find({ query: '开心', target: 'group:123' });
    assert.equal(found.source, 'disabled');
    assert.equal(found.stickers.length, 0);
    const prompt = await service.prompt({ key: 'group:123' });
    assert.doesNotMatch(prompt, /sticker_preview 看一张/);
  } finally { cleanup(); }
});

test('writeStore=false 时只读运行，不回写 stickers.json（供宿主拼提示词用）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-ro2-'));
  const config = normalizeConfig({ allow: { groups: ['123'] }, dataDir }, { baseDir: dataDir, env: {} });
  const client = new FakeClient();
  const svc = new StickerService(config, { client, writeStore: false, fetchText: async () => ({ body: searchHtml() }), fetchBytes: async () => ({ buffer: PNG }), makePreview: async () => JPEG, sleep: async () => {}, log: () => {} });
  try {
    const prompt = await svc.prompt({ key: 'group:123' });
    assert.match(prompt, /可用表情包/);
    assert.equal(fs.existsSync(path.join(dataDir, 'stickers.json')), false, '只读实例不应创建/改写库文件');
    assert.equal(svc.status().storeWritable, false);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

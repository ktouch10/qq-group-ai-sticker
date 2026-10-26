import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWebStickerLibrary, parseExpressionResults, expressionKeyword } from '../src/web-stickers.js';
import { createPreview } from '../src/preview.js';

// 用 sharp 现场生成一张合法的小 PNG：手写的 1×1 占位图 sharp 解码会失败，
// 而这里要真的走一次预览生成，所以必须是能解码的真图。
const { default: sharp } = await import('sharp');
const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
const imageUrl = (n) => 'https://www.dogetu.com/data/doutula/' + n.toString(16).padStart(32, '0') + '.png';
const html = (q = '开心', n = 4) => '<div class="pic-list">' + Array.from({ length: n }, (_, i) => '<img src="' + imageUrl(i + 1) + '" title="' + q + (i ? '呀'.repeat(i) : '') + '">').join('') + '</div>';
const ctx = { owner: 'group:456', token: 'fixture-token' };

async function fixture(fn, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-web-'));
  let time = Date.now();
  const calls = [];
  // 搜图抓页面走文本抓取器，图片走字节抓取器：两条通道必须分开，否则 512KB 的图片上限会让搜索永远失败。
  const fetchText = options.fetchText || (async (url) => { calls.push({ url, kind: 'text' }); return { body: html() }; });
  const fetchBytes = options.fetchBytes || (async (url, max, opts) => { calls.push({ url, max, opts, kind: 'image' }); return { buffer: png }; });
  const makePreview = options.makePreview || ((buffer) => createPreview(buffer));
  const factory = () => createWebStickerLibrary({ root, fetchText, fetchBytes, makePreview, now: () => time });
  try {
    await fn({ lib: factory(), factory, root, calls, advance: (ms) => { time += ms; } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('公共短词校验：URL/凭据/长数字/长文本一律拒绝', () => {
  assert.equal(expressionKeyword(' 开心表情包 '), '开心');
  for (const q of ['', 'a'.repeat(17), 'https://example.com', '123456', 'sk-test-secrets', 'C:\\secret', '开心\n123456']) {
    assert.throws(() => expressionKeyword(q));
  }
});

test('HTML 解析只接受固定来源固定路径的有标题图片', () => {
  const bad = ['http://127.0.0.1/a.png', 'https://evil.test/a.png', imageUrl(8) + '?x=1', 'https://www.dogetu.com@127.0.0.1/a.png'];
  const input = html('开心', 6) + bad.map((url) => '<img title="开心" src="' + url + '">').join('') + '<img src="' + imageUrl(9) + '">';
  const out = parseExpressionResults(input, 'dogetu', '开心');
  assert.equal(out.length, 6);
  assert.ok(out.every((x) => x.url.startsWith('https://www.dogetu.com/data/doutula/')));
  const secondary = '<img class="bqppsearch lazy" data-original="https://img.soutula.com/bmiddle/abc.jpg" title="&#24320;&#24515;">';
  assert.equal(parseExpressionResults(secondary, 'fabiaoqing', '开心')[0].title, '开心');
  assert.equal(parseExpressionResults(secondary.replace('bqppsearch', 'advert'), 'fabiaoqing', '开心').length, 0);
});

test('搜索最多返回 3 个纯文字候选，第二次命中查询缓存', () => fixture(async ({ lib, calls }) => {
  const r = await lib.find('开心', ctx);
  assert.equal(r.source, 'web');
  assert.equal(r.stickers.length, 3);
  assert.ok(JSON.stringify(r).length < 900);
  assert.doesNotMatch(JSON.stringify(r), /https:|base64|<img/);
  assert.equal((await lib.find('开心', ctx)).source, 'search-cache');
  assert.equal(calls.length, 1);
}));

test('联网新图必须先看图才能发送；记下的含义可跨会话复用且不再联网', () => fixture(async ({ lib, calls }) => {
  const id = (await lib.find('开心', ctx)).stickers[0].id;
  await assert.rejects(lib.image(id, ctx), /先用/);
  assert.throws(() => lib.note(id, { note: '开心' }, ctx), /先看过这张图/);
  const preview = await lib.preview(id, ctx);
  assert.equal(preview.image.mimeType, 'image/jpeg');
  assert.ok(preview.image.data);
  assert.throws(() => lib.note(id, { note: '开心' }, { ...ctx, token: 'stale' }), /先看过这张图/);
  lib.note(id, { note: '猫猫得意偷笑', tags: ['得意', '笑'], usage: '赢下比赛时接梗' }, ctx);
  const before = calls.length;
  const reused = await lib.find('得意', { owner: 'private:123' });
  assert.equal(reused.source, 'local-cache');
  assert.equal(reused.stickers[0].needsPreview, false);
  assert.equal((await lib.find('赢下比赛', { owner: 'group:789' })).source, 'local-cache');
  assert.equal(calls.length, before);
  assert.deepEqual((await lib.image(id, { owner: 'group:789', token: 'other' })).buffer, png);
}));

test('搜索冷却与每小时配额在重启、换 token 后仍然生效', () => fixture(async ({ lib, factory, calls, advance }) => {
  await lib.find('开心', ctx);
  assert.equal((await lib.find('无语', ctx)).source, 'budget');
  assert.equal((await factory().find('无语', { ...ctx, token: 'new' })).source, 'budget');
  advance(121000); await lib.find('无语', ctx);
  advance(121000); await lib.find('赞同', ctx);
  advance(121000);
  assert.equal((await factory().find('震惊', ctx)).source, 'budget');
  assert.ok(calls.length <= 5);
}));

test('全局每小时上限对无关会话同样生效', () => fixture(async ({ lib, calls }) => {
  for (let i = 0; i < 12; i += 1) await lib.find('情绪' + String.fromCharCode(65 + i), { owner: 'group:' + i });
  assert.equal((await lib.find('新情绪', { owner: 'private:100' })).source, 'budget');
  assert.equal(calls.length, 24);
}));

test('来源失败只回退一次，空结果有负缓存不再重试', () => fixture(async ({ lib, calls }) => {
  const r = await lib.find('无语', ctx);
  assert.equal(r.stickers.length, 0);
  assert.equal(calls.length, 2);
  assert.equal((await lib.find('无语', ctx)).source, 'search-cache');
  assert.equal(calls.length, 2);
}));

test('主站失败可回退到固定备用站', () => fixture(async ({ lib }) => {
  const r = await lib.find('开心', ctx);
  assert.equal(r.stickers[0].source, 'fabiaoqing');
}, {
  fetchText: async (url) => {
    if (url.includes('dogetu')) throw new Error('offline');
    return { body: '<img class="bqppsearch" data-original="https://img.soutula.com/bmiddle/abc.jpg" title="开心">' };
  }
}));

test('看新图额度会持久化；同一张已看过的图不重复占额度', () => fixture(async ({ lib, factory }) => {
  const ids = (await lib.find('开心', ctx)).stickers.map((e) => e.id);
  for (const id of ids) await lib.preview(id, ctx);
  await lib.preview(ids[0], ctx);
  await assert.rejects(factory().preview(ids[0], ctx), /预算/);
}));

test('guard 撤销后不会写出任何图片文件', () => fixture(async ({ lib, root }) => {
  const id = (await lib.find('开心', ctx)).stickers[0].id;
  let checks = 0;
  await assert.rejects(lib.preview(id, { ...ctx, guard: () => { if (++checks > 1) throw new Error('revoked'); } }), /revoked/);
  assert.equal(fs.readdirSync(path.join(root, 'web-stickers-cache')).length, 0);
}));

test('预览超限时报错并清掉半成品文件', () => fixture(async ({ lib, root }) => {
  const id = (await lib.find('开心', ctx)).stickers[0].id;
  await assert.rejects(lib.preview(id, ctx), /超限/);
  assert.equal(fs.readdirSync(path.join(root, 'web-stickers-cache')).length, 0);
}, { makePreview: async () => { throw new Error('缩略预览生成失败或超限'); } }));

test('30 天未用的条目会被淘汰，且只删本库自己的文件', () => fixture(async ({ lib, root, advance }) => {
  const id = (await lib.find('开心', ctx)).stickers[0].id;
  await lib.preview(id, ctx);
  const dir = path.join(root, 'web-stickers-cache');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'fixture');
  advance(31 * 86400000);
  assert.equal(lib.summary().entries, 0);
  assert.deepEqual(fs.readdirSync(dir), ['keep.txt']);
}));

test('缓存元数据损坏时停用写入，不覆盖损坏文件，也不清理缓存目录', () => fixture(async ({ root, factory }) => {
  const file = path.join(root, 'web-stickers.json');
  fs.writeFileSync(file, 'broken');
  // 目录里放一个真实图片文件：只读降级时它可能是唯一还能救回来的东西，
  // summary()/status() 这种「看一眼状态」的操作绝不能把它当孤儿删掉。
  const dir = path.join(root, 'web-stickers-cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a'.repeat(24) + '.image'), png);
  const lib = factory();
  await assert.rejects(lib.find('开心', ctx), /损坏/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
  const summary = lib.summary();
  assert.equal(summary.writable, false);
  assert.deepEqual(fs.readdirSync(dir), ['a'.repeat(24) + '.image']);
}));

test('缓存大小与条数上限：32MB / 120 条', () => fixture(async ({ root, factory }) => {
  const dir = path.join(root, 'web-stickers-cache');
  fs.mkdirSync(dir, { recursive: true });
  const entries = [];
  for (let i = 0; i < 18; i += 1) {
    const url = imageUrl(i + 1);
    const id = 'web:' + crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
    entries.push({ id, url, source: 'dogetu', title: '开心', createdAt: Date.now(), lastUsedAt: Date.now() + i });
    fs.writeFileSync(path.join(dir, id.slice(4) + '.image'), Buffer.alloc(2 * 1024 * 1024));
  }
  fs.writeFileSync(path.join(root, 'web-stickers.json'), JSON.stringify({ version: 1, entries, queries: [], searches: [], previews: [] }));
  assert.ok(factory().summary().entries <= 16);
  const bytes = fs.readdirSync(dir).reduce((n, file) => n + fs.statSync(path.join(dir, file)).size, 0);
  assert.ok(bytes <= 32 * 1024 * 1024);
  for (let i = 18; i < 150; i += 1) {
    const url = imageUrl(i + 1);
    entries.push({ id: 'web:' + crypto.createHash('sha256').update(url).digest('hex').slice(0, 24), url, source: 'dogetu', title: '开心', createdAt: Date.now() });
  }
  fs.writeFileSync(path.join(root, 'web-stickers.json'), JSON.stringify({ version: 1, entries, queries: [], searches: [], previews: [] }));
  assert.ok(factory().summary().entries <= 120);
}));

test('第 5 个并发任务被拒绝，而不是无限排队', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  await fixture(async ({ lib }) => {
    const pending = Array.from({ length: 4 }, () => lib.find('开心', ctx));
    await assert.rejects(lib.find('开心', ctx), /繁忙/);
    release();
    await Promise.all(pending);
  }, {
    fetchText: async () => { await blocked; return { body: html() }; }
  });
});

test('在一个会话看过的图，可以在另一个会话直接发送（看图许可按进程，不按会话）', () => fixture(async ({ lib }) => {
  const id = (await lib.find('开心', ctx)).stickers[0].id;
  await lib.preview(id, { owner: 'group:111', token: 'same-process' });
  const img = await lib.image(id, { owner: 'group:222', token: 'same-process' });
  assert.ok(img.buffer.length > 0);
  // 换一个进程（token 不同）就必须重新看
  await assert.rejects(lib.image(id, { owner: 'group:222', token: 'other-process' }), /sticker_preview/);
}));

test('库级直接调用不传 owner/token 也不会崩（默认 local / 空 token）', () => fixture(async ({ lib }) => {
  const id = (await lib.find('开心')).stickers[0].id;
  const preview = await lib.preview(id);
  assert.equal(preview.image.mimeType, 'image/jpeg');
  assert.ok((await lib.image(id)).buffer.length > 0);
  assert.equal(lib.note(id, { note: '开心' }).needsPreview, false);
}));

test('缓存文件是半截/0 字节时不算命中，会重新下载', () => fixture(async ({ lib, root, calls }) => {
  const id = (await lib.find('开心', ctx)).stickers[0].id;
  await lib.preview(id, ctx);
  const dir = path.join(root, 'web-stickers-cache');
  fs.writeFileSync(path.join(dir, id.slice(4) + '.image'), Buffer.alloc(0));
  const before = calls.filter((c) => c.kind === 'image').length;
  await lib.preview(id, ctx);
  assert.ok(calls.filter((c) => c.kind === 'image').length > before, '半截缓存应被重新下载覆盖');
}));

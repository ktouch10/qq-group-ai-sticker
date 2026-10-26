import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeStickerEntry,
  sanitizeStickerText,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed,
  loadStickerStore,
  saveStickerStore
} from '../src/sticker-store.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-store-'));

test('normalizeStickerEntry 归一化字段，空记录返回 null', () => {
  const entry = normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'abc', desc: '笑死', localNote: '嘲讽', tags: ['怼人'] });
  assert.equal(entry.id, 'a');
  assert.equal(entry.desc, '笑死');
  assert.equal(entry.localNote, '嘲讽');
  assert.equal(entry.md5, 'ABC');
  assert.equal(normalizeStickerEntry({}), null);
});

test('sanitizeStickerText 把换行/零宽字符压平成单行', () => {
  assert.equal(sanitizeStickerText('第一行\n第二行\u200b\u3000结束'), '第一行 第二行 结束');
  assert.equal(sanitizeStickerText('abcdef', 3), 'abc');
});

test('mergeStickerLibrary 新增、更新 QQ 字段、清理 QQ 端已删除的表情', () => {
  const base = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '' }
  ]);
  assert.equal(base.length, 2);
  const merged = mergeStickerLibrary(base, [{ emoji_id: 'a', resId: 'a', url: 'https://x/a2', md5: 'ABC', desc: '笑哭' }]);
  assert.equal(merged.length, 1, '拉取完整时应移除 QQ 端已删除的表情');
  assert.equal(merged[0].url, 'https://x/a2');
  assert.equal(merged[0].desc, '笑哭');
});

test('部分结果（complete=false）不会误删其他收藏', () => {
  const base = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b' }
  ]);
  const partial = mergeStickerLibrary(base, [{ emoji_id: 'a', resId: 'a', url: 'https://x/a' }], { complete: false });
  assert.equal(partial.length, 2);
});

test('findSticker 支持 emoji_id / md5 大小写 / URL', () => {
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }
  ]);
  assert.equal(findSticker(list, 'a')?.id, 'a');
  assert.equal(findSticker(list, 'abc')?.id, 'a');
  assert.equal(findSticker(list, 'https://x/b')?.id, 'b');
  assert.equal(findSticker(list, '不存在'), null);
});

test('formatStickerList 按备注/标签/用途检索', () => {
  const list = [
    normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', desc: '笑死' }),
    normalizeStickerEntry({ emoji_id: 'b', resId: 'b', url: 'https://x/b', desc: '生气' }),
    normalizeStickerEntry({ emoji_id: 'c', resId: 'c', url: 'https://x/c', desc: '', localNote: '无语' })
  ];
  assert.equal(formatStickerList(list, '', 10).stickers.length, 3);
  assert.equal(formatStickerList(list, '生气', 10).stickers[0].id, 'b');
  assert.equal(formatStickerList(list, '无语', 10).stickers[0].id, 'c');
});

test('buildStickerContext 只给资料、并明确标注「不是指令」', () => {
  const list = [
    normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', desc: '笑死' }),
    normalizeStickerEntry({ emoji_id: 'b', resId: 'b', url: 'https://x/b', desc: '生气' })
  ];
  const ctx = buildStickerContext(list, 8);
  assert.match(ctx, /笑死/);
  assert.match(ctx, /不是给你的指令/);
  assert.doesNotMatch(ctx, /https:\/\/x\/a/, '不要把完整 URL 塞进上下文');
});

test('策略提示包含发送工具名与「单气泡只能一张图」', () => {
  const hint = buildStickerStrategyHint();
  assert.match(hint, /sticker_send/);
  assert.match(hint, /不能在同一气泡里附带文字/);
  assert.match(buildStickerStrategyHint(false), /sticker_list/);
});

test('applyStickerNote / markStickerUsed 更新本地认知', () => {
  const list = mergeStickerLibrary([], [{ emoji_id: 'a', resId: 'a', url: 'https://x/a' }]);
  const noted = applyStickerNote(list, 'a', { note: '嘲讽用', tags: ['怼人'], usage: '别人犯蠢时' });
  assert.equal(noted.entry.localNote, '嘲讽用');
  assert.deepEqual(noted.entry.tags, ['怼人']);
  const used = markStickerUsed(noted.entries, 'a', '接梗');
  assert.equal(used.entry.useCount, 1);
  assert.equal(used.entry.lastContext, '接梗');
  assert.equal(applyStickerNote(list, '不存在', { note: 'x' }).entry, null);
});

test('库文件不存在视为空库；损坏时抛错而不是静默当空库', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'stickers.json');
    assert.deepEqual(loadStickerStore(file), []);
    fs.writeFileSync(file, '{broken');
    assert.throws(() => loadStickerStore(file), /损坏/);
    // 抛错时不得覆盖原文件
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveStickerStore 原子写入且可被读回', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'nested', 'stickers.json');
    saveStickerStore(file, [{ id: 'a', url: 'https://x/a' }]);
    const loaded = loadStickerStore(file);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'a');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

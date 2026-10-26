import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig, loadConfig, DEFAULTS } from '../src/config.js';

test('默认配置：白名单为空时不允许发送，数据目录相对配置文件', () => {
  const cfg = normalizeConfig({}, { baseDir: 'some/example/dir', env: {} });
  assert.equal(cfg.onebot.httpUrl, DEFAULTS.onebot.httpUrl);
  assert.deepEqual(cfg.allow, { groups: [], private: [] });
  assert.equal(cfg.allowAllWhenEmpty, false);
  assert.equal(cfg.sticker.send.cooldownMs, 20000);
  assert.equal(cfg.sticker.remark.enabled, false);
  assert.equal(cfg.dataDir, path.resolve('some/example/dir', './data'));
});

test('深合并：只覆盖写到的字段，其余保持默认', () => {
  const cfg = normalizeConfig({ sticker: { send: { maxPerHour: 5 } } }, { baseDir: '.', env: {} });
  assert.equal(cfg.sticker.send.maxPerHour, 5);
  assert.equal(cfg.sticker.send.cooldownMs, 20000, '未写的兄弟字段应保留默认');
  assert.equal(cfg.sticker.web.enabled, true);
});

test('ID 列表归一化：数字转字符串、去空、去重前的空值', () => {
  const cfg = normalizeConfig({ allow: { groups: [123, ' 456 ', '', null], private: [789] } }, { baseDir: '.', env: {} });
  assert.deepEqual(cfg.allow.groups, ['123', '456']);
  assert.deepEqual(cfg.allow.private, ['789']);
});

test('环境变量优先于配置文件（token 不必写进文件）', () => {
  const cfg = normalizeConfig({ onebot: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'file-token' } }, {
    baseDir: '.',
    env: { ONEBOT_HTTP_URL: 'http://127.0.0.1:9999', ONEBOT_ACCESS_TOKEN: 'env-token' }
  });
  assert.equal(cfg.onebot.httpUrl, 'http://127.0.0.1:9999');
  assert.equal(cfg.onebot.accessToken, 'env-token');
});

test('数值兜底：负间隔/超大上限被夹到合法区间', () => {
  const cfg = normalizeConfig({ sticker: { maxListCount: 9999, send: { minDelayMs: -5, maxDelayMs: -1, maxPerHour: 0 }, collect: { maxRemarkChars: 0 } } }, { baseDir: '.', env: {} });
  assert.equal(cfg.sticker.maxListCount, 500);
  assert.equal(cfg.sticker.send.minDelayMs, 0);
  assert.equal(cfg.sticker.send.maxDelayMs, 0);
  assert.equal(cfg.sticker.send.maxPerHour, 40);
  assert.equal(cfg.sticker.collect.maxRemarkChars, 20);
});

test('loadConfig：文件不存在时回落默认值；有 BOM 也能读', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-cfg-'));
  try {
    const missing = loadConfig(path.join(dir, 'nope.json'), { env: {} });
    assert.equal(missing.onebot.httpUrl, DEFAULTS.onebot.httpUrl);
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ allow: { groups: ['1'] } }));
    const loaded = loadConfig(file, { env: {} });
    assert.deepEqual(loaded.allow.groups, ['1']);
    assert.equal(loaded.configFile, file);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadConfig：坏 JSON 报错而不是静默用默认值跑', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-cfg-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{oops');
    assert.throws(() => loadConfig(file, { env: {} }), /读取失败/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreview } from '../src/preview.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'two-frame.gif');

async function makePng(width, height) {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
}

test('静图预览：输出 JPEG，且不超过 160KB', async () => {
  const png = await makePng(600, 400);
  const jpeg = await createPreview(png);
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.ok(jpeg.length <= 160 * 1024);
  const { default: sharp } = await import('sharp');
  const meta = await sharp(jpeg).metadata();
  assert.ok(meta.width <= 384 && meta.height <= 384);
});

test('动图预览：取三帧拼成 768×256 一张 JPEG', async () => {
  const gif = fs.readFileSync(FIXTURE);
  const jpeg = await createPreview(gif);
  const { default: sharp } = await import('sharp');
  const meta = await sharp(jpeg).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 768);
  assert.equal(meta.height, 256);
});

test('像素超限的图会被拒绝', async () => {
  const big = await makePng(3000, 3000);
  await assert.rejects(createPreview(big), /超限/);
});

test('非图片字节会被拒绝', async () => {
  await assert.rejects(createPreview(Buffer.from('not an image')));
});

test('guard 在解码后立刻有机会中止（用于取消/权限变更）', async () => {
  const png = await makePng(20, 20);
  await assert.rejects(
    createPreview(png, { guard: () => { throw new Error('revoked'); } }),
    /revoked/
  );
});

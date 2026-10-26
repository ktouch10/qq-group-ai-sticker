// 表情预览：把任意表情图片（含动图）压成一张模型看得懂的 JPEG。
// - 静图：等比缩到 384×384 以内
// - 动图：取首、中、尾三帧，各 256×256，横向拼成 768×256
// 全程在进程内完成（sharp），不需要额外的 FFmpeg 可执行文件。
import sharp from 'sharp';

// 表情是高频小图：限制并发与缓存，避免和宿主的其他图像任务抢内存。
sharp.cache({ memory: 16, files: 0, items: 20 });
sharp.concurrency(1);

const OPTIONS = { limitInputPixels: 16_000_000, failOn: 'warning' };
const MAX_PIXELS = 2_500_000;
const MAX_FRAMES = 240;
const MAX_DURATION_MS = 30_000;
const MAX_PREVIEW_BYTES = 160 * 1024;

export async function createPreview(buffer, { guard = () => {} } = {}) {
  const meta = await sharp(buffer, { ...OPTIONS, pages: 1 }).metadata();
  guard();
  const frames = meta.pages || 1;
  const frameHeight = meta.pageHeight || meta.height;
  const durationMs = (meta.delay || []).reduce((n, v) => n + v, 0);
  if (
    !['png', 'jpeg', 'gif', 'webp'].includes(meta.format) ||
    !(meta.width > 0 && frameHeight > 0) ||
    meta.width * frameHeight > MAX_PIXELS ||
    frames > MAX_FRAMES ||
    durationMs > MAX_DURATION_MS
  ) {
    throw new Error('表情格式、像素、帧数或时长超限');
  }
  let result;
  if (frames > 1) {
    const pages = [0, Math.floor((frames - 1) / 2), frames - 1];
    const tiles = [];
    for (const page of pages) {
      const tile = await sharp(buffer, { ...OPTIONS, page, pages: 1 })
        .resize(256, 256, { fit: 'contain', background: 'white' })
        .flatten({ background: 'white' })
        .timeout({ seconds: 8 })
        .jpeg({ quality: 65 })
        .toBuffer();
      guard();
      tiles.push(tile);
    }
    result = await sharp({ create: { width: 768, height: 256, channels: 3, background: 'white' } })
      .composite(tiles.map((input, i) => ({ input, left: i * 256, top: 0 })))
      .timeout({ seconds: 8 })
      .jpeg({ quality: 65 })
      .toBuffer();
  } else {
    result = await sharp(buffer, OPTIONS)
      .rotate()
      .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: 'white' })
      .timeout({ seconds: 8 })
      .jpeg({ quality: 65 })
      .toBuffer();
  }
  guard();
  if (!result?.length || result.length > MAX_PREVIEW_BYTES) throw new Error('缩略预览生成失败或超限');
  return result;
}

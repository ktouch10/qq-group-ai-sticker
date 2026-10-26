// 最小宿主示例：不接 MCP，直接用库把「找图 → 看图 → 发送 → 记含义」跑一遍。
//
// 运行：
//   node examples/use-as-library.mjs group:123456789 无语
//
// 前提：config.json 已配好 onebot 与 allow 白名单，且目标会话在白名单里。
// 这个示例会真的往 QQ 发一张图；只想看效果可以先注释掉 send 那一段。
import { loadConfig } from '../src/index.js';
import { StickerService } from '../src/service.js';

const [target = 'group:123456789', query = '无语'] = process.argv.slice(2);
const service = new StickerService(loadConfig('./config.json'), {
  log: (message) => console.error(`[sticker] ${message}`)
});

// 1) 这一轮要注入系统提示词的文本（可用表情 + 策略 + 节奏）
const promptBlock = await service.prompt({ key: target });
console.log('--- 注入提示词 ---');
console.log(promptBlock || '（还没有可注入的内容：收藏为空且联网关闭）');

// 2) 找图
const found = await service.find({ query, target });
console.log('\n--- 找图结果 ---');
console.log(JSON.stringify(found, null, 2));
if (!found.stickers?.length) {
  console.log('没有结果：这一轮用文字，不重试');
  process.exit(0);
}

const stickerId = found.stickers[0].id;

// 3) 先看一眼（联网新图必须先看）
const preview = await service.preview({ stickerId, target });
console.log(`\n--- 预览 ---\nJPEG ${Math.round(preview.image.data.length * 0.75 / 1024)} KB`);

// 4) 发出去（真实发送；不想发就注释掉这一段）
const sent = await service.send({ target, stickerId });
console.log(`\n--- 已发送 ---\nmessageId=${sent.messageId}`);

// 5) 记下这张图怎么用，下次别的群可以按标签复用
await service.note({ stickerId, note: '无语到极点', tags: ['无语'], usage: '对方发离谱消息时', target });

// 6) 注意：每发一条文字都要告诉插件，节奏提示才准
service.noteTextSent(target);

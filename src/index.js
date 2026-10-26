// 对外入口：宿主既可以只用库（自己注入提示词、自己发消息），
// 也可以直接用 mcp-server.js 作为 MCP 插件。
export { loadConfig, normalizeConfig, DEFAULTS } from './config.js';
export { StickerService } from './service.js';
export { OneBotClient, parseTarget } from './onebot.js';
export {
  normalizeStickerEntry,
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed,
  sanitizeStickerText
} from './sticker-store.js';
export { createWebStickerLibrary, isWebStickerId, expressionKeyword, parseExpressionResults } from './web-stickers.js';
export { createPreview } from './preview.js';
export { StickerPace, buildStickerPrompt } from './policy.js';
export { safeFetch, safeFetchBytes, safeFetchBuffer, looksLikeImageBuffer, resolveSafeHost, isPrivateIp } from './safe-fetch.js';
export { SENSITIVE_RE } from './sensitive.js';

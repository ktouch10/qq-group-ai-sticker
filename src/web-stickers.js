// 联网梗图库：固定来源、只接受公共短词、有界缓存与限额，绝不把网页内容当指令。
//
// 与「QQ 收藏表情库」分离存放：收藏表情由 OneBot 同步，联网库是本插件自己下载的公共图片。
// 一行 URL 都不会交给 QQ 网关去抓 —— 下载一律走进程内的 safe-fetch（DNS 固定、逐跳校验、限大小）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeFetch, safeFetchBytes, looksLikeImageBuffer } from './safe-fetch.js';
import { SENSITIVE_RE } from './sensitive.js';
import { sanitizeStickerText } from './sticker-store.js';
import { createPreview as defaultPreview } from './preview.js';

const HOUR = 3600000, DAY = 24 * HOUR;
const LIMIT = Object.freeze({ html: 512 * 1024, image: 2 * 1024 * 1024, cache: 32 * 1024 * 1024, entries: 120 });
const digest = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
export const isWebStickerId = value => /^web:[0-9a-f]{24}$/.test(String(value));
const decode = text => String(text).replace(/&#(x[0-9a-f]+|\d+);/gi, (all, v) => {
  const n = v[0].toLowerCase() === 'x' ? parseInt(v.slice(1),16) : Number(v);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}).replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');

// 只接受「公共情绪/动作短词」：URL、长数字、十六进制串、路径、凭据一律拒绝。
// 这不是安全边界（模型仍可能传错），但能挡住把聊天原文、人名、QQ 号当关键词发出去的最常见路径。
export function expressionKeyword(value) {
  const q = sanitizeStickerText(value, 256).normalize('NFC').replace(/表情包/g,'').trim();
  if (!q || [...q].length > 16 || !/^[\p{L}\p{N}\s！!？?~～，,]+$/u.test(q) || /\d{5,}|[a-f0-9]{16}/i.test(q) || SENSITIVE_RE.test(q)) {
    throw new Error('仅用1～16字的情绪/动作词，例如“开心”“猫猫无语”；不要传聊天原文、姓名、QQ号或凭据');
  }
  return q.toLowerCase();
}

// 只信任两个固定来源的固定路径；协议、host、端口、查询串、片段、凭据一律卡死。
function trustedImage(raw, source) {
  try {
    const u = new URL(decode(raw));
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return '';
    const ok = source === 'dogetu'
      ? u.hostname === 'www.dogetu.com' && /^\/data\/doutula\/[a-f0-9]{32}\.(jpg|png|gif|webp)$/i.test(u.pathname)
      : u.hostname === 'img.soutula.com' && /^\/(bmiddle|large)\/[a-z0-9_-]+\.(jpg|png|gif|webp)$/i.test(u.pathname);
    return ok ? u.href : '';
  } catch { return ''; }
}

export function parseExpressionResults(html, source, query) {
  if (!['dogetu','fabiaoqing'].includes(source)) return [];
  // 只看结果区：忽略脚本、页头、广告和站点侧边栏。
  const body = source === 'dogetu' ? String(html).split('class="pic-list"')[1]?.split('class="pagination"')[0] || '' : String(html);
  const out = [], seen = new Set();
  for (const match of body.matchAll(/<img\b[^>]{0,4096}>/gi)) {
    const attrs = Object.create(null);
    for (const a of match[0].matchAll(/([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) attrs[a[1].toLowerCase()] = a[3];
    if (source === 'fabiaoqing' && !/\bbqppsearch\b/.test(attrs.class || '')) continue;
    const url = trustedImage(attrs['data-original'] || attrs.src || '', source);
    const title = sanitizeStickerText(decode(attrs.title || attrs.alt || ''), 48);
    if (!url || !title || seen.has(url)) continue;
    const terms = query.split(/\s+/).filter(Boolean);
    if (!terms.every(t => title.toLowerCase().includes(t))) continue;
    seen.add(url); out.push({ id:'web:'+digest(url), url, title, source });
    if (out.length >= 15) break;
  }
  return out.sort((a,b) => Number(b.title === query) - Number(a.title === query) || a.title.length - b.title.length).slice(0, 6);
}

export function createWebStickerLibrary({ root, fetchBytes = safeFetchBytes, fetchText = safeFetch, makePreview = defaultPreview, now = Date.now } = {}) {
  root = path.resolve(root);
  const directory = path.join(root,'web-stickers-cache');
  const file = path.join(root,'web-stickers.json');
  let state = { version:1, entries:[], queries:[], searches:[], previews:[] }, writable = true;
  try {
    const raw = JSON.parse(fs.readFileSync(file,'utf8'));
    if (raw.version !== 1 || !['entries','queries','searches','previews'].every(k => Array.isArray(raw[k]))) throw new Error('schema');
    state = raw;
    // 缓存里的元数据不是新的 URL 授信来源：加载时按固定规则重新校验一遍。
    state.entries = state.entries.filter(e => isWebStickerId(e?.id) && trustedImage(e.url,e.source) === e.url && e.id === 'web:'+digest(e.url)).slice(-LIMIT.entries);
    state.queries = state.queries.slice(-80);state.searches=state.searches.slice(-100);state.previews=state.previews.slice(-100);
  } catch (e) { if (e.code !== 'ENOENT') writable = false; }
  const viewed = new Set();
  let queue = Promise.resolve(), queued = 0;
  function serialize(fn) {
    if (queued >= 4) return Promise.reject(new Error('表情任务繁忙，本轮使用已有收藏或文字，不要连续重试'));
    queued++;
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task.finally(() => { queued--; });
  }
  function ensureWritable() { if (!writable) throw new Error('联网表情缓存元数据损坏，已停用新功能以保护数据；使用原 QQ 收藏即可'); }
  function save() {
    ensureWritable();fs.mkdirSync(path.dirname(file),{recursive:true});
    const tmp = file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
    try { fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});fs.renameSync(tmp,file); }
    catch(e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  }
  function asset(id, suffix) {
    if (!isWebStickerId(id)) throw new Error('无效联网表情标识');
    return path.join(directory,id.slice(4)+suffix);
  }
  function entry(id) {
    ensureWritable();const e=state.entries.find(e => e.id === id);
    if (!e) throw new Error('表情已过期或不在缓存中，请按短关键词查找；不能传任意 URL');
    return e;
  }
  function clean() {
    // 只读模式（元数据损坏）下**绝不**动磁盘：此时 state.entries 是空的，
    // 继续清理会把缓存目录里真实存在的图片当「孤儿」全删掉，而 URL 已经丢了、不可恢复。
    if (!writable) return;
    const t=now();state.searches=state.searches.filter(r=>r.at>t-DAY);state.previews=state.previews.filter(r=>r.at>t-HOUR);
    state.queries=state.queries.filter(q=>q.expires>t).slice(-80);
    state.entries.sort((a,b)=>(b.lastUsedAt||b.createdAt)-(a.lastUsedAt||a.createdAt));
    let bytes=0;
    state.entries=state.entries.filter((e,i)=>{
      const size=['.image','.jpg'].reduce((n,s)=>{try{return n+fs.statSync(asset(e.id,s)).size;}catch{return n;}},0);
      const keep=i<LIMIT.entries && (e.lastUsedAt||e.createdAt)>t-30*DAY && bytes+size<=LIMIT.cache;
      if (keep) bytes+=size;
      else for(const suffix of ['.image','.jpg'])try{fs.unlinkSync(asset(e.id,suffix));}catch{}
      return keep;
    });
    // 只清理本库自己的哈希文件名；写入中断留下的残片也一并收掉，其他文件不动。
    try{for(const name of fs.readdirSync(directory)){if(/^[0-9a-f]{24}\.(image|jpg)\.[0-9a-f]{12}\.tmp$/.test(name)){try{fs.unlinkSync(path.join(directory,name));}catch{}continue;}if(/^[0-9a-f]{24}\.(image|jpg)$/.test(name)&&!state.entries.some(e=>name.startsWith(e.id.slice(4)+'.')))fs.unlinkSync(path.join(directory,name));}}catch{}
  }
  function concise(e) { return { id:e.id,label:sanitizeStickerText(e.note||e.title,36),...(e.reviewed?{tags:(e.tags||[]).slice(0,3),usage:sanitizeStickerText(e.usage,36)}:{}),source:e.source,needsPreview:!e.reviewed }; }
  const output = (entries, source, note='') => ({ source, stickers:entries.slice(0,3).map(concise), ...(note?{note}:{}) });
  function rate(kind, owner) {
    const t=now(),who=digest(String(owner ?? 'local')),rows=state[kind];
    if (kind === 'searches') {
      const mine=rows.filter(r=>r.who===who&&r.at>t-HOUR);
      if (mine.some(r=>r.at>t-120000)||mine.length>=3||rows.filter(r=>r.at>t-HOUR).length>=12||rows.length>=48) return false;
    } else if (rows.filter(r=>r.who===who&&r.at>t-HOUR).length>=3 || rows.filter(r=>r.at>t-HOUR).length>=24) return false;
    rows.push({who,at:t});save();return true;
  }
  async function find(query,{ owner, guard=()=>{} }={}) {
    const q=expressionKeyword(query);
    return serialize(async()=>{
      guard();ensureWritable();clean();
      const local=state.entries.filter(e=>e.reviewed&&q.split(/\s+/).every(word=>[e.note,e.title,e.usage,...(e.tags||[]),...(e.keywords||[])].some(v=>String(v||'').toLowerCase().includes(word))));
      if(local.length)return output(local,'local-cache');
      const cached=state.queries.find(x=>x.q===q&&x.expires>now());
      if(cached){const found=cached.ids.map(id=>state.entries.find(e=>e.id===id)).filter(Boolean);if(found.length||!cached.ids.length)return output(found,'search-cache',found.length?'':'没有合适结果，本轮用收藏或文字，不重试');}
      if(!rate('searches',owner))return output([],'budget','联网搜索冷却/预算已用完，本轮用收藏或文字，不重试');
      let results=[],success=false;
      const sources=[['dogetu','https://www.dogetu.com/search?keyword='+encodeURIComponent(q)],['fabiaoqing','https://fabiaoqing.com/search/bqb/keyword/'+encodeURIComponent(q)]];
      for(const [source,url] of sources){
        guard();
        try{const r=await fetchText(url,LIMIT.html);guard();success=true;results=parseExpressionResults(String(r?.body ?? ''),source,q);if(results.length)break;}
        catch(e){guard();}
      }
      guard();
      for(const r of results){let old=state.entries.find(e=>e.id===r.id);if(!old){old={...r,keywords:[q],createdAt:now(),lastUsedAt:now(),reviewed:false};state.entries.push(old);}else old.keywords=[...new Set([...(old.keywords||[]),q])].slice(-4);}
      state.queries=state.queries.filter(x=>x.q!==q);state.queries.push({q,ids:results.map(e=>e.id),expires:now()+(results.length?DAY:15*60000)});
      clean();save();return output(results.map(r=>entry(r.id)),'web',results.length?'新图先用 sticker_preview 看一张，再发送并用 sticker_note 记短标签以便复用':(success?'没有合适结果':'来源暂不可用')+'，本轮用收藏或文字，不连续重试');
    });
  }
  // 写缓存文件必须原子：进程被杀/断电时留下半截文件，下一次请求会因为「文件已存在」直接复用坏图。
  function writeAtomic(file, buffer) {
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { fs.writeFileSync(tmp, buffer, { mode: 0o600 }); fs.renameSync(tmp, file); }
    catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  }
  // 文件存在且非空；原始图还要校验图片魔数，避免把半截/错误内容当成缓存命中。
  function cachedOk(file, checkMagic = false) {
    try {
      if (fs.statSync(file).size <= 0) return false;
      if (!checkMagic) return true;
      const fd = fs.openSync(file, 'r');
      try {
        const head = Buffer.alloc(12);
        return fs.readSync(fd, head, 0, 12, 0) === 12 && looksLikeImageBuffer(head);
      } finally { fs.closeSync(fd); }
    } catch { return false; }
  }
  async function prepare(e,guard) {
    const original=asset(e.id,'.image'),preview=asset(e.id,'.jpg');
    if(cachedOk(original,true)&&cachedOk(preview))return;
    fs.mkdirSync(directory,{recursive:true});
    const r=await fetchBytes(e.url,LIMIT.image,{timeoutMs:12000});guard();
    if(!looksLikeImageBuffer(r.buffer))throw new Error('表情来源没有返回 PNG/JPEG/GIF/WebP 图片');
    try{
      writeAtomic(original,r.buffer);
      const jpeg=await makePreview(r.buffer,{guard});guard();
      if(!jpeg?.length||jpeg.length>160*1024)throw new Error('缩略预览生成失败或超限');
      writeAtomic(preview,jpeg);
    }catch(e){for(const p of [original,preview])try{fs.unlinkSync(p);}catch{}throw e;}
  }
  // 「这张图当前进程已经看过」的许可。按 token（= 一次进程启动）而不是按会话记账：
  // 同一个 MCP server 就是同一个调用方，按会话切分只会让模型「在 A 会话看了、在 B 会话发」
  // 时莫名报错，反而诱导它重复看图。额度仍然按会话（owner）计。
  const ticket=(owner,token,id)=>digest(String(token ?? ''))+'#'+id;
  async function preview(id,{owner,token,guard=()=>{}}={}){
    return serialize(async()=>{
      guard();ensureWritable();clean();const e=entry(id),t=ticket(owner,token,id);
      if(!viewed.has(t)&&!rate('previews',owner))throw new Error('本小时看新图预算已用完，复用已理解的表情或文字');
      await prepare(e,guard);guard();
      viewed.add(t);if(viewed.size>256)viewed.delete(viewed.values().next().value);
      e.lastUsedAt=now();clean();save();
      return {sticker:concise(e),image:{mimeType:'image/jpeg',data:fs.readFileSync(asset(id,'.jpg')).toString('base64')}};
    });
  }
  function note(id,patch,{owner,token,guard=()=>{}}={}) {
    guard();const e=entry(id);
    if(!viewed.has(ticket(owner,token,id)))throw new Error('先看过这张图的缩略图，再记录含义；不能把网页标题当成已经看懂');
    const text=sanitizeStickerText(patch.note||patch.usage,60);
    if(!text||SENSITIVE_RE.test(text))throw new Error('请记一句简短的表情含义，不含路径或凭据');
    const usage=sanitizeStickerText(patch.usage,60);
    const tags=Array.isArray(patch.tags)?patch.tags.map(t=>sanitizeStickerText(t,12)).filter(t=>t&&!SENSITIVE_RE.test(t)).slice(0,6):[];
    if(SENSITIVE_RE.test(usage))throw new Error('表情用途不能包含路径或凭据');
    e.note=text;e.usage=usage;e.tags=tags;e.reviewed=true;e.lastUsedAt=now();save();return concise(e);
  }
  async function image(id,{owner,token,guard=()=>{}}={}) {
    return serialize(async()=>{
      guard();ensureWritable();clean();const e=entry(id);
      if(!e.reviewed&&!viewed.has(ticket(owner,token,id)))throw new Error('联网新图需先用 sticker_preview 确认后再发送');
      await prepare(e,guard);guard();const buffer=fs.readFileSync(asset(id,'.image'));e.lastUsedAt=now();clean();save();
      return {entry:{id:e.id,desc:e.note||e.title,source:'web'},buffer};
    });
  }
  function used(id){const e=entry(id);e.lastUsedAt=now();e.useCount=(e.useCount||0)+1;save();return {id:e.id,desc:e.note||e.title,source:'web'};}
  return {find,preview,note,image,used,summary(){clean();return {entries:state.entries.length,reviewed:state.entries.filter(e=>e.reviewed).length,writable};}};
}

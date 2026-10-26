// OneBot v11 HTTP 适配层：只实现本插件需要的几个动作。
//
// 设计要点：
// - 所有请求都带超时；网关连不上时给可操作的提示，而不是抛一个裸 fetch 错误。
// - 图片字节**由本进程下载后转 base64** 再交给网关，绝不让网关去抓 URL
//   （否则 URL 就等于一条可被注入的任意下载指令，绕过本插件的 SSRF 防护）。
// - 响应统一校验 status/retcode，错误信息里带上网关的 retcode/wording 便于排查。

const DEFAULT_TIMEOUT_MS = 15000;

/** 解析 "group:123456" / "private:7890" 形式的会话标识。 */
export function parseTarget(target) {
  const raw = String(target ?? '').trim();
  const match = raw.match(/^(group|private):([1-9]\d*)$/);
  if (!match) throw new Error('会话标识必须形如 group:123456 或 private:7890');
  return { kind: match[1], id: match[2], key: `${match[1]}:${match[2]}` };
}

function normalizeReplyId(value) {
  const rid = String(value ?? '').trim();
  if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
  return rid;
}

function normalizeAtId(value) {
  const at = String(value ?? '').trim();
  // 必须是规范的正整数：'00'、'007' 这类前导零会被 QQ 当成非法号码。
  if (!/^[1-9]\d*$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all 或带前导零');
  return at;
}

export class OneBotClient {
  constructor({ httpUrl = 'http://127.0.0.1:3000', accessToken = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.base = String(httpUrl).replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    this.timeoutMs = timeoutMs;
  }

  async call(action, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    const url = `${this.base}/${action}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {})
        },
        body: JSON.stringify(params ?? {}),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const hint = /ECONNREFUSED|fetch failed/i.test(String(error?.message))
        ? `（连不上 OneBot HTTP 服务：请确认 SnowLuma 正在运行，且配置里的 onebot.httpUrl 是 HTTP API 地址而不是 WebSocket 端口）`
        : '';
      throw new Error(`OneBot ${action} 请求失败：${error?.message ?? error}${hint}`);
    }
    const body = (await res.json().catch(() => ({}))) ?? {};
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426
        ? '（HTTP 426：onebot.httpUrl 可能指向了 WebSocket 端口，应为 OneBot HTTP API 地址）'
        : '';
      const reason = body.wording || body.message || '未返回原因';
      const retcode = body.retcode ?? `HTTP ${res.status}`;
      throw new Error(`OneBot ${action} 失败：${reason}（retcode=${retcode}）${hint}`);
    }
    return body.data;
  }

  /** 拉取 QQ 账号收藏的表情（SnowLuma 扩展动作）。 */
  async fetchCustomFaces(count = 100) {
    const data = await this.call('fetch_custom_face_detail', { count });
    if (!Array.isArray(data)) throw new Error('fetch_custom_face_detail 返回的 data 不是数组，已放弃本次同步');
    return data;
  }

  /** 修改收藏表情的官方备注。 */
  modifyCustomFace(emojiId, desc) {
    return this.call('modify_custom_face', { emoji_id: String(emojiId), desc: String(desc ?? '') });
  }

  /** 把一张图（base64://）加进 QQ 收藏表情。 */
  addCustomFace(file) {
    return this.call('add_custom_face', { file: String(file) });
  }

  /** 取单条消息（用于收藏群友发来的图）。 */
  async getMsg(messageId) {
    const id = Number(messageId);
    // 超过 2^53 的消息 id 转 Number 会丢精度，进而可能读到别的消息。
    if (!Number.isSafeInteger(id)) throw new Error('messageId 超出可安全表示的范围，拒绝按不精确的 id 读取消息');
    return this.call('get_msg', { message_id: id });
  }

  /** 取登录账号信息（用于判断「是不是自己发的」）。 */
  getLoginInfo() {
    return this.call('get_login_info');
  }

  /**
   * 以「一条消息一张图」的形式发一张表情。
   * 返回网关的发送结果（含 message_id）。
   */
  async sendImage({ target, buffer, replyToMessageId, atUserId, timeoutMs } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('缺少要发送的图片字节');
    const { kind, id } = parseTarget(target);
    const message = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      message.push({ type: 'reply', data: { id: normalizeReplyId(replyToMessageId) } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      // 私聊没有 @ 的概念：带上 at 段只会让网关报错或静默丢掉，直接拒绝更清楚。
      if (kind === 'private') throw new Error('私聊不支持 atUserId（只有群聊可以 @）');
      message.push({ type: 'at', data: { qq: normalizeAtId(atUserId) } });
    }
    // 一条消息只能是一张表情：不混文字，避免真人群聊里出现「图+说明」的机器味。
    message.push({ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } });
    const params = kind === 'private' ? { user_id: Number(id), message } : { group_id: Number(id), message };
    return this.call(kind === 'private' ? 'send_private_msg' : 'send_group_msg', params, { timeoutMs });
  }
}

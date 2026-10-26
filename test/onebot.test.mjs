import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { OneBotClient, parseTarget } from '../src/onebot.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;

test('parseTarget 只接受 group:/private: 的合法数字 id', () => {
  assert.deepEqual(parseTarget('group:123456'), { kind: 'group', id: '123456', key: 'group:123456' });
  assert.deepEqual(parseTarget(' private:7890 '), { kind: 'private', id: '7890', key: 'private:7890' });
  for (const bad of ['', 'group:', 'group:0', 'group:-5', 'private:abc', 'all:123', 'group:1.5']) {
    assert.throws(() => parseTarget(bad));
  }
});

test('call 会带上鉴权头并把 retcode!=0 统一抛成可读错误', async () => {
  const seen = [];
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      if (req.url === '/fetch_custom_face_detail') {
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: [{ emoji_id: 'a', url: 'https://x/a' }] }));
      } else {
        res.end(JSON.stringify({ status: 'failed', retcode: 100, wording: 'bad token' }));
      }
    });
  });
  try {
    const client = new OneBotClient({ httpUrl: urlOf(server), accessToken: 'secret-token' });
    assert.equal((await client.fetchCustomFaces(5)).length, 1);
    assert.equal(seen[0].auth, 'Bearer secret-token');
    assert.deepEqual(JSON.parse(seen[0].body), { count: 5 });
    await assert.rejects(client.getMsg(1), /100/);
    await assert.rejects(client.getMsg(1), /bad token/);
  } finally { server.close(); }
});

test('网关回非数组时拒绝同步（不能拿空数组清空本地库）', async () => {
  const server = await startServer((req, res) => res.end(JSON.stringify({ status: 'ok', retcode: 0 })));
  try {
    const client = new OneBotClient({ httpUrl: urlOf(server) });
    await assert.rejects(client.fetchCustomFaces(5), /不是数组/);
  } finally { server.close(); }
});

test('HTTP 426 给出「httpUrl 指错端口」的可操作提示', async () => {
  const server = await startServer((req, res) => { res.statusCode = 426; res.end('{}'); });
  try {
    const client = new OneBotClient({ httpUrl: urlOf(server) });
    await assert.rejects(client.getMsg(1), /426/);
    await assert.rejects(client.getMsg(1), /WebSocket/);
  } finally { server.close(); }
});

test('sendImage 用 base64 传输、一条消息一张图，并按会话类型选动作', async () => {
  const seen = [];
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body) });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } }));
    });
  });
  try {
    const client = new OneBotClient({ httpUrl: urlOf(server) });
    const buffer = Buffer.from([1, 2, 3]);
    const group = await client.sendImage({ target: 'group:123', buffer });
    assert.equal(group.message_id, 42);
    assert.equal(seen[0].url, '/send_group_msg');
    assert.equal(seen[0].body.group_id, 123);
    assert.equal(seen[0].body.message.length, 1);
    assert.equal(seen[0].body.message[0].data.file, 'base64://' + buffer.toString('base64'));

    await client.sendImage({ target: 'private:456', buffer, replyToMessageId: -7, atUserId: 10001 });
    assert.equal(seen[1].url, '/send_private_msg');
    assert.equal(seen[1].body.user_id, 456);
    assert.deepEqual(seen[1].body.message.map((s) => s.type), ['reply', 'at', 'image']);
    assert.equal(seen[1].body.message[0].data.id, '-7');
    assert.equal(seen[1].body.message[1].data.qq, '10001');

    await assert.rejects(client.sendImage({ target: 'group:123', buffer, replyToMessageId: 0 }), /非零整数/);
    await assert.rejects(client.sendImage({ target: 'group:123', buffer, atUserId: 'all' }), /不能为 all/);
    await assert.rejects(client.sendImage({ target: 'group:123', buffer: Buffer.alloc(0) }), /缺少/);
    await assert.rejects(client.sendImage({ target: 'group:0', buffer }), /会话标识/);
  } finally { server.close(); }
});

test('连不上网关时给出排查提示而不是裸 fetch 错误', async () => {
  const client = new OneBotClient({ httpUrl: 'http://127.0.0.1:1', timeoutMs: 1500 });
  await assert.rejects(client.getMsg(1), /OneBot|请求失败/);
});

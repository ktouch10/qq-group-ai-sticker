// 端到端：真的把 MCP server 起成子进程，用 JSON-RPC 走一遍 initialize / tools/list / tools/call。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'mcp-server.js');

function startServer(configFile) {
  const child = spawn(process.execPath, [SERVER, '--config', configFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}\nstderr: ${stderr}`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  return {
    request,
    notify,
    stderr: () => stderr,
    close: () => new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    })
  };
}

function writeConfig(dir) {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    onebot: { httpUrl: 'http://127.0.0.1:1', accessToken: '' },
    allow: { groups: ['123'], private: [] },
    dataDir: './data'
  }));
  return file;
}

test('MCP server 能初始化、列出 6 个表情工具，并能容忍网关离线', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-mcp-'));
  const server = startServer(writeConfig(dir));
  try {
    const init = await server.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'qq-sticker-test', version: '0.0.0' }
    });
    assert.ok(init.serverInfo, 'initialize 应返回 serverInfo');
    server.notify('notifications/initialized');

    const tools = await server.request('tools/list', {});
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['sticker_collect', 'sticker_find', 'sticker_list', 'sticker_note', 'sticker_preview', 'sticker_send']);
    const send = tools.tools.find((tool) => tool.name === 'sticker_send');
    assert.match(send.description, /一条消息只能一张图/);
    assert.ok(send.inputSchema.properties.target);

    // 网关不可达时 sticker_list 应返回空列表而不是崩掉整个 server
    const listed = await server.request('tools/call', { name: 'sticker_list', arguments: {} });
    assert.ok(listed.content?.[0]?.text);
    const parsed = JSON.parse(listed.content[0].text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.total, 0);
    assert.ok(fs.existsSync(path.join(dir, 'data')), '应创建数据目录');

    // 越权目标必须被拒绝
    const denied = await server.request('tools/call', {
      name: 'sticker_send',
      arguments: { target: 'group:999', stickerId: 'a' }
    });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /白名单/);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('默认配置下不暴露改官方备注的工具（写操作默认关闭）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-mcp-'));
  const server = startServer(writeConfig(dir));
  try {
    await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    server.notify('notifications/initialized');
    const tools = await server.request('tools/list', {});
    assert.ok(!tools.tools.some((tool) => tool.name === 'sticker_remark'));
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('开启改备注后，sticker_remark 要求 target 并通过白名单', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-mcp-remark-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    onebot: { httpUrl: 'http://127.0.0.1:1', accessToken: '' },
    allow: { groups: ['123'], private: [] },
    dataDir: './data',
    sticker: { remark: { enabled: true } }
  }));
  const server = startServer(file);
  try {
    await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    server.notify('notifications/initialized');
    const tools = await server.request('tools/list', {});
    const remark = tools.tools.find((tool) => tool.name === 'sticker_remark');
    assert.ok(remark, '开启后应注册 sticker_remark');
    assert.ok(remark.inputSchema.required.includes('target'), 'target 必须是必填参数');

    const denied = await server.request('tools/call', { name: 'sticker_remark', arguments: { target: 'group:999', stickerId: 'a', remark: 'x' } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /白名单/);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

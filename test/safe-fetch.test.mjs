// safe-fetch 是这个项目里最复杂的安全模块（SSRF / DNS / 重定向 / 解压），这些是纯函数级的定向用例。
import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateIp, isSyntheticDnsResult, looksLikeImageBuffer, resolveSafeHost, validateFetchUrl } from '../src/safe-fetch.js';

test('isPrivateIp：私网/环回/链路本地/CGNAT/保留段一律判为私有', () => {
  const bad = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1', '192.0.0.1',
    '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1',
    '64:ff9b::c0a8:101', '::ffff:192.168.1.1', '::ffff:7f00:1', '2002:c0a8:101::1'
  ];
  for (const ip of bad) assert.equal(isPrivateIp(ip), true, `${ip} 应判为私有`);
});

test('isPrivateIp：正常公网地址不误判', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPrivateIp(ip), false, `${ip} 不应判为私有`);
  }
});

test('isPrivateIp：非法地址按私有处理（fail closed）', () => {
  for (const value of ['', 'not-an-ip', '1.2.3', '1.2.3.4.5', 'fe80::1%eth0', 'localhost']) {
    assert.equal(isPrivateIp(value), true, `${value} 应判为不安全`);
  }
});

test('isSyntheticDnsResult：TUN 模式的假地址会被识别出来走公共 DNS 复核', () => {
  assert.equal(isSyntheticDnsResult([{ address: '198.18.0.1' }, { address: '198.19.1.2' }]), true);
  assert.equal(isSyntheticDnsResult([{ address: '2001:2::1' }]), true);
  assert.equal(isSyntheticDnsResult([{ address: '93.184.216.34' }]), false);
  assert.equal(isSyntheticDnsResult([]), false);
});

test('resolveSafeHost / validateFetchUrl 拒绝本机、内网与凭据 URL', async () => {
  await assert.rejects(resolveSafeHost('localhost'), /内网|本机/);
  await assert.rejects(resolveSafeHost('foo.local'), /内网|本机/);
  await assert.rejects(resolveSafeHost('127.0.0.1'), /内网|本机/);
  await assert.rejects(resolveSafeHost('192.168.1.1'), /内网|本机/);
  await assert.rejects(validateFetchUrl('file:///etc/passwd'), /http/);
  await assert.rejects(validateFetchUrl('https://user:pass@example.com/a.png'), /凭据/);
  await assert.rejects(validateFetchUrl('not a url'), /URL 无效/);
});

test('validateFetchUrl 接受公网 IP 字面量（不触发 DNS）', async () => {
  const { ip } = await validateFetchUrl('https://1.1.1.1/x');
  assert.equal(ip, '1.1.1.1');
});

test('looksLikeImageBuffer 只认四种图片魔数', () => {
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const jpeg = Buffer.from('ffd8ffe000104a4649460001', 'hex');
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(6)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
  for (const buf of [png, jpeg, gif, webp]) assert.equal(looksLikeImageBuffer(buf), true);
  assert.equal(looksLikeImageBuffer(Buffer.from('hello world!')), false);
  assert.equal(looksLikeImageBuffer(Buffer.alloc(4)), false);
  assert.equal(looksLikeImageBuffer(null), false);
});

test('Teredo 隧道地址（2001::/32）按保留段拒绝', async () => {
  for (const ip of ['2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::1', '2001:0:0:0:0:0:0:1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} 应判为不安全`);
  }
});

test('safeFetch 拒绝非法的自定义超时', async () => {
  const { safeFetch } = await import('../src/safe-fetch.js');
  await assert.rejects(safeFetch('https://example.com/', 1000, { timeoutMs: 10 }), /无效阅读时限/);
});

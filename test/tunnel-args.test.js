// issue #78 回归：cloudflared 2026.x 把 `tunnel run` 子命令层级的 `--no-autoupdate` 删了，
// 但该 flag 在全局位置（子命令之前）仍有效。这里用假 cloudflared 记录 argv，断言顺序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startQuickTunnel, startNamedTunnel, cloudflaredArgs, firstMeaningfulErrorLine } from '../lib/tunnel.mjs';

test('argv 顺序：命名隧道的 --metrics / --protocol 必须在 run 之前（否则 cloudflared 报 flag not defined）', () => {
  const argv = cloudflaredArgs({ mode: 'named', metricsPort: 20241 });
  assert.equal(argv[0], '--no-autoupdate', '--no-autoupdate 必须在全局位置');
  const runAt = argv.indexOf('run');
  assert.ok(runAt > 0, '命名隧道必须带 run 子命令');
  assert.ok(argv.indexOf('--metrics') > 0 && argv.indexOf('--metrics') < runAt, '--metrics 必须出现在 run 之前');
  assert.ok(argv.indexOf('--protocol') < runAt, '--protocol 必须出现在 run 之前');
  assert.equal(argv[argv.indexOf('--metrics') + 1], '127.0.0.1:20241');
});

test('argv 顺序：metrics 不可用时不传 --metrics，其余参数仍在 run 之前', () => {
  const named = cloudflaredArgs({ mode: 'named', metricsPort: null });
  assert.ok(!named.includes('--metrics'), '不支持 metrics 的 binary 不能收到 --metrics');
  assert.ok(named.indexOf('--protocol') < named.indexOf('run'));

  const quick = cloudflaredArgs({ mode: 'quick', metricsPort: null, port: 3081 });
  assert.ok(!quick.includes('--metrics'));
  assert.ok(quick.includes('--url'), '快速隧道必须带 --url');
  assert.equal(quick[quick.indexOf('--url') + 1], 'http://127.0.0.1:3081');
});

async function makeFakeCloudflared() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pocket-fake-cf-'));
  const bin = join(dir, 'cloudflared');
  const record = join(dir, 'argv.json');
  // 假二进制：把 argv 写盘，再按模式打印让隧道"就绪"的行后退出
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));
const argv = process.argv.slice(2);
if (argv.includes('--url')) {
  process.stdout.write('https://abc123.trycloudflare.com\\n');
} else {
  process.stdout.write('INF Registered tunnel connection\\n');
}
`;
  await writeFile(bin, script, { mode: 0o755 });
  return { bin, record, dir };
}

function withFakeBin(bin, fn) {
  const prev = process.env.DSH_POCKET_CLOUDFLARED;
  process.env.DSH_POCKET_CLOUDFLARED = bin;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.DSH_POCKET_CLOUDFLARED;
    else process.env.DSH_POCKET_CLOUDFLARED = prev;
  });
}

// 记录子进程实际拿到的环境（用于验证代理 env 被剥离）
async function makeFakeCloudflaredRecordEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pocket-fake-cf-env-'));
  const bin = join(dir, 'cloudflared');
  const record = join(dir, 'env.json');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.env));
const argv = process.argv.slice(2);
if (argv.includes('--url')) {
  process.stdout.write('https://abc123.trycloudflare.com\\n');
} else {
  process.stdout.write('INF Registered tunnel connection\\n');
}
`;
  await writeFile(bin, script, { mode: 0o755 });
  return { bin, record, dir };
}

function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  Object.assign(process.env, env);
  return fn().finally(() => {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

test('issue #78: 快速隧道 --no-autoupdate 在全局位置（argv[0]）', async () => {
  const { bin, record, dir } = await makeFakeCloudflared();
  try {
    await withFakeBin(bin, async () => {
      const ac = new AbortController();
      const { url, kill } = await startQuickTunnel({ port: 3081, signal: ac.signal });
      kill();
      const argv = JSON.parse(await readFile(record, 'utf8'));
      assert.ok(url.includes('trycloudflare.com'), '应解析到快速隧道 URL');
      assert.equal(argv[0], '--no-autoupdate', '--no-autoupdate 必须是 argv 第一个（全局位置）');
      assert.ok(argv.indexOf('tunnel') > argv.indexOf('--no-autoupdate'), '--no-autoupdate 必须在 tunnel 子命令之前');
      assert.ok(argv.includes('--url'), '快速隧道应含 --url');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('issue #78: 命名隧道 --no-autoupdate 在全局位置（argv[0]，含 run）', async () => {
  const { bin, record, dir } = await makeFakeCloudflared();
  try {
    await withFakeBin(bin, async () => {
      const ac = new AbortController();
      const res = await startNamedTunnel({ token: 'faketoken', signal: ac.signal });
      res.kill();
      const argv = JSON.parse(await readFile(record, 'utf8'));
      assert.equal(res.url, null, '命名隧道 url 应为 null（由调用方拼固定域名）');
      assert.equal(argv[0], '--no-autoupdate', '--no-autoupdate 必须是 argv 第一个（全局位置）');
      assert.ok(argv.indexOf('tunnel') > argv.indexOf('--no-autoupdate'), '--no-autoupdate 必须在 tunnel 子命令之前');
      assert.ok(argv.includes('run'), '命名隧道应含 run 子命令');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('issue #1033: 快速隧道不把本机代理 env 传给 cloudflared（避免 error 1033）', async () => {
  const { bin, record, dir } = await makeFakeCloudflaredRecordEnv();
  try {
    await withFakeBin(bin, async () => {
      await withEnv({ HTTP_PROXY: 'http://127.0.0.1:50168', HTTPS_PROXY: 'http://127.0.0.1:50168' }, async () => {
        const ac = new AbortController();
        const { kill } = await startQuickTunnel({ port: 3081, signal: ac.signal });
        kill();
        const env = JSON.parse(await readFile(record, 'utf8'));
        assert.equal(env.HTTP_PROXY, undefined, 'HTTP_PROXY 不应传给 cloudflared（否则隧道边缘连接被绕进本地代理 → 1033）');
        assert.equal(env.HTTPS_PROXY, undefined, 'HTTPS_PROXY 不应传给 cloudflared');
        assert.ok(env.PATH !== undefined, 'PATH 等其它环境应保留');
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('issue #1033: 命名隧道同样不传代理 env，但保留 TUNNEL_TOKEN', async () => {
  const { bin, record, dir } = await makeFakeCloudflaredRecordEnv();
  try {
    await withFakeBin(bin, async () => {
      await withEnv({ HTTP_PROXY: 'http://127.0.0.1:50168', HTTPS_PROXY: 'http://127.0.0.1:50168' }, async () => {
        const ac = new AbortController();
        const res = await startNamedTunnel({ token: 'faketoken', signal: ac.signal });
        res.kill();
        const env = JSON.parse(await readFile(record, 'utf8'));
        assert.equal(env.HTTPS_PROXY, undefined, 'HTTPS_PROXY 不应传给 cloudflared');
        assert.equal(env.TUNNEL_TOKEN, 'faketoken', 'TUNNEL_TOKEN 必须保留');
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('firstMeaningfulErrorLine: 参数错误取开头首行', () => {
  const buf = 'Incorrect Usage: flag provided but not defined: -no-autoupdate\n\nNAME:\n  cloudflared tunnel run - Proxy a local web server\n--bastion Runs as jump host ...';
  assert.equal(firstMeaningfulErrorLine(buf), 'Incorrect Usage: flag provided but not defined: -no-autoupdate');
});

test('firstMeaningfulErrorLine: 版本横幅在前后仍能取到参数错误行', () => {
  const buf = 'cloudflared version 2026.4.0\nIncorrect Usage: flag provided but not defined: -no-autoupdate\n\nNAME:\n  cloudflared tunnel run ...';
  assert.equal(firstMeaningfulErrorLine(buf), 'Incorrect Usage: flag provided but not defined: -no-autoupdate');
});

test('firstMeaningfulErrorLine: 运行期错误（403）仍取尾部', () => {
  const buf = 'INF Starting tunnel\nERR Failed to connect to origin: 403 Forbidden\nERR retrying';
  const r = firstMeaningfulErrorLine(buf);
  assert.ok(r.includes('403'), '应保留尾部含 403 的报错信息');
});

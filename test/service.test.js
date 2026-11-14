// dsh-pocket 服务 + RPC 测试（stub 隧道/代理，无网络）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPocketService, selectLanIPv4 } from '../lib/service.mjs';
import { installPocketRpc } from '../lib/web-rpc.js';
import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS } from '../client/api.js';
import { isValidIpv4 } from '../lib/ip.mjs';

function fakeCtxConnection() {
  let handler = null;
  const handle = (channel, fn, opts) => {
    assert.equal(channel, POCKET_RPC_CHANNEL);
    assert.deepEqual(opts, { authority: 'loopback' });
    handler = fn;
    return () => { handler = null; };
  };
  return { rpc: { handle }, get handler() { return handler; } };
}

function stubInternals() {
  const started = [];
  let tunnelUrl = null;
  return {
    started,
    lanIPv4: () => '192.168.1.50',
    lanCandidates: async () => ['192.168.1.50', '100.119.24.44'],
    encodeQr: async (text) => `data:qr;${text}`,
    createProxy: async ({ port }) => ({
      port,
      close: async () => { started.push('closed'); },
    }),
    startTunnel: async ({ port }) => {
      started.push(`tunnel:${port}`);
      tunnelUrl = 'https://abc-123.trycloudflare.com';
      return tunnelUrl;
    },
    get tunnelUrl() { return tunnelUrl; },
  };
}

/** 构造 networkInterfaces() 形状的最小接口表。 */
function ifaces(entries) {
  return Object.fromEntries(entries.map(([name, ip]) => [name, [{ address: ip, family: 'IPv4', internal: false }]]));
}

test('selectLanIPv4：排在前面的 Radmin VPN 不遮蔽 WLAN 私网地址', () => {
  assert.equal(
    selectLanIPv4(ifaces([
      ['Radmin VPN', '198.51.100.10'],
      ['WLAN', '192.168.1.50'],
    ])),
    '192.168.1.50',
  );
});

test('selectLanIPv4：两张私网网卡时优先名称像物理网卡的接口', () => {
  assert.equal(
    selectLanIPv4(ifaces([
      ['vEthernet (WSL)', '172.25.0.1'],
      ['以太网', '10.0.0.8'],
    ])),
    '10.0.0.8',
    '同为 RFC1918 私网时，物理网卡优先于虚拟网卡',
  );
});

test('selectLanIPv4（issue #43）：Easytier 网卡不遮蔽改名后的物理网卡', () => {
  assert.equal(
    selectLanIPv4(ifaces([
      ['et_15_x3sw', '10.126.126.1'], // Easytier P2P VPN 网卡
      ['有线连接', '192.168.1.1'],    // 改过名的物理网卡（中文名）
    ])),
    '192.168.1.1',
    'Easytier（et_ 前缀）被识别为 VPN 减分，中文物理网卡名（有线）加分',
  );
  // 物理网卡排在前时也不变（"无线网络连接"中文名）
  assert.equal(
    selectLanIPv4(ifaces([
      ['无线网络连接', '192.168.31.8'],
      ['et_aaa01', '10.126.126.1'],
    ])),
    '192.168.31.8',
    '无线网络连接（中文物理名）优先',
  );
});

test('selectLanIPv4：没有私网地址时回退到非回环地址（纯 VPN 环境仍可用）', () => {
  assert.equal(
    selectLanIPv4(ifaces([
      ['Radmin VPN', '198.51.100.10'],
      ['Loopback Pseudo-Interface 1', '127.0.0.1'],
      ['WLAN', '169.254.12.34'],
    ])),
    '198.51.100.10',
  );
});

test('selectLanIPv4：空接口表返回 null', () => {
  assert.equal(selectLanIPv4({}), null);
});

test('selectLanIPv4（blacklist）：按网卡名或 IP 忽略，排除 VirtualBox host-only 后选到 WLAN', () => {
  const list = ifaces([
    ['以太网 8', '192.168.56.1'],
    ['WLAN', '192.168.5.19'],
  ]);
  assert.equal(selectLanIPv4(list), '192.168.56.1', '无黑名单时按原逻辑（平局选枚举第一个）');
  assert.equal(selectLanIPv4(list, ['以太网 8']), '192.168.5.19', '按网卡名忽略');
  assert.equal(selectLanIPv4(list, ['192.168.56.1']), '192.168.5.19', '按 IP 忽略');
  assert.equal(selectLanIPv4(list, ['以太网 8', '192.168.56.1']), '192.168.5.19', '两者混用');
  assert.equal(selectLanIPv4(list, ['不存在的网卡']), '192.168.56.1', '未命中的条目无影响');
  assert.equal(selectLanIPv4(list, []), '192.168.56.1', '空黑名单无影响');
  assert.equal(selectLanIPv4(list, ['wlan']), '192.168.56.1', '网卡名比较忽略大小写（WLAN 已命中则仍选第一张）');
});

test('selectLanIPv4（issue #176）：Windows ICS / 移动热点虚拟网卡 本地连接* N 不被当物理网卡', () => {
  // 模拟 Windows 开热点：ICS 虚拟适配器 本地连接* 2（192.168.137.1，固定保留段），
  // 真实 WLAN 在另一私网段。ICS 网卡常排在 WLAN 之前（枚举顺序），旧实现会选到不可达的 137.1。
  assert.equal(
    selectLanIPv4(ifaces([
      ['本地连接* 2', '192.168.137.1'],
      ['WLAN', '192.168.1.50'],
    ])),
    '192.168.1.50',
    'ICS 虚拟网卡不加分，真实 WLAN 胜出',
  );
  // ICS 排在 WLAN 之前也一样（旧实现此处会误选 137.1）
  assert.equal(
    selectLanIPv4(ifaces([
      ['WLAN', '192.168.1.50'],
      ['本地连接* 2', '192.168.137.1'],
    ])),
    '192.168.1.50',
  );
  // 同分时（假设真实网卡名也不匹配 PHYSICAL）仍优先非 192.168.137.x 段
  assert.equal(
    selectLanIPv4(ifaces([
      ['本地连接* 9', '192.168.137.1'],
      ['SomeAdapter', '192.168.137.2'],
    ])),
    '192.168.137.2',
    '兜底：同分优先非 ICS 保留段',
  );
});

test('service：lanIpOverride 优先于自动选择，status 返回候选地址', async () => {
  const internals = stubInternals();
  let override = '';
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getLanIpOverride: () => override });
  await service.startProxy();

  let st = await service.status();
  assert.equal(st.lanUrl, 'http://192.168.1.50:3081', '默认自动选择');
  assert.deepEqual(st.lanCandidates, ['192.168.1.50', '100.119.24.44'], '候选包含 Tailscale IP');
  assert.equal(st.lanIpOverride, '', '未设置覆盖');

  override = '100.119.24.44';
  st = await service.status();
  assert.equal(st.lanUrl, 'http://100.119.24.44:3081', '手动覆盖优先');
  assert.equal(st.lanIpOverride, '100.119.24.44', '状态返回当前覆盖');

  override = 'not-an-ip';
  st = await service.status();
  assert.equal(st.lanUrl, 'http://192.168.1.50:3081', '非法覆盖被忽略，回退自动选择');
  assert.equal(st.lanIpOverride, '', '非法覆盖不进入状态');

  await service.dispose();
});


test('service：startProxy → 局域网状态（含二维码）；startTunnel → 公网状态', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals });

  const before = await service.status();
  assert.equal(before.proxyRunning, false);

  const proxy = await service.startProxy();
  assert.equal(proxy.port, 3081);
  const lan = await service.status();
  assert.equal(lan.lanUrl, 'http://192.168.1.50:3081');
  assert.equal(lan.lanQr, 'data:qr;http://192.168.1.50:3081');
  assert.equal(lan.tunnelRunning, false);

  const url = await service.startTunnel();
  assert.equal(url, 'https://abc-123.trycloudflare.com');
  const pub = await service.status();
  assert.equal(pub.tunnelRunning, true);
  assert.equal(pub.tunnelQr, 'data:qr;https://abc-123.trycloudflare.com');
  assert.deepEqual(internals.started, ['tunnel:3081'], '隧道指向代理端口');

  service.stopTunnel();
  const stopped = await service.status();
  assert.equal(stopped.tunnelRunning, false);
  assert.equal(stopped.lanUrl, 'http://192.168.1.50:3081', '停隧道不影响局域网代理');

  await service.dispose();
});

test('service：QR 生成失败时记录错误码，status 仍可用（issue #211）', async () => {
  const warnings = [];
  const internals = {
    ...stubInternals(),
    encodeQr: async () => {
      const error = new Error('QR encoder unavailable');
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    },
  };
  const service = createPocketService({
    dshPort: 3080,
    port: 3081,
    internals,
    log: {
      info() {},
      log() {},
      warn: (...args) => warnings.push(args),
    },
  });

  await service.startProxy();
  const status = await service.status();

  assert.equal(status.lanQr, null, '生成失败时 status 返回 null，由前端提示');
  assert.ok(
    warnings.some(([message, code, detail]) =>
      message === 'dsh-pocket: QR generation failed (%s): %s'
        && code === 'MODULE_NOT_FOUND'
        && detail === 'QR encoder unavailable'),
    '日志要带错误码与原因，便于区分缺依赖与其它失败',
  );

  await service.dispose();
});

test('RPC：status / tunnel.start / tunnel.stop / 未知端点', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, { service, log: { error() {}, warn() {} } });

  // 先让代理跑起来（插件 apply 里会自动启动）
  await service.startProxy();

  const s1 = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(s1.ok, true);
  assert.equal(s1.value.lanUrl, 'http://192.168.1.50:3081');
  assert.ok(s1.value.lanQr.startsWith('data:qr;'), '局域网二维码 data URL');

  const denied = await conn.handler(POCKET_ENDPOINTS.tunnelStart, {});
  assert.equal(denied.ok, false, '未勾选免责声明 → 拒绝开启');
  assert.equal(denied.error.code, 'bad-request');
  assert.ok(denied.error.message.includes('免责声明'), '提示勾选免责声明');

  const started = await conn.handler(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true });
  assert.equal(started.ok, true);
  assert.equal(started.value.tunnelRunning, true);
  assert.equal(started.value.tunnelUrl, 'https://abc-123.trycloudflare.com');

  const stopped = await conn.handler(POCKET_ENDPOINTS.tunnelStop, {});
  assert.equal(stopped.ok, true);
  assert.equal(stopped.value.tunnelRunning, false);

  const unknown = await conn.handler('nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'bad-request');

  await service.dispose();
});

test('RPC：lan.setOverride 设置/清除覆盖地址，非法 IP 被拒绝', async () => {
  const internals = stubInternals();
  let stored = '';
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getLanIpOverride: () => stored });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    getLanIpOverride: () => stored,
    setLanIpOverride: (ip) => {
      if (ip && !isValidIpv4(ip)) throw new Error('局域网地址必须是 IPv4 地址 | LAN address must be an IPv4 address');
      stored = ip;
      return ip;
    },
    log: { error() {}, warn() {} },
  });
  await service.startProxy();

  const set = await conn.handler(POCKET_ENDPOINTS.lanSetOverride, { ip: '100.119.24.44' });
  assert.equal(set.ok, true);
  assert.equal(set.value.lanIpOverride, '100.119.24.44', '覆盖地址已保存');
  const st = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(st.value.lanUrl, 'http://100.119.24.44:3081', '二维码使用覆盖地址');

  const bad = await conn.handler(POCKET_ENDPOINTS.lanSetOverride, { ip: '999.1.1.1' });
  assert.equal(bad.ok, false, '非法地址拒绝');
  assert.equal(bad.error.code, 'bad-request');

  const clear = await conn.handler(POCKET_ENDPOINTS.lanSetOverride, { ip: '' });
  assert.equal(clear.ok, true);
  assert.equal(clear.value.lanIpOverride, '', '清除覆盖');
  const restored = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(restored.value.lanUrl, 'http://192.168.1.50:3081', '恢复自动选择');

  await service.dispose();
});

test('RPC：lan.setEnabled 设置局域网访问总开关并回写到 status', async () => {
  const internals = stubInternals();
  let lanOn = true;
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getLanEnabled: () => lanOn });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    getLanEnabled: () => lanOn,
    setLanEnabled: (on) => { lanOn = on === true; return lanOn; },
    log: { error() {}, warn() {} },
  });
  await service.startProxy();

  const s1 = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(s1.ok, true);
  assert.equal(s1.value.lanEnabled, true, '默认开启');

  const off = await conn.handler(POCKET_ENDPOINTS.lanSetEnabled, { on: false });
  assert.equal(off.ok, true);
  assert.equal(off.value.lanEnabled, false, '关闭成功');
  assert.equal((await conn.handler(POCKET_ENDPOINTS.status, {})).value.lanEnabled, false, 'status 反映关闭');

  const on = await conn.handler(POCKET_ENDPOINTS.lanSetEnabled, { on: true });
  assert.equal(on.ok, true);
  assert.equal(on.value.lanEnabled, true, '重新开启');

  await service.dispose();
});

test('隧道进度：startTunnel 阶段透出到 status.tunnelState', async () => {
  const internals = {
    ...stubInternals(),
    startTunnel: async ({ onPhase }) => {
      onPhase('downloading');
      onPhase('registering');
      onPhase('ready');
      return { url: 'https://x.trycloudflare.com', kill: () => {} };
    },
  };
  const service = createPocketService({ dshPort: 3080, port: 3081, internals });
  await service.startProxy();
  await service.startTunnel();
  const s = await service.status();
  assert.equal(s.tunnelState.phase, 'ready');
  assert.ok(s.tunnelState.startedAt > 0, '开始时间已记录');
  assert.ok(s.tunnelState.detail.length > 0);
  service.stopTunnel();
  const after = await service.status();
  assert.equal(after.tunnelState.phase, 'idle');
});

test('lib/index.js 模块可加载，apply 可调用（防模块级 ReferenceError 回归）', async () => {
  // 回归线：apply 内部曾出现模块级 ReferenceError（提前引用参数），此处只做冒烟防护
  const mod = await import('../lib/index.js');
  assert.equal(typeof mod.apply, 'function');
  assert.equal(typeof mod.name, 'string');

  // apply 用最小 fake ctx 调用不应抛错（不启动真实代理：注入 stub service）
  const ctx = {
    logger: () => ({ error() {}, info() {}, warn() {} }),
    webServer: { port: 3080 },
    on: () => () => {},
    effect: () => {},
  };
  const stubService = {
    startProxy: async () => ({}), dispose: async () => {}, status: async () => ({}),
    startTunnel: async () => 'https://x.trycloudflare.com', stopTunnel: () => {},
  };
  // apply 内部用 ctx.effect 注册清理，返回值不是契约；这里只验证不抛错
  mod.apply(ctx, {}, {
    service: stubService,
  });
  assert.ok(true, 'apply 正常路径不抛错');
});

test('stop 竞态：stop 打断 in-flight 后立即 start，不会并发 spawn cloudflared', async () => {
  let spawnCount = 0;
  let releaseA;
  const gateA = new Promise((r) => { releaseA = r; });
  const internals = {
    ...stubInternals(),
    startTunnel: async ({ signal }) => {
      spawnCount += 1;
      await gateA; // 挂起直到 releaseA
      if (signal.aborted) throw new Error('cancelled');
      return { url: 'https://a.trycloudflare.com', kill: () => {} };
    },
  };
  const service = createPocketService({ dshPort: 3080, port: 3081, internals });
  await service.startProxy();

  const pA = service.startTunnel().catch(() => null); // A in-flight
  await new Promise((r) => setTimeout(r, 20));
  service.stopTunnel(); // abort A、清 tunnelPromise
  const pB = service.startTunnel().catch(() => null); // B 新起（gate 尚未释放，B 也挂起）
  await new Promise((r) => setTimeout(r, 20));
  releaseA(); // 释放 A：其 finally 不得清掉 B 的引用
  await pA;
  await new Promise((r) => setTimeout(r, 20));
  await service.startTunnel().catch(() => null); // C：应复用 B 或等 B 完成，不再 spawn

  assert.equal(spawnCount, 2, 'A、B 各 spawn 一次，C 不产生第三个 cloudflared');

  service.stopTunnel();
  await service.dispose();
});

test('killHint：按平台返回停止命令（Windows 无 lsof）', async () => {
  const { killHint } = await import('../lib/web-rpc.js');
  const hint = killHint(3080);
  if (process.platform === 'win32') {
    assert.ok(hint.includes('netstat') && hint.includes('taskkill'), 'Windows 用 netstat/taskkill');
  } else {
    assert.ok(hint.includes('lsof -ti :3080'), 'macOS/Linux 用 lsof');
  }
  assert.ok(!hint.includes('undefined'), '端口正确插入');
});

test('tsinghuaBottleUrl：按平台/架构匹配清华 bottle（Windows 无匹配；mock 目录，不依赖外网）', async () => {
  const { tsinghuaBottleUrl } = await import('../lib/tunnel.mjs');
  const origFetch = globalThis.fetch;
  // mock 清华目录页（CI 在境外，真实访问清华会超时导致测试抖动）
  globalThis.fetch = async (url) => {
    if (String(url).includes('mirrors.tuna.tsinghua.edu.cn')) {
      return {
        ok: true,
        status: 200,
        text: async () => `
          <a href="cloudflared-2026.8.2.arm64_sequoia.bottle.tar.gz">
          <a href="cloudflared-2026.8.2.arm64_sonoma.bottle.tar.gz">
          <a href="cloudflared-2026.8.2.arm64_tahoe.bottle.tar.gz">
          <a href="cloudflared-2026.8.2.arm64_linux.bottle.tar.gz">
          <a href="cloudflared-2026.8.2.sonoma.bottle.tar.gz">
          <a href="cloudflared-2026.8.2.x86_64_linux.bottle.tar.gz">
        `,
      };
    }
    return origFetch(url);
  };
  try {
    // Windows：无 Homebrew bottle → null
    assert.equal(await tsinghuaBottleUrl({ os: 'windows', a: 'amd64' }), null, 'Windows 不走清华');
    // macOS arm64 → 清华 arm64_ 开头的 bottle URL
    const macUrl = await tsinghuaBottleUrl({ os: 'darwin', a: 'arm64' });
    assert.ok(macUrl && macUrl.includes('mirrors.tuna.tsinghua.edu.cn'), 'macOS 有清华 URL: ' + macUrl);
    assert.ok(/arm64_(sequoia|sonoma|tahoe)\.bottle\.tar\.gz$/.test(macUrl), '匹配 arm64 macOS bottle: ' + macUrl);
    // macOS Intel → 无 arm64 前缀的 bottle
    const intelUrl = await tsinghuaBottleUrl({ os: 'darwin', a: 'amd64' });
    assert.ok(intelUrl && !/arm64_/.test(intelUrl), 'Intel 用无前缀 bottle: ' + intelUrl);
    // Linux：Homebrew bottle 的 ELF 解释器是占位符，不能直接用 → 跳过清华（issue #22）
    assert.equal(await tsinghuaBottleUrl({ os: 'linux', a: 'arm64' }), null, 'Linux 不走清华（Homebrew bottle 不可用）');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('桌面端（desktop=true）：status 带标志，正常功能不受影响', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    desktop: true,
    log: { error() {}, warn() {} },
  });
  await service.startProxy();

  // status 带 desktop 标志
  const s = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(s.ok, true);
  assert.equal(s.value.desktop, true, 'status 标记桌面端');

  // 正常功能（隧道）不受影响（同样需要免责声明确认）
  const t = await conn.handler(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true });
  assert.equal(t.ok, true, '隧道功能照常');

  await service.dispose();
});

test('startProxy：端口被占（EADDRINUSE）时自动尝试下一个端口', async () => {
  let attempts = 0;
  const internals = {
    ...stubInternals(),
    createProxy: async ({ port: p }) => {
      attempts += 1;
      if (attempts === 1) {
        const e = new Error('address in use');
        e.code = 'EADDRINUSE';
        throw e;
      }
      return { port: p, close: async () => {} };
    },
  };
  const service = createPocketService({ dshPort: 3080, port: 3081, internals });
  const proxy = await service.startProxy();
  assert.equal(attempts, 2, '第一个端口失败后重试');
  assert.equal(proxy.port, 3082, '自动换到下一个端口');
  const st = await service.status();
  assert.equal(st.proxyRunning, true);
  assert.ok(st.lanUrl.includes(':3082'), 'URL 使用实际端口');
  await service.dispose();
});

test('公网隧道自动恢复：开启时持久化标记，重启后 restoreTunnelIfNeeded 自动拉起（issue #11）', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshp-auto-'));

  let startCount = 0;
  const internals = {
    ...stubInternals(),
    startTunnel: async () => {
      startCount += 1;
      return { url: 'https://auto.trycloudflare.com', kill: () => {} };
    },
  };
  const service = createPocketService({ dshPort: 3080, port: 3081, home, internals });
  await service.startProxy();

  // 开启隧道 → 持久化标记（persistAutoTunnel 是异步 fire-and-forget，等它落盘）
  await service.startTunnel();
  await new Promise((r) => setTimeout(r, 60));
  const statePath = path.join(home, 'dsh-pocket', 'tunnel-auto.json');
  assert.ok((await fsp.readFile(statePath, 'utf8')).includes('"at"'), '开启后写入标记');

  // 模拟重启：新 service 实例（相同 home）→ 自动恢复
  const service2 = createPocketService({ dshPort: 3080, port: 3081, home, internals });
  await service2.startProxy();
  await service2.restoreTunnelIfNeeded();
  assert.equal(startCount, 2, '重启后自动拉起隧道');

  // 手动关闭 → 标记清除 → 下次不自动恢复
  service2.stopTunnel();
  // Windows 上 rm 可能与实时扫描竞态偶发失败（clearAutoTunnel 内部吞错），轮询等待落盘
  let afterClose = null;
  for (let i = 0; i < 50; i++) {
    afterClose = await fsp.readFile(statePath, 'utf8').catch(() => null);
    if (afterClose === null) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(afterClose, null, '关闭后删除标记');
  const service3 = createPocketService({ dshPort: 3080, port: 3081, home, internals });
  await service3.startProxy();
  await service3.restoreTunnelIfNeeded();
  assert.equal(startCount, 2, '无标记不自动恢复');

  await fsp.rm(home, { recursive: true, force: true });
});

test('公网隧道自动恢复：dispose（进程退出/重启）保留标记，下次启动仍自动拉起；手动 stopTunnel 仍删标记（issue #11 语义澄清）', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshp-dispose-'));

  let startCount = 0;
  const internals = {
    ...stubInternals(),
    startTunnel: async () => {
      startCount += 1;
      return { url: 'https://auto.trycloudflare.com', kill: () => {} };
    },
  };
  const statePath = path.join(home, 'dsh-pocket', 'tunnel-auto.json');

  const service1 = createPocketService({ dshPort: 3080, port: 3081, home, internals });
  await service1.startProxy();
  await service1.startTunnel();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok((await fsp.readFile(statePath, 'utf8')).includes('"at"'), '开启后写入标记');

  // 模拟 DSH 正常重启：dispose（插件卸载）→ 隧道随进程被动消失，不是用户主动关闭 → 标记必须保留。
  // 回归背景：dispose 曾无条件 clearAutoTunnel，导致每次正常重启后隧道永远不会自动恢复
  // （只有进程被强杀、dispose 未跑完时才侥幸可用）。
  await service1.dispose();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok((await fsp.readFile(statePath, 'utf8')).includes('"at"'), 'dispose 保留自动恢复标记');

  const service2 = createPocketService({ dshPort: 3080, port: 3081, home, internals });
  await service2.startProxy();
  await service2.restoreTunnelIfNeeded();
  assert.equal(startCount, 2, 'dispose 后重启仍自动恢复');

  // 对照：手动 stopTunnel()（设置页关闭）仍然删除标记
  service2.stopTunnel();
  let afterClose = null;
  for (let i = 0; i < 50; i++) {
    afterClose = await fsp.readFile(statePath, 'utf8').catch(() => null);
    if (afterClose === null) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(afterClose, null, '手动关闭仍删除标记');

  await fsp.rm(home, { recursive: true, force: true });
});

test('RPC：局域网密码独立于公网；lanTokenRefresh 刷新并返回新密码（issue #18）', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals });
  const conn = fakeCtxConnection();
  let lan = '11111111';
  installPocketRpc({ connection: conn }, {
    service,
    getToken: () => '99999999',
    getLanToken: () => lan,
    refreshLanToken: () => { lan = '22222222'; return lan; },
    log: { error() {}, warn() {} },
  });
  await service.startProxy();

  const s = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(s.value.accessToken, '99999999', '公网密码');
  assert.equal(s.value.lanToken, '11111111', '局域网密码独立');

  const r = await conn.handler(POCKET_ENDPOINTS.lanTokenRefresh, {});
  assert.equal(r.ok, true);
  assert.equal(r.value.lanToken, '22222222', '刷新返回新密码');
  const s2 = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(s2.value.lanToken, '22222222', 'status 反映新密码');

  await service.dispose();
});

test('WSL 局域网 IP（issue #39）：parseIpconfig 取物理网卡 IP、排除虚拟网卡；detectWsl 识别环境', async () => {
  const { parseIpconfig, detectWsl } = await import('../lib/service.mjs');

  // 中文 ipconfig 输出：物理网卡在前、虚拟网卡（vEthernet (WSL)）在后
  const zhSample = `\u4ee5\u592a\u7f51\u9002\u914d\u5668 WLAN:
\n\n   连接特定的 DNS 后缀 . . . . . . . :
   本地链接 IPv6 地址. . . . . . . . : fe80::1%12
   IPv4 地址 . . . . . . . . . . . . : 192.168.1.100
   子网掩码  . . . . . . . . . . . . : 255.255.255.0
   默认网关. . . . . . . . . . . . . : 192.168.1.1

\u4ee5\u592a\u7f51\u9002\u914d\u5668 vEthernet (WSL (Hyper-V firewall)):
\n\n   连接特定的 DNS 后缀 . . . . . . . :
   IPv4 地址 . . . . . . . . . . . . : 172.26.96.1
   子网掩码  . . . . . . . . . . . . : 255.255.255.240

\u4ee5\u592a\u7f51\u9002\u914d\u5668 vEthernet (Docker NAT):
\n\n   IPv4 地址 . . . . . . . . . . . . : 10.0.75.1
   子网掩码  . . . . . . . . . . . . : 255.255.255.0
`;
  const zh = parseIpconfig(zhSample);
  assert.deepEqual(zh, ['192.168.1.100'], '中文输出：只取物理网卡 WLAN 的 IP，排除 vEthernet(WSL/Docker)');

  // 英文 ipconfig 输出
  const enSample = `Ethernet adapter Ethernet:
\n\n   Connection-specific DNS Suffix  . :
   Link-local IPv6 Address . . . . . : fe80::2%4
   IPv4 Address. . . . . . . . . . . : 192.168.50.10
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.50.1

Ethernet adapter vEthernet (WSL):
\n\n   IPv4 Address. . . . . . . . . . . : 172.20.0.1
   Subnet Mask . . . . . . . . . . . : 255.255.255.240
`;
  const en = parseIpconfig(enSample);
  assert.deepEqual(en, ['192.168.50.10'], '英文输出：只取物理网卡 IP');

  // 虚拟网卡在前也跳过（vEthernet 块被排除）
  const vpnFirst = `Ethernet adapter vEthernet (WSL):
\n\n   IPv4 Address. . . . . . . . . . . : 172.20.0.1

Ethernet adapter Wi-Fi:
\n\n   IPv4 Address. . . . . . . . . . . : 192.168.31.8
`;
  assert.deepEqual(parseIpconfig(vpnFirst), ['192.168.31.8'], '虚拟网卡在前也正确跳过');

  // 手动覆盖候选：保留 Tailscale/VPN 地址供设置页选择
  const tailscaleFirst = `Unknown adapter Tailscale:

   IPv4 Address. . . . . . . . . . . : 100.119.24.44

Ethernet adapter WLAN:

   IPv4 Address. . . . . . . . . . . : 10.179.45.172
`;
  assert.deepEqual(parseIpconfig(tailscaleFirst), ['10.179.45.172'], '自动模式仍排除 Tailscale');
  assert.deepEqual(
    parseIpconfig(tailscaleFirst, { includeVpn: true }),
    ['100.119.24.44', '10.179.45.172'],
    '候选模式保留 Tailscale/VPN 地址',
  );

  // detectWsl：环境变量触发（本机 macOS 无 /proc/version，走 env 分支）
  const prev = process.env.WSL_DISTRO_NAME;
  process.env.WSL_DISTRO_NAME = 'Ubuntu';
  try {
    assert.equal(detectWsl(), true, 'WSL_DISTRO_NAME 存在 → 判定 WSL');
  } finally {
    if (prev === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = prev;
  }
  assert.equal(detectWsl(), false, '非 WSL 环境返回 false（macOS 无 /proc/version microsoft 标记）');

  // WSLENV 由 Windows Terminal 在**原生 Windows** 上也会设置（WT_SESSION 等），
  // 不能作为 WSL 判据——回归：仅设 WSLENV 不得误判为 WSL（issue #39 误报）。
  const prevWslEnv = process.env.WSLENV;
  process.env.WSLENV = 'WT_SESSION:WT_PROFILE_ID:';
  try {
    assert.equal(detectWsl(), false, '仅 WSLENV 不判定为 WSL（Windows Terminal 误报）');
  } finally {
    if (prevWslEnv === undefined) delete process.env.WSLENV;
    else process.env.WSLENV = prevWslEnv;
  }
});

test('startTunnel 同步抛错后不残留 rejected 的 in-flight（TDZ 回归）：修好配置后可再次启动', async () => {
  // 回归背景：启动流程里 `const p = tunnelPromise` 声明在 async IIFE 之后，
  // 而 IIFE 体内没有 await 之前的挂起点——getTunnelConfig 之类同步抛错时，
  // finally 会引用尚未初始化的 `p` 触发 TDZ 报错，tunnelPromise 永远停在
  // rejected，后续 startTunnel 一直复用这个失败态，隧道再也起不来。
  const internals = stubInternals();
  let broken = true;
  const service = createPocketService({
    dshPort: 3080,
    port: 3081,
    internals,
    getTunnelConfig: () => {
      if (broken) throw new Error('config boom');
      return { mode: 'quick' };
    },
  });
  await service.startProxy();
  await assert.rejects(() => service.startTunnel(), /config boom/, '第一次因配置读取失败而拒绝');

  broken = false;
  const url = await service.startTunnel();
  assert.equal(url, 'https://abc-123.trycloudflare.com', '修好后能正常启动，没有残留失败态');
  assert.equal((await service.status()).tunnelRunning, true, '隧道确实起来了');
  await service.dispose();
});

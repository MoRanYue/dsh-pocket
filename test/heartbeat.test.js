import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { attachWebSocketHeartbeat } from '../lib/proxy.mjs';

/** 假 socket：记录写出的 Ping，destroy 时按真实行为发 close。 */
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writes = 0;
  }

  write() {
    this.writes += 1;
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

test('WS 心跳（issue #221）：默认容忍 8 个静默周期（4 分钟），先 Ping 再计数', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const socket = new FakeSocket();
  attachWebSocketHeartbeat(socket);
  for (let i = 1; i <= 7; i += 1) {
    t.mock.timers.tick(30_000);
    assert.equal(socket.destroyed, false, `第 ${i} 个静默周期仍保留连接`);
  }
  assert.equal(socket.writes, 7, '每个周期都发过 Ping');
  // 旧默认 2 个周期（60s）会把「手机切会话/切前后台」的正常空闲当成死链
  t.mock.timers.tick(30_000);
  assert.equal(socket.destroyed, true, '第 8 个静默周期才断开，交给客户端重连');
  assert.equal(socket.writes, 8, '断开前那一轮也先发了 Ping');
});

test('WS 心跳：收到任何入站字节就归零，空闲但有心跳的连接不会被误杀', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const socket = new FakeSocket();
  attachWebSocketHeartbeat(socket, { intervalMs: 1000, missLimit: 3 });
  for (let i = 0; i < 10; i += 1) {
    t.mock.timers.tick(1000);
    socket.emit('data', Buffer.from([0x8a, 0x00])); // Pong
  }
  assert.equal(socket.destroyed, false, '每轮都有 Pong → 永不判死');
  assert.equal(socket.writes, 10, 'Ping 照常发送');
});

test('WS 心跳：missLimit<=0 只保活、永不主动断链', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const socket = new FakeSocket();
  attachWebSocketHeartbeat(socket, { intervalMs: 100, missLimit: 0 });
  t.mock.timers.tick(100 * 50);
  assert.equal(socket.destroyed, false, '长空闲场景也不断链');
  assert.equal(socket.writes, 50, '每个周期仍在 Ping 保活');
});

test('WS 心跳：连接关闭后停止定时器，不再空转', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const socket = new FakeSocket();
  attachWebSocketHeartbeat(socket, { intervalMs: 100 });
  t.mock.timers.tick(100);
  assert.equal(socket.writes, 1);
  socket.emit('close');
  t.mock.timers.tick(100 * 20);
  assert.equal(socket.writes, 1, '关闭后不再 Ping');
});

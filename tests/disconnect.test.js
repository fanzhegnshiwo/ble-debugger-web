// 断开连接的会话取消逻辑回归测试（假 GATT 设备，无真实蓝牙依赖）
// 背景：手动断开时，进行中的"服务发现失败自动重试/首连重试"会把设备连回去，
// 表现为"点断开连接没反应"。修复：disconnect() 递增会话代数，流水线在每个
// await 恢复点检查代数，不匹配即静默中止。

import test from 'node:test';
import assert from 'node:assert/strict';

import { BleAdapter } from '../js/ble.js';

function fakeDevice() {
  const d = {
    name: 'TEST-DEV',
    id: 'test-1',
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() { /* 测试中无需 */ },
    // 挂起控制器：由测试决定 getPrimaryServices 何时完成/失败
    _servicesPromise: null,
    gatt: {
      connected: false,
      connectCount: 0,
      disconnectCount: 0,
      async connect() { this.connectCount++; this.connected = true; },
      disconnect() {
        this.disconnectCount++;
        this.connected = false;
        (d.listeners.gattserverdisconnected || []).forEach((fn) => fn());
      },
      getPrimaryServices() { return d._servicesPromise; },
    },
  };
  return d;
}

test('发现服务挂起时手动断开：挂起完成后不再发 connected、不重连', async () => {
  const adapter = new BleAdapter();
  const dev = fakeDevice();
  let resolveServices;
  dev._servicesPromise = new Promise((res) => { resolveServices = res; });

  const events = [];
  adapter.on('connected', () => events.push('connected'));

  const attachPromise = adapter.attach(dev);
  await new Promise((r) => setTimeout(r, 30)); // 流水线走到 discover() 挂起
  assert.equal(dev.gatt.connectCount, 1);

  adapter.disconnect();          // 用户手动断开
  resolveServices([]);           // 挂起的发现在断开后才完成
  await attachPromise;
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(events.includes('connected'), false, '断开后不得再发 connected');
  assert.equal(dev.gatt.connectCount, 1, '不得发生重试性二次连接');
  assert.ok(dev.gatt.disconnectCount >= 1, 'gatt.disconnect 应被调用');
});

test('发现失败但已手动断开：不得触发自动重连（旧行为会连回去）', async () => {
  const adapter = new BleAdapter();
  const dev = fakeDevice();
  let rejectServices;
  dev._servicesPromise = new Promise((_, rej) => { rejectServices = rej; });

  const events = [];
  adapter.on('connected', () => events.push('connected'));
  adapter.on('conn-error', () => events.push('conn-error'));

  const attachPromise = adapter.attach(dev).catch(() => 'failed');
  await new Promise((r) => setTimeout(r, 30));

  adapter.disconnect();          // 在发现结果返回前手动断开
  rejectServices(new Error('boom')); // 随后发现失败（旧代码会自动重连）
  await attachPromise;
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(events.includes('connected'), false);
  assert.equal(dev.gatt.connectCount, 1, '发现失败后不得自动重连');
});

test('正常路径：发现成功后发 connected（确认会话检查不误伤）', async () => {
  const adapter = new BleAdapter();
  const dev = fakeDevice();
  dev._servicesPromise = Promise.resolve([]);

  const events = [];
  adapter.on('connected', () => events.push('connected'));
  adapter.on('tree', () => events.push('tree'));

  await adapter.attach(dev);
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(events.includes('connected'), '未断开时应正常发出 connected');
  assert.ok(events.includes('tree'), '发现完成应发出 tree 事件');
  assert.equal(adapter.tree.length, 0);
});

test('回归：discover() 不得清空事件监听器（曾与通知处理器表同名冲突导致连接后应用失聪）', async () => {
  const adapter = new BleAdapter();
  const dev = fakeDevice();
  dev._servicesPromise = Promise.resolve([]);

  const logs = [];
  adapter.on('log', (e) => logs.push(e.text));

  await adapter.attach(dev);
  await new Promise((r) => setTimeout(r, 30));

  // discover() 之后发出的事件必须仍能到达 attach 之前注册的监听器
  assert.ok(logs.some((t) => t.includes('发现')), '应收到 discover 内部的进度日志');
  assert.ok(logs.some((t) => t.includes('GATT 就绪')), '应收到 discover 之后的就绪日志');
});

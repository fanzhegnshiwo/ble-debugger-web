// 特征属性提取回归测试
// 背景：Chrome 里 BluetoothCharacteristicProperties 的成员（read/write/notify…）
// 是原型访问器，{...c.properties} 展开只复制自有可枚举属性 → 得到空对象，
// 导致特征卡片上「读取/订阅/定时/发送」按钮和属性徽标全部消失，
// 用户只能点到描述符的读取按钮。

import test from 'node:test';
import assert from 'node:assert/strict';

import { BleAdapter } from '../js/ble.js';

/** 模拟 Chrome：属性定义为原型 getter（IDL readonly attribute 的 Blink 实现） */
class FakeProps {}
const TRUE = ['read', 'notify'];
for (const k of ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate']) {
  Object.defineProperty(FakeProps.prototype, k, {
    get() { return TRUE.includes(k); },
    enumerable: true,
  });
}

function fakeChar() {
  return {
    uuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
    properties: new FakeProps(),
    getDescriptors: async () => [],
  };
}

function fakeDevice(char) {
  const svc = {
    uuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
    getCharacteristics: async () => [char],
  };
  return {
    name: 'P', id: 'p1',
    addEventListener() {}, removeEventListener() {},
    gatt: {
      connected: false,
      async connect() { this.connected = true; },
      disconnect() { this.connected = false; },
      getPrimaryServices: async () => [svc],
    },
  };
}

test('回归：原型 getter 形式的属性必须能被提取（展开 {...props} 为空）', async () => {
  assert.deepEqual({ ...new FakeProps() }, {}, '前提：spread 模拟对象应得到空对象');

  const adapter = new BleAdapter();
  await adapter.attach(fakeDevice(fakeChar()));
  const ch = adapter.tree[0].chars[0];

  assert.equal(ch.props.read, true, 'read 应为 true');
  assert.equal(ch.props.notify, true, 'notify 应为 true');
  assert.equal(ch.props.write, false, 'write 应为 false');
  assert.equal(ch.props.writeWithoutResponse, false);
});

test('普通对象形式的属性同样兼容', async () => {
  const char = {
    uuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
    properties: { read: true, write: true, notify: false, indicate: false },
    getDescriptors: async () => [],
  };
  const adapter = new BleAdapter();
  await adapter.attach(fakeDevice(char));
  const ch = adapter.tree[0].chars[0];

  assert.equal(ch.props.read, true);
  assert.equal(ch.props.write, true);
  assert.equal(ch.props.notify, false);
});

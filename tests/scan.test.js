// 扫描请求构造（buildScanRequest / serviceToken）单元测试
// 背景：Chrome 拒绝空 namePrefix（'namePrefix' must be non-empty），
// 「仅列出有名称的设备」改用可打印 ASCII 首字符集合近似实现。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildScanRequest, serviceToken } from '../js/ble.js';

test('named 模式：所有 namePrefix 非空（Chrome 拒绝空前缀）', () => {
  const req = buildScanRequest({ mode: 'named' });
  assert.equal(req.acceptAllDevices, undefined);
  assert.ok(req.filters.length >= 90, `filters=${req.filters.length}`);
  for (const f of req.filters) {
    assert.equal(typeof f.namePrefix, 'string');
    assert.ok(f.namePrefix.length > 0, 'namePrefix 不能为空字符串');
  }
  const firsts = new Set(req.filters.map((f) => f.namePrefix));
  assert.ok(firsts.has('A') && firsts.has('a') && firsts.has('0') && firsts.has('-'));
});

test('prefix 模式：单一前缀过滤', () => {
  const req = buildScanRequest({ mode: 'prefix', namePrefix: 'HM-' });
  assert.deepEqual(req.filters, [{ namePrefix: 'HM-' }]);
});

test('prefix 模式空前缀回退为 named 集合（不产生空 namePrefix）', () => {
  const req = buildScanRequest({ mode: 'prefix', namePrefix: '' });
  assert.ok(req.filters.length >= 90);
  for (const f of req.filters) assert.ok(f.namePrefix.length > 0);
});

test('named + services：交叉乘积且服务解析为 16 位别名', () => {
  const req = buildScanRequest({ mode: 'named', services: ['180F', '0xFFE0'] });
  assert.equal(req.filters.length, 95 * 2);
  const svcSet = new Set(req.filters.map((f) => f.services[0]));
  assert.ok(svcSet.has(0x180f) && svcSet.has(0xffe0));
  for (const f of req.filters) {
    assert.ok(f.namePrefix.length > 0);
    assert.equal(f.services.length, 1);
  }
});

test('all 模式：acceptAllDevices，services 转入 optionalServices 保证可访问', () => {
  const req = buildScanRequest({ mode: 'all', services: ['180F'] });
  assert.equal(req.acceptAllDevices, true);
  assert.equal(req.filters, undefined);
  assert.ok(req.optionalServices.includes(0x180f));
});

test('serviceToken：短码/0x 前缀转数字，UUID 转小写，非法值返回 null', () => {
  assert.equal(serviceToken('180F'), 0x180f);
  assert.equal(serviceToken('0xffe0'), 0xffe0);
  assert.equal(serviceToken('FFE0'), 0xffe0);
  assert.equal(serviceToken('6E400001-B5A3-F393-E0A9-E50E24DCCA9E'), '6e400001-b5a3-f393-e0a9-e50e24dcca9e');
  assert.equal(serviceToken('battery_service'), 'battery_service');
  assert.equal(serviceToken('garbage!!'), null);
  assert.equal(serviceToken(''), null);
  assert.equal(serviceToken(null), null);
});

test('非法服务输入被过滤，不会进入 filters', () => {
  const req = buildScanRequest({
    mode: 'prefix', namePrefix: 'X',
    services: ['battery_service', 'garbage!!', ''],
  });
  const svcs = req.filters.map((f) => f.services[0]);
  assert.deepEqual(svcs, ['battery_service']);
});

test('optionalServices 默认包含常用服务且去重', () => {
  const req = buildScanRequest({ mode: 'prefix', namePrefix: 'X', optionalServices: ['FFE0', 'ffe0'] });
  const nums = req.optionalServices.filter((s) => typeof s === 'number');
  assert.equal(nums.filter((n) => n === 0xffe0).length, 1);
  assert.ok(req.optionalServices.includes('battery_service'));
});

// 编解码与工具层单元测试（纯逻辑，Node 直接运行，同时验证逻辑层零 DOM 依赖）
// 运行：node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHexInput, hexBytes, toAscii, formatBytes, bytesOf,
} from '../js/utils.js';
import {
  parseField, parseAll, parseEnumText, inferType, sanitizeRules, newRule,
} from '../js/protocol.js';
import { shortUuid, expandUuid, charLabel, serviceLabel } from '../js/gatt-names.js';

// ---------- HEX 输入解析 ----------

test('parseHexInput 接受多种分隔风格', () => {
  assert.deepEqual([...parseHexInput('01 02 03')], [1, 2, 3]);
  assert.deepEqual([...parseHexInput('010203')], [1, 2, 3]);
  assert.deepEqual([...parseHexInput('01:02:03')], [1, 2, 3]);
  assert.deepEqual([...parseHexInput('0x01, 0x02 0x03')], [1, 2, 3]);
  assert.deepEqual([...parseHexInput('A1 b2')], [0xa1, 0xb2]);
});

test('parseHexInput 非法输入返回 null', () => {
  assert.equal(parseHexInput('xyz'), null);
  assert.equal(parseHexInput('123'), null);   // 奇数长度
  assert.equal(parseHexInput(''), null);
  assert.equal(parseHexInput(null), null);
});

test('hexBytes 输出大写两位十六进制', () => {
  assert.equal(hexBytes(new Uint8Array([0, 1, 0xab])), '00 01 AB');
});

test('toAscii 不可打印字符替换为点', () => {
  assert.equal(toAscii(new Uint8Array([0x41, 0x00, 0x7f])), 'A..');
});

test('formatBytes 三种显示模式', () => {
  const b = new Uint8Array([0x48, 0x49]);
  assert.equal(formatBytes(b, 'hex'), '48 49');
  assert.equal(formatBytes(b, 'ascii'), 'HI');
  assert.equal(formatBytes(b, 'mixed'), '48 49  |  HI');
});

test('bytesOf 兼容 DataView / Uint8Array / ArrayBuffer', () => {
  const u8 = new Uint8Array([1, 2, 3, 4]);
  const dv = new DataView(u8.buffer, 1, 2);
  assert.deepEqual([...bytesOf(u8)], [1, 2, 3, 4]);
  assert.deepEqual([...bytesOf(dv)], [2, 3]);
  assert.deepEqual([...bytesOf(u8.buffer.slice(0))], [1, 2, 3, 4]);
});

// ---------- 协议字段解析 ----------

test('uint16 大端 / 小端', () => {
  const bytes = new Uint8Array([0x01, 0x02]);
  const big = parseField(bytes, newRule({ offset: 0, type: 'uint16', endian: 'big' }));
  const little = parseField(bytes, newRule({ offset: 0, type: 'uint16', endian: 'little' }));
  assert.equal(big.ok, true);
  assert.equal(big.text, '258');
  assert.equal(little.ok, true);
  assert.equal(little.text, '513');
});

test('int8 符号位扩展为负数', () => {
  const r = parseField(new Uint8Array([0xff]), newRule({ offset: 0, type: 'int8' }));
  assert.equal(r.ok, true);
  assert.equal(r.text, '-1');
});

test('uint64 超出安全整数时以大整数显示', () => {
  const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const r = parseField(bytes, newRule({ offset: 0, type: 'uint64' }));
  assert.equal(r.ok, true);
  assert.equal(r.text, '18446744073709551615');
});

test('float32 字节序', () => {
  const big = parseField(new Uint8Array([0x41, 0x20, 0x00, 0x00]), newRule({ type: 'float32', endian: 'big' }));
  const little = parseField(new Uint8Array([0x00, 0x00, 0x20, 0x41]), newRule({ type: 'float32', endian: 'little' }));
  assert.equal(big.text, '10');
  assert.equal(little.text, '10');
});

test('偏移与单位', () => {
  const bytes = new Uint8Array([0xaa, 0x00, 0x64]);
  const r = parseField(bytes, newRule({ offset: 2, type: 'uint8', unit: '%' }));
  assert.equal(r.ok, true);
  assert.equal(r.text, '100 %');
});

test('枚举映射优先于数值显示', () => {
  const r = parseField(new Uint8Array([0x01]), newRule({ type: 'uint8', enum_text: '0=停止;1=运行;2:完成' }));
  assert.equal(r.ok, true);
  assert.equal(r.text, '运行');
});

test('越界返回错误信息', () => {
  const r = parseField(new Uint8Array([0x01, 0x02]), newRule({ offset: 2, type: 'uint8' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /超出数据范围/);
});

test('parseAll 汇总多条规则', () => {
  const bytes = new Uint8Array([0x00, 0x64, 0x01]);
  const results = parseAll(bytes, [
    newRule({ name: '温度', offset: 1, type: 'uint8', unit: '℃' }),
    newRule({ name: '状态', offset: 2, type: 'uint8', enum_text: '0=停止;1=运行' }),
    newRule({ name: '越界', offset: 5, type: 'uint8' }),
  ]);
  assert.equal(results.length, 3);
  assert.equal(results[0].text, '100 ℃');
  assert.equal(results[1].text, '运行');
  assert.equal(results[2].ok, false);
});

test('parseEnumText 容错', () => {
  const m = parseEnumText('0=停止; 1=运行\n2:完成;;垃圾');
  assert.equal(m.get(0), '停止');
  assert.equal(m.get(1), '运行');
  assert.equal(m.get(2), '完成');
  assert.equal(m.size, 3);
});

test('inferType 按长度推断', () => {
  assert.equal(inferType(1), 'uint8');
  assert.equal(inferType(2), 'uint16');
  assert.equal(inferType(3), 'uint24');
  assert.equal(inferType(4), 'uint32');
  assert.equal(inferType(8), 'uint64');
  assert.equal(inferType(5), 'uint8');
});

test('sanitizeRules 清洗非法字段', () => {
  const rules = sanitizeRules([
    { name: 'a', offset: '3', type: 'uint16', endian: 'little' },
    { name: 'b', offset: -5, type: '不存在的类型' },
    null,
    '垃圾',
  ]);
  assert.equal(rules.length, 2); // null 与字符串条目被过滤
  assert.equal(rules[0].offset, 3);
  assert.equal(rules[0].endian, 'little');
  assert.equal(rules[1].offset, 0);
  assert.equal(rules[1].type, 'uint16');
});

// ---------- UUID 工具 ----------

test('shortUuid 识别标准 UUID', () => {
  assert.equal(shortUuid('0000ffe1-0000-1000-8000-00805f9b34fb'), 'FFE1');
  assert.equal(shortUuid('00002a19-0000-1000-8000-00805f9b34fb'), '2A19');
  assert.equal(shortUuid('6e400002-b5a3-f393-e0a9-e50e24dcca9e'), null);
  assert.equal(shortUuid(''), null);
});

test('expandUuid 短码与完整 UUID', () => {
  assert.equal(expandUuid('2A19'), '00002a19-0000-1000-8000-00805f9b34fb');
  assert.equal(expandUuid('6E400002-B5A3-F393-E0A9-E50E24DCCA9E'), '6e400002-b5a3-f393-e0a9-e50e24dcca9e');
  assert.equal(expandUuid('abc'), null);
});

test('名称表翻译', () => {
  assert.match(charLabel('00002a19-0000-1000-8000-00805f9b34fb'), /电量/);
  assert.match(serviceLabel('0000180f-0000-1000-8000-00805f9b34fb'), /电池/);
  assert.match(charLabel('6e400002-b5a3-f393-e0a9-e50e24dcca9e'), /NUS TX/);
});

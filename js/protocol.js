// 自定义协议字段解析（纯数据层，无 DOM 依赖，可在 Node 中单测）
// 规则模型与桌面版一致：按特征 UUID 配置 字段名/偏移/类型/字节序/单位/枚举映射。

export const FIELD_TYPES = [
  'uint8', 'int8', 'uint16', 'int16', 'uint24', 'int24',
  'uint32', 'int32', 'uint64', 'int64', 'float32', 'float64',
];

export const TYPE_SIZES = {
  uint8: 1, int8: 1, uint16: 2, int16: 2, uint24: 3, int24: 3,
  uint32: 4, int32: 4, uint64: 8, int64: 8, float32: 4, float64: 8,
};

/** 按字节长度推断默认类型（与桌面版一致） */
export function inferType(len) {
  return ({ 1: 'uint8', 2: 'uint16', 3: 'uint24', 4: 'uint32', 8: 'uint64' })[len] || 'uint8';
}

export function newRule(partial = {}) {
  return {
    name: partial.name || '字段',
    offset: partial.offset ?? 0,
    type: TYPE_SIZES[partial.type] ? partial.type : 'uint16',
    endian: partial.endian === 'little' ? 'little' : 'big',
    unit: partial.unit || '',
    enum_text: partial.enum_text || '',
  };
}

/** 解析枚举映射文本："0=停止;1=运行"（支持 = 或 : 分隔，分号或换行分隔条目） */
export function parseEnumText(text) {
  const out = new Map();
  for (const part of String(text ?? '').split(/[;\n]/)) {
    const seg = part.trim();
    if (!seg) continue;
    const m = seg.match(/^(-?\d+)\s*[=:]\s*(.*)$/);
    if (m) out.set(Number(m[1]), m[2].trim());
  }
  return out;
}

function trimNum(v) {
  return String(Number(v.toPrecision(6)));
}

/**
 * 按单条规则解析一段字节。
 * @returns {{ ok: boolean, text: string, value?: number|bigint, error?: string }}
 */
export function parseField(bytes, rule) {
  const size = TYPE_SIZES[rule.type];
  if (!size) return { ok: false, text: '', error: `未知类型：${rule.type}` };
  const off = Number(rule.offset) || 0;
  if (off < 0 || off + size > bytes.length) {
    return { ok: false, text: '', error: `偏移 ${off} + 长度 ${size} 超出数据范围（共 ${bytes.length} 字节）` };
  }
  const chunk = bytes.slice(off, off + size);
  const little = rule.endian === 'little';

  let value;
  if (rule.type === 'float32' || rule.type === 'float64') {
    const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    value = rule.type === 'float32' ? dv.getFloat32(0, little) : dv.getFloat64(0, little);
  } else {
    let v = 0n;
    if (little) { for (let i = chunk.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(chunk[i]); }
    else { for (let i = 0; i < chunk.length; i++) v = (v << 8n) | BigInt(chunk[i]); }
    // 符号位扩展
    const msb = chunk[little ? chunk.length - 1 : 0];
    if (rule.type.startsWith('int') && msb >= 0x80) v -= 1n << BigInt(size * 8);
    value = (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(v) : v;
  }

  const enumMap = parseEnumText(rule.enum_text);
  if (enumMap.size && typeof value === 'number' && enumMap.has(value)) {
    return { ok: true, text: enumMap.get(value), value };
  }
  const unit = rule.unit ? ` ${rule.unit}` : '';
  if (typeof value === 'number' && !Number.isInteger(value)) {
    return { ok: true, text: `${trimNum(value)}${unit}`, value };
  }
  return { ok: true, text: `${value}${unit}`, value };
}

/** 按规则列表解析整段字节，返回逐条结果 */
export function parseAll(bytes, rules) {
  return (rules || []).map((rule) => ({ rule, ...parseField(bytes, rule) }));
}

/** 导入/反序列化时清洗规则列表 */
export function sanitizeRules(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const offset = parseInt(r.offset, 10);
    out.push(newRule({
      name: String(r.name || '字段').slice(0, 40),
      offset: Number.isFinite(offset) ? Math.max(0, Math.min(65535, offset)) : 0,
      type: r.type,
      endian: r.endian,
      unit: String(r.unit || '').slice(0, 16),
      enum_text: String(r.enum_text || '').slice(0, 500),
    }));
  }
  return out;
}

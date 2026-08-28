// 通用工具：事件总线 / 字节与文本转换 / 时间 / 本地存储 / 下载
// 本模块不依赖 DOM（下载函数仅在调用时触碰 document），可在 Node 中被单测导入。

export class EventBus {
  constructor() { this._handlers = new Map(); }

  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) { this._handlers.get(type)?.delete(fn); }

  emit(type, data) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(data); } catch (e) { console.error(e); }
    }
  }
}

// ---------- 字节与文本 ----------

/** DataView / Uint8Array / ArrayBuffer -> Uint8Array */
export function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof DataView) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
}

/** 字节数组 -> "01 02 03" */
export function hexBytes(value, sep = ' ') {
  return [...bytesOf(value)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(sep);
}

/** 不可打印字符以 '.' 代替（仅英文字符） */
export function toAscii(value) {
  return [...bytesOf(value)].map((b) => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
}

export function toUtf8(value) {
  return new TextDecoder('utf-8').decode(bytesOf(value));
}

export function encodeUtf8(text) {
  return new TextEncoder().encode(text);
}

/** 解析用户输入的 HEX："01 02 03"、"010203"、"01:02"、"0x01,0x02" 均可；非法返回 null */
export function parseHexInput(text) {
  const cleaned = String(text ?? '').replace(/0x/gi, '').replace(/[\s:,，]/g, '');
  if (!cleaned) return null;
  if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0) return null;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 按显示模式格式化字节 */
export function formatBytes(value, mode = 'hex') {
  if (mode === 'ascii') return toAscii(value);
  if (mode === 'mixed') return `${hexBytes(value)}  |  ${toAscii(value)}`;
  return hexBytes(value);
}

// ---------- 时间 ----------

export function nowTs() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// ---------- 本地存储 ----------

const NS = 'bleweb.';

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(NS + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch { /* 隐私模式等场景忽略 */ }
  },
};

// ---------- 下载（仅浏览器调用） ----------

export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

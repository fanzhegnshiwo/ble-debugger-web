// BLE 适配层：封装 Web Bluetooth 的连接 / GATT 操作 / 订阅 / 定时读取 / 自动重连 / 广播监听
// 只通过 EventBus 向外发事件，不包含任何界面逻辑。

import { EventBus } from './utils.js';
import { serviceLabel, charLabel, descLabel } from './gatt-names.js';

const RECONNECT_MAX = 5;

// 默认附加的可访问服务（含常用 16 位别名与 Nordic UART），保证 acceptAllDevices 下也能操作
const COMMON_OPTIONAL = [
  0xfe59, 0xffe0, 0xffe5,
  'battery_service', 'device_information', 'heart_rate', 'environmental_sensing', 'user_data',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
];

// 「仅列出有名称的设备」的实现：Web Bluetooth 没有"有名称"过滤项，
// 且 Chrome 会拒绝空 namePrefix（报 'namePrefix' must be non-empty），
// 因此用可打印 ASCII 首字符集合近似（名称以中文等非 ASCII 字符开头的设备不会出现）。
const NAMED_PREFIXES = [];
for (let c = 0x20; c <= 0x7e; c++) NAMED_PREFIXES.push(String.fromCharCode(c));

// 规范定义的标准服务名（BluetoothServiceName），requestDevice 只接受这些名称
const KNOWN_SERVICE_NAMES = new Set([
  'alert_notification', 'battery_service', 'blood_pressure', 'body_composition',
  'current_time', 'cycling_power', 'cycling_speed_and_cadence', 'device_information',
  'environmental_sensing', 'fitness_machine', 'generic_access', 'generic_attribute',
  'glucose', 'health_thermometer', 'heart_rate', 'human_interface_device',
  'immediate_alert', 'link_loss', 'mesh_provisioning_service', 'mesh_proxy_service',
  'phone_alert_status', 'pulse_oximeter', 'reconnection_configuration',
  'reference_time_update', 'running_speed_and_cadence', 'scan_parameters',
  'tx_power', 'user_data', 'weight_scale',
]);

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 服务标识解析："180F"/"0xFFE0" -> 16 位数字别名；完整 UUID -> 小写字符串；
 * 规范标准名 -> 原样；其余非法输入 -> null（过滤掉，避免 requestDevice 直接抛错）。
 */
export function serviceToken(tok) {
  const t = String(tok || '').trim().toLowerCase();
  if (!t) return null;
  if (/^0x[0-9a-f]{1,4}$/.test(t) || /^[0-9a-f]{1,4}$/.test(t)) return parseInt(t, 16);
  if (FULL_UUID_RE.test(t)) return t;
  if (KNOWN_SERVICE_NAMES.has(t)) return t;
  return null;
}

/**
 * 构造 requestDevice 参数（纯函数，可在 Node 中单测）。
 * - all: acceptAllDevices（services 转入 optionalServices 保证连接后可访问）
 * - prefix: 单个 namePrefix 过滤器（空前缀回退为 named 集合）
 * - named: 可打印 ASCII 首字符集合过滤器；提供 services 时做交叉乘积（有名称 AND 任一服务）
 */
export function buildScanRequest(opts = {}) {
  const req = { optionalServices: [] };
  const extra = (opts.optionalServices || []).map(serviceToken).filter(Boolean);
  const svcs = (opts.services || []).map(serviceToken).filter(Boolean);
  req.optionalServices = [...new Set([...extra, ...svcs, ...COMMON_OPTIONAL])];

  if (opts.mode === 'all') {
    req.acceptAllDevices = true;
    return req;
  }

  const prefixFilters = (opts.mode === 'prefix' && opts.namePrefix)
    ? [{ namePrefix: opts.namePrefix }]
    : NAMED_PREFIXES.map((c) => ({ namePrefix: c }));

  req.filters = svcs.length
    ? prefixFilters.flatMap((f) => svcs.map((s) => ({ ...f, services: [s] })))
    : prefixFilters;
  return req;
}

export class BleAdapter extends EventBus {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.tree = [];                 // [{ uuid, label, chars: [...], error }]
    this.chars = new Map();         // "svc/chr" -> BluetoothRemoteGATTCharacteristic
    this._svcOf = new Map();        // key -> service uuid
    this._handlers = new Map();     // key -> valuechanged 处理器
    this.subscribedKeys = new Set();
    this.pollKey = null;
    this._pollTimer = null;
    this.autoReconnect = true;
    this._manualClose = false;
    this._retries = 0;
    this._reconnectTimer = null;
    this._watching = false;
    this._advHandler = (e) => this.emit('rssi', { rssi: e.rssi, txPower: e.txPower, name: e.name });
    this._onDisconnectedBound = () => this._onDisconnected();
  }

  get connected() { return !!(this.device?.gatt?.connected); }
  get watching() { return this._watching; }

  supported() { return typeof navigator !== 'undefined' && 'bluetooth' in navigator; }

  keyOf(svcUuid, chrUuid) { return `${svcUuid}/${chrUuid}`; }

  // ---------- 设备选择与连接 ----------

  /**
   * 弹出系统设备选择器并连接。
   * @param {{mode:'named'|'prefix'|'all', namePrefix?:string, services?:string[], optionalServices?:string[]}} opts
   */
  async requestAndConnect(opts = {}) {
    if (!this.supported()) throw new Error('当前浏览器不支持 Web Bluetooth');
    const device = await navigator.bluetooth.requestDevice(buildScanRequest(opts));
    await this.attach(device);
    return device;
  }

  /** 连接一个已知设备（来自 requestDevice 或 getDevices） */
  async attach(device) {
    if (this.device && this.device !== device) this._reset();
    // 先移除再添加，避免同一设备重复绑定监听
    this.device?.removeEventListener('gattserverdisconnected', this._onDisconnectedBound);
    this.device = device;
    this.device.addEventListener('gattserverdisconnected', this._onDisconnectedBound);
    this._manualClose = false;
    await this._connect();
  }

  async _connect() {
    const name = this.device?.name || '设备';
    this.emit('log', { dir: 'sys', text: `正在连接 ${name}…` });
    try {
      this.server = await this.device.gatt.connect();
    } catch (e) {
      this.emit('log', { dir: 'err', text: `连接失败：${e.message}` });
      this.emit('state');
      throw e;
    }
    this._retries = 0;
    this.emit('state');
    this.emit('log', { dir: 'sys', text: '已连接，正在发现服务…' });
    try {
      await this.discover();
      this.emit('tree');
    } catch (e) {
      this.emit('log', { dir: 'err', text: `服务发现失败：${e.message}` });
    }
    const resumed = await this._resubscribe();
    if (resumed) this.emit('log', { dir: 'sys', text: `已恢复订阅 ${resumed} 个特征` });
    this.emit('log', { dir: 'sys', text: `GATT 就绪：${this.tree.length} 个服务，${this.chars.size} 个特征` });
  }

  async discover() {
    this.chars.clear();
    this._handlers.clear();
    this._svcOf.clear();
    this.tree = [];
    const services = await this.server.getPrimaryServices();
    for (const svc of services) {
      const node = { uuid: svc.uuid, label: serviceLabel(svc.uuid), chars: [], error: null };
      try {
        for (const c of await svc.getCharacteristics()) {
          const key = this.keyOf(svc.uuid, c.uuid);
          this.chars.set(key, c);
          this._svcOf.set(key, svc.uuid);
          let descriptors = [];
          try {
            descriptors = (await c.getDescriptors()).map((d) => ({ uuid: d.uuid, label: descLabel(d.uuid), obj: d }));
          } catch { /* 描述符获取失败不影响主流程 */ }
          node.chars.push({ key, uuid: c.uuid, label: charLabel(c.uuid), props: { ...c.properties }, descriptors });
        }
      } catch (e) {
        node.error = e.message;
      }
      this.tree.push(node);
    }
  }

  /** 重连后按记忆恢复订阅，返回恢复数量 */
  async _resubscribe() {
    let count = 0;
    for (const key of [...this.subscribedKeys]) {
      if (!this.chars.has(key)) { this.subscribedKeys.delete(key); continue; }
      try {
        await this._startNotify(key);
        count++;
      } catch { this.subscribedKeys.delete(key); }
    }
    return count;
  }

  disconnect() {
    this._manualClose = true;
    this._clearReconnect();
    this.stopPoll(true);
    this._stopWatch();
    try { this.device?.gatt.disconnect(); } catch { /* ignore */ }
  }

  _onDisconnected() {
    this.stopPoll(true);
    this.emit('poll', null);
    this.emit('state');
    this.emit('log', { dir: 'sys', text: '连接已断开' });
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._manualClose || !this.autoReconnect || !this.device) return;
    if (this._retries >= RECONNECT_MAX) {
      this.emit('log', { dir: 'err', text: `自动重连已达上限（${RECONNECT_MAX} 次），请手动重连` });
      return;
    }
    const delay = Math.min(16000, 1000 * 2 ** this._retries);
    this._retries++;
    this.emit('log', { dir: 'sys', text: `自动重连第 ${this._retries}/${RECONNECT_MAX} 次，${Math.round(delay / 1000)} 秒后重试…` });
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try { await this._connect(); } catch { this._scheduleReconnect(); }
    }, delay);
  }

  _clearReconnect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._retries = 0;
  }

  _reset() {
    this.stopPoll(true);
    this._clearReconnect();
    this._stopWatch();
    this.device?.removeEventListener('gattserverdisconnected', this._onDisconnectedBound);
    this.device = null;
    this.server = null;
    this.tree = [];
    this.chars.clear();
    this._handlers.clear();
    this._svcOf.clear();
    this.subscribedKeys.clear();
    this.emit('state');
  }

  // ---------- 已授权设备 ----------

  async listKnown() {
    if (!navigator.bluetooth?.getDevices) return [];
    try { return await navigator.bluetooth.getDevices(); } catch { return []; }
  }

  // ---------- GATT 操作 ----------

  async read(key) {
    const c = this.chars.get(key);
    if (!c) throw new Error('特征未就绪，请重新连接');
    const value = await c.readValue();
    this.emit('rx', { key, uuid: c.uuid, value, source: 'read' });
    return value;
  }

  async write(key, bytes, withResponse = true) {
    const c = this.chars.get(key);
    if (!c) throw new Error('特征未就绪，请重新连接');
    if (withResponse && typeof c.writeValueWithResponse === 'function') await c.writeValueWithResponse(bytes);
    else if (!withResponse && typeof c.writeValueWithoutResponse === 'function') await c.writeValueWithoutResponse(bytes);
    else await c.writeValue(bytes);
    this.emit('tx', { key, uuid: c.uuid, bytes });
  }

  async subscribe(key) {
    if (!this.chars.has(key)) throw new Error('特征未就绪，请重新连接');
    await this._startNotify(key);
    this.subscribedKeys.add(key);
    const uuid = this.chars.get(key).uuid;
    this.emit('subscribed', { key, uuid, on: true });
  }

  async unsubscribe(key) {
    const c = this.chars.get(key);
    const handler = this._handlers.get(key);
    if (c && handler) {
      try { c.removeEventListener('characteristicvaluechanged', handler); } catch { /* ignore */ }
      await c.stopNotifications();
    }
    this._handlers.delete(key);
    this.subscribedKeys.delete(key);
    this.emit('subscribed', { key, uuid: c?.uuid, on: false });
  }

  async _startNotify(key) {
    const c = this.chars.get(key);
    const uuid = c.uuid;
    const handler = (e) => this.emit('rx', { key, uuid, value: e.target.value, source: 'notify' });
    await c.startNotifications();
    c.addEventListener('characteristicvaluechanged', handler);
    this._handlers.set(key, handler);
  }

  /** 定时读取（秒），启动时立即读一次；同一时间仅一个定时任务 */
  startPoll(key, intervalSec) {
    this.stopPoll(true);
    this.pollKey = key;
    const sec = Math.max(1, Math.min(3600, intervalSec || 5));
    const run = async () => {
      try { await this.read(key); }
      catch (e) {
        this.emit('log', { dir: 'err', text: `定时读取失败：${e.message}` });
        this.stopPoll();
        this.emit('poll', null);
      }
    };
    run();
    this._pollTimer = setInterval(run, sec * 1000);
    this.emit('poll', { key, uuid: this.chars.get(key)?.uuid, intervalSec: sec });
  }

  stopPoll(silent = false) {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    const had = this.pollKey !== null;
    this.pollKey = null;
    if (had && !silent) this.emit('poll', null);
  }

  // ---------- 广播监听（RSSI） ----------

  async watchRssi(on) {
    if (!this.device) throw new Error('未选择设备');
    if (typeof this.device.watchAdvertisements !== 'function') {
      throw new Error('当前浏览器不支持监听广播');
    }
    if (on === this._watching) return this._watching;
    if (on) {
      this.device.addEventListener('advertisementreceived', this._advHandler);
      await this.device.watchAdvertisements();
      this._watching = true;
    } else {
      this._stopWatch();
    }
    this.emit('state');
    return this._watching;
  }

  _stopWatch() {
    if (!this._watching) return;
    this.device?.removeEventListener('advertisementreceived', this._advHandler);
    try { this.device?.unwatchAdvertisements?.(); } catch { /* ignore */ }
    this._watching = false;
    this.emit('state');
  }
}

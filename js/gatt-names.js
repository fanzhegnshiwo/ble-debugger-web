// GATT 标准 UUID 名称表（从桌面版 core.py 精简移植）+ UUID 工具
// 本模块为纯数据，无 DOM 依赖。

const BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';

const SVC = {
  '1800': '通用访问 Generic Access',
  '1801': '通用属性 Generic Attribute',
  '1802': '立即告警 Immediate Alert',
  '1805': '当前时间 Current Time',
  '180A': '设备信息 Device Information',
  '180D': '心率 Heart Rate',
  '180F': '电池 Battery',
  '1809': '健康体温计 Health Thermometer',
  '1810': '血压 Blood Pressure',
  '1811': '提醒通知 Alert Notification',
  '1812': 'HID 人机接口设备',
  '1816': '骑行速度与踏频 CSC',
  '1818': '骑行功率 Cycling Power',
  '181A': '环境传感 Environmental Sensing',
  '181B': '身体成分 Body Composition',
  '181C': '用户数据 User Data',
  '181D': '体重秤 Weight Scale',
  '1822': '脉搏血氧 Pulse Oximeter',
  '1826': '健身器械 Fitness Machine',
  '1828': 'Mesh 代理 Mesh Proxy',
  'FE59': 'Nordic UART（非标准）',
  'FFE0': '串口透传（HM-10 / TI SensorTag）',
  'FFE5': 'Nordic LED 按键服务',
};

const CHR = {
  '2A00': '设备名 Device Name',
  '2A01': '外观 Appearance',
  '2A05': 'Service Changed',
  '2A19': '电量 Battery Level',
  '2A23': '系统 ID System ID',
  '2A24': '型号 Model Number',
  '2A25': '序列号 Serial Number',
  '2A26': '固件版本 Firmware Rev',
  '2A27': '硬件版本 Hardware Rev',
  '2A28': '软件版本 Software Rev',
  '2A29': '制造商名称 Manufacturer',
  '2A2B': '当前时间 Current Time',
  '2A37': '心率测量 HR Measurement',
  '2A38': '传感器位置 Body Sensor Location',
  '2A39': '心率控制点 HR Control Point',
  '2A5B': 'CSC 测量 CSC Measurement',
  '2A5C': 'CSC 特征 CSC Feature',
  '2A63': '骑行功率测量 Cycling Power Measurement',
  '2A6D': '气压 Pressure',
  '2A6E': '温度 Temperature',
  '2A6F': '湿度 Humidity',
};

// 完整 128 位 UUID 的自定义映射
const FULL_SVC = {
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e': 'Nordic UART 服务 (NUS)',
};

const FULL_CHR = {
  '6e400002-b5a3-f393-e0a9-e50e24dcca9e': 'NUS TX（写入）',
  '6e400003-b5a3-f393-e0a9-e50e24dcca9e': 'NUS RX（通知）',
};

const DESC = {
  '2900': '扩展属性',
  '2901': '用户描述',
  '2902': 'CCCD（通知/指示开关）',
  '2903': '服务端配置',
  '2904': '呈现格式',
  '2906': '有效范围',
};

/** 标准 128 位 UUID -> 4 位短码（"0000ffe1-0000-1000-..." -> "FFE1"），非标准返回 null */
export function shortUuid(uuid) {
  const u = String(uuid || '').toLowerCase();
  if (u.length === 36 && u.startsWith('0000') && u.endsWith(BASE_SUFFIX)) {
    return u.slice(4, 8).toUpperCase();
  }
  return null;
}

/** "2A19" -> 完整标准 UUID；已是完整 UUID 则原样小写返回；非法返回 null */
export function expandUuid(input) {
  const t = String(input || '').trim().toLowerCase();
  if (/^[0-9a-f]{4}$/.test(t)) return `0000${t}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t)) return t;
  return null;
}

export function serviceLabel(uuid) {
  const short = shortUuid(uuid);
  if (short && SVC[short]) return SVC[short];
  const full = FULL_SVC[String(uuid).toLowerCase()];
  if (full) return full;
  return short ? `服务 ${short}` : '自定义服务';
}

export function charLabel(uuid) {
  const short = shortUuid(uuid);
  if (short && CHR[short]) return CHR[short];
  const full = FULL_CHR[String(uuid).toLowerCase()];
  if (full) return full;
  return short ? `特征 ${short}` : '自定义特征';
}

export function descLabel(uuid) {
  const short = shortUuid(uuid);
  return (short && DESC[short]) || `描述符 ${short || String(uuid).slice(0, 8)}`;
}

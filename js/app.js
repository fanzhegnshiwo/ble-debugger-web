// 应用装配：连接 / GATT / 控制台 / 协议 四页签的全部界面逻辑

import { BleAdapter } from './ble.js?v=2'; // ?v=N：发布后强制刷新浏览器缓存的模块
import * as P from './protocol.js';
import {
  bytesOf, encodeUtf8, formatBytes, parseHexInput, nowTs, store, downloadText,
} from './utils.js';
import { expandUuid, shortUuid } from './gatt-names.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const hex2 = (b) => b.toString(16).padStart(2, '0').toUpperCase();
const charShort = (uuid) => shortUuid(uuid) || String(uuid || '').slice(0, 13);

/** 连接页消息横幅：err（红）/ ok（绿）/ warn（黄）；空文本隐藏 */
function connMsg(text, kind = 'err') {
  const n = $('#conn-msg');
  if (!n) return;
  if (!text) { n.hidden = true; n.textContent = ''; return; }
  n.hidden = false;
  n.className = 'banner' + (kind === 'ok' ? ' ok' : kind === 'warn' ? ' warn' : '');
  n.textContent = text;
}

const PROP_BADGES = [
  ['read', '读'], ['write', '写'], ['writeWithoutResponse', '无响应写'],
  ['notify', '通知'], ['indicate', '指示'],
];

const LOG_MAX_DOM = 500;
const LOG_MAX_BUF = 2000;

const adapter = new BleAdapter();

const S = {
  viewFormat: store.get('viewFormat', 'hex'),
  autoReconnect: store.get('autoReconnect', true),
  scan: store.get('scan', { mode: 'named', prefix: '', services: '', optional: '' }),
  rules: new Map(Object.entries(store.get('rules', {}))), // charUuid -> [rule]
  latest: new Map(),          // charUuid -> Uint8Array（最新接收数据）
  charEls: new Map(),         // key -> { val, parsed, notifyBtn, pollBtn, pollInput }
  logBuf: [], pending: [],
  logPaused: false,
  logFilter: { rx: true, tx: true, sys: true, err: true },
  counts: { rx: 0, tx: 0 },
  protoUuid: null,
  protoBytes: null,
  pasteBytes: null,
  liveParse: true,
  selStart: null, selEnd: null,
  lastResults: [],
};

// ============================== 页签 ==============================

function switchTab(page) {
  $$('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
}

// ============================== 日志 ==============================

function addLog(dir, text) {
  const entry = { ts: nowTs(), dir, text: String(text) };
  S.logBuf.push(entry);
  if (S.logBuf.length > LOG_MAX_BUF) S.logBuf.splice(0, S.logBuf.length - LOG_MAX_BUF);
  S.pending.push(entry);
  if (S.pending.length > LOG_MAX_BUF) S.pending.splice(0, S.pending.length - LOG_MAX_BUF);
  scheduleLogRender();
}

let logRaf = false;
function scheduleLogRender() {
  if (logRaf) return;
  logRaf = true;
  requestAnimationFrame(() => { logRaf = false; if (!S.logPaused) flushLog(); });
}

function flushLog() {
  const box = $('#log-list');
  if (!S.pending.length) { box.scrollTop = box.scrollHeight; return; }
  const frag = document.createDocumentFragment();
  for (const e of S.pending) if (S.logFilter[e.dir]) frag.append(logNode(e));
  S.pending.length = 0;
  box.append(frag);
  while (box.children.length > LOG_MAX_DOM) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

function logNode(e) {
  const line = el('div', `log-line ${e.dir}`);
  line.append(el('span', 'ts', e.ts), el('span', 'tag', e.dir.toUpperCase()), el('span', 'txt', e.text));
  return line;
}

function renderLogFull() {
  S.pending.length = 0;
  const box = $('#log-list');
  box.innerHTML = '';
  const visible = S.logBuf.filter((e) => S.logFilter[e.dir]).slice(-LOG_MAX_DOM);
  const frag = document.createDocumentFragment();
  for (const e of visible) frag.append(logNode(e));
  box.append(frag);
  box.scrollTop = box.scrollHeight;
}

function updateStats() {
  $('#log-stats').textContent = `RX ${S.counts.rx} · TX ${S.counts.tx}`;
}

// ============================== 连接页 ==============================

function bindConn() {
  const modeSel = $('#scan-mode');
  const prefixInput = $('#scan-prefix');
  const servicesInput = $('#scan-services');
  const optionalInput = $('#scan-optional');

  modeSel.value = S.scan.mode;
  prefixInput.value = S.scan.prefix;
  servicesInput.value = S.scan.services;
  optionalInput.value = S.scan.optional;
  const syncPrefixField = () => { $('#scan-prefix-field').hidden = modeSel.value !== 'prefix'; };
  syncPrefixField();

  const saveScan = () => {
    S.scan = { mode: modeSel.value, prefix: prefixInput.value.trim(), services: servicesInput.value.trim(), optional: optionalInput.value.trim() };
    store.set('scan', S.scan);
  };
  [modeSel, prefixInput, servicesInput, optionalInput].forEach((n) => n.addEventListener('change', () => { syncPrefixField(); saveScan(); }));

  $('#btn-scan').addEventListener('click', async () => {
    saveScan();
    connMsg(null);
    const services = S.scan.services.split(/[,，\s]+/).filter(Boolean);
    const optionalServices = S.scan.optional.split(/[,，\s]+/).filter(Boolean);
    try {
      await adapter.requestAndConnect({
        mode: S.scan.mode,
        namePrefix: S.scan.prefix,
        services,
        optionalServices,
      });
    } catch (e) {
      const cancelled = /cancel|cancelled|选择器|chooser/i.test(e.message || '');
      const msg = cancelled ? '已取消设备选择' : `连接失败：${e.message}`;
      addLog('err', msg);
      connMsg(msg, cancelled ? 'ok' : 'err');
    }
  });

  $('#btn-refresh-known').addEventListener('click', renderKnown);

  $('#btn-disconnect').addEventListener('click', () => adapter.disconnect());

  $('#btn-watch').addEventListener('click', async () => {
    try {
      await adapter.watchRssi(!adapter.watching);
      connMsg(null);
    } catch (e) {
      const msg = `监听广播失败：${e.message}`;
      addLog('err', msg);
      connMsg(msg);
    }
    renderStatus();
  });

  $('#chk-reconnect').addEventListener('change', (e) => {
    S.autoReconnect = e.target.checked;
    adapter.autoReconnect = S.autoReconnect;
    store.set('autoReconnect', S.autoReconnect);
  });
}

async function renderKnown() {
  const box = $('#known-list');
  box.innerHTML = '';
  const devices = await adapter.listKnown();
  if (!devices.length) {
    box.append(el('p', 'hint', '暂无。连接过的设备会出现在这里，可直接重连。'));
    return;
  }
  for (const d of devices) {
    const row = el('div', 'known-row');
    const info = el('div', 'known-info');
    info.append(el('div', 'known-name', d.name || '（未命名设备）'), el('div', 'known-id mono', d.id));
    const btnC = el('button', 'btn small primary', '连接');
    btnC.type = 'button';
    btnC.onclick = async () => {
      connMsg(null);
      try { await adapter.attach(d); }
      catch (e) {
        const msg = `连接失败：${e.message}`;
        addLog('err', msg);
        connMsg(msg);
      }
    };
    const btnF = el('button', 'btn small', '忘记');
    btnF.type = 'button';
    btnF.onclick = async () => {
      try { await d.forget?.(); } catch { /* ignore */ }
      renderKnown();
    };
    row.append(info, btnC, btnF);
    box.append(row);
  }
}

function renderStatus() {
  if (adapter.connected) connMsg(null);
  const pill = $('#status-pill');
  const dev = adapter.device;
  const conn = adapter.connected;
  pill.className = 'pill ' + (conn ? 'on' : 'off');
  pill.textContent = conn ? `已连接 · ${dev?.name || '未命名'}` : '未连接';

  const card = $('#device-card');
  if (!dev) { card.hidden = true; return; }
  card.hidden = false;

  const info = $('#device-info');
  info.innerHTML = '';
  const rows = [
    ['名称', dev.name || '（未命名）'],
    ['ID', dev.id],
    ['状态', conn ? '已连接' : '已断开'],
    ['RSSI', adapter.watching ? '监听中…' : '—'],
    ['服务', adapter.tree.length ? `${adapter.tree.length} 个服务 / ${adapter.chars.size} 个特征` : '—'],
  ];
  for (const [k, v] of rows) {
    const r = el('div', 'info-row');
    const val = el('span', 'v', v);
    if (k === 'RSSI') val.id = 'dev-rssi';
    r.append(el('span', 'k', k), val);
    info.append(r);
  }

  $('#btn-watch').textContent = adapter.watching ? '停止监听（RSSI）' : '监听广播（RSSI）';
  $('#gatt-empty').hidden = adapter.tree.length > 0;
}

// ============================== GATT 页 ==============================

function renderGatt() {
  const treeBox = $('#gatt-tree');
  treeBox.innerHTML = '';
  S.charEls.clear();
  $('#gatt-empty').hidden = adapter.tree.length > 0;
  for (const svc of adapter.tree) {
    const det = el('details', 'svc');
    det.open = true;
    const sum = el('summary');
    sum.append(el('span', 'svc-name', svc.label), el('span', 'svc-uuid mono', svc.uuid));
    det.append(sum);
    for (const ch of svc.chars) det.append(charCard(ch));
    if (svc.error) det.append(el('p', 'hint', `特征读取失败：${svc.error}`));
    treeBox.append(det);
  }
}

function charCard(ch) {
  const card = el('div', 'char-card');

  const head = el('div', 'char-head');
  const title = el('div', 'char-title');
  const uuidText = shortUuid(ch.uuid) ? `${shortUuid(ch.uuid)} · ${ch.uuid}` : ch.uuid;
  title.append(el('div', 'char-name', ch.label), el('div', 'char-uuid mono', uuidText));
  const badges = el('div', 'badges');
  for (const [p, label] of PROP_BADGES) if (ch.props[p]) badges.append(el('span', `badge b-${p}`, label));
  head.append(title, badges);
  card.append(head);

  const val = el('div', 'char-value mono', '—');
  const parsed = el('div', 'char-parsed mono', '');
  card.append(val, parsed);

  const actions = el('div', 'row wrap actions');
  let notifyBtn = null, pollBtn = null, pollInput = null;

  if (ch.props.read) {
    const b = el('button', 'btn small', '读取');
    b.type = 'button';
    b.onclick = () => adapter.read(ch.key).catch((e) => addLog('err', `读取失败：${e.message}`));
    actions.append(b);
  }

  if (ch.props.notify || ch.props.indicate) {
    const base = ch.props.notify ? '订阅通知' : '订阅指示';
    const b = el('button', 'btn small', base);
    b.type = 'button';
    b.dataset.base = base;
    b.onclick = async () => {
      try {
        if (adapter.subscribedKeys.has(ch.key)) await adapter.unsubscribe(ch.key);
        else await adapter.subscribe(ch.key);
      } catch (e) { addLog('err', `订阅操作失败：${e.message}`); }
    };
    notifyBtn = b;
    actions.append(b);
  }

  if (ch.props.read) {
    const sec = el('input', 'poll-sec');
    sec.type = 'number'; sec.min = 1; sec.max = 3600; sec.value = 5; sec.title = '间隔（秒）';
    const b = el('button', 'btn small', '定时读取');
    b.type = 'button';
    b.onclick = () => {
      if (adapter.pollKey === ch.key) adapter.stopPoll();
      else adapter.startPoll(ch.key, parseInt(sec.value, 10) || 5);
    };
    pollBtn = b;
    pollInput = sec;
    const wrap = el('div', 'poll-wrap');
    wrap.append(sec, el('span', null, '秒'), b);
    actions.append(wrap);
  }

  const pb = el('button', 'btn small ghost', '解析');
  pb.type = 'button';
  pb.title = '在协议页为该特征配置解析规则';
  pb.onclick = () => {
    switchTab('proto');
    $('#proto-uuid').value = shortUuid(ch.uuid) || ch.uuid;
    setProtoUuid(ch.uuid);
  };
  actions.append(pb);
  card.append(actions);

  if (ch.props.write || ch.props.writeWithoutResponse) {
    const area = el('div', 'write-area');
    const fmt = el('select', 'write-fmt');
    for (const [v, l] of [['hex', 'HEX'], ['ascii', 'ASCII'], ['utf8', 'UTF-8']]) {
      const o = el('option', null, l); o.value = v; fmt.append(o);
    }
    const wt = el('select', 'write-type');
    if (ch.props.write) { const o = el('option', null, '带响应'); o.value = 'with'; wt.append(o); }
    if (ch.props.writeWithoutResponse) { const o = el('option', null, '无响应'); o.value = 'without'; wt.append(o); }
    wt.value = ch.props.write ? 'with' : 'without';
    const input = el('input', 'write-input');
    input.type = 'text';
    input.placeholder = 'HEX：01 02 03 或文本';
    const send = el('button', 'btn small primary', '发送');
    send.type = 'button';
    const doSend = () => {
      const text = input.value;
      if (!text) return;
      let bytes = null;
      if (fmt.value === 'hex') bytes = parseHexInput(text);
      else if (fmt.value === 'ascii') bytes = new Uint8Array([...text].map((c) => c.charCodeAt(0) & 0xff));
      else bytes = encodeUtf8(text);
      if (!bytes || bytes.length === 0) { addLog('err', '发送内容为空或 HEX 格式错误'); return; }
      adapter.write(ch.key, bytes, wt.value === 'with').catch((e) => addLog('err', `写入失败：${e.message}`));
    };
    send.onclick = doSend;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
    area.append(fmt, wt, input, send);
    card.append(area);
  }

  if (ch.descriptors.length) {
    const det = el('details', 'descs');
    det.append(el('summary', null, `描述符（${ch.descriptors.length}）`));
    for (const d of ch.descriptors) {
      const row = el('div', 'desc-row');
      const info = el('div', 'desc-info');
      info.append(el('span', 'desc-name', d.label), el('span', 'desc-uuid mono', shortUuid(d.uuid) || d.uuid));
      const b = el('button', 'btn small', '读取');
      b.type = 'button';
      b.onclick = async () => {
        try {
          const v = await d.obj.readValue();
          addLog('rx', `${shortUuid(d.uuid) || '描述符'} ← ${formatBytes(v, S.viewFormat)}`);
        } catch (e) { addLog('err', `描述符读取失败：${e.message}`); }
      };
      row.append(info, b);
      det.append(row);
    }
    card.append(det);
  }

  S.charEls.set(ch.key, { val, parsed, notifyBtn, pollBtn, pollInput });
  return card;
}

function updateNotifyButton(key, on) {
  const cel = S.charEls.get(key);
  if (!cel?.notifyBtn) return;
  cel.notifyBtn.textContent = on ? cel.notifyBtn.dataset.base.replace('订阅', '退订') : cel.notifyBtn.dataset.base;
}

function updatePollButtons() {
  for (const [key, cel] of S.charEls) {
    if (!cel.pollBtn) continue;
    const active = adapter.pollKey === key;
    cel.pollBtn.textContent = active ? '停止定时' : '定时读取';
    if (cel.pollInput) cel.pollInput.disabled = active;
  }
}

// ============================== 控制台页 ==============================

function bindConsole() {
  $('#view-format').value = S.viewFormat;
  $('#view-format').addEventListener('change', (e) => {
    S.viewFormat = e.target.value;
    store.set('viewFormat', S.viewFormat);
  });

  $$('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const dir = chip.dataset.dir;
      S.logFilter[dir] = !S.logFilter[dir];
      chip.classList.toggle('active', S.logFilter[dir]);
      renderLogFull();
    });
  });

  $('#btn-pause').addEventListener('click', () => {
    S.logPaused = !S.logPaused;
    $('#btn-pause').textContent = S.logPaused ? '继续' : '暂停';
    if (!S.logPaused) renderLogFull();
  });

  $('#btn-clear').addEventListener('click', () => {
    S.logBuf.length = 0;
    S.pending.length = 0;
    S.counts = { rx: 0, tx: 0 };
    updateStats();
    renderLogFull();
    addLog('sys', '日志已清空');
  });

  $('#btn-export').addEventListener('click', () => {
    if (!S.logBuf.length) { addLog('err', '暂无日志可导出'); return; }
    const text = S.logBuf.map((e) => `${e.ts} [${e.dir.toUpperCase()}] ${e.text}`).join('\n');
    const d = new Date();
    const name = `ble-log-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.log`;
    downloadText(name, text);
  });
}

// ============================== 协议页 ==============================

function curRules() { return S.rules.get(S.protoUuid) || []; }

function saveRules() {
  store.set('rules', Object.fromEntries(S.rules));
}

function setProtoUuid(uuid) {
  S.protoUuid = uuid;
  S.pasteBytes = null;
  S.selStart = S.selEnd = null;
  renderProtoChips();
  renderProtoData(S.latest.get(uuid) || null);
  renderRules();
}

function renderProtoChips() {
  const box = $('#proto-chips');
  box.innerHTML = '';
  const seen = new Set();
  for (const svc of adapter.tree) {
    for (const ch of svc.chars) {
      if (seen.has(ch.uuid)) continue;
      seen.add(ch.uuid);
      const b = el('button', 'chip' + (ch.uuid === S.protoUuid ? ' active' : ''), ch.label);
      b.type = 'button';
      b.onclick = () => {
        $('#proto-uuid').value = shortUuid(ch.uuid) || ch.uuid;
        setProtoUuid(ch.uuid);
      };
      box.append(b);
    }
  }
}

function renderProtoData(bytes) {
  S.protoBytes = bytes;
  renderByteGrid();
  renderResults();
}

function renderByteGrid() {
  const grid = $('#byte-grid');
  grid.innerHTML = '';
  S.selStart = S.selEnd = null;
  updateByteUI();
  const bytes = S.protoBytes;
  if (!bytes || !bytes.length) {
    grid.append(el('p', 'hint', '暂无数据：接收数据后自动更新，或粘贴 HEX 后点「解析粘贴数据」。'));
    return;
  }
  const frag = document.createDocumentFragment();
  bytes.forEach((b, i) => {
    const cell = el('button', 'byte');
    cell.type = 'button';
    cell.append(el('i', null, String(i)), el('span', null, hex2(b)));
    cell.onclick = () => onByteClick(i);
    frag.append(cell);
  });
  grid.append(frag);
}

function onByteClick(i) {
  if (S.selStart === null || S.selEnd !== null) { S.selStart = i; S.selEnd = null; }
  else if (i === S.selStart) { S.selStart = null; }
  else { S.selEnd = i; }
  paintSelection();
  updateByteUI();
}

function paintSelection() {
  const cells = $$('#byte-grid .byte');
  const a = S.selStart, b = S.selEnd;
  cells.forEach((c, i) => {
    c.classList.toggle('start', a !== null && b === null && i === a);
    c.classList.toggle('sel', a !== null && b !== null && i >= Math.min(a, b) && i <= Math.max(a, b));
  });
}

function updateByteUI() {
  const info = $('#byte-info');
  const actions = $('#byte-actions');
  const n = S.protoBytes ? S.protoBytes.length : 0;
  if (S.selStart !== null && S.selEnd !== null) {
    const a = Math.min(S.selStart, S.selEnd), b = Math.max(S.selStart, S.selEnd);
    const len = b - a + 1;
    info.textContent = `已选字节 ${a}–${b}（${len} 字节）· 推荐类型 ${P.inferType(len)}`;
    actions.hidden = false;
  } else if (S.selStart !== null) {
    info.textContent = `起点 ${S.selStart}：再点一个字节作为终点`;
    actions.hidden = true;
  } else {
    info.textContent = n ? `共 ${n} 字节。点选首尾两个字节可快速添加字段。` : '';
    actions.hidden = true;
  }
}

function renderRules() {
  const box = $('#rules-list');
  box.innerHTML = '';
  if (!S.protoUuid) { box.append(el('p', 'hint', '先在上方选择或输入特征 UUID。')); return; }
  const rules = curRules();
  if (!rules.length) { box.append(el('p', 'hint', '暂无字段。在字节视图点选两个字节即可快速添加，或点「添加字段」。')); return; }
  rules.forEach((rule, idx) => box.append(ruleCard(rule, idx, rules)));
}

function ruleCard(rule, idx, rules) {
  const card = el('div', 'rule-card');
  const mk = (labelText, node, span2) => {
    const f = el('div', 'rf' + (span2 ? ' span2' : ''));
    f.append(el('label', null, labelText), node);
    return f;
  };

  const name = el('input'); name.value = rule.name; name.placeholder = '字段名';
  name.oninput = () => { rule.name = name.value; scheduleRulesChange(); };

  const off = el('input'); off.type = 'number'; off.min = 0; off.max = 65535; off.value = rule.offset;
  off.oninput = () => { rule.offset = parseInt(off.value, 10) || 0; scheduleRulesChange(); };

  const type = el('select');
  for (const t of P.FIELD_TYPES) { const o = el('option', null, t); o.value = t; type.append(o); }
  type.value = rule.type;
  type.onchange = () => { rule.type = type.value; scheduleRulesChange(); };

  const endian = el('select');
  for (const [v, l] of [['big', '大端'], ['little', '小端']]) { const o = el('option', null, l); o.value = v; endian.append(o); }
  endian.value = rule.endian;
  endian.onchange = () => { rule.endian = endian.value; scheduleRulesChange(); };

  const unit = el('input'); unit.value = rule.unit; unit.placeholder = '℃ / ms / …';
  unit.oninput = () => { rule.unit = unit.value; scheduleRulesChange(); };

  const en = el('input'); en.value = rule.enum_text; en.placeholder = '0=停止;1=运行';
  en.oninput = () => { rule.enum_text = en.value; scheduleRulesChange(); };

  const del = el('button', 'btn small danger block', '删除');
  del.type = 'button';
  del.onclick = () => { rules.splice(idx, 1); commitRules(rules); };

  card.append(
    mk('字段名', name, true),
    mk('偏移', off), mk('类型', type),
    mk('字节序', endian), mk('单位', unit),
    mk('枚举映射', en, true),
    del,
  );
  return card;
}

let rulesTimer = null;
function scheduleRulesChange() {
  clearTimeout(rulesTimer);
  rulesTimer = setTimeout(() => commitRules(curRules(), false), 400);
}

function commitRules(rules, rerender = true) {
  if (rules.length) S.rules.set(S.protoUuid, rules);
  else S.rules.delete(S.protoUuid);
  saveRules();
  renderResults();
  if (rerender) renderRules();
}

function renderResults() {
  const box = $('#proto-results');
  box.innerHTML = '';
  if (!S.protoUuid) { box.append(el('p', 'hint', '先在上方选择或输入特征 UUID。')); S.lastResults = []; return; }
  const bytes = S.protoBytes;
  if (!bytes || !bytes.length) { box.append(el('p', 'hint', '暂无数据：连接后接收，或粘贴 HEX 解析。')); S.lastResults = []; return; }
  const rules = curRules();
  if (!rules.length) { box.append(el('p', 'hint', '暂无规则。可在字节视图点选添加，或手动「添加字段」。')); S.lastResults = []; return; }

  S.lastResults = P.parseAll(bytes, rules);
  const tbl = el('table', 'tbl');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['字段', '原始', '值']) hr.append(el('th', null, h));
  thead.append(hr);
  const tb = el('tbody');
  for (const r of S.lastResults) {
    const tr = el('tr', r.ok ? '' : 'bad');
    const size = P.TYPE_SIZES[r.rule.type] || 0;
    const raw = bytes.slice(r.rule.offset, r.rule.offset + size);
    tr.append(
      el('td', null, r.rule.name),
      el('td', 'mono', [...raw].map(hex2).join(' ')),
      el('td', 'mono', r.ok ? r.text : r.error),
    );
    tb.append(tr);
  }
  tbl.append(thead, tb);
  box.append(tbl);
}

function bindProto() {
  $('#proto-uuid').addEventListener('change', () => {
    const raw = $('#proto-uuid').value.trim();
    if (!raw) return;
    const uuid = expandUuid(raw);
    if (!uuid) { addLog('err', 'UUID 格式不正确（应为 4 位短码或完整 UUID）'); return; }
    setProtoUuid(uuid);
  });

  $('#btn-parse-paste').addEventListener('click', () => {
    const bytes = parseHexInput($('#proto-paste').value);
    if (!bytes || !bytes.length) { addLog('err', 'HEX 格式错误或为空'); return; }
    S.pasteBytes = bytes;
    renderProtoData(bytes);
    addLog('sys', `已解析粘贴数据（${bytes.length} 字节）`);
  });

  $('#btn-use-latest').addEventListener('click', () => {
    if (!S.protoUuid) { addLog('err', '请先选择特征 UUID'); return; }
    const bytes = S.latest.get(S.protoUuid);
    if (!bytes) { addLog('err', '该特征暂无接收数据'); return; }
    S.pasteBytes = null;
    renderProtoData(bytes);
    addLog('sys', `已载入最新接收数据（${bytes.length} 字节）`);
  });

  $('#chk-live').addEventListener('change', (e) => { S.liveParse = e.target.checked; });

  $('#btn-add-field').addEventListener('click', () => {
    if (S.selStart === null || S.selEnd === null) return;
    const a = Math.min(S.selStart, S.selEnd);
    const len = Math.abs(S.selEnd - S.selStart) + 1;
    const rules = curRules();
    rules.push(P.newRule({ name: `字段${rules.length + 1}`, offset: a, type: P.inferType(len) }));
    commitRules(rules);
    renderByteGrid();
  });

  $('#btn-clear-sel').addEventListener('click', () => {
    S.selStart = S.selEnd = null;
    paintSelection();
    updateByteUI();
  });

  $('#btn-rule-add').addEventListener('click', () => {
    if (!S.protoUuid) { addLog('err', '请先选择或输入特征 UUID'); return; }
    const rules = curRules();
    rules.push(P.newRule({ name: `字段${rules.length + 1}` }));
    commitRules(rules);
  });

  $('#btn-rule-export').addEventListener('click', () => {
    downloadText('ble-rules.json', JSON.stringify(Object.fromEntries(S.rules), null, 2), 'application/json');
  });

  $('#btn-rule-import').addEventListener('click', () => $('#rule-import-file').click());
  $('#rule-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const next = new Map();
      let count = 0;
      for (const [uuid, list] of Object.entries(raw)) {
        const u = expandUuid(uuid) || String(uuid).toLowerCase();
        const rules = P.sanitizeRules(list);
        if (u && rules.length) { next.set(u, rules); count++; }
      }
      S.rules = next;
      saveRules();
      renderProtoChips();
      if (S.protoUuid) { renderRules(); renderResults(); }
      addLog('sys', `已导入 ${count} 个特征的解析规则`);
    } catch (err) {
      addLog('err', `规则导入失败：${err.message}`);
    }
  });

  $('#btn-result-csv').addEventListener('click', () => {
    if (!S.lastResults.length) { addLog('err', '暂无可导出的解析结果'); return; }
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['字段,偏移,长度,类型,字节序,值'];
    for (const r of S.lastResults) {
      lines.push([
        r.rule.name, r.rule.offset, P.TYPE_SIZES[r.rule.type], r.rule.type, r.rule.endian,
        r.ok ? r.text : `错误: ${r.error}`,
      ].map(esc).join(','));
    }
    const short = (shortUuid(S.protoUuid) || 'result').toLowerCase();
    downloadText(`protocol-${short}.csv`, '\ufeff' + lines.join('\n'), 'text/csv');
  });
}

// ============================== 数据流 ==============================

function parsedSummary(uuid, bytes) {
  const rules = S.rules.get(uuid);
  if (!rules || !rules.length) return '';
  const ok = P.parseAll(bytes, rules).filter((r) => r.ok);
  if (!ok.length) return '';
  return ok.map((r) => `${r.rule.name}=${r.text}`).join(', ');
}

function handleRx(ev) {
  const bytes = bytesOf(ev.value);
  S.counts.rx++;
  S.latest.set(ev.uuid, bytes);
  const tag = ev.source === 'poll' ? '（定时）' : ev.source === 'read' ? '（读取）' : '';
  addLog('rx', `${charShort(ev.uuid)} ← ${formatBytes(bytes, S.viewFormat)}${tag ? ' ' + tag : ''}`);
  updateStats();

  const parsed = parsedSummary(ev.uuid, bytes);
  if (parsed) addLog('sys', `解析 ${charShort(ev.uuid)}：${parsed}`);

  const cel = S.charEls.get(ev.key);
  if (cel) {
    cel.val.textContent = formatBytes(bytes, S.viewFormat);
    cel.parsed.textContent = parsed;
  }

  if (S.protoUuid === ev.uuid && S.liveParse && !S.pasteBytes) renderProtoData(bytes);
}

// ============================== 初始化 ==============================

function init() {
  const ok = adapter.supported();
  $('#compat-banner').hidden = ok;
  $('#https-banner').hidden = ok && window.isSecureContext;
  $('#btn-scan').disabled = !ok;
  if (!ok) addLog('err', '当前浏览器不支持 Web Bluetooth，请使用 Android 版 Chrome / Edge');

  $('#chk-reconnect').checked = S.autoReconnect;
  adapter.autoReconnect = S.autoReconnect;

  $$('#tabbar button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.page)));

  bindConn();
  bindConsole();
  bindProto();

  adapter.on('log', (e) => addLog(e.dir, e.text));
  adapter.on('state', renderStatus);
  adapter.on('tree', () => { renderGatt(); renderProtoChips(); });
  adapter.on('rx', handleRx);
  adapter.on('tx', (e) => {
    S.counts.tx++;
    addLog('tx', `${charShort(e.uuid)} → ${formatBytes(e.bytes, S.viewFormat)}`);
    updateStats();
  });
  adapter.on('rssi', (e) => {
    const s = $('#dev-rssi');
    if (s) s.textContent = e?.rssi != null ? `${e.rssi} dBm` : '—';
  });
  adapter.on('subscribed', ({ key, uuid, on }) => {
    updateNotifyButton(key, on);
    if (uuid) addLog('sys', `${charShort(uuid)} ${on ? '已订阅' : '已退订'}`);
  });
  adapter.on('poll', (p) => {
    if (p) addLog('sys', `定时读取启动：${charShort(p.uuid)}，间隔 ${p.intervalSec}s`);
    else addLog('sys', '定时读取已停止');
    updatePollButtons();
  });

  renderKnown();
  renderStatus();
  renderProtoChips();
  addLog('sys', 'BLE 调试助手（网页版）已就绪');
}

init();

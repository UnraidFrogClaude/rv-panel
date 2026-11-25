import * as P from './protocols.js';
import { KINDS, VictronListener, choose, log, note, remembered, supported } from './ble.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n, d = 1, unit = '') => (n === null || n === undefined || !Number.isFinite(n) ? '–' : `${n.toFixed(d)}${unit}`);
const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const STALE_MS = 60000;

// ---- storage (best effort; the panel works without it)
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(`rv.${k}`)) ?? d; } catch { return d; } };
const save = (k, v) => { try { v === null ? localStorage.removeItem(`rv.${k}`) : localStorage.setItem(`rv.${k}`, JSON.stringify(v)); } catch { /* private mode */ } };

const state = {
  accessories: new Map(), victron: new Map(), listener: null, locked: true, demo: false,
  keys: load('keys', []), known: load('known', {}), creds: load('creds', { email: '', password: '' }),
  remember: Boolean(load('creds', null)), pending: new Map(), message: '', offline: 'checking',
};

// ---- theme
let theme = load('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('theme').textContent = theme === 'dark' ? 'Day view' : 'Night view';
}

// ---- rendering: each card's DOM is only replaced when its markup changes, so taps are not lost
const drawn = new Map();
function put(id, html) { if (drawn.get(id) !== html) { drawn.set(id, html); $(id).innerHTML = html; } }
let queued = false;
function refresh() { if (!queued) { queued = true; setTimeout(() => { queued = false; draw(); }, 30); } }

const STATUS = { connecting: 'Connecting', waiting: 'Reconnecting', connected: 'Live', demo: 'Demo', off: 'Off' };
function ageText(t) {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 10 ? 'just now' : s < 60 ? `${Math.floor(s / 10) * 10} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}
function card(title, body, { updatedAt = 0, status = null, error = null } = {}) {
  const stale = updatedAt && Date.now() - updatedAt > STALE_MS;
  const text = [status && status !== 'connected' ? STATUS[status] : '', updatedAt ? ageText(updatedAt) : ''].filter(Boolean).join(', ');
  return `<article class="card${stale ? ' stale' : ''}"><div class="top"><h2>${esc(title)}</h2><span class="state${stale || status === 'waiting' ? ' bad' : ''}">${stale ? 'Old reading: ' : ''}${esc(text)}</span></div>
    <div class="body">${body}</div>${error ? `<p class="warn">${esc(error)}</p>` : ''}</article>`;
}
const facts = (pairs) => `<dl class="facts">${pairs.filter(([, v]) => v !== null).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const of = (kind) => [...state.accessories.values()].filter((a) => a.kind === kind);
const canAdd = () => supported() && !state.demo;
const add = (kind, label) => (canAdd() ? `<div class="row"><button class="main" data-act="add" data-kind="${kind}">${label}</button></div>` : '');
const fToText = (c) => `${Math.round(c * 9 / 5 + 32)}°F`;
const hours = (h) => (h === null ? null : h > 99 ? '99+ h' : h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`);

function batteryCard(a) {
  const d = a.data;
  if (!d) return card(a.name, '<p class="hint">Waiting for the first reading.</p>', a);
  const flow = Math.abs(d.current) < 0.1 ? 'Idle' : d.current > 0 ? 'Charging' : 'Discharging';
  return card(a.name, `<div class="hero"><span class="big">${d.soc}<small>%</small></span>
      <span class="mid ${d.current > 0.1 ? 'in' : 'out'}">${flow} ${num(Math.abs(d.power), 0, ' W')}</span></div>
    <div class="bar${d.soc <= 20 ? ' low' : ''}"><i style="width:${Math.max(0, Math.min(100, d.soc))}%"></i></div>
    ${facts([['Voltage', num(d.voltage, 2, ' V')], ['Current', num(d.current, 1, ' A')], ['Left', num(d.remainingAh, 0, ' Ah')],
      ['Time left', hours(d.hoursLeft)], ['Temperature', d.temps.length ? d.temps.map(fToText).join(', ') : null],
      ['Cell spread', d.cells.length > 1 ? `${Math.round((Math.max(...d.cells) - Math.min(...d.cells)) * 1000)} mV` : null],
      ['Cycles', d.cycles], ['Heater', d.heater ? 'On' : null]])}
    ${d.problem ? `<p class="warn">The battery reports a problem (code ${esc(d.problemCode)}). Open the LiTime app for details.</p>` : ''}`, a);
}

function victronCard(v) {
  const d = v.data;
  if (d.kind === 'solar') return card(v.name, `<div class="hero"><span class="big">${num(d.watts, 0)}<small> W</small></span><span class="mid out">${esc(d.state)}</span></div>
    <div style="height:12px"></div>${facts([['Today', num(d.yieldWh, 0, ' Wh')], ['Battery', num(d.voltage, 2, ' V')], ['Charging', num(d.current, 1, ' A')]])}
    ${d.error ? `<p class="warn">Charger error ${d.error}. Open VictronConnect for details.</p>` : ''}`, v);
  if (d.kind === 'shunt') return card(v.name, `<div class="hero"><span class="big">${num(d.soc, 0)}<small>%</small></span></div><div style="height:12px"></div>
    ${facts([['Voltage', num(d.voltage, 2, ' V')], ['Current', num(d.current, 1, ' A')], ['Used', num(d.usedAh, 0, ' Ah')], ['Time left', d.minutesLeft === null ? null : hours(d.minutesLeft / 60)]])}
    ${d.alarm ? '<p class="warn">Battery monitor alarm. Open VictronConnect for details.</p>' : ''}`, v);
  return card(v.name, `<p class="hint">Received, but this Victron device type (${d.type}) is not decoded yet.</p>`, v);
}

const MODE_LABEL = { off: 'Off', cool: 'Cool', heat: 'Heat', auto: 'Auto', fan: 'Fan' };
const ACTION_LABEL = { cooling: 'Cooling', heating: 'Heating', fan: 'Fan running', idle: 'Idle' };
const cmdHtml = (c) => (!c ? '' : `<p class="cmd ${c.state}" role="status">${c.state === 'sending' ? `Sending: ${esc(c.label)}` : c.state === 'confirmed' ? `Thermostat confirmed: ${esc(c.label)}` : `Not confirmed: ${esc(c.label)}. ${esc(c.error)}`}</p>`);

function zoneCard(a, z, many) {
  const id = `${a.key}|${z.zone}`;
  const want = state.pending.get(id) || {};
  const fresh = Date.now() - a.updatedAt <= STALE_MS;
  const busy = a.command?.state === 'sending';
  const off = state.locked || busy || !fresh || !['connected', 'demo'].includes(a.status) ? 'disabled' : '';
  const setRow = (f, label) => `<div class="set"><span class="label">${label}</span><button data-act="step" data-id="${esc(id)}" data-f="${f}" data-d="-1" ${off} aria-label="Lower ${label}">−</button><span class="to">${want[f] ?? z[f]}°</span><button data-act="step" data-id="${esc(id)}" data-f="${f}" data-d="1" ${off} aria-label="Raise ${label}">+</button></div>`;
  const rows = z.mode === 'cool' ? setRow('cool', 'Cool to') : z.mode === 'heat' ? setRow('heat', 'Heat to') : z.mode === 'auto' ? setRow('autoHeat', 'Heat to') + setRow('autoCool', 'Cool to') : '';
  const fans = z.mode === 'fan' ? ['low', 'high'] : ['cool', 'heat', 'auto'].includes(z.mode) ? ['low', 'high', 'auto'] : [];
  return card(many ? `${a.name}, zone ${z.zone + 1}` : a.name, `<div class="hero"><span class="big">${num(z.temp, 0)}<small>°F</small></span>
      <span class="mid ${z.action}">${z.mode === 'off' ? 'Off' : ACTION_LABEL[z.action]}</span></div>
    <div class="row seg" role="group" aria-label="Mode">${Object.keys(MODE_LABEL).map((m) => `<button data-act="mode" data-id="${esc(id)}" data-v="${m}" ${off} class="${z.mode === m ? 'on' : ''}" aria-pressed="${z.mode === m}">${MODE_LABEL[m]}</button>`).join('')}</div>
    ${rows}
    ${fans.length ? `<div class="row seg" role="group" aria-label="Fan speed">${fans.map((f) => `<button data-act="fan" data-id="${esc(id)}" data-v="${f}" ${off} class="${z.fan === f ? 'on' : ''}" aria-pressed="${z.fan === f}">Fan ${f}</button>`).join('')}</div>` : ''}
    ${z.fan?.startsWith('cycled') ? `<p class="hint">Fan is set to ${z.fan} at the thermostat.</p>` : ''}
    ${a.data.wallOff ? '<p class="hint">The thermostat may be switched off at the wall.</p>' : ''}
    ${state.locked ? '<p class="hint">Controls are locked. Unlock them at the top of the screen.</p>' : ''}
    ${cmdHtml(a.command)}`, a);
}

function easystartCard(a) {
  const d = a.data;
  if (!d) return card(a.name, '<p class="hint">Waiting for the first reading.</p>', a);
  return card(a.name, `<div class="hero"><span class="big">${num(d.amps, 1)}<small> A</small></span><span class="mid ${d.ok ? 'in' : 'out'}">${esc(d.status)}</span></div><div style="height:12px"></div>
    ${facts([['Last start peak', num(d.lastPeak, 1, ' A')], ['Line', num(d.hz, 1, ' Hz')], ['Starts', d.starts], ['Faults', d.faults], ['Delay', d.delaying ? `${d.delaySec} s` : null]])}`, a);
}

function draw() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('lock').textContent = state.locked ? 'Unlock controls' : 'Lock controls';
  $('lock').setAttribute('aria-pressed', String(state.locked));

  const banner = state.demo ? 'Demo data. Nothing on screen is from your RV, and controls do nothing real.'
    : !supported() ? 'This browser cannot use Bluetooth. On the iPad, open this page in Bluefy.' : state.message;
  $('banner').hidden = !banner;
  $('banner').textContent = banner;

  const bats = of('litime'), vics = [...state.victron.values()];
  const listenBtn = canAdd() && state.keys.length && !state.listener && VictronListener.method() ? '<div class="row"><button class="main" data-act="listen">Start listening</button></div>' : '';
  put('power', (bats.length ? bats.map(batteryCard).join('') : card('LiTime battery', `<p class="hint">Shows charge, power, temperature and cell balance.</p>${add('litime', 'Connect battery')}`))
    + vics.map(victronCard).join('')
    + (!vics.length || listenBtn ? card('Victron', state.listener ? `<p class="hint">Listening. ${state.listener.heard ? 'Victron broadcasts heard, but none match your keys yet.' : 'No Victron broadcasts heard yet.'}</p>`
      : `<p class="hint">${!VictronListener.method() && !state.demo ? 'This browser has no Victron broadcast support. Use Boardstrom for Victron.' : 'Readings only. Add your Victron keys under Setup.'}</p>${listenBtn}`) : ''));

  const thermos = of('easytouch');
  put('climate', thermos.length ? thermos.map((a) => (a.data ? a.data.zones.map((z) => zoneCard(a, z, a.data.zones.length > 1)).join('') : card(a.name, '<p class="hint">Waiting for the first reading.</p>', a))).join('')
    : card('EasyTouch thermostat', `<p class="hint">Shows and sets temperature, mode and fan. Needs your Micro-Air sign-in under Setup.</p>${add('easytouch', 'Connect thermostat')}`));

  const starts = of('easystart');
  put('other', (starts.length ? starts.map(easystartCard).join('') : card('EasyStart', `<p class="hint">Shows A/C current, start peaks and faults.</p>${add('easystart', 'Connect EasyStart')}`))
    + card('Starlink', '<p class="hint">Opens the dish’s own status page. Use the Starlink app for stow and reboot.</p><div class="row"><button data-act="starlink">Open dish status</button></div>'));
}

// ---- accessories
function attach(kind, device) {
  const key = `${kind}:${device.id}`;
  state.accessories.get(key)?.stop();
  const a = new KINDS[kind](device, refresh, () => state.creds);
  state.accessories.set(key, a);
  state.known[device.id] = kind; save('known', state.known);
  a.start();
}
async function addAccessory(kind, showAll) {
  state.message = '';
  try { attach(kind, await choose(kind, showAll)); }
  catch (e) { if (e.name !== 'NotFoundError') state.message = `Could not connect: ${e.message}`; note('Setup', `${kind}: ${e.name} ${e.message}`); }
  refresh();
}
function zoneOf(id) {
  const cut = id.lastIndexOf('|');
  const a = state.accessories.get(id.slice(0, cut));
  const z = a?.data?.zones.find((x) => x.zone === Number(id.slice(cut + 1)));
  return z ? { a, z } : null;
}
/** Every control goes through here, so the lock and freshness checks cannot be skipped. */
async function control(id, build, label) {
  const t = zoneOf(id);
  if (!t || state.locked || t.a.command?.state === 'sending') return;
  if (Date.now() - t.a.updatedAt > STALE_MS) return;
  try { await t.a.change(build(t.z), label); }
  catch (e) { t.a.command = { label, state: 'failed', error: e.message }; }
  refresh();
}
const stepTimers = new Map();
function step(id, field, delta) {
  const t = zoneOf(id);
  if (!t || state.locked) return;
  const cur = state.pending.get(id) || {};
  const val = P.clampF((cur[field] ?? t.z[field]) + delta);
  const next = { ...t.z, ...cur, [field]: val };
  if (t.z.mode === 'auto' && next.autoCool - next.autoHeat < P.EASYTOUCH.autoGap) return;
  state.pending.set(id, { ...cur, [field]: val });
  clearTimeout(stepTimers.get(id));
  stepTimers.set(id, setTimeout(async () => {
    const want = { ...state.pending.get(id) };
    const mode = t.z.mode;
    const text = mode === 'auto' ? `${want.autoHeat ?? t.z.autoHeat}° to ${want.autoCool ?? t.z.autoCool}°` : `${want[mode]}°`;
    await control(id, (z) => {
      if (z.mode !== mode) throw new Error('The mode changed before this was sent');
      return P.tempCommand(z.zone, mode, { ...z, ...want });
    }, text);
    state.pending.delete(id); refresh();
  }, 1200));
  refresh();
}
function clearPending() { stepTimers.forEach(clearTimeout); stepTimers.clear(); state.pending.clear(); }

// ---- Victron
async function listen() {
  const l = new VictronListener(() => state.keys, (k, data) => {
    state.victron.set(k.key, { name: k.name, data, updatedAt: Date.now(), status: 'connected' });
    refresh();
  });
  try { await l.start(); state.listener = l; } catch (e) { l.stop(); state.message = e.message; note('Victron', e.message); }
  refresh();
}

// ---- setup
function drawSetup() {
  const devs = [...state.accessories.values()];
  $('setup').innerHTML = `
  <div class="top"><h2>Setup</h2><button data-act="close">Done</button></div>
  <h2>Equipment</h2>
  ${devs.length ? devs.map((a) => `<div class="dev"><span>${esc(a.name)}: ${STATUS[a.status]}</span><button data-act="drop" data-id="${esc(a.key)}">Disconnect</button></div>`).join('') : '<p>Nothing connected.</p>'}
  ${canAdd() ? `<div class="row">${Object.entries(KINDS).map(([k, c]) => `<button data-act="add" data-kind="${k}">Add ${esc(c.label)}</button>`).join('')}</div>
  <p class="hint">Not in the list? Show every Bluetooth device:</p><div class="row">${Object.entries(KINDS).map(([k, c]) => `<button data-act="addall" data-kind="${k}">${esc(c.label)}, show all</button>`).join('')}</div>` : ''}
  <p class="hint">Most of these accept one connection at a time. Disconnect here before opening the maker’s app, and close that app before connecting here.</p>
  <h2>Micro-Air sign-in</h2><p>The thermostat checks this over Bluetooth. This page sends it only to the thermostat.</p>
  <label for="em">Email</label><input id="em" type="email" autocomplete="off" autocapitalize="none" value="${esc(state.creds.email)}">
  <label for="pw">Password</label><input id="pw" type="password" autocomplete="off" value="${esc(state.creds.password)}">
  <label class="check"><input id="rm" type="checkbox" ${state.remember ? 'checked' : ''}>Remember on this iPad, unencrypted</label>
  <div class="row"><button class="main" data-act="creds">Save sign-in</button><button data-act="forget">Forget everything saved</button></div>
  <h2>Victron keys</h2><p>In VictronConnect: device, gear, menu, Product info, Instant readout via Bluetooth, Show. Keys are saved on this iPad.</p>
  ${state.keys.map((k, i) => `<div class="dev"><span>${esc(k.name)}</span><button data-act="delkey" data-i="${i}">Remove</button></div>`).join('')}
  <label for="vn">Name</label><input id="vn" maxlength="30" placeholder="Solar charger">
  <label for="vk">Key, 32 characters</label><input id="vk" autocomplete="off" autocapitalize="none" spellcheck="false">
  <div class="row"><button data-act="addkey">Add key</button></div>
  <p id="msg" class="warn" role="status"></p>
  <h2>Demo</h2><div class="row"><button data-act="demo">${state.demo ? 'Stop demo' : 'Show demo data'}</button></div>
  <h2>Diagnostics</h2>
  <p>Bluetooth: ${supported() ? 'yes' : 'no'}. Victron broadcasts: ${VictronListener.method() || 'no'}. Reconnect without a tap: ${navigator.bluetooth?.getDevices ? 'yes' : 'no'}. Offline copy: ${state.offline}.</p>
  <pre id="log">${esc(log.slice(-60).join('\n') || 'Nothing logged yet.')}</pre>
  <div class="row"><button data-act="copylog">Copy log</button></div>
  <p class="hint">The log leaves out your sign-in and keys. It includes device names and raw battery and EasyStart readings.</p>`;
}
const setupMsg = (t) => { const m = $('msg'); if (m) m.textContent = t; };

// ---- demo
let demoTimer;
function setDemo(on) {
  clearInterval(demoTimer); clearPending();
  state.accessories.forEach((a) => a.stop?.());
  state.accessories.clear(); state.victron.clear(); state.listener?.stop(); state.listener = null;
  state.demo = on; state.locked = true;
  if (!on) { refresh(); return; }
  const base = (kind, name, data) => ({ kind, key: `${kind}:demo`, name, data, status: 'demo', updatedAt: Date.now(), command: null, stop() {} });
  const bat = base('litime', 'Demo battery', { voltage: 13.21, current: -8.4, power: -111, remainingAh: 164, capacityAh: 230, soc: 71, health: 100, cycles: 46, cells: [3.301, 3.304, 3.303, 3.302], temps: [21], heater: false, problem: false, hoursLeft: 19.5 });
  const th = base('easytouch', 'Demo thermostat', { wallOff: false, zones: [{ zone: 0, mode: 'cool', temp: 76, action: 'cooling', autoHeat: 66, autoCool: 76, cool: 73, heat: 68, fan: 'auto' }] });
  th.change = async (cmd, label) => {
    th.command = { label, state: 'sending' }; refresh();
    await new Promise((r) => setTimeout(r, 900));
    if (!state.demo) return;
    const z = th.data.zones[0], c = cmd.Changes;
    if ('mode' in c) { z.mode = Object.keys(P.MODES).find((m) => P.MODES[m] === c.mode); z.action = { cool: 'cooling', heat: 'heating', fan: 'fan' }[z.mode] || 'idle'; z.fan = z.mode === 'off' ? null : z.mode === 'fan' ? 'low' : 'auto'; }
    if ('cool_sp' in c) z.cool = c.cool_sp; if ('heat_sp' in c) z.heat = c.heat_sp;
    if ('autoCool_sp' in c) { z.autoCool = c.autoCool_sp; z.autoHeat = c.autoHeat_sp; }
    for (const k of ['fanOnly', 'coolFan', 'heatFan', 'autoFan']) if (k in c) z.fan = Object.keys(P.FAN_VALUES).find((f) => P.FAN_VALUES[f] === c[k]);
    th.command = { label, state: 'confirmed' }; refresh();
    setTimeout(() => { th.command = null; refresh(); }, 3000);
  };
  const es = base('easystart', 'Demo EasyStart', { status: 'Normal', ok: true, delaying: false, amps: 11.6, hz: 60, lastPeak: 19.2, delaySec: 0, faults: 0, starts: 1284 });
  [bat, th, es].forEach((a) => state.accessories.set(a.key, a));
  state.victron.set('demo', { name: 'Demo solar charger', status: 'demo', updatedAt: Date.now(), data: { kind: 'solar', state: 'Bulk', error: 0, voltage: 13.4, current: 18.2, yieldWh: 940, watts: 246 } });
  demoTimer = setInterval(() => { state.accessories.forEach((a) => { a.updatedAt = Date.now(); }); state.victron.forEach((v) => { v.updatedAt = Date.now(); }); refresh(); }, 3000);
  refresh();
}

// ---- events
const actions = {
  lock() { state.locked = !state.locked; if (state.locked) clearPending(); },
  theme() { theme = theme === 'dark' ? 'light' : 'dark'; save('theme', theme); applyTheme(); },
  setup() { drawSetup(); $('setup').showModal(); },
  close() { $('setup').close(); },
  add(d) { $('setup').close(); return addAccessory(d.kind, false); },
  addall(d) { $('setup').close(); return addAccessory(d.kind, true); },
  drop(d) { const a = state.accessories.get(d.id); if (a) { a.stop(); state.accessories.delete(d.id); delete state.known[a.device?.id]; save('known', state.known); } drawSetup(); },
  creds() {
    state.creds = { email: $('em').value.trim(), password: $('pw').value };
    state.remember = $('rm').checked;
    save('creds', state.remember ? state.creds : null);
    if (!state.demo) of('easytouch').forEach((a) => attach('easytouch', a.device)); // reconnect with the new sign-in
    setupMsg('Sign-in saved.');
  },
  forget() {
    if (!confirm('Remove the saved sign-in, Victron keys and device list from this iPad?')) return;
    ['creds', 'keys', 'known'].forEach((k) => save(k, null));
    state.creds = { email: '', password: '' }; state.keys = []; state.known = {}; state.remember = false;
    state.listener?.stop(); state.listener = null; state.victron.clear();
    drawSetup();
  },
  addkey() {
    try {
      const key = P.normalizeKey($('vk').value);
      if (state.keys.some((k) => k.key === key)) throw new Error('That key is already saved');
      state.keys.push({ name: $('vn').value.trim() || `Victron ${state.keys.length + 1}`, key });
      save('keys', state.keys); drawSetup(); setupMsg('Key added. Tap Done, then Start listening.');
    } catch (e) { setupMsg(e.message); }
  },
  delkey(d) { const [k] = state.keys.splice(Number(d.i), 1); if (k) state.victron.delete(k.key); save('keys', state.keys); drawSetup(); },
  demo() { setDemo(!state.demo); $('setup').close(); },
  async copylog() { const t = log.join('\n'); try { await navigator.clipboard.writeText(t); setupMsg('Log copied.'); } catch { getSelection().selectAllChildren($('log')); setupMsg('Copy was blocked. The log is selected; use Copy.'); } },
  listen() { return listen(); },
  starlink() { window.open('http://192.168.100.1/', '_blank', 'noopener'); },
  mode(d) { clearPending(); return control(d.id, (z) => P.modeCommand(z.zone, d.v), MODE_LABEL[d.v]); },
  fan(d) { return control(d.id, (z) => P.fanCommand(z.zone, z.mode, d.v), `fan ${d.v}`); },
  step(d) { step(d.id, d.f, Number(d.d)); },
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  Promise.resolve(actions[b.dataset.act]?.(b.dataset)).catch((err) => note('Panel', err.message));
  refresh();
});
// Relock whenever the panel is put away, so a pocket tap cannot change the A/C.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { state.locked = true; clearPending(); } else { keepAwake(); state.accessories.forEach((a) => a.status === 'waiting' && a.start?.()); }
  refresh();
});
async function keepAwake() { try { await navigator.wakeLock?.request('screen'); } catch { /* set Auto-Lock to Never instead */ } }

async function boot() {
  applyTheme();
  if (local && new URLSearchParams(location.search).has('sim')) await import('./test/mock-ble.js');
  draw(); setInterval(draw, 5000); keepAwake();
  if (supported()) for (const d of await remembered()) if (KINDS[state.known[d.id]]) attach(state.known[d.id], d);
  if (!('serviceWorker' in navigator)) state.offline = 'not supported here';
  else if (local) state.offline = 'off while testing';
  else navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => { state.offline = 'ready'; }, () => { state.offline = 'unavailable'; });
}
boot();

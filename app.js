import * as P from './protocols.js';
import * as W from './weather.js';
import { KINDS, VictronListener, browserDetails, choose, log, note, remembered, supported, why } from './ble.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n, d = 1, unit = '') => (n === null || n === undefined || !Number.isFinite(n) ? '–' : `${n.toFixed(d)}${unit}`);
const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const STALE_MS = 60000;
const WEATHER_EVERY = 20 * 60000, WEATHER_STALE = 3 * 3600000;
const VERSION = 4; // keep in step with sw.js

// ---- storage (best effort; the panel works without it)
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(`rv.${k}`)) ?? d; } catch { return d; } };
const save = (k, v) => { try { v === null ? localStorage.removeItem(`rv.${k}`) : localStorage.setItem(`rv.${k}`, JSON.stringify(v)); } catch { /* private mode */ } };

const state = {
  accessories: new Map(), victron: new Map(), listener: null, vicIds: load('vic', []), locked: true, demo: false,
  keys: load('keys', []), known: load('known', {}), creds: load('creds', { email: '', password: '' }),
  remember: Boolean(load('creds', null)), pending: new Map(), message: '', offline: 'checking',
  place: load('place', null), wx: load('wx', null), wxBusy: false, wxError: '', placeError: '', found: [],
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
function card(title, body, { updatedAt = 0, status = null, error = null, key = null, device = null, staleMs = STALE_MS } = {}) {
  const stale = updatedAt && Date.now() - updatedAt > staleMs;
  const text = [status && status !== 'connected' ? STATUS[status] : '', updatedAt ? ageText(updatedAt) : ''].filter(Boolean).join(', ');
  return `<article class="card${stale ? ' stale' : ''}"><div class="top"><h2>${esc(title)}</h2><span class="state${stale || status === 'waiting' ? ' bad' : ''}">${stale ? 'Old reading: ' : ''}${esc(text)}</span></div>
    <div class="body">${body}</div>${error ? `<p class="warn">${esc(error)}</p>` : ''}${device && status === 'waiting' && canAdd()
    ? `<div class="row"><button class="main" data-act="reconnect" data-id="${esc(key)}">Reconnect</button></div>` : ''}</article>`;
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
  if (d.kind === 'orion') return card(v.name, `<div class="hero"><span class="big">${num(d.watts, 0)}<small> W</small></span><span class="mid ${d.outA > 0 ? 'in' : 'out'}">${esc(d.state)}</span></div><div style="height:12px"></div>
    ${facts([['Output', num(d.outV, 2, ' V')], ['Charging', num(d.outA, 1, ' A')], ['Input', num(d.inV, 2, ' V')], ['Input current', num(d.inA, 1, ' A')]])}
    ${d.offReasons.length ? `<p class="hint">Why it is off: ${esc(d.offReasons.join(', '))}.</p>` : ''}
    ${d.error ? `<p class="warn">Charger error ${d.error}. Open VictronConnect for details.</p>` : ''}`, v);
  if (d.kind === 'shunt') return card(v.name, `<div class="hero"><span class="big">${num(d.soc, 0)}<small>%</small></span><span class="mid ${d.current > 0.05 ? 'in' : 'out'}">${d.current === null ? '' : Math.abs(d.current) <= 0.05 ? 'Idle' : d.current > 0 ? 'Charging' : 'Discharging'}</span></div><div style="height:12px"></div>
    ${facts([['Voltage', num(d.voltage, 2, ' V')], ['Current', num(d.current, 1, ' A')], ['Power', d.voltage === null || d.current === null ? '–' : num(d.voltage * d.current, 0, ' W')], ['Used', num(d.usedAh, 0, ' Ah')],
      ['Time left', d.minutesLeft === null ? null : hours(d.minutesLeft / 60)], ['Starter battery', d.starter === null ? null : num(d.starter, 2, ' V')],
      ['Midpoint', d.midpoint === null ? null : num(d.midpoint, 2, ' V')], ['Temperature', d.tempC === null ? null : fToText(d.tempC)]])}
    ${d.alarm ? `<p class="warn">Battery monitor alarm${d.alarms.length ? `: ${esc(d.alarms.join(', '))}` : ''}. Open VictronConnect for details.</p>` : ''}`, v);
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

const DEMO_WX = { forecast: { temp: 88, feels: 93, humidity: 41, sky: 'Partly cloudy', wind: 9, gust: 21, from: 'SW', sunrise: '6:12 AM', sunset: '8:31 PM',
  days: [['Fri', 'Partly cloudy', 92, 64, 10, 21], ['Sat', 'Storms', 86, 61, 70, 44], ['Sun', 'Clear', 84, 58, 5, 15], ['Mon', 'Clear', 89, 60, 0, 14]].map(([name, sky, high, low, rain, gust]) => ({ name, sky, high, low, rain, gust })) },
  alerts: { status: 'ok', list: [{ event: 'Wind Advisory', severity: 'Moderate', until: null, headline: 'Demo alert. Not real.', text: '' }] } };

const deg = (n) => num(n, 0, '°');
function weatherCard() {
  const demo = state.demo, p = demo ? { name: 'Demo place' } : state.place, wx = demo ? { ...DEMO_WX, at: Date.now() } : state.wx;
  if (!p) return card('Weather', `<p class="hint">Shows the forecast, and weather alerts in the US. Your location, rounded to about half a mile, is sent to Open-Meteo and the US National Weather Service.</p>
    <div class="row"><button class="main" data-act="here" ${state.wxBusy ? 'disabled' : ''}>${state.wxBusy ? 'Finding you' : 'Use my location'}</button><button data-act="setup">Enter a place</button></div>`, { error: state.placeError || null });
  const again = demo ? '' : `<div class="row"><button data-act="wxnow" ${state.wxBusy ? 'disabled' : ''}>${state.wxBusy ? 'Updating' : 'Update'}</button>${p.mode === 'here' ? '' : '<button data-act="here">Use my location</button>'}</div>`;
  const problems = [state.placeError ? `${state.placeError} Showing weather for the last known place.` : '', state.wxError].filter(Boolean).join(' ');
  if (!wx) return card(`Weather: ${p.name}`, `<p class="hint">${state.wxBusy ? 'Getting the forecast.' : 'No forecast yet.'}</p>${again}`, { error: problems || null });
  const f = wx.forecast, list = W.activeAlerts(wx.alerts.list), checked = wx.alertsAt ? ` (checked ${ageText(wx.alertsAt)})` : '';
  const until = (t) => (t ? ` until ${new Date(t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '');
  const alertHtml = list.length ? `<div class="alert">${list.map((a) => `<p><b>${esc(a.event)}</b>${until(a.until)}</p>`).join('')}<button data-act="alerts">Read ${list.length > 1 ? 'alerts' : 'alert'}</button></div>` : '';
  const alertNote = wx.alerts.status === 'ok' ? (list.length ? '' : `No weather alerts${checked}.`) : wx.alerts.status === 'outside' ? 'Alerts cover the US only.' : 'Alerts could not be checked.';
  return card(`Weather: ${p.name}`, `${alertHtml}<div class="hero"><span class="big">${num(f.temp, 0)}<small>°F</small></span><span class="mid">${esc(f.sky)}</span></div><div style="height:12px"></div>
    ${facts([['Feels like', deg(f.feels)], ['Wind', f.wind === null ? '–' : `${num(f.wind, 0)} mph ${esc(f.from)}`], ['Gusts', num(f.gust, 0, ' mph')], ['Humidity', num(f.humidity, 0, '%')], ['Sunset', f.sunset ? esc(f.sunset) : null]])}
    <div class="days">${f.days.map((d) => `<div><b>${esc(d.name)}</b><span>${deg(d.high)} / ${deg(d.low)}</span><span>${esc(d.sky)}</span><span>Precip ${num(d.rain, 0, '%')}</span><span>Gusts ${num(d.gust, 0)}</span></div>`).join('')}</div>
    <p class="hint">${alertNote}</p>${again}<p class="fine">Forecast by Open-Meteo. Alerts by the US National Weather Service.</p>`,
  { updatedAt: wx.at, status: demo ? 'demo' : null, staleMs: WEATHER_STALE, error: problems || null });
}

function victronHint(l) {
  const unmatched = [...l.heard.keys()].filter((n) => !l.matched.has(n));
  if (l.heard.size && !unmatched.length) return `Listening to ${[...l.heard.keys()].map(esc).join(', ')}.`;
  const heard = unmatched.map(esc).join(', ');
  const watching = [...l.devices.values()].map((x) => esc(x.d.name || 'Victron device'));
  if (!heard && watching.length) return `Listening to ${watching.join(', ')}. Nothing received yet. Readings arrive every few seconds when in range.`;
  if (!heard) return l.broadcasts ? 'Listening. Other Bluetooth devices are coming through, but nothing from Victron yet.' : 'Listening. No broadcasts received yet.';
  if (unmatched.every((n) => l.heard.get(n) === 0)) return `Listening. Heard ${heard}, but its Instant readout is off. Turn it on in VictronConnect.`;
  return `Listening. Heard ${heard}. ${state.keys.length ? 'Your saved keys do not match it.' : 'Add its key under Setup to see the readings.'}`;
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
  const how = state.listener?.how || VictronListener.method();
  const listenBtn = !canAdd() || !how || (state.listener && how !== 'pick') ? ''
    : how !== 'pick' ? '<div class="row"><button class="main" data-act="listen">Start listening</button></div>'
      : `<div class="row"><button class="main" data-act="listen">${state.listener?.devices.size ? 'Add another Victron device' : 'Pick Victron device'}</button><button data-act="listenall">Not listed? Show all</button></div>`;
  const vicCard = !vics.length || listenBtn || state.listener?.devices.size;
  put('power', (bats.length ? bats.map(batteryCard).join('') : card('LiTime battery', `<p class="hint">Shows charge, power, temperature and cell balance.</p>${add('litime', 'Connect battery')}`))
    + vics.map(victronCard).join('')
    + (vicCard ? card('Victron', state.listener ? `<p class="hint">${victronHint(state.listener)}</p>${listenBtn}`
      : `<p class="hint">${!VictronListener.method() && !state.demo ? 'This browser has no Victron broadcast support. Use Boardstrom for Victron.' : state.keys.length ? 'Readings only.' : how === 'pick' ? 'Readings only, for solar chargers, battery monitors and the Orion XS. Pick each one once, then add its key under Setup. The panel listens to them again after a reload.' : 'Readings only, for solar chargers, battery monitors and the Orion XS. Start listening to see what is in range, then add its key under Setup.'}</p>${listenBtn}`) : ''));

  const thermos = of('easytouch');
  put('climate', thermos.length ? thermos.map((a) => (a.data ? a.data.zones.map((z) => zoneCard(a, z, a.data.zones.length > 1)).join('') : card(a.name, '<p class="hint">Waiting for the first reading.</p>', a))).join('')
    : card('EasyTouch thermostat', `<p class="hint">Shows and sets temperature, mode and fan. Needs your Micro-Air sign-in under Setup.</p>${add('easytouch', 'Connect thermostat')}`));

  const starts = of('easystart');
  put('other', weatherCard() + (starts.length ? starts.map(easystartCard).join('') : card('EasyStart', `<p class="hint">Shows A/C current, start peaks and faults.</p>${add('easystart', 'Connect EasyStart')}`))
    + card('Starlink', '<p class="hint">Opens the dish’s own status page. Leaving this page can drop the Bluetooth connections. Use the Starlink app for stow and reboot.</p><div class="row"><button data-act="starlink">Open dish status</button></div>'));
}

// ---- accessories
function attach(kind, device, restored = false, last = null) {
  const key = `${kind}:${device.id}`;
  const old = state.accessories.get(key);
  old?.stop();
  const from = last || old;
  const a = new KINDS[kind](device, refresh, () => state.creds);
  a.restored = restored;
  if (from) Object.assign(a, { data: from.data, updatedAt: from.updatedAt }); // keeps the last reading, with its age, on screen
  state.accessories.set(key, a);
  state.known[device.id] = kind; save('known', state.known);
  a.start();
}
async function addAccessory(kind, showAll) {
  state.message = '';
  try { take(kind, await choose(kind, showAll)); }
  catch (e) { if (e?.name !== 'NotFoundError') state.message = `Could not connect: ${why(e)}`; note('Setup', `${kind}: ${why(e)}`); }
  refresh();
}
/** Connects a picked device as what its name says it is. */
function take(kind, d) {
  if (P.looksVictron(d.name)) state.message = `${d.name} is a Victron device. It is read from its broadcasts, not a connection. Use the Victron card.`;
  else attach(P.kindForName(d.name) || kind, d);
}
/** Picks the device again. A fresh pick can work where reopening a remembered one does not. */
async function reconnect(key) {
  const a = state.accessories.get(key);
  if (!a?.device) return;
  state.message = '';
  a.stop(); // frees the accessory so it can be found
  let d = null;
  try { d = await choose(a.kind, false, a.device.name); }
  catch (e) {
    note('Setup', `reconnect ${a.name}: ${why(e)}`);
    state.message = 'Nothing was picked. If the device was not listed, close Bluefy completely, open it again and retry.';
  }
  if (d && (d.id === a.device.id || d.name === a.device.name)) {
    state.accessories.delete(key);
    if (d.id !== a.device.id) delete state.known[a.device.id];
    attach(a.kind, d, false, a);
  } else {
    if (d) take(a.kind, d);
    attach(a.kind, a.device, true); // keep trying the original meanwhile
  }
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
const newListener = () => new VictronListener(() => state.keys, (k, data) => {
  state.victron.set(k.key, { name: k.name, data, updatedAt: Date.now(), status: 'connected' });
  refresh();
});
function rememberVictron(l) {
  state.vicIds = [...new Set([...state.vicIds, ...l.devices.keys()])]; save('vic', state.vicIds);
}
async function listen(showAll = false) {
  const l = state.listener || newListener();
  state.message = '';
  try { await l.start(showAll); state.listener = l; rememberVictron(l); }
  catch (e) {
    if (l !== state.listener) l.stop();
    if (e?.name !== 'NotFoundError') state.message = `Could not listen for Victron: ${why(e)}${!state.listener && VictronListener.method() ? '. Tap the Victron button to try another way.' : ''}`;
  }
  refresh();
}
/** Devices picked before. No tap needed; failures only go to the log. */
async function resumeVictron(devices) {
  if (!devices.length || VictronListener.method() !== 'pick') return;
  const l = state.listener || newListener();
  for (const d of devices) {
    try { await l.watch(d); } catch (e) { note('Victron', `could not resume ${d.name || 'a device'}: ${why(e)}`); }
  }
  if (l.devices.size) state.listener = l;
  refresh();
}

// ---- weather
let wxRun = 0;
async function updateWeather() {
  if (state.demo || !state.place || state.wxBusy) return;
  const run = ++wxRun, asked = state.place;
  state.wxBusy = true; state.wxTried = Date.now(); refresh();
  try {
    let p = asked;
    if (p.mode === 'here') {
      try { p = { ...p, ...await W.locate() }; state.placeError = ''; }
      catch (e) { if (!Number.isFinite(p.lat)) throw e; state.placeError = e.message; }
      if (p.lat !== asked.lat || p.lon !== asked.lon || !p.named) { const town = await W.nearestTown(p.lat, p.lon); p = { ...p, name: town || 'Current location', named: Boolean(town) }; }
    }
    const [f, a] = await Promise.allSettled([W.forecast(p.lat, p.lon), W.alerts(p.lat, p.lon)]);
    if (run !== wxRun || state.place !== asked) return; // the place was changed meanwhile
    const moved = p.lat !== asked.lat || p.lon !== asked.lon;
    state.place = p; save('place', p);
    if (moved && f.status === 'rejected') state.wx = null; // never show one place's forecast under another's name
    if (f.status === 'rejected') {
      state.wxError = f.reason.message;
      if (state.wx && a.value.status === 'ok') Object.assign(state.wx, { alerts: a.value, alertsAt: Date.now() });
    } else {
      state.wxError = '';
      // A failed alert check keeps alerts already known for this place, and says it failed.
      const known = !moved && a.value.status === 'failed' && state.wx ? { status: 'failed', list: state.wx.alerts.list } : a.value;
      state.wx = { forecast: f.value, alerts: known, alertsAt: a.value.status === 'ok' ? Date.now() : null, at: Date.now() };
    }
    save('wx', state.wx);
  } catch (e) {
    if (run !== wxRun || state.place !== asked) return;
    state.placeError = why(e); note('Weather', why(e));
    if (!Number.isFinite(asked.lat)) state.place = null;
  } finally { if (run === wxRun) state.wxBusy = false; refresh(); }
}
function setPlace(p) {
  wxRun++; state.wxBusy = false; // anything still on its way belongs to the old place
  state.place = p; state.wx = null; state.wxError = state.placeError = ''; state.found = [];
  save('wx', null); save('place', p && Number.isFinite(p.lat) ? p : null);
  updateWeather();
}
function weatherDue() {
  if (!document.hidden && state.place && Date.now() - Math.max(state.wx?.at || 0, state.wxTried || 0) > WEATHER_EVERY) updateWeather();
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
  <h2>Weather place</h2><p>${state.place ? `Now: ${esc(state.place.name || 'finding you')}. ` : ''}What you type here is sent to Open-Meteo to look it up.</p>
  <label for="wp">Town or ZIP code</label><input id="wp" autocomplete="off" value="">
  <div class="row"><button data-act="find">Find place</button><button data-act="here">Use my location</button>${state.place ? '<button data-act="noplace">Remove place</button>' : ''}</div>
  ${state.found.map((p, i) => `<div class="dev"><span>${esc(p.name)}</span><button data-act="pickplace" data-i="${i}">Use</button></div>`).join('')}
  <p id="msg" class="warn" role="status"></p>
  <h2>Demo</h2><div class="row"><button data-act="demo">${state.demo ? 'Stop demo' : 'Show demo data'}</button></div>
  <h2>Diagnostics</h2>
  <p>Bluetooth: ${supported() ? 'yes' : 'no'}. Victron broadcasts: ${VictronListener.method() || 'no'}. Reconnect without a tap: ${navigator.bluetooth?.getDevices ? 'yes' : 'no'}. Offline copy: ${state.offline}.</p>
  <pre id="log">${esc(log.slice(-60).join('\n') || 'Nothing logged yet.')}</pre>
  <div class="row"><button data-act="copylog">Copy log</button><button data-act="copybrowser">Copy browser details</button></div>
  <p class="hint">The log leaves out your sign-in and keys. It includes device names and some raw battery and EasyStart readings, and is kept on this iPad so a reload does not lose it. Panel version ${VERSION}.</p>`;
}
const saveLog = () => { if (!state.demo) save('log', log.slice(-200)); };
async function copy(text) {
  try { await navigator.clipboard.writeText(text); setupMsg('Copied.'); }
  catch { $('log').textContent = text; getSelection().selectAllChildren($('log')); setupMsg('Copy was blocked. The text is selected; use Copy.'); }
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
  state.victron.set('demo3', { name: 'Demo SmartShunt', status: 'demo', updatedAt: Date.now(), data: { kind: 'shunt', minutesLeft: 1170, voltage: 13.2, alarm: 0, alarms: [], current: -8.4, usedAh: 66, soc: 71, starter: 12.71, midpoint: null, tempC: null } });
  state.victron.set('demo2', { name: 'Demo Orion XS', status: 'demo', updatedAt: Date.now(), data: { kind: 'orion', state: 'Bulk', error: 0, outV: 13.42, outA: 49.8, watts: 668, inV: 13.9, inA: 48.9, offReasons: [] } });
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
    if (!confirm('Remove the saved sign-in, Victron keys, device lists and weather place from this iPad?')) return;
    ['creds', 'keys', 'known', 'log', 'place', 'wx', 'vic'].forEach((k) => save(k, null));
    log.length = 0; wxRun++; Object.assign(state, { place: null, wx: null, wxBusy: false, wxError: '', placeError: '', found: [] });
    state.creds = { email: '', password: '' }; state.keys = []; state.known = {}; state.remember = false;
    state.listener?.stop(); state.listener = null; state.victron.clear(); state.vicIds = [];
    drawSetup();
  },
  addkey() {
    try {
      const key = P.normalizeKey($('vk').value);
      if (state.keys.some((k) => k.key === key)) throw new Error('That key is already saved');
      state.keys.push({ name: $('vn').value.trim() || `Victron ${state.keys.length + 1}`, key });
      save('keys', state.keys); drawSetup(); setupMsg('Key added. Readings appear once the device is being listened to.');
    } catch (e) { setupMsg(e.message); }
  },
  delkey(d) { const [k] = state.keys.splice(Number(d.i), 1); if (k) state.victron.delete(k.key); save('keys', state.keys); drawSetup(); },
  demo() { setDemo(!state.demo); $('setup').close(); },
  copylog() { return copy(`Panel version ${VERSION}\n${log.join('\n')}`); },
  async copybrowser() { setupMsg('Collecting…'); return copy(await browserDetails()); },
  reconnect(d) { return reconnect(d.id); },
  here() { $('setup').close(); setPlace({ mode: 'here', name: 'Current location' }); },
  wxnow() { return updateWeather(); },
  noplace() { wxRun++; Object.assign(state, { place: null, wx: null, wxBusy: false, wxError: '', placeError: '' }); save('place', null); save('wx', null); drawSetup(); },
  async find() {
    const text = $('wp').value;
    try { state.found = await W.findPlace(text); drawSetup(); $('wp').value = text; setupMsg(state.found.length ? '' : 'No place by that name.'); }
    catch (e) { setupMsg(why(e)); }
  },
  pickplace(d) { const p = state.found[Number(d.i)]; if (p) { $('setup').close(); setPlace({ mode: 'fixed', lat: p.lat, lon: p.lon, name: p.name }); } },
  alerts() {
    const list = W.activeAlerts((state.demo ? DEMO_WX : state.wx)?.alerts.list || []);
    $('setup').innerHTML = `<div class="top"><h2>Weather alerts</h2><button data-act="close">Done</button></div>${list.map((a) => `<h2>${esc(a.event)}</h2><p>${esc(a.headline)}</p><pre class="long">${esc(a.text)}</pre>`).join('')}`;
    $('setup').showModal();
  },
  listen() { return listen(); },
  listenall() { return listen(true); },
  starlink() { window.open('http://192.168.100.1/', '_blank', 'noopener'); },
  mode(d) { clearPending(); return control(d.id, (z) => P.modeCommand(z.zone, d.v), MODE_LABEL[d.v]); },
  fan(d) { return control(d.id, (z) => P.fanCommand(z.zone, z.mode, d.v), `fan ${d.v}`); },
  step(d) { step(d.id, d.f, Number(d.d)); },
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  Promise.resolve(actions[b.dataset.act]?.(b.dataset)).catch((err) => note('Panel', why(err)));
  refresh();
});
// Relock whenever the panel is put away, so a pocket tap cannot change the A/C.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { state.locked = true; clearPending(); note('Panel', 'put away'); saveLog(); } else { note('Panel', 'shown again'); keepAwake(); weatherDue(); state.accessories.forEach((a) => a.status === 'waiting' && a.start?.()); }
  refresh();
});
// Let go of everything before the page goes, so the equipment is free to be picked up again.
addEventListener('pagehide', () => { note('Panel', 'page closing'); saveLog(); if (!state.demo) state.accessories.forEach((a) => a.drop?.()); });
async function keepAwake() { try { await navigator.wakeLock?.request('screen'); } catch { /* set Auto-Lock to Never instead */ } }

async function boot() {
  applyTheme();
  if (local && new URLSearchParams(location.search).has('sim')) await import('./test/mock-ble.js');
  log.unshift(...load('log', [])); note('Panel', `opened, version ${VERSION}`);
  draw(); setInterval(draw, 5000); setInterval(saveLog, 10000); setInterval(weatherDue, 60000); keepAwake(); weatherDue();
  if (supported()) {
    const victron = [];
    for (const d of await remembered()) {
      if (P.looksVictron(d.name) || state.vicIds.includes(d.id)) {
        if (state.known[d.id]) { delete state.known[d.id]; save('known', state.known); } // picked by mistake as a battery before
        victron.push(d);
      } else if (Object.hasOwn(KINDS, state.known[d.id] ?? '')) attach(P.kindForName(d.name) || state.known[d.id], d, true);
    }
    resumeVictron(victron);
  }
  if (!('serviceWorker' in navigator)) state.offline = 'not supported here';
  else if (local) state.offline = 'off while testing';
  else navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => { state.offline = 'ready'; }, () => { state.offline = 'unavailable'; });
}
boot();

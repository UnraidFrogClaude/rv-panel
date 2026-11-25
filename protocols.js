// Pure encode/decode for each device. No Bluetooth or DOM here, so it can be unit tested in Node.

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const s16 = (b, i) => (u16(b, i) << 16) >> 16;
const s32 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const u32 = (b, i) => s32(b, i) >>> 0;
const full = (short) => `0000${short}-0000-1000-8000-00805f9b34fb`;

export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (s) => Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));

// ---------------------------------------------------------------- LiTime

export const LITIME = {
  service: full('ffe0'),
  notify: full('ffe1'),
  write: full('ffe2'),
  namePrefixes: ['L-12', 'L-24', 'L-51', 'LT-12', 'LT-24', 'LT-51'],
  // Status request only. This file deliberately contains no battery control commands.
  statusRequest: fromHex('000004011355aa17'),
};

/** Collects notification chunks into complete, checksum-verified frames. */
export class LitimeFramer {
  constructor() { this.buf = []; }
  push(chunk) {
    const frames = [];
    this.buf.push(...chunk);
    while (this.buf.length >= 3) {
      if (this.buf[0] !== 0 || this.buf[1] !== 0) { this.buf.shift(); continue; }
      const len = this.buf[2] + 4;
      if (this.buf.length < len) break;
      const frame = Uint8Array.from(this.buf.slice(0, len));
      const sum = frame.slice(0, -1).reduce((a, x) => (a + x) & 0xff, 0);
      if (sum === frame[len - 1]) { frames.push(frame); this.buf.splice(0, len); }
      else this.buf.shift();
    }
    if (this.buf.length > 512) this.buf = [];
    return frames;
  }
  reset() { this.buf = []; }
}

export function decodeLitime(f) {
  if (f.length < 100) throw new Error(`Battery reply too short (${f.length} bytes)`);
  const cells = [];
  for (let i = 0; i < 16; i++) { const v = u16(f, 16 + i * 2); if (v) cells.push(v / 1000); }
  const temps = [];
  for (let i = 0; i < 5; i++) temps.push(s16(f, 52 + i * 2));
  while (temps.length > 1 && temps[temps.length - 1] === 0) temps.pop();
  let problem = false;
  for (let i = 76; i < 84; i++) if (f[i]) problem = true;
  const voltage = u16(f, 12) / 1000;
  const current = s32(f, 48) / 1000; // negative while discharging
  const remainingAh = u16(f, 62) / 100;
  return {
    voltage, current, power: voltage * current, remainingAh,
    capacityAh: Math.floor(u32(f, 64) / 100),
    soc: u16(f, 90), health: u32(f, 92), cycles: u32(f, 96),
    cells, temps, heater: u32(f, 68) !== 0, problem,
    problemCode: problem ? toHex(f.slice(76, 84)) : null,
    hoursLeft: current < -0.1 ? remainingAh / -current : null,
  };
}

// ---------------------------------------------------------------- EasyTouch

export const EASYTOUCH = {
  service: full('00ff'),
  password: full('dd01'),
  command: full('ee01'),
  reply: full('ff01'),
  namePrefixes: ['EasyTouch'],
  minF: 60, maxF: 90, autoGap: 3,
};
export const MODES = { off: 0, fan: 1, cool: 2, heat: 4, auto: 11 };
const MODE_NAMES = { 0: 'off', 1: 'fan', 2: 'cool', 3: 'cool', 4: 'heat', 5: 'heat', 6: 'dry', 11: 'auto' };
const ACTIONS = { 1: 'fan', 3: 'cooling', 5: 'heating' };
const FAN_KEY = { fan: 'fanOnly', cool: 'coolFan', heat: 'heatFan', auto: 'autoFan' };
const FAN_IDX = { fan: 6, cool: 7, auto: 9, heat: 11 };
export const FAN_VALUES = { low: 1, high: 2, auto: 128 };
const FAN_NAMES = { 0: 'off', 1: 'low', 2: 'high', 65: 'cycled low', 66: 'cycled high', 128: 'auto' };

export const easytouchStatusRequest = (email, zone = 0, now = Date.now()) =>
  ({ Type: 'Get Status', Zone: zone, EM: email, TM: Math.floor(now / 1000) });

export function decodeEasytouch(text) {
  const s = JSON.parse(text);
  if (!s || typeof s.Z_sts !== 'object' || s.Z_sts === null) throw new Error('Thermostat reply has no zone data');
  const prm = Array.isArray(s.PRM) ? s.PRM : [];
  const zones = [];
  for (const [key, a] of Object.entries(s.Z_sts)) {
    if (!Array.isArray(a) || a.length < 16) continue;
    const mode = MODE_NAMES[a[10]] || `mode ${a[10]}`;
    zones.push({
      zone: Number(key), mode, temp: a[12], action: ACTIONS[a[15]] || 'idle',
      autoHeat: a[0], autoCool: a[1], cool: a[2], heat: a[3],
      fan: FAN_IDX[mode] === undefined ? null : (FAN_NAMES[a[FAN_IDX[mode]]] || `fan ${a[FAN_IDX[mode]]}`),
    });
  }
  if (!zones.length) throw new Error('Thermostat reply has no usable zones');
  zones.sort((x, y) => x.zone - y.zone);
  return { zones, wallOff: prm.includes(7) && !prm.includes(15) };
}

export function modeCommand(zone, mode) {
  if (!Object.hasOwn(MODES, mode)) throw new Error(`Unsupported mode: ${mode}`);
  return { Type: 'Change', Changes: { zone, power: mode === 'off' ? 0 : 1, mode: MODES[mode] } };
}

export function fanCommand(zone, mode, fan) {
  if (!Object.hasOwn(FAN_KEY, mode)) throw new Error('Fan speed can only be set in fan, cool, heat or auto mode');
  if (!Object.hasOwn(FAN_VALUES, fan) || (mode === 'fan' && fan === 'auto')) throw new Error(`Unsupported fan speed: ${fan}`);
  return { Type: 'Change', Changes: { zone, [FAN_KEY[mode]]: FAN_VALUES[fan] } };
}

export function clampF(n) {
  if (!Number.isFinite(n)) throw new Error('Temperature is not a number');
  return Math.max(EASYTOUCH.minF, Math.min(EASYTOUCH.maxF, Math.round(n)));
}

export function tempCommand(zone, mode, t) {
  const c = { zone, power: 1 };
  if (mode === 'cool') c.cool_sp = clampF(t.cool);
  else if (mode === 'heat') c.heat_sp = clampF(t.heat);
  else if (mode === 'auto') {
    c.autoHeat_sp = clampF(t.autoHeat);
    c.autoCool_sp = clampF(t.autoCool);
    if (c.autoCool_sp - c.autoHeat_sp < EASYTOUCH.autoGap) throw new Error(`Keep at least ${EASYTOUCH.autoGap}° between heat and cool`);
  } else throw new Error('Set cool, heat or auto mode before changing temperature');
  return { Type: 'Change', Changes: c };
}

/** True when a decoded zone shows that a Change command took effect. */
export function commandApplied(cmd, z) {
  const c = cmd.Changes;
  if (z.zone !== c.zone) return false;
  if ('mode' in c && MODES[z.mode] !== c.mode) return false;
  for (const [k, f] of [['cool_sp', 'cool'], ['heat_sp', 'heat'], ['autoHeat_sp', 'autoHeat'], ['autoCool_sp', 'autoCool']]) {
    if (k in c && z[f] !== c[k]) return false;
  }
  for (const [m, k] of Object.entries(FAN_KEY)) {
    if (k in c && (z.mode !== m || FAN_VALUES[z.fan] !== c[k])) return false;
  }
  return true;
}

// ---------------------------------------------------------------- EasyStart

export const EASYSTART = {
  service: 'd973f2e0-b19e-11e2-9e96-0800200c9a66',
  notify: 'd973f2e1-b19e-11e2-9e96-0800200c9a66',
  write: 'd973f2e2-b19e-11e2-9e96-0800200c9a66',
  namePrefixes: ['EasyStart'],
  statusRequest: '{"Cmd": "ReadLive"}',
};
const EASYSTART_STATUS = ['Normal', 'Unexpected current fault', 'Short cycle delay', 'Power interruption fault',
  'Stall fault', 'Stuck start relay fault', 'Open overload fault', 'Overcurrent fault', 'Bad wiring fault', 'Wrong voltage fault'];

export function decodeEasystart(b) {
  if (b.length < 18 || b[0] === 0x7b) return null; // too short, or a JSON acknowledgement
  const period = u16(b, 6);
  const amps = u16(b, 4) / 10;
  return {
    status: EASYSTART_STATUS[b[2]] || `Status ${b[2]}`,
    ok: b[2] === 0, delaying: b[2] === 2,
    amps: amps <= 50 ? amps : null,
    hz: period ? 500000 / period : null,
    lastPeak: u16(b, 8) / 10, delaySec: u16(b, 10), faults: u16(b, 12), starts: u32(b, 14),
  };
}

// ---------------------------------------------------------------- Victron Instant Readout

export const VICTRON_COMPANY = 0x02e1;
const CHARGE = { 0: 'Off', 1: 'Low power', 2: 'Fault', 3: 'Bulk', 4: 'Absorption', 5: 'Float', 6: 'Storage', 7: 'Equalize', 11: 'Power supply',
  245: 'Starting', 246: 'Repeated absorption', 247: 'Recondition', 248: 'Battery safe', 252: 'External control' };
const ALARMS = ['low voltage', 'high voltage', 'low charge', 'low starter voltage', 'high starter voltage', 'low temperature', 'high temperature',
  'midpoint voltage', 'overload', 'DC ripple', 'low AC voltage', 'high AC voltage', 'short circuit', 'BMS lockout'];
const OFF_REASONS = [[0x1, 'no input power'], [0x2, 'switched off'], [0x4, 'switched off in settings'], [0x8, 'remote input'], [0x10, 'protection active'],
  [0x20, 'out of credit'], [0x40, 'BMS'], [0x80, 'engine off'], [0x100, 'checking input voltage']];
const offReasons = (mask) => {
  const list = OFF_REASONS.filter(([bit]) => mask & bit).map(([, text]) => text);
  return list.length || !mask ? list : [`code 0x${mask.toString(16)}`];
};

/** Names Victron products advertise. They need a key and broadcasts, not a connection. */
export const looksVictron = (name) => /^(orion|smart ?solar|blue ?solar|smart ?shunt|bmv|blue ?smart|phoenix|smart ?(bms|lithium|battery)|lynx|multi|victron)/i.test(name || '');

/** Which accessory a name belongs to, or null when the name is unfamiliar. */
export function kindForName(name) {
  for (const [kind, spec] of [['litime', LITIME], ['easytouch', EASYTOUCH], ['easystart', EASYSTART]]) {
    if (spec.namePrefixes.some((p) => (name || '').startsWith(p))) return kind;
  }
  return null;
}

const isBuffer = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v) || Array.isArray(v);
function toBytes(v) {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return Array.isArray(v) ? Uint8Array.from(v) : null;
}
/** Victron bytes from an advertisement. Browsers differ in how they hold manufacturer data, so several shapes are accepted. */
export function victronBytes(md) {
  if (!md) return null;
  const prefixed = (b) => b?.[0] === 0xe1 && b[1] === 0x02; // company ID still in front
  if (isBuffer(md)) { const b = toBytes(md); return prefixed(b) ? b.slice(2) : null; }
  const keys = [String(VICTRON_COMPANY), '02e1', '2e1', '0x02e1', '0x2e1'];
  const entries = typeof md.entries === 'function' ? [...md.entries()] : Object.entries(md);
  const b = toBytes(entries.find(([k]) => keys.includes(String(k).toLowerCase()))?.[1]);
  return prefixed(b) ? b.slice(2) : b;
}

export const normalizeKey = (k) => {
  const s = String(k).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (s.length !== 32) throw new Error('A Victron key is 32 characters, 0-9 and a-f');
  return s;
};

/** Bytes are the manufacturer data after the company ID. Returns null for anything that is not a readout for this key. */
export async function decodeVictron(bytes, keyHex) {
  if (bytes.length < 12 || bytes[0] !== 0x10) return null;
  const key = fromHex(keyHex);
  if (bytes[7] !== key[0]) return null; // key check byte
  const type = bytes[4];
  if (![1, 2, 0x0f].includes(type)) return { kind: 'other', type };
  const plain = await aesCtrLE(key, u16(bytes, 5), bytes.slice(8));
  const bits = bitReader(plain);
  if (type === 1) {
    const state = bits(8), err = bits(8), v = bits(16, true), a = bits(16, true), y = bits(16), w = bits(16);
    return {
      kind: 'solar', state: CHARGE[state] || `State ${state}`, error: err === 0xff ? null : err,
      voltage: v === 0x7fff ? null : v / 100, current: a === 0x7fff ? null : a / 10,
      yieldWh: y === 0xffff ? null : y * 10, watts: w === 0xffff ? null : w,
    };
  }
  if (type === 0x0f) { // Orion XS, layout posted by Victron staff on their community forum
    const state = bits(8), err = bits(8), ov = bits(16, true), oa = bits(16, true), iv = bits(16), ia = bits(16), off = bits(32);
    const outV = ov === 0x7fff ? null : ov / 100, outA = oa === 0x7fff ? null : oa / 10;
    return {
      kind: 'orion', state: state === 0xff ? 'Unknown' : CHARGE[state] || `State ${state}`, error: err === 0xff ? null : err,
      outV, outA, watts: outV === null || outA === null ? null : outV * outA,
      inV: iv === 0xffff ? null : iv / 100, inA: ia === 0xffff ? null : ia / 10,
      offReasons: off === 0xffffffff ? [] : offReasons(off),
    };
  }
  const mins = bits(16), v = bits(16, true), alarm = bits(16);
  const aux = bits(16), auxMode = bits(2);
  const ma = bits(22, true), used = bits(20), soc = bits(10);
  return {
    kind: 'shunt', minutesLeft: mins === 0xffff ? null : mins, voltage: v === 0x7fff ? null : v / 100, alarm,
    alarms: ALARMS.filter((_, i) => alarm & (1 << i)),
    current: ma === 0x1fffff || ma === -1 ? null : ma / 1000, // all ones means not available
    starter: auxMode === 0 && aux !== 0x7fff ? s16([aux & 255, aux >> 8], 0) / 100 : null,
    midpoint: auxMode === 1 && aux !== 0xffff ? aux / 100 : null,
    tempC: auxMode === 2 && aux !== 0xffff ? aux / 100 - 273.15 : null,
    usedAh: used === 0xfffff ? null : used / 10, soc: soc === 0x3ff ? null : soc / 10,
  };
}

async function aesCtrLE(key, iv, data) {
  const k = await crypto.subtle.importKey('raw', key, 'AES-CTR', false, ['decrypt']);
  const out = new Uint8Array(data.length);
  for (let off = 0, n = iv; off < data.length; off += 16, n++) {
    const counter = new Uint8Array(16);
    counter[0] = n & 0xff; counter[1] = (n >> 8) & 0xff; counter[2] = (n >> 16) & 0xff;
    out.set(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 128 }, k, data.slice(off, off + 16))), off);
  }
  return out;
}

function bitReader(b) {
  let p = 0;
  return (n, signed = false) => {
    let v = 0;
    for (let i = 0; i < n; i++, p++) v += (((b[p >> 3] || 0) >> (p & 7)) & 1) * 2 ** i;
    return signed && v >= 2 ** (n - 1) ? v - 2 ** n : v;
  };
}

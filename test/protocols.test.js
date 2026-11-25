import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../protocols.js';
import * as W from '../weather.js';

// Captured frames come from the test suites of aiobmsble (LiTime/Redodo) and victron-ble.
const LITIME_FRAME = '000065019355aa0046660000bc670000f50cf70cfc0cfb0cf80cf20cfa0cf50c0000000000000000000000000000000065faffff17001600feff00000000e91a0429000000000000000000000000000000000000000000000000410064000000030000005f010000a2';

test('LiTime: captured frame decodes to published values', () => {
  const raw = P.fromHex(LITIME_FRAME);
  assert.equal(raw.length, 105);
  const [f] = new P.LitimeFramer().push(raw);
  const d = P.decodeLitime(f);
  assert.equal(d.voltage, 26.556);
  assert.equal(d.current, -1.435);
  assert.equal(d.soc, 65);
  assert.equal(d.health, 100);
  assert.equal(d.remainingAh, 68.89);
  assert.equal(d.capacityAh, 105);
  assert.equal(d.cycles, 3);
  assert.deepEqual(d.cells, [3.317, 3.319, 3.324, 3.323, 3.320, 3.314, 3.322, 3.317]);
  assert.deepEqual(d.temps, [23, 22, -2]);
  assert.equal(d.problem, false);
  assert.equal(Math.round(d.hoursLeft * 3600), 172825);
});
test('LiTime: split notifications reassemble', () => {
  const raw = P.fromHex(LITIME_FRAME), fr = new P.LitimeFramer();
  let out = [];
  for (let i = 0; i < raw.length; i += 20) out.push(...fr.push(raw.slice(i, i + 20)));
  assert.equal(out.length, 1);
});
test('LiTime: bad checksum and leading junk', () => {
  const bad = P.fromHex(LITIME_FRAME); bad[104] ^= 1;
  assert.equal(new P.LitimeFramer().push(bad).length, 0);
  assert.equal(new P.LitimeFramer().push([0x41, 0x54, ...P.fromHex(LITIME_FRAME)]).length, 1);
});
test('LiTime: status request checksum is valid', () => {
  const r = P.LITIME.statusRequest;
  assert.equal(r.slice(0, -1).reduce((a, x) => (a + x) & 255, 0), r[r.length - 1]);
});

const zone = (o = {}) => { const a = [68, 74, 72, 70, 72, 0, 1, 128, 0, 128, 2, 128, 76, 0, 0, 3]; Object.assign(a, o); return a; };
const status = (z, PRM = [0, 15]) => JSON.stringify({ Z_sts: { 0: z }, PRM, SN: 'x' });
test('EasyTouch: status', () => {
  const d = P.decodeEasytouch(status(zone()));
  assert.deepEqual(d.zones[0], { zone: 0, mode: 'cool', temp: 76, action: 'cooling', autoHeat: 68, autoCool: 74, cool: 72, heat: 70, fan: 'auto' });
  assert.equal(d.wallOff, false);
  assert.equal(P.decodeEasytouch(status(zone(), [7])).wallOff, true);
});
test('EasyTouch: bad replies are rejected', () => {
  for (const s of ['', 'nope', '{}', '{"Z_sts":null}', '{"Z_sts":{"0":[1,2]}}']) assert.throws(() => P.decodeEasytouch(s));
});
test('EasyTouch: commands', () => {
  assert.deepEqual(P.modeCommand(0, 'off').Changes, { zone: 0, power: 0, mode: 0 });
  assert.deepEqual(P.modeCommand(1, 'auto').Changes, { zone: 1, power: 1, mode: 11 });
  assert.deepEqual(P.fanCommand(0, 'fan', 'high').Changes, { zone: 0, fanOnly: 2 });
  assert.deepEqual(P.fanCommand(0, 'cool', 'auto').Changes, { zone: 0, coolFan: 128 });
  assert.deepEqual(P.tempCommand(0, 'cool', { cool: 73 }).Changes, { zone: 0, power: 1, cool_sp: 73 });
  assert.equal(P.tempCommand(0, 'cool', { cool: 20 }).Changes.cool_sp, 60);
  assert.equal(P.tempCommand(0, 'heat', { heat: 200 }).Changes.heat_sp, 90);
  assert.throws(() => P.tempCommand(0, 'auto', { autoHeat: 72, autoCool: 73 }));
  assert.throws(() => P.tempCommand(0, 'off', { cool: 72 }));
  assert.throws(() => P.tempCommand(0, 'cool', { cool: NaN }));
  assert.throws(() => P.fanCommand(0, 'off', 'high'));
  assert.throws(() => P.fanCommand(0, 'fan', 'auto'));
  assert.throws(() => P.modeCommand(0, 'toString'));
});
test('EasyTouch: confirmation needs the thermostat to report the change', () => {
  const z = P.decodeEasytouch(status(zone())).zones[0];
  assert.equal(P.commandApplied(P.tempCommand(0, 'cool', { cool: 72 }), z), true);
  assert.equal(P.commandApplied(P.tempCommand(0, 'cool', { cool: 71 }), z), false);
  assert.equal(P.commandApplied(P.modeCommand(0, 'heat'), z), false);
  assert.equal(P.commandApplied(P.fanCommand(0, 'cool', 'low'), z), false);
  assert.equal(P.commandApplied(P.modeCommand(1, 'cool'), z), false);
});

test('EasyStart: telemetry', () => {
  const b = [0, 0, 0, 0, 98, 0, 141, 32, 187, 0, 0, 0, 2, 0, 0x10, 0x27, 0, 0];
  const d = P.decodeEasystart(Uint8Array.from(b));
  assert.equal(d.status, 'Normal'); assert.equal(d.amps, 9.8); assert.equal(d.lastPeak, 18.7);
  assert.equal(Math.round(d.hz), 60); assert.equal(d.faults, 2); assert.equal(d.starts, 10000);
  b[5] = 9; b[6] = b[7] = 0; b[2] = 7;
  const e = P.decodeEasystart(Uint8Array.from(b));
  assert.equal(e.amps, null); assert.equal(e.hz, null); assert.equal(e.status, 'Overcurrent fault');
  assert.equal(P.decodeEasystart(new TextEncoder().encode('{"Sts": Success}xxxxx')), null);
});

const SHUNT = ['100289a302b040af925d09a4d89aa0128bdef48c6298a9', 'aff4d0995b7d1e176c0c33ecb9e70dcd'];
const SOLAR = ['100242a0016207adceb37b605d7e0ee21b24df5c', 'adeccb947395801a4dd45a2eaa44bf17'];
test('Victron: captured SmartShunt broadcast', async () => {
  const d = await P.decodeVictron(P.fromHex(SHUNT[0]), SHUNT[1]);
  assert.equal(d.kind, 'shunt'); assert.equal(d.voltage, 12.53); assert.equal(d.soc, 50);
  assert.equal(d.current, 0); assert.equal(d.usedAh, 50); assert.equal(d.minutesLeft, null); assert.equal(d.alarm, 0);
});
test('Victron: captured solar charger broadcast', async () => {
  const d = await P.decodeVictron(P.fromHex(SOLAR[0]), SOLAR[1]);
  assert.equal(d.kind, 'solar'); assert.equal(d.state, 'Absorption'); assert.equal(d.voltage, 13.88);
  assert.equal(d.current, 1.4); assert.equal(d.yieldWh, 30); assert.equal(d.watts, 19);
});
// No real Orion XS frame with its key is published, so this one is encrypted here from Victron's published layout.
const ORION_KEY = '000102030405060708090a0b0c0d0e0f';
async function orionFrame(plainHex, nonce = 0x1234, type = '0f') {
  const key = await crypto.subtle.importKey('raw', P.fromHex(ORION_KEY), 'AES-CTR', false, ['encrypt']);
  const counter = new Uint8Array(16); counter[0] = nonce & 255; counter[1] = nonce >> 8;
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CTR', counter, length: 128 }, key, P.fromHex(plainHex)));
  return P.fromHex(`1002c7a3${type}3412${ORION_KEY.slice(0, 2)}${P.toHex(body)}`);
}
test('Victron: Orion XS (made-up sample)', async () => {
  const d = await P.decodeVictron(await orionFrame('03003e05f2016e05e90100000000ffff'), ORION_KEY);
  assert.equal(d.kind, 'orion'); assert.equal(d.state, 'Bulk'); assert.equal(d.error, 0);
  assert.equal(d.outV, 13.42); assert.equal(d.outA, 49.8); assert.equal(Math.round(d.watts), 668);
  assert.equal(d.inV, 13.9); assert.equal(d.inA, 48.9); assert.deepEqual(d.offReasons, []);
  const off = await P.decodeVictron(await orionFrame('0000ff7fff7fffffffff81000000ffff'), ORION_KEY);
  assert.equal(off.state, 'Off'); assert.equal(off.outV, null); assert.equal(off.outA, null); assert.equal(off.watts, null);
  assert.equal(off.inV, null); assert.equal(off.inA, null);
  assert.deepEqual(off.offReasons, ['no input power', 'engine off']);
  const sink = await P.decodeVictron(await orionFrame('030032 05f6ff6e05e901000000 00ffff'.replace(/ /g, '')), ORION_KEY);
  assert.equal(sink.outA, -1);
});
test('Victron: battery monitor extra input (published samples) and alarms', async () => {
  const read = async (hex) => P.decodeVictron(await orionFrame(hex, 0x1234, '02'), ORION_KEY);
  const off = await read('ffffe50400000000030000f40140df03');
  assert.equal(off.soc, 50); assert.equal(off.starter, null); assert.equal(off.midpoint, null); assert.equal(off.tempC, null); assert.deepEqual(off.alarms, []);
  assert.equal((await read('ffffe6040000feff010000000080fe0c')).midpoint, 655.34);
  assert.equal((await read('ffffe6040000feff000000000080feac')).starter, -0.02);
  assert.equal((await read('ffffe6040000fdff020000000080fede')).tempC.toFixed(2), (655.33 - 273.15).toFixed(2));
  assert.deepEqual((await read('ffffe50405000000030000f40140df03')).alarms, ['low voltage', 'low charge']);
  assert.equal((await read('ffffe50400000000fffffff40140df03')).current, null);
});
test('Weather: forecast', () => {
  const j = { current: { temperature_2m: 50.2, apparent_temperature: 43.8, relative_humidity_2m: 26, weather_code: 0, wind_speed_10m: 1.9, wind_gusts_10m: 3.6, wind_direction_10m: 121 },
    daily: { time: ['2026-11-25', '2026-11-26'], weather_code: [3, 86], temperature_2m_max: [50.5, 59.2], temperature_2m_min: [23.8, null], precipitation_probability_max: [0, 46], wind_gusts_10m_max: [8.7, 34.9], sunrise: ['2026-11-25T06:55'], sunset: ['2026-11-25T16:38'] } };
  const f = W.decodeForecast(j);
  assert.equal(f.sky, 'Clear'); assert.equal(f.from, 'SE'); assert.equal(f.sunset, '4:38 PM'); assert.equal(f.sunrise, '6:55 AM');
  assert.equal(f.days[0].name, 'Wed'); assert.equal(f.days[1].sky, 'Heavy snow showers'); assert.equal(f.days[1].low, null);
  assert.equal(W.clock('2026-11-25T00:05'), '12:05 AM'); assert.equal(W.clock('2026-11-25T12:00'), '12:00 PM'); assert.equal(W.clock(undefined), null);
  for (const bad of [null, {}, { current: {} }, { error: true }]) assert.throws(() => W.decodeForecast(bad));
});
test('Weather: alerts', () => {
  const a = (o) => ({ properties: { event: 'E', status: 'Actual', messageType: 'Alert', severity: 'Minor', ...o } });
  const list = W.decodeAlerts({ features: [a({ event: 'Wind Advisory', severity: 'Moderate', ends: '2026-11-25T20:00:00-07:00' }), a({ event: 'Tornado Warning', severity: 'Extreme', expires: '2026-11-25T18:00:00-07:00' }), a({ status: 'Test' }), a({ messageType: 'Cancel' })] });
  assert.deepEqual(list.map((x) => x.event), ['Tornado Warning', 'Wind Advisory']);
  assert.deepEqual(W.activeAlerts(list, Date.parse('2026-11-25T19:00:00-07:00')).map((x) => x.event), ['Wind Advisory']);
  assert.throws(() => W.decodeAlerts({}));
  assert.equal(W.roundPlace(39.73915), 39.74); assert.equal(String(W.roundPlace(-104.9999)), '-105');
});
test('Weather: a failed alert check is never reported as no alerts', async () => {
  const real = globalThis.fetch;
  const as = async (f) => { globalThis.fetch = f; const r = await W.alerts(1, 2); globalThis.fetch = real; return r.status; };
  assert.equal(await as(async () => { throw new TypeError('offline'); }), 'failed');
  assert.equal(await as(async () => new Response('', { status: 503 })), 'failed');
  assert.equal(await as(async () => new Response('{}')), 'failed');
  assert.equal(await as(async () => new Response('{}', { status: 400 })), 'outside');
  assert.equal(await as(async () => new Response('{"features":[]}')), 'ok');
});
test('Victron: broadcast data is accepted in every shape a browser might use', () => {
  const b = P.fromHex(SOLAR[0]), dv = new DataView(b.buffer), hex = (x) => x && P.toHex(x);
  for (const md of [new Map([[0x02e1, dv]]), new Map([['02e1', dv]]), { 737: dv }, { '0x02E1': [...b] }, { '02e1': b.buffer },
    new Map([[0x02e1, P.fromHex(`e102${SOLAR[0]}`)]]), P.fromHex(`e102${SOLAR[0]}`)]) assert.equal(hex(P.victronBytes(md)), SOLAR[0]);
  for (const md of [null, undefined, new Map(), {}, new Map([[0x004c, dv]]), b, { 737: 'text' }]) assert.equal(P.victronBytes(md), null);
});
test('Names route to the right equipment', () => {
  assert.equal(P.looksVictron('Orion XS HQ0000TEST'), true); assert.equal(P.looksVictron('SmartSolar HQ1'), true);
  for (const n of ['L-12320BH000-00001', 'EasyTouch 350000001', 'EasyStart_1', '', undefined]) assert.equal(P.looksVictron(n), false);
  assert.equal(P.kindForName('L-12320BH000-00001'), 'litime'); assert.equal(P.kindForName('EasyTouch 350000001'), 'easytouch');
  assert.equal(P.kindForName('Orion XS'), null); assert.equal(P.kindForName(undefined), null);
});
test('Victron: wrong key and key format', async () => {
  assert.equal(await P.decodeVictron(P.fromHex(SHUNT[0]), SOLAR[1]), null);
  assert.equal(P.normalizeKey(SHUNT[1].toUpperCase().replace(/(....)/g, '$1 ')), SHUNT[1]);
  assert.throws(() => P.normalizeKey('abc'));
});

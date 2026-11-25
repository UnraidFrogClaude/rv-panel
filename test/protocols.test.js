import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../protocols.js';

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
test('Victron: wrong key and key format', async () => {
  assert.equal(await P.decodeVictron(P.fromHex(SHUNT[0]), SOLAR[1]), null);
  assert.equal(P.normalizeKey(SHUNT[1].toUpperCase().replace(/(....)/g, '$1 ')), SHUNT[1]);
  assert.throws(() => P.normalizeKey('abc'));
});

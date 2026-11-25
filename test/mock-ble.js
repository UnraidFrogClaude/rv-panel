// Simulated accessories for localhost testing (?sim). Never loaded on a published copy.
import { LITIME, EASYTOUCH, EASYSTART, fromHex } from '../protocols.js';

const FRAME = fromHex('000065019355aa0046660000bc670000f50cf70cfc0cfb0cf80cf20cfa0cf50c0000000000000000000000000000000065faffff17001600feff00000000e91a0429000000000000000000000000000000000000000000000000410064000000030000005f010000a2');
const dv = (u8) => new DataView(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
const enc = (s) => new TextEncoder().encode(s);
const sim = window.sim = {
  silentThermostat: false, writes: [], stale: new Set(), mustHear: new Set(), inFlight: 0, parallel: false, authed: false, password: 'test-pass', overlap: 0, busy: 0, connects: 0,
  z: [68, 76, 72, 70, 72, 0, 1, 128, 0, 128, 2, 128, 76, 0, 0, 3], devices: {},
};

class Ch extends EventTarget {
  constructor(props, onWrite, onRead) { super(); this.properties = props; this.onWrite = onWrite; this.onRead = onRead; }
  async startNotifications() { this.on = true; return this; }
  emit(u8) { if (this.on) { this.value = dv(u8); this.dispatchEvent(new Event('characteristicvaluechanged')); } }
  async writeValueWithResponse(d) { await this.op(() => this.onWrite(new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d))); }
  async readValue() { let v; await this.op(() => { v = dv(this.onRead()); }); return v; }
  async op(f) { if (++sim.busy > 1) sim.overlap++; await new Promise((r) => setTimeout(r, 20)); sim.busy--; f(); }
}
class Dev extends EventTarget {
  constructor(id, name, service, chars) {
    super(); this.id = id; this.name = name;
    const self = this;
    this.gatt = {
      connected: false,
      async connect() { sim.connects++; if (sim.inFlight++) sim.parallel = true; await new Promise((r) => setTimeout(r, 60)); sim.inFlight--; if (sim.stale.has(id)) return Promise.reject(); if (sim.mustHear.has(id)) throw 'not seen yet'; this.connected = true; return { getPrimaryService: async (s) => { if (s !== service) throw new Error('service not found'); return { getCharacteristic: async (c) => { if (!chars[c]) throw new Error('characteristic not found'); return chars[c]; } }; } }; },
      disconnect() { if (!this.connected) return; this.connected = false; if (id === 't1') sim.authed = false; self.dispatchEvent(new Event('gattserverdisconnected')); },
    };
  }
}
sim.devices.orion = new Dev('o1', 'Orion XS SIM', 'none', {});
const rx = new Ch({ notify: true });
sim.devices.litime = new Dev('b1', 'L-12230-SIM', LITIME.service, { [LITIME.notify]: rx, [LITIME.write]: new Ch({ write: true }, (b) => {
  if (String(b) === String(LITIME.statusRequest)) { rx.emit(FRAME.slice(0, 60)); rx.emit(FRAME.slice(60)); }
}) });
const es = new Ch({ notify: true });
sim.devices.easystart = new Dev('e1', 'EasyStart-SIM', EASYSTART.service, { [EASYSTART.notify]: es, [EASYSTART.write]: new Ch({ write: true }, () => {
  es.emit(enc('{"Sts": Success}')); es.emit(Uint8Array.from([0, 0, 0, 0, 98, 0, 141, 32, 187, 0, 0, 0, 2, 0, 0x10, 0x27, 0, 0]));
}) });
let reply = '';
sim.devices.easytouch = new Dev('t1', 'EasyTouch <b>SIM</b>', EASYTOUCH.service, {
  [EASYTOUCH.password]: new Ch({ write: true }, (b) => { sim.authed = new TextDecoder().decode(b) === sim.password; }),
  [EASYTOUCH.reply]: new Ch({ read: true }, null, () => enc(sim.authed ? reply : '')),
  [EASYTOUCH.command]: new Ch({ write: true }, (b) => {
    if (!sim.authed) return;
    const m = JSON.parse(new TextDecoder().decode(b));
    if (m.Type === 'Change') {
      sim.writes.push(m.Changes);
      if (sim.silentThermostat) return;
      const c = m.Changes, z = sim.z;
      if ('mode' in c) { z[10] = c.mode; z[15] = { 0: 0, 1: 1, 2: 3, 4: 5, 11: 2 }[c.mode]; }
      for (const [k, i] of [['cool_sp', 2], ['heat_sp', 3], ['autoHeat_sp', 0], ['autoCool_sp', 1], ['fanOnly', 6], ['coolFan', 7], ['autoFan', 9], ['heatFan', 11]]) if (k in c) z[i] = c[k];
    }
    reply = JSON.stringify({ Z_sts: { 0: sim.z }, PRM: [0, 15], SN: 'SIM' });
  }),
});

class Bt extends EventTarget {
  async requestDevice(o) {
    const d = Object.values(sim.devices).find((x) => (sim.pick ? x.id === sim.pick : true) && (o.acceptAllDevices || o.filters?.some((f) => (f.name ? x.name === f.name : x.name.startsWith(f.namePrefix)))));
    if (!d) { const e = new Error('none'); e.name = 'NotFoundError'; throw e; }
    sim.stale.delete(d.id);
    return d;
  }
  // ?stale: remembered devices refuse to connect and give no reason, as Bluefy did after a reload.
  async getDevices() { return Object.values(sim.devices); }
  async requestLEScan() { return { stop() {} }; }
}
const q = new URLSearchParams(location.search);
if (q.has('stale')) ['b1', 't1', 'e1', 'o1'].forEach((i) => sim.stale.add(i));
if (q.has('mustHear')) for (const d of Object.values(sim.devices)) { sim.mustHear.add(d.id); d.watchAdvertisements = async () => { setTimeout(() => { sim.mustHear.delete(d.id); d.dispatchEvent(new Event('advertisementreceived')); }, 100); }; }
const bt = new Bt();
Object.defineProperty(navigator, 'bluetooth', { value: bt, configurable: true });
sim.advertise = (hex) => { const e = new Event('advertisementreceived'); e.device = { name: 'Orion XS SIM' }; e.manufacturerData = new Map([[0x02e1, dv(fromHex(hex))]]); bt.dispatchEvent(e); };

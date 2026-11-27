// Bluetooth connection handling. Works with any browser exposing navigator.bluetooth (Bluefy on iPad).
import * as P from './protocols.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bytesOf = (dv) => new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
const timeout = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(`${what} timed out`)), ms); })])
    .finally(() => clearTimeout(t));
};

// ---- diagnostics log. Callers never pass the password, email or Victron keys to this.
export const log = [];
export function note(source, text) {
  log.push(`${new Date().toISOString().slice(11, 23)} ${source}: ${text}`);
  if (log.length > 400) log.splice(0, log.length - 400);
}

/** Bluefy can reject with nothing, or with a plain string, so never assume an Error. */
export function why(e) {
  if (e === undefined || e === null) return 'the browser gave no reason';
  if (typeof e === 'string') return e;
  return e.message || e.name || (e.code !== undefined ? `code ${e.code}` : 'the browser gave no reason');
}

// Connections are opened one at a time across all accessories.
let radio = Promise.resolve();
function oneAtATime(job) {
  const r = radio.then(job);
  radio = r.catch(() => {});
  return r;
}

async function write(ch, data) {
  const p = ch.properties || {};
  if (p.write && ch.writeValueWithResponse) return ch.writeValueWithResponse(data);
  if (p.writeWithoutResponse && ch.writeValueWithoutResponse) return ch.writeValueWithoutResponse(data);
  return ch.writeValue(data);
}

/** One connected accessory. Subclasses implement setup() and poll(). */
class Accessory {
  constructor(device, onChange) {
    Object.assign(this, { device, onChange, status: 'connecting', error: null, data: null, updatedAt: 0, stopped: false, attempts: 0, restored: false, raw: 0 });
    this.name = device.name || this.constructor.label;
    this.key = `${this.kind}:${device.id}`;
    this.queue = Promise.resolve();
    // While still connecting, the connect attempt itself reports the failure.
    this.onDrop = () => { if (!this.stopped && this.status === 'connected') { note(this.name, 'connection dropped'); this.lost('Connection lost'); } };
    device.addEventListener('gattserverdisconnected', this.onDrop);
  }
  get kind() { return this.constructor.kind; }

  /** Runs jobs one at a time; these devices do not tolerate overlapping requests. */
  run(job) {
    const r = this.queue.then(job);
    this.queue = r.catch(() => {});
    return r;
  }
  async start() {
    if (this.stopped || this.starting) return;
    this.starting = true;
    clearTimeout(this.timer);
    this.status = 'connecting'; this.onChange();
    try {
      await oneAtATime(() => this.run(() => this.open()));
      this.starting = false;
      if (this.stopped) return;
      this.status = 'connected'; this.error = null; this.restored = false; this.raw = 0;
      note(this.name, 'connected');
      this.onChange();
      this.loop();
    } catch (e) {
      this.starting = false;
      if (this.stopped) return;
      note(this.name, `connect failed: ${why(e)}`);
      this.lost(this.restored ? `Could not reconnect by itself (${why(e)}). Tap Reconnect.` : why(e));
    }
  }
  /** Runs inside the connection queue, and cleans up after itself so the next attempt starts fresh. */
  async open() {
    if (this.stopped) throw new Error('Stopped');
    const { gatt } = this.device;
    try {
      let server;
      try { server = await timeout(gatt.connect(), this.restored ? 10000 : 20000, 'Connecting'); }
      catch (e) {
        if (!this.restored || !this.device.watchAdvertisements) throw e;
        note(this.name, `direct connect failed (${why(e)}), listening for it first`);
        await this.hear();
        server = await timeout(gatt.connect(), 10000, 'Connecting');
      }
      if (this.stopped) throw new Error('Stopped');
      const service = await timeout(server.getPrimaryService(this.constructor.spec.service), 10000, 'Finding the service');
      await timeout(this.setup(service), 15000, 'Setup');
      if (this.stopped) throw new Error('Stopped');
    } catch (e) { this.drop(); throw e; }
  }
  /** Some browsers will only reopen a remembered device after hearing it broadcast. */
  async hear() {
    const abort = new AbortController();
    let heard;
    const broadcast = new Promise((r) => { heard = r; });
    this.device.addEventListener('advertisementreceived', heard);
    try {
      await timeout(this.device.watchAdvertisements({ signal: abort.signal }), 5000, 'Listening');
      await timeout(broadcast, 8000, 'Hearing the device');
    } finally { abort.abort(); this.device.removeEventListener('advertisementreceived', heard); }
  }
  async loop() {
    clearTimeout(this.timer);
    if (this.stopped || this.status !== 'connected') return;
    try {
      await this.run(() => timeout(this.poll(), 15000, 'Reading'));
      this.attempts = 0; this.error = null;
    } catch (e) {
      if (this.stopped || this.status !== 'connected') return;
      note(this.name, `read failed: ${why(e)}`);
      this.error = why(e);
      if (++this.attempts >= 3) { this.attempts = 0; this.lost(why(e)); this.drop(); return; }
    }
    if (this.stopped || this.status !== 'connected') return;
    this.onChange();
    this.timer = setTimeout(() => this.loop(), this.constructor.interval);
  }
  lost(msg) {
    if (this.stopped) return;
    if (this.status === 'waiting') return; // a retry is already scheduled
    clearTimeout(this.timer);
    this.status = 'waiting'; this.error = msg;
    const delay = Math.min(60, 3 * 2 ** Math.min(this.retries = (this.retries || 0) + 1, 5)) * 1000;
    this.timer = setTimeout(() => this.start(), delay);
    this.onChange();
  }
  // Always asks, even when the browser believes it is disconnected: that also cancels an attempt still in progress.
  drop() { try { this.device.gatt.disconnect(); } catch { /* already gone */ } }
  /** Raw bytes are logged only a few times per connection, so the log keeps its history. */
  noteRaw(b) { if (this.raw++ < 3) note(this.name, `rx ${P.toHex(b)}`); }
  got(data) { this.data = data; this.updatedAt = Date.now(); this.retries = 0; this.onChange(); }
  stop() {
    this.stopped = true; this.status = 'off';
    clearTimeout(this.timer);
    this.device.removeEventListener('gattserverdisconnected', this.onDrop);
    this.drop();
  }
  /** Subscribes to notifications and resolves once the next decoded message arrives. */
  async listen(ch, handler) {
    if (this.ch && this.handler) this.ch.removeEventListener('characteristicvaluechanged', this.handler);
    this.ch = ch;
    this.handler = (e) => { try { handler(bytesOf(e.target.value)); } catch (err) { note(this.name, `decode failed: ${why(err)}`); } };
    ch.addEventListener('characteristicvaluechanged', this.handler);
    await ch.startNotifications();
  }
  nextReply() { return new Promise((r) => { this.arrived = r; }); }
}

export class Litime extends Accessory {
  static kind = 'litime'; static label = 'LiTime battery'; static spec = P.LITIME; static interval = 5000;
  async setup(service) {
    this.framer = new P.LitimeFramer();
    const rx = await service.getCharacteristic(P.LITIME.notify);
    this.tx = await service.getCharacteristic(P.LITIME.write);
    await this.listen(rx, (b) => {
      this.noteRaw(b);
      for (const f of this.framer.push(b)) { this.got(P.decodeLitime(f)); this.arrived?.(); }
    });
  }
  async poll() {
    this.framer.reset();
    const reply = this.nextReply();
    await write(this.tx, P.LITIME.statusRequest);
    await timeout(reply, 5000, 'Battery reply');
  }
}

export class Easystart extends Accessory {
  static kind = 'easystart'; static label = 'EasyStart'; static spec = P.EASYSTART; static interval = 10000;
  async setup(service) {
    const rx = await service.getCharacteristic(P.EASYSTART.notify);
    this.tx = await service.getCharacteristic(P.EASYSTART.write);
    await this.listen(rx, (b) => {
      this.noteRaw(b);
      const d = P.decodeEasystart(b);
      if (d) { this.got(d); this.arrived?.(); }
    });
  }
  async poll() {
    const reply = this.nextReply();
    await write(this.tx, new TextEncoder().encode(P.EASYSTART.statusRequest));
    await timeout(reply, 8000, 'EasyStart reply');
  }
}

export class Easytouch extends Accessory {
  static kind = 'easytouch'; static label = 'EasyTouch'; static spec = P.EASYTOUCH; static interval = 15000;
  constructor(device, onChange, credentials) { super(device, onChange); this.credentials = credentials; this.command = null; }
  async setup(service) {
    const { email, password } = this.credentials();
    if (!email || !password) throw new Error('Add your Micro-Air sign-in under Setup');
    const pw = await service.getCharacteristic(P.EASYTOUCH.password);
    this.tx = await service.getCharacteristic(P.EASYTOUCH.command);
    this.rx = await service.getCharacteristic(P.EASYTOUCH.reply);
    await write(pw, new TextEncoder().encode(password));
    await wait(300);
  }
  async send(obj) { await write(this.tx, new TextEncoder().encode(JSON.stringify(obj))); }
  async readStatus() {
    let last;
    await this.send(P.easytouchStatusRequest(this.credentials().email));
    for (let i = 0; i < 4; i++) {
      await wait(250 * (i + 1));
      const b = bytesOf(await this.rx.readValue());
      try { return P.decodeEasytouch(new TextDecoder().decode(b)); }
      catch (e) { last = e; note(this.name, `unreadable reply, ${b.length} bytes: ${why(e)}`); }
    }
    throw new Error('The thermostat gave no usable reply. Check your Micro-Air sign-in and close its app.', { cause: last });
  }
  async poll() { this.got(await this.readStatus()); }

  /** Sends one change, then waits for the thermostat itself to report it. Never reports success optimistically. */
  async change(cmd, label) {
    const mine = this.command = { label, state: 'sending' };
    this.onChange();
    try {
      await this.run(async () => {
        if (this.stopped || this.status !== 'connected') throw new Error('Thermostat is not connected');
        note(this.name, `send ${JSON.stringify(cmd)}`);
        await timeout(this.send(cmd), 8000, 'Sending');
        for (let i = 0; i < 3; i++) {
          await wait(1200);
          const d = await timeout(this.readStatus(), 10000, 'Checking');
          this.got(d);
          if (d.zones.some((z) => P.commandApplied(cmd, z))) { mine.state = 'confirmed'; return; }
        }
        throw new Error('The thermostat did not report the change. Check it at the wall.');
      });
    } catch (e) {
      mine.state = 'failed'; mine.error = why(e);
      note(this.name, `change failed: ${why(e)}`);
    }
    this.onChange();
    if (mine.state === 'confirmed') setTimeout(() => { if (this.command === mine) { this.command = null; this.onChange(); } }, 4000);
    return mine.state === 'confirmed';
  }
}

export const KINDS = { litime: Litime, easytouch: Easytouch, easystart: Easystart };
export const supported = () => Boolean(navigator.bluetooth?.requestDevice);

/** Must be called from a tap. showAll is for accessories with an unexpected name. */
export async function choose(kind, showAll = false, name = null) {
  const { spec } = KINDS[kind];
  const opts = name && P.kindForName(name) !== kind ? { filters: [{ name }] } : showAll ? { acceptAllDevices: true } : { filters: spec.namePrefixes.map((namePrefix) => ({ namePrefix })) };
  return navigator.bluetooth.requestDevice({ ...opts, optionalServices: [spec.service] });
}

/** Devices this browser already allows, so they can reconnect without a tap. Not every browser supports this. */
export async function remembered() {
  try { return navigator.bluetooth?.getDevices ? await navigator.bluetooth.getDevices() : []; } catch { return []; }
}

// ---------------------------------------------------------------- Victron (receive only)

const METHODS = {
  scan: () => Boolean(navigator.bluetooth?.requestLEScan),
  bluefy: () => Boolean(navigator.bluetooth?.watchAdvertisements),
  // Pick each Victron device once, then listen to it. Bluefy's devices can do this even though it has no global BluetoothDevice.
  pick: () => Boolean(navigator.bluetooth?.requestDevice),
};
const failedMethods = new Set(); // the next tap tries the next way
const VICTRON_PREFIXES = ['Orion', 'SmartSolar', 'Smart Solar', 'BlueSolar', 'SmartShunt', 'Smart Shunt', 'BMV', 'SmartBMV', 'Smart BMV', 'Blue Smart', 'Phoenix', 'SmartBMS', 'Smart BMS', 'SmartLithium', 'Lynx', 'Multi', 'Victron'];

export class VictronListener {
  constructor(keys, onReading) { Object.assign(this, { keys, onReading, state: 'off', how: null, broadcasts: 0, heard: new Map(), matched: new Set(), shapes: 0, devices: new Map() }); }
  static method() { return Object.keys(METHODS).find((m) => METHODS[m]() && !failedMethods.has(m)) || null; }
  /** From a tap. In pick mode each tap adds one device; showAll is for a renamed one. */
  async start(showAll = false) {
    const how = this.how || VictronListener.method();
    if (!how) throw new Error('This browser cannot receive Victron broadcasts. Use Boardstrom for Victron.');
    const bt = navigator.bluetooth;
    try {
      if (how === 'pick') {
        const opts = showAll ? { acceptAllDevices: true } : { filters: VICTRON_PREFIXES.map((namePrefix) => ({ namePrefix })) };
        const d = await bt.requestDevice({ ...opts, optionalManufacturerData: [P.VICTRON_COMPANY] });
        await this.watch(d);
      } else {
        const opts = { acceptAllAdvertisements: true, keepRepeatedDevices: true };
        this.handler = (e) => this.receive(e);
        bt.addEventListener('advertisementreceived', this.handler);
        const started = how === 'scan' ? bt.requestLEScan(opts) : bt.watchAdvertisements({ ...opts, acceptAllDevices: true });
        this.scan = await Promise.race([started, wait(30000)]); // one that never answers may still deliver
      }
    } catch (e) {
      if (e?.name !== 'NotFoundError' && e?.name !== 'AbortError' && !this.devices.size) failedMethods.add(how);
      note('Victron', `${how} failed: ${why(e)}`);
      throw e;
    }
    this.how = how; this.state = 'listening';
    note('Victron', `listening (${how})`);
  }
  /** Listens to one device's broadcasts. Needs no tap, so devices picked before resume after a reload. */
  async watch(d) {
    if (this.devices.has(d.id)) return;
    if (typeof d.watchAdvertisements !== 'function') throw new Error('This browser cannot listen to Victron devices. Use Boardstrom for Victron.');
    const abort = new AbortController(), h = (e) => this.receive(e, d);
    d.addEventListener('advertisementreceived', h);
    this.devices.set(d.id, { d, abort, h });
    try { await timeout(d.watchAdvertisements({ signal: abort.signal }), 15000, 'Listening'); }
    catch (e) { abort.abort(); d.removeEventListener('advertisementreceived', h); this.devices.delete(d.id); throw e; }
    this.how = 'pick'; this.state = 'listening';
    note('Victron', `listening to ${d.name || 'a device'}`);
  }
  async receive(e, d = null) {
    this.broadcasts++;
    const bytes = P.victronBytes(e.manufacturerData);
    const name = e.device?.name || d?.name || e.name || 'Victron device';
    if (!bytes) {
      if ((d || P.looksVictron(name)) && this.shapes++ < 3) note('Victron', `broadcast from ${name} without readable data: ${Object.prototype.toString.call(e.manufacturerData)}, keys ${Object.keys(e.manufacturerData || {}).slice(0, 5)}`);
      return;
    }
    if (bytes[0] !== 0x10) return; // not a readout
    if (this.heard.get(name) !== bytes[4]) { this.heard.set(name, bytes[4]); note('Victron', `heard ${name}, record type ${bytes[4]}, ${bytes.length} bytes`); }
    for (const k of this.keys()) {
      try {
        const r = await P.decodeVictron(bytes, k.key);
        if (r) { this.matched.add(name); this.onReading(k, r); return; }
      } catch (err) { note('Victron', `decode failed: ${why(err)}`); }
    }
  }
  stop() {
    if (this.handler) navigator.bluetooth?.removeEventListener?.('advertisementreceived', this.handler);
    for (const { d, abort, h } of this.devices.values()) { abort.abort(); d.removeEventListener('advertisementreceived', h); }
    this.devices.clear();
    try { this.scan?.stop?.(); } catch { /* already stopped */ }
    this.state = 'off';
  }
}

/** What this browser offers. Bluefy's extras are undocumented, so the functions' own code is the only reference. */
export async function browserDetails() {
  const bt = navigator.bluetooth;
  const names = (o) => {
    const s = new Set();
    for (let p = o; p && p !== Object.prototype && p !== Function.prototype; p = Object.getPrototypeOf(p)) Object.getOwnPropertyNames(p).forEach((n) => s.add(n));
    return [...s].join(', ') || 'empty';
  };
  const D = globalThis.BluetoothDevice?.prototype, G = globalThis.BluetoothRemoteGATTServer?.prototype;
  const dev = (await remembered())[0]; // only its property names and code are shown, not which device it is
  const code = { 'remembered device.watchAdvertisements': dev?.watchAdvertisements, watchAdvertisements: bt?.watchAdvertisements, requestLEScan: bt?.requestLEScan, getDevices: bt?.getDevices,
    setScreenDimEnabled: bt?.setScreenDimEnabled, 'device.watchAdvertisements': D?.watchAdvertisements, 'gatt.connect': G?.connect };
  return [`Browser: ${navigator.userAgent}`, `bluetooth: ${bt ? names(bt) : 'none'}`, `BLENative: ${globalThis.BLENative ? names(globalThis.BLENative) : 'none'}`,
    `BluetoothDevice: ${D ? names(D) : 'none'}`, `GATT server: ${G ? names(G) : 'none'}`,
    `remembered device: ${dev ? names(dev) : 'none'}`, `[BLENative.notifyAdvertisementReceived] ${String(globalThis.BLENative?.notifyAdvertisementReceived ?? 'none').slice(0, 1500)}`,
    ...Object.entries(code).map(([k, f]) => `[${k}] ${typeof f === 'function' ? String(f).slice(0, 1500) : 'none'}`)].join('\n');
}

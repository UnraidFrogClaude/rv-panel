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

async function write(ch, data) {
  const p = ch.properties || {};
  if (p.write && ch.writeValueWithResponse) return ch.writeValueWithResponse(data);
  if (p.writeWithoutResponse && ch.writeValueWithoutResponse) return ch.writeValueWithoutResponse(data);
  return ch.writeValue(data);
}

/** One connected accessory. Subclasses implement setup() and poll(). */
class Accessory {
  constructor(device, onChange) {
    Object.assign(this, { device, onChange, status: 'connecting', error: null, data: null, updatedAt: 0, stopped: false, attempts: 0 });
    this.name = device.name || this.constructor.label;
    this.key = `${this.kind}:${device.id}`;
    this.queue = Promise.resolve();
    this.onDrop = () => { if (!this.stopped) { note(this.name, 'connection dropped'); this.lost('Connection lost'); } };
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
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.status = 'connecting'; this.onChange();
    try {
      await this.run(async () => {
        const server = await timeout(this.device.gatt.connect(), 20000, 'Connecting');
        const service = await timeout(server.getPrimaryService(this.constructor.spec.service), 10000, 'Finding the service');
        await timeout(this.setup(service), 15000, 'Setup');
      });
      if (this.stopped) return;
      this.status = 'connected'; this.error = null;
      note(this.name, 'connected');
      this.onChange();
      this.loop();
    } catch (e) {
      note(this.name, `connect failed: ${e.message}`);
      this.lost(e.message); // before drop(), so the real reason is not replaced by 'Connection lost'
      this.drop();
    }
  }
  async loop() {
    clearTimeout(this.timer);
    if (this.stopped || this.status !== 'connected') return;
    try {
      await this.run(() => timeout(this.poll(), 15000, 'Reading'));
      this.attempts = 0; this.error = null;
    } catch (e) {
      note(this.name, `read failed: ${e.message}`);
      this.error = e.message;
      if (++this.attempts >= 3) { this.lost(e.message); this.drop(); return; }
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
    this.timer = setTimeout(() => { this.status = 'connecting'; this.start(); }, delay);
    this.onChange();
  }
  drop() { try { if (this.device.gatt.connected) this.device.gatt.disconnect(); } catch { /* already gone */ } }
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
    this.handler = (e) => { try { handler(bytesOf(e.target.value)); } catch (err) { note(this.name, `decode failed: ${err.message}`); } };
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
      note(this.name, `rx ${P.toHex(b)}`);
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
      note(this.name, `rx ${P.toHex(b)}`);
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
      catch (e) { last = e; note(this.name, `unreadable reply, ${b.length} bytes: ${e.message}`); }
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
      mine.state = 'failed'; mine.error = e.message;
      note(this.name, `change failed: ${e.message}`);
    }
    this.onChange();
    if (mine.state === 'confirmed') setTimeout(() => { if (this.command === mine) { this.command = null; this.onChange(); } }, 4000);
    return mine.state === 'confirmed';
  }
}

export const KINDS = { litime: Litime, easytouch: Easytouch, easystart: Easystart };
export const supported = () => Boolean(navigator.bluetooth?.requestDevice);

/** Must be called from a tap. showAll is for accessories with an unexpected name. */
export async function choose(kind, showAll = false) {
  const { spec } = KINDS[kind];
  const opts = showAll ? { acceptAllDevices: true } : { filters: spec.namePrefixes.map((namePrefix) => ({ namePrefix })) };
  return navigator.bluetooth.requestDevice({ ...opts, optionalServices: [spec.service] });
}

/** Devices this browser already allows, so they can reconnect without a tap. Not every browser supports this. */
export async function remembered() {
  try { return navigator.bluetooth?.getDevices ? await navigator.bluetooth.getDevices() : []; } catch { return []; }
}

// ---------------------------------------------------------------- Victron (receive only)

export class VictronListener {
  constructor(keys, onReading) { Object.assign(this, { keys, onReading, state: 'off', error: null, heard: 0 }); }
  static method() {
    const bt = navigator.bluetooth;
    if (bt?.requestLEScan) return 'scan';
    if (globalThis.BluetoothDevice && 'watchAdvertisements' in BluetoothDevice.prototype) return 'watch';
    return null;
  }
  async start() {
    const how = VictronListener.method();
    if (!how) throw new Error('This browser cannot receive Victron broadcasts. Use Boardstrom for Victron.');
    this.handler = (e) => this.receive(e);
    if (how === 'scan') {
      navigator.bluetooth.addEventListener('advertisementreceived', this.handler);
      this.scan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
    } else {
      this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalManufacturerData: [P.VICTRON_COMPANY] });
      this.device.addEventListener('advertisementreceived', this.handler);
      this.abort = new AbortController();
      await this.device.watchAdvertisements({ signal: this.abort.signal });
    }
    this.state = 'listening';
    note('Victron', `listening (${how})`);
  }
  async receive(e) {
    const dv = e.manufacturerData?.get?.(P.VICTRON_COMPANY);
    if (!dv) return;
    this.heard++;
    for (const k of this.keys()) {
      try {
        const d = await P.decodeVictron(bytesOf(dv), k.key);
        if (d) { this.onReading(k, d); return; }
      } catch (err) { note('Victron', `decode failed: ${err.message}`); }
    }
  }
  stop() {
    navigator.bluetooth?.removeEventListener?.('advertisementreceived', this.handler);
    this.device?.removeEventListener('advertisementreceived', this.handler);
    this.scan?.stop?.(); this.abort?.abort(); this.state = 'off';
  }
}

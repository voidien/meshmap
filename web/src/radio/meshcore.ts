/**
 * MeshCore companion-radio protocol, just the parts needed to hear packets: framing, the start-up commands, and the
 * "log RX data" push that carries the RSSI/SNR of every packet the radio receives. Layouts follow the official
 * meshcore.js client (BLE: UUIDs below, one frame per notification; USB serial: '<' / '>' + 2-byte little-endian length).
 */

export const BLE_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const BLE_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // we write here
export const BLE_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // radio notifies here

const CMD_APP_START = 0x01;
const CMD_DEVICE_QUERY = 0x16;
const PUSH_LOG_RX_DATA = 0x88;
const SERIAL_TO_RADIO = 0x3c;
const SERIAL_FROM_RADIO = 0x3e;

export function appStartFrame(appName = "meshmap"): Uint8Array {
  const name = new TextEncoder().encode(appName);
  const out = new Uint8Array(8 + name.length);
  out[0] = CMD_APP_START;
  out[1] = 1; // app version; bytes 2-7 reserved
  out.set(name, 8);
  return out;
}

export const deviceQueryFrame = (): Uint8Array => Uint8Array.of(CMD_DEVICE_QUERY, 3);

/** Wrap a command for a USB serial link. */
export function serialFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(3 + payload.length);
  out[0] = SERIAL_TO_RADIO;
  out[1] = payload.length & 0xff;
  out[2] = payload.length >> 8;
  out.set(payload, 3);
  return out;
}

/** Reassembles frames from the radio out of arbitrary chunks of serial bytes. */
export class SerialDeframer {
  private buf: number[] = [];

  push(chunk: Uint8Array): Uint8Array[] {
    for (const b of chunk) this.buf.push(b);
    const frames: Uint8Array[] = [];
    while (this.buf.length >= 3) {
      const len = this.buf[1] | (this.buf[2] << 8);
      if ((this.buf[0] !== SERIAL_FROM_RADIO && this.buf[0] !== SERIAL_TO_RADIO) || len === 0) {
        this.buf.shift(); // not a frame start: skip a byte and look again
        continue;
      }
      if (this.buf.length < 3 + len) break;
      frames.push(Uint8Array.from(this.buf.slice(3, 3 + len)));
      this.buf = this.buf.slice(3 + len);
    }
    return frames;
  }
}

export interface RxLog {
  snrDb: number;
  rssiDbm: number;
  /** the packet as received over the air */
  raw: Uint8Array;
}

/** A "log RX data" push: code 0x88, SNR (int8, quarter dB), RSSI (int8, dBm), then the packet. */
export function parseRxLog(frame: Uint8Array): RxLog | null {
  if (frame.length < 3 || frame[0] !== PUSH_LOG_RX_DATA) return null;
  const i8 = (v: number) => (v > 127 ? v - 256 : v);
  return { snrDb: i8(frame[1]) / 4, rssiDbm: i8(frame[2]), raw: frame.slice(3) };
}

export const PAYLOAD_ADVERT = 4;

export interface MeshPacket {
  payloadType: number;
  /** number of repeaters the packet went through; 0 means it came straight from the sender */
  hops: number;
  payload: Uint8Array;
}

export function parsePacket(raw: Uint8Array): MeshPacket | null {
  if (raw.length < 2) return null;
  const header = raw[0];
  const route = header & 3;
  let i = 1 + (route === 0 || route === 3 ? 4 : 0); // flood/direct with transport codes carry 4 extra bytes
  if (i >= raw.length) return null;
  const pathLen = raw[i++];
  const hops = pathLen & 63;
  i += hops * ((pathLen >> 6) + 1);
  if (i > raw.length) return null;
  return { payloadType: (header >> 2) & 15, hops, payload: raw.slice(i) };
}

export interface Advert {
  publicKeyHex: string;
  /** advertised name, if the node sends one */
  name: string | null;
  /** advertised position, if the node shares it */
  lat: number | null;
  lon: number | null;
}

export function parseAdvert(payload: Uint8Array): Advert | null {
  if (payload.length < 32 + 4 + 64 + 1) return null;
  const publicKeyHex = [...payload.slice(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const app = payload.slice(100);
  const flags = app[0];
  const dv = new DataView(app.buffer, app.byteOffset, app.byteLength);
  let i = 1;
  let lat: number | null = null;
  let lon: number | null = null;
  if (flags & 0x10) {
    if (app.length < i + 8) return null;
    lat = dv.getInt32(i, true) / 1e6;
    lon = dv.getInt32(i + 4, true) / 1e6;
    i += 8;
  }
  if (flags & 0x20) i += 2;
  if (flags & 0x40) i += 2;
  let name: string | null = null;
  if (flags & 0x80 && i <= app.length) name = new TextDecoder().decode(app.slice(i)).replace(/\0+$/, "").trim() || null;
  return { publicKeyHex, name, lat, lon };
}

/** A packet heard directly from a node (no repeater in between): the only kind whose signal tells about that one path. */
export interface HeardAdvert {
  advert: Advert;
  rssiDbm: number;
  snrDb: number;
}

export function heardAdvert(frame: Uint8Array): HeardAdvert | null {
  const rx = parseRxLog(frame);
  if (!rx) return null;
  const pkt = parsePacket(rx.raw);
  if (!pkt || pkt.payloadType !== PAYLOAD_ADVERT || pkt.hops !== 0) return null;
  const advert = parseAdvert(pkt.payload);
  return advert ? { advert, rssiDbm: rx.rssiDbm, snrDb: rx.snrDb } : null;
}

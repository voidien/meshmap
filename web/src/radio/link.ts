/** Connecting a MeshCore radio to the page over Web Bluetooth or USB (Web Serial). The protocol itself is in meshcore.ts. */
import { appStartFrame, BLE_RX, BLE_SERVICE, BLE_TX, deviceQueryFrame, heardAdvert, SerialDeframer, serialFrame, type HeardAdvert } from "./meshcore";

export type Transport = "bluetooth" | "usb";

export interface RadioLink {
  transport: Transport;
  name: string;
  close: () => Promise<void>;
}

export const supports = (t: Transport): boolean => (t === "bluetooth" ? "bluetooth" in navigator : "serial" in navigator);

interface Handlers {
  onHeard: (h: HeardAdvert) => void;
  onPacket: () => void;
  onClosed: () => void;
}

// Browser APIs without bundled types in this project's TS lib
/* eslint-disable @typescript-eslint/no-explicit-any */

export async function connectRadio(t: Transport, h: Handlers): Promise<RadioLink> {
  const frame = (f: Uint8Array) => {
    h.onPacket();
    const heard = heardAdvert(f);
    if (heard) h.onHeard(heard);
  };
  if (t === "bluetooth") {
    const device = await (navigator as any).bluetooth.requestDevice({ filters: [{ services: [BLE_SERVICE] }] });
    device.addEventListener("gattserverdisconnected", h.onClosed);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE);
    const rx = await service.getCharacteristic(BLE_RX);
    const tx = await service.getCharacteristic(BLE_TX);
    await tx.startNotifications();
    tx.addEventListener("characteristicvaluechanged", (e: any) => frame(new Uint8Array(e.target.value.buffer.slice(e.target.value.byteOffset, e.target.value.byteOffset + e.target.value.byteLength))));
    await rx.writeValue(appStartFrame());
    await rx.writeValue(deviceQueryFrame());
    return { transport: t, name: device.name || "MeshCore radio", close: async () => void server.disconnect() };
  }
  const port = await (navigator as any).serial.requestPort({});
  await port.open({ baudRate: 115200 });
  port.addEventListener("disconnect", h.onClosed);
  const deframer = new SerialDeframer();
  const reader = port.readable.getReader();
  const send = async (b: Uint8Array) => {
    const w = port.writable.getWriter();
    try {
      await w.write(serialFrame(b));
    } finally {
      w.releaseLock();
    }
  };
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const f of deframer.push(value)) frame(f);
      }
    } catch {
      /* unplugged or closed */
    } finally {
      h.onClosed();
    }
  })();
  await send(appStartFrame());
  await send(deviceQueryFrame());
  return {
    transport: t,
    name: "USB radio",
    close: async () => {
      try {
        await reader.cancel();
        reader.releaseLock();
        await port.close();
      } catch {
        /* already gone */
      }
    },
  };
}

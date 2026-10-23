import { describe, expect, it } from "vitest";
import { flushQueue, loadQueue, saveQueue, type NewReading, type Store } from "./fieldQueue";

const mem = (): Store => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};
const r = (id: string): NewReading => ({ id, nodeRef: "n1", lat: 36, lon: -85, accuracyM: 5, rssiDbm: -100, snrDb: 5, note: "", takenAt: 1 });

describe("field reading queue", () => {
  it("keeps readings until they are uploaded, then empties", async () => {
    const s = mem();
    saveQueue("p", [r("a1"), r("a2"), r("a3")], s);
    const sent: unknown[][] = [];
    const left = await flushQueue("p", async (_p, b) => void sent.push(b as unknown[]), s);
    expect(left).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(loadQueue("p", s)).toEqual([]);
  });

  it("keeps everything when the network is down", async () => {
    const s = mem();
    saveQueue("p", [r("a1"), r("a2")], s);
    const left = await flushQueue("p", async () => Promise.reject(new TypeError("offline")), s);
    expect(left).toHaveLength(2);
    expect(loadQueue("p", s)).toHaveLength(2);
  });

  it("sends in batches and keeps the unsent tail after a failure", async () => {
    const s = mem();
    saveQueue("p", Array.from({ length: 120 }, (_, i) => r(`id-${i}`)), s);
    let calls = 0;
    const left = await flushQueue("p", async () => {
      if (++calls === 2) throw new TypeError("lost signal");
    }, s);
    expect(calls).toBe(2);
    expect(left).toHaveLength(70);
    expect(loadQueue("p", s)[0].id).toBe("id-50");
  });

  it("drops only the reading the server rejects as invalid, so the queue cannot jam", async () => {
    const s = mem();
    saveQueue("p", [r("good1"), r("bad1"), r("good2")], s);
    const stored: string[] = [];
    const left = await flushQueue("p", async (_p, b) => {
      const batch = b as NewReading[];
      if (batch.some((x) => x.id === "bad1")) throw { status: 400 };
      stored.push(...batch.map((x) => x.id));
    }, s);
    expect(left).toEqual([]);
    expect(stored).toEqual(["good1", "good2"]);
  });

  it("survives corrupt storage", () => {
    const s = mem();
    s.setItem("meshmap.field.queue.p", "{not json");
    expect(loadQueue("p", s)).toEqual([]);
  });
});

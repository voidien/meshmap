/** Which mesh software the project is planned for, and the starting settings that go with it. */
export type Network = "meshcore" | "reticulum" | "meshtastic";

export interface NetworkInfo {
  id: Network;
  label: string;
  /** radio setting new nodes start with (a preset id) */
  presetId: string;
  /** centre frequency to plan at, MHz (US 902-928 MHz band) */
  freqMhz: number;
  /** how many hops to treat as the most a message should need (a planning figure, editable) */
  hopLimit: number;
  /** what the hop figure means for this software */
  hopNote: string;
  note: string;
}

export const NETWORKS: Record<Network, NetworkInfo> = {
  meshcore: {
    id: "meshcore",
    label: "MeshCore",
    presetId: "meshcore_us",
    freqMhz: 910.525,
    hopLimit: 8,
    hopNote: "MeshCore sends along stored paths and has no small fixed hop limit; 8 is a planning figure",
    note: "US/Canada recommended radio: 910.525 MHz, 62.5 kHz bandwidth, SF7. Frequency, bandwidth and SF must match on every node.",
  },
  reticulum: {
    id: "reticulum",
    label: "Reticulum (RNode)",
    presetId: "reticulum_sf8_125",
    freqMhz: 915,
    hopLimit: 8,
    hopNote: "Reticulum routes by announced paths (up to 128 hops); 8 is a planning figure",
    note: "RNode radio parameters are chosen by you (frequency, bandwidth, SF, coding rate) and must match across the LoRa interfaces; 125 kHz SF8 is a common example. Use a custom setting for yours.",
  },
  meshtastic: {
    id: "meshtastic",
    label: "Meshtastic",
    presetId: "long_fast",
    freqMhz: 915,
    hopLimit: 3,
    hopNote: "Meshtastic's default hop limit is 3 (at most 7)",
    note: "Meshtastic modem presets (Long Fast and so on).",
  },
};

export const NETWORK_LIST: NetworkInfo[] = [NETWORKS.meshcore, NETWORKS.reticulum, NETWORKS.meshtastic];

export function isNetwork(v: unknown): v is Network {
  return v === "meshcore" || v === "reticulum" || v === "meshtastic";
}

const MESHTASTIC_IDS = new Set(["long_slow", "long_moderate", "long_fast", "medium_slow", "medium_fast", "short_slow", "short_fast", "short_turbo", "long_turbo"]);
export const isMeshtasticPreset = (id: string) => MESHTASTIC_IDS.has(id);

/** The family ("meshcore", "reticulum", "meshtastic" or "custom") a radio setting id belongs to. */
export function familyOfPreset(id: string): string {
  if (id.startsWith("lora:")) return "custom";
  if (id.startsWith("meshcore_")) return "meshcore";
  if (id.startsWith("reticulum_")) return "reticulum";
  if (MESHTASTIC_IDS.has(id)) return "meshtastic";
  return "custom";
}

/** For a project saved before networks existed: Meshtastic presets mean it was planned for Meshtastic; an empty one starts as MeshCore. */
export function inferNetwork(presetIds: string[]): Network {
  if (presetIds.some((p) => MESHTASTIC_IDS.has(p))) return "meshtastic";
  if (presetIds.some((p) => p.startsWith("reticulum_"))) return "reticulum";
  return "meshcore";
}

/** Is this radio setting a good fit for the network (so that no warning is needed)? Custom settings always are. */
export function fitsNetwork(presetId: string, network: Network): boolean {
  const f = familyOfPreset(presetId);
  return f === "custom" || f === network;
}

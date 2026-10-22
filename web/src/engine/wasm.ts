import init, * as core from "../wasm/pkg/meshmap_wasm";
import wasmUrl from "../wasm/pkg/meshmap_wasm_bg.wasm?url";
import type { Preset } from "../types";

let ready: Promise<void> | null = null;

/** Load the WASM module once; resolves when the exports below are usable. */
export function loadCore(): Promise<void> {
  ready ??= init({ module_or_path: wasmUrl }).then(() => undefined);
  return ready;
}

export const wasm = core;

export function getPresets(): Preset[] {
  return core.presets() as Preset[];
}

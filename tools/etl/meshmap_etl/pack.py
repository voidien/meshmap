"""The meshmap terrain-pack format (version 1).

A pack is a folder::

    <id>/pack.json                 manifest
    <id>/tiles.json                one entry per tile: {"x", "y", "clutter": <source>, "lidar": <share 0..1>}
    <id>/<z>/<x>/<y>.bare.png      RGB, 256x256. v = round((elevation_m + 500) * 10) clipped to 0..65535;
                                   R = v >> 8, G = v & 255, B = 0 (reserved).
    <id>/<z>/<x>/<y>.clutter.png   grey 8-bit, 256x256. v = round(height_m * 2) clipped to 0..255 (0.5 m steps).
                                   The height of trees and buildings above the ground. Absent when the tile has no clutter data.

Both PNGs use ordinary 8-bit channels so a browser can decode them exactly with a canvas.
"""

import io
import json
import os
from datetime import datetime, timezone

import numpy as np
from PIL import Image

FORMAT = "meshmap-pack/1"
BARE_OFFSET_M = 500.0
BARE_STEP_M = 0.1
CLUTTER_STEP_M = 0.5


def encode_bare(elev_m: np.ndarray) -> bytes:
    """Float elevations (metres) -> RGB PNG bytes. NaN is stored as 0 m above the offset (the minimum)."""
    v = np.nan_to_num(elev_m, nan=-BARE_OFFSET_M)
    v = np.clip(np.rint((v + BARE_OFFSET_M) / BARE_STEP_M), 0, 65535).astype(np.uint16)
    rgb = np.zeros(v.shape + (3,), dtype=np.uint8)
    rgb[..., 0] = v >> 8
    rgb[..., 1] = v & 255
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def decode_bare(png: bytes) -> np.ndarray:
    a = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"), dtype=np.uint32)
    return ((a[..., 0] << 8 | a[..., 1]) * BARE_STEP_M - BARE_OFFSET_M).astype(np.float32)


def encode_clutter(height_m: np.ndarray) -> bytes:
    v = np.nan_to_num(height_m, nan=0.0)
    v = np.clip(np.rint(v / CLUTTER_STEP_M), 0, 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(v, "L").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def decode_clutter(png: bytes) -> np.ndarray:
    return (np.asarray(Image.open(io.BytesIO(png)).convert("L"), dtype=np.float32) * CLUTTER_STEP_M).astype(np.float32)


def tile_path(root: str, z: int, x: int, y: int, band: str) -> str:
    return os.path.join(root, str(z), str(x), f"{y}.{band}.png")


def write_tile(root: str, z: int, x: int, y: int, bare: np.ndarray, clutter: np.ndarray | None) -> int:
    """Write a tile's files atomically; returns bytes written."""
    total = 0
    for band, data in (("bare", encode_bare(bare)), ("clutter", encode_clutter(clutter) if clutter is not None else None)):
        path = tile_path(root, z, x, y, band)
        if data is None:
            if os.path.exists(path):
                os.remove(path)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + f".tmp{os.getpid()}"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        total += len(data)
    return total


def write_manifest(root: str, manifest: dict, tiles: list[dict]) -> None:
    os.makedirs(root, exist_ok=True)
    manifest = {
        "format": FORMAT,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tileSize": 256,
        "bare": {"encoding": "rg16-dm-offset500"},
        "clutter": {"encoding": "gray8-half-metre"},
        **manifest,
        "tileCount": len(tiles),
    }
    for name, obj in (("tiles.json", tiles), ("pack.json", manifest)):
        tmp = os.path.join(root, name + ".tmp")
        with open(tmp, "w") as f:
            json.dump(obj, f, separators=(",", ":") if name == "tiles.json" else None, indent=None if name == "tiles.json" else 2)
        os.replace(tmp, os.path.join(root, name))


def read_manifest(root: str) -> dict:
    with open(os.path.join(root, "pack.json")) as f:
        return json.load(f)

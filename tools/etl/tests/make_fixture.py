"""Writes the small synthetic pack used by the Rust server tests (crates/meshmap-server/tests/data/pack-fixture).

Run from tools/etl:  python tests/make_fixture.py ../../crates/meshmap-server/tests/data/pack-fixture

Ground and clutter are simple functions of the global pixel position (below), so the Rust tests can recompute the expected
values of any pixel and compare them with what they decode from the PNG files.
"""

import json
import math
import os
import sys

import numpy as np

from meshmap_etl import pack
from meshmap_etl.tiles import tile_for

Z = 13
# the node of the Rust tests sits at (36.0, -85.0); the pack is the 3x3 tiles around it
LON, LAT = -85.0, 36.0


def ground(gx, gy):
    return 300.0 + 20.0 * np.sin(gx / 300.0) + 15.0 * np.cos(gy / 250.0)


def trees(gx, gy, gx0):
    """A belt of 25 m trees 130..200 pixels east of the node column."""
    return np.where((gx - gx0 >= 130) & (gx - gx0 < 200), 25.0, 0.0)


def main(out: str) -> None:
    center = tile_for(LON, LAT, Z)
    gx0 = center.x * 256 + 128
    root = os.path.join(out, "fixture")
    entries = []
    for ty in range(center.y - 1, center.y + 2):
        for tx in range(center.x - 1, center.x + 2):
            gy, gx = np.mgrid[0:256, 0:256]
            gx = gx + tx * 256
            gy = gy + ty * 256
            bare = ground(gx, gy)
            has_clutter = not (tx == center.x + 1 and ty == center.y + 1)  # one corner tile has no clutter data
            clutter = trees(gx, gy, gx0) if has_clutter else None
            pack.write_tile(root, Z, tx, ty, bare, clutter)
            entries.append({"x": tx, "y": ty, "clutter": "canopy+buildings" if has_clutter else "none", "lidar": 0.0})
    pack.write_manifest(
        root,
        {
            "id": "fixture",
            "name": "Synthetic fixture",
            "zoom": Z,
            "bbox": [-85.1, 35.9, -84.9, 36.1],
            "bare": {"encoding": "rg16-dm-offset500", "source": "synthetic"},
            "clutter": {"encoding": "gray8-half-metre", "sources": ["synthetic"]},
            "bytes": 0,
        },
        entries,
    )
    # a fixed build time keeps the committed fixture stable
    m = json.load(open(os.path.join(root, "pack.json")))
    m["builtAt"] = "2026-01-01T00:00:00Z"
    json.dump(m, open(os.path.join(root, "pack.json"), "w"), indent=2)
    print(f"center tile {center.x},{center.y} gx0={gx0}; wrote {len(entries)} tiles to {root}")


if __name__ == "__main__":
    main(sys.argv[1])

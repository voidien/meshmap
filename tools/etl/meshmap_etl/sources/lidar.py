"""Clutter from lidar: USGS 3DEP point clouds (Entwine Point Tiles on AWS).

For every pixel: the top of the surface (the 95th percentile of non-ground, non-noise returns, which is the canopy or roof) minus
the ground (the median of ground returns) is the height of whatever stands there. This captures trees and buildings alike.
"""

import io
import json
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import numpy as np

from ..http import fetch
from ..tiles import Tile, lonlat_to_mercator, mercator_to_lonlat, pixel_size_m

BASE = "https://usgs-lidar-public.s3.amazonaws.com/"
SOURCE_NAME = "USGS 3DEP lidar (first returns minus ground)"
NOISE_CLASSES = (7, 18)  # low and high noise
GROUND = 2
WATER = 9
MIN_HEIGHT_M = 1.0  # lower than this is ground clutter or noise, not an obstruction
MAX_HEIGHT_M = 120.0


def group_percentile(cell: np.ndarray, values: np.ndarray, n_cells: int, q: float) -> np.ndarray:
    """Per-cell percentile of `values` (NaN for cells without points)."""
    out = np.full(n_cells, np.nan)
    if len(cell) == 0:
        return out
    order = np.lexsort((values, cell))
    c, v = cell[order], values[order]
    starts = np.flatnonzero(np.r_[True, c[1:] != c[:-1]])
    ends = np.r_[starts[1:], len(c)]
    idx = starts + np.floor((ends - starts - 1) * q).astype(int)
    out[c[starts]] = v[idx]
    return out


def clutter_from_points(tile: Tile, x, y, z, cls, bare_dem: np.ndarray, min_points: int = 4):
    """(clutter heights, valid mask) for a tile from classified lidar points in Mercator coordinates."""
    min_x, min_y, max_x, max_y = tile.bounds_m
    px = pixel_size_m(tile.z)
    inside = (x >= min_x) & (x < max_x) & (y > min_y) & (y <= max_y)
    x, y, z, cls = x[inside], y[inside], z[inside], cls[inside]
    col = np.clip(((x - min_x) / px).astype(int), 0, 255)
    row = np.clip(((max_y - y) / px).astype(int), 0, 255)
    cell = row * 256 + col
    n = 256 * 256

    usable = ~np.isin(cls, NOISE_CLASSES) & (cls != WATER)
    ground = usable & (cls == GROUND)
    surface = usable & (cls != GROUND)
    count = np.bincount(cell[usable], minlength=n)
    top = group_percentile(cell[surface], z[surface], n, 0.95) if surface.any() else np.full(n, np.nan)
    floor = group_percentile(cell[ground], z[ground], n, 0.5) if ground.any() else np.full(n, np.nan)

    bare = bare_dem.reshape(-1).astype(np.float64)
    ref = np.where(np.isnan(floor), bare, floor)
    height = np.where(np.isnan(top), 0.0, top - ref)
    height = np.where(np.isnan(height), 0.0, height)
    height = np.where(height < MIN_HEIGHT_M, 0.0, np.minimum(height, MAX_HEIGHT_M))
    valid = count >= min_points
    return height.reshape(256, 256).astype(np.float32), valid.reshape(256, 256)


class EptProject:
    """One USGS 3DEP lidar project in Entwine Point Tile format."""

    def __init__(self, name: str, max_depth: int = 7, base: str = BASE, threads: int = 16):
        self.name = name
        self.threads = threads
        self.url = f"{base}{name}/"
        # deeper than 8 is more than a 15 m pixel can use (each level is 8x the data)
        self.max_depth = min(max_depth, 8)
        meta = json.loads(fetch(self.url + "ept.json"))
        if meta.get("dataType") != "laszip":
            raise ValueError(f"{name}: unsupported point format {meta.get('dataType')}")
        if str(meta["srs"].get("horizontal")) != "3857":
            raise ValueError(f"{name}: only EPSG:3857 point clouds are supported (this one is {meta['srs'].get('horizontal')})")
        self.bounds = meta["bounds"]
        c = meta["boundsConforming"]
        (self.west, self.east), (self.south, self.north) = mercator_to_lonlat([c[0], c[3]], [c[1], c[4]])
        self._hier: dict = {}

    def covers(self, tile: Tile) -> bool:
        w, s, e, n = tile.bounds_lonlat
        return not (e < self.west or w > self.east or n < self.south or s > self.north)

    def _page(self, key: str) -> None:
        page = json.loads(fetch(self.url + f"ept-hierarchy/{key}.json"))
        # a sub-page replaces the "-1" placeholder (subtree stored elsewhere) that pointed to it with the real counts
        self._hier.update(page)

    def _node_bounds(self, d, x, y, z):
        b = self.bounds
        sx, sy = (b[3] - b[0]) / 2**d, (b[4] - b[1]) / 2**d
        return b[0] + x * sx, b[1] + y * sy, b[0] + (x + 1) * sx, b[1] + (y + 1) * sy

    def nodes(self, bounds_m):
        """Keys of the octree nodes (up to max_depth) that may hold points inside the box."""
        x0, y0, x1, y1 = bounds_m
        if "0-0-0-0" not in self._hier:
            self._page("0-0-0-0")
        out, stack = [], [(0, 0, 0, 0)]
        while stack:
            d, x, y, z = stack.pop()
            key = f"{d}-{x}-{y}-{z}"
            nx0, ny0, nx1, ny1 = self._node_bounds(d, x, y, z)
            if nx1 < x0 or nx0 > x1 or ny1 < y0 or ny0 > y1:
                continue
            n = self._hier.get(key)
            if n == -1:
                self._page(key)
                n = self._hier.get(key)
            if n is None or n == -1:
                continue
            if n > 0:
                out.append(key)
            if d < self.max_depth:
                stack.extend((d + 1, 2 * x + dx, 2 * y + dy, 2 * z + dz) for dx in (0, 1) for dy in (0, 1) for dz in (0, 1))
        return out

    def read_node(self, key: str):
        return _read_node(self.url, key)

    def tile_points(self, tile: Tile):
        """x, y, z, classification of the points inside the tile (Mercator metres)."""
        min_x, min_y, max_x, max_y = tile.bounds_m

        def one(key):
            x, y, z, c = self.read_node(key)
            # coarse nodes span the whole project: keep only what lies in this tile, so memory stays small
            keep = (x >= min_x) & (x < max_x) & (y > min_y) & (y <= max_y)
            return (x[keep], y[keep], z[keep], c[keep]) if keep.any() else None

        # a tile needs hundreds of small files: fetch and decode them in parallel
        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            parts = [r for r in pool.map(one, self.nodes(tile.bounds_m)) if r is not None]
        if not parts:
            e = np.zeros(0)
            return e, e, e, e.astype(np.uint8)
        return tuple(np.concatenate([p[i] for p in parts]) for i in range(4))


@lru_cache(maxsize=48)
def _read_node(url: str, key: str):
    import laspy

    las = laspy.read(io.BytesIO(fetch(url + f"ept-data/{key}.laz")))
    return np.asarray(las.x), np.asarray(las.y), np.asarray(las.z), np.asarray(las.classification)


def list_projects(prefix: str) -> list[str]:
    """Names of the USGS lidar projects whose names start with `prefix` (for example "TN_")."""
    import re
    import urllib.parse

    names, token = [], None
    while True:
        url = f"{BASE}?list-type=2&delimiter=/&prefix={urllib.parse.quote(prefix)}"
        if token:
            url += f"&continuation-token={urllib.parse.quote(token)}"
        text = fetch(url).decode()
        names += [p.rstrip("/") for p in re.findall(r"<Prefix>([^<]+)</Prefix>", text) if p.rstrip("/") != prefix.rstrip("/")]
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", text)
        if not m:
            return names
        token = m.group(1)

"""Web-Mercator (XYZ) tile maths. Pixel centres are used everywhere, matching the server and the web app."""

import math
from dataclasses import dataclass

import numpy as np

R = 6378137.0  # the sphere the rest of meshmap uses
TILE = 256
WORLD_M = 2 * math.pi * R


def lonlat_to_mercator(lon, lat):
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.asarray(lat, dtype=np.float64)
    return R * np.radians(lon), R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


def mercator_to_lonlat(x, y):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    return np.degrees(x / R), np.degrees(2 * np.arctan(np.exp(y / R)) - np.pi / 2)


def pixel_size_m(z: int) -> float:
    """Mercator metres per pixel (ground metres are this times cos(latitude))."""
    return WORLD_M / (TILE * 2**z)


@dataclass(frozen=True)
class Tile:
    z: int
    x: int
    y: int

    @property
    def bounds_m(self):
        """(min_x, min_y, max_x, max_y) in Mercator metres."""
        size = WORLD_M / 2**self.z
        min_x = -WORLD_M / 2 + self.x * size
        max_y = WORLD_M / 2 - self.y * size
        return (min_x, max_y - size, min_x + size, max_y)

    @property
    def bounds_lonlat(self):
        a, b, c, d = self.bounds_m
        (w, e), (s, n) = mercator_to_lonlat([a, c], [b, d])
        return (float(w), float(s), float(e), float(n))

    def pixel_centres_m(self):
        """Two (256, 256) arrays of Mercator x and y at the pixel centres (row 0 is the north row)."""
        min_x, _, _, max_y = self.bounds_m
        px = pixel_size_m(self.z)
        xs = min_x + (np.arange(TILE) + 0.5) * px
        ys = max_y - (np.arange(TILE) + 0.5) * px
        return np.meshgrid(xs, ys)

    def pixel_centres_lonlat(self):
        mx, my = self.pixel_centres_m()
        return mercator_to_lonlat(mx, my)

    def affine(self):
        """rasterio Affine of this tile in EPSG:3857."""
        from rasterio.transform import Affine

        min_x, _, _, max_y = self.bounds_m
        px = pixel_size_m(self.z)
        return Affine(px, 0, min_x, 0, -px, max_y)


def tile_for(lon: float, lat: float, z: int) -> Tile:
    mx, my = lonlat_to_mercator(lon, lat)
    size = WORLD_M / 2**z
    x = int((float(mx) + WORLD_M / 2) // size)
    y = int((WORLD_M / 2 - float(my)) // size)
    n = 2**z
    return Tile(z, min(max(x, 0), n - 1), min(max(y, 0), n - 1))


def tiles_in_bbox(bbox, z: int):
    """All tiles touching (west, south, east, north), row by row from the north."""
    w, s, e, n = bbox
    t0 = tile_for(w, n, z)
    t1 = tile_for(e, s, z)
    return [Tile(z, x, y) for y in range(t0.y, t1.y + 1) for x in range(t0.x, t1.x + 1)]

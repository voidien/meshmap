"""Bare earth: USGS 3DEP 1/3 arc-second (about 10 m) seamless DEM, in 1-degree Cloud Optimized GeoTIFFs on AWS."""

import math
import os

import numpy as np

from ..tiles import Tile

DEFAULT_URL = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/{name}/USGS_13_{name}.tif"
SOURCE_NAME = "USGS 3DEP 1/3 arc-second DEM (NAVD88 metres)"


def file_name(lon: float, lat: float) -> str:
    """3DEP names a 1-degree file after its north-west corner: lat 36.1, lon -86.8 -> n37w087."""
    n = math.floor(lat) + 1
    w = -math.floor(lon)
    return f"n{n:02d}w{w:03d}"


def bilinear(window: np.ndarray, rows: np.ndarray, cols: np.ndarray, nodata: float | None) -> np.ndarray:
    """Sample `window` at fractional pixel-centre coordinates (row/col 0 = first pixel's centre). NaN where any corner is no-data."""
    h, w = window.shape
    r0 = np.clip(np.floor(rows).astype(int), 0, h - 2)
    c0 = np.clip(np.floor(cols).astype(int), 0, w - 2)
    fr = np.clip(rows - r0, 0.0, 1.0)
    fc = np.clip(cols - c0, 0.0, 1.0)
    a = window[r0, c0].astype(np.float64)
    b = window[r0, c0 + 1].astype(np.float64)
    c = window[r0 + 1, c0].astype(np.float64)
    d = window[r0 + 1, c0 + 1].astype(np.float64)
    out = (a * (1 - fc) + b * fc) * (1 - fr) + (c * (1 - fc) + d * fc) * fr
    if nodata is not None:
        bad = (a == nodata) | (b == nodata) | (c == nodata) | (d == nodata)
        out = np.where(bad, np.nan, out)
    return out


class Dem3dep:
    def __init__(self, url_template: str | None = None):
        self.template = url_template or os.environ.get("MESHMAP_DEM_URL") or DEFAULT_URL
        self._open: dict = {}

    def _dataset(self, name: str):
        import rasterio

        if name not in self._open:
            try:
                self._open[name] = rasterio.open(self.template.format(name=name))
            except Exception:  # outside the coverage (ocean, other countries)
                self._open[name] = None
        return self._open[name]

    def sample(self, tile: Tile) -> np.ndarray:
        """Ground elevation in metres at the tile's pixel centres; NaN where there is no data."""
        lon, lat = tile.pixel_centres_lonlat()
        out = np.full(lon.shape, np.nan, dtype=np.float64)
        names = np.vectorize(file_name)(lon, lat)
        for name in np.unique(names):
            ds = self._dataset(str(name))
            if ds is None:
                continue
            m = names == name
            t = ds.transform
            cols = (lon[m] - t.c) / t.a - 0.5
            rows = (lat[m] - t.f) / t.e - 0.5
            r0, r1 = max(int(np.floor(rows.min())) - 1, 0), min(int(np.ceil(rows.max())) + 2, ds.height)
            c0, c1 = max(int(np.floor(cols.min())) - 1, 0), min(int(np.ceil(cols.max())) + 2, ds.width)
            if r1 - r0 < 2 or c1 - c0 < 2:
                continue
            window = ds.read(1, window=((r0, r1), (c0, c1)))
            out[m] = bilinear(window, rows - r0, cols - c0, ds.nodata)
        return out.astype(np.float32)

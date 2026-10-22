"""Tree canopy height: Meta / World Resources Institute global canopy height map, 1.2 m, whole metres (CC BY 4.0).

Used for places without lidar. Unlike a canopy-cover percentage it is a height, which is what a radio path needs.
"""

import numpy as np

from ..tiles import Tile

DEFAULT_URL = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/{quadkey}.tif"
SOURCE_NAME = "Meta/WRI global canopy height (1.2 m)"
MAX_HEIGHT_M = 70.0  # taller values are retrieval artefacts


def quadkey(z: int, x: int, y: int) -> str:
    q = ""
    for i in range(z, 0, -1):
        d = 0
        m = 1 << (i - 1)
        if x & m:
            d += 1
        if y & m:
            d += 2
        q += str(d)
    return q


class CanopyHeight:
    def __init__(self, url_template: str | None = None, stat: str = "max"):
        self.template = url_template or DEFAULT_URL
        self.stat = stat
        self._open: dict = {}

    def _dataset(self, qk: str):
        import rasterio

        if qk not in self._open:
            try:
                self._open[qk] = rasterio.open(self.template.format(quadkey=qk))
            except Exception:
                self._open[qk] = None
        return self._open[qk]

    def cell_heights(self, tile: Tile) -> np.ndarray | None:
        """Canopy height in metres per tile pixel (0 = no trees), or None when there is no data for this area."""
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.warp import reproject

        if tile.z < 9:
            raise ValueError("canopy tiles are looked up at zoom 9; use a tile zoom of 9 or more")
        ds = self._dataset(quadkey(9, tile.x >> (tile.z - 9), tile.y >> (tile.z - 9)))
        if ds is None:
            return None
        dst = np.zeros((256, 256), dtype=np.float32)
        reproject(
            source=rasterio.band(ds, 1),
            destination=dst,
            dst_transform=tile.affine(),
            dst_crs="EPSG:3857",
            resampling=getattr(Resampling, self.stat),
            dst_nodata=0,
        )
        dst[dst > MAX_HEIGHT_M] = 0.0
        return dst

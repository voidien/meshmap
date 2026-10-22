"""Buildings: Overture Maps building footprints (GeoParquet on AWS) with heights where known."""

import numpy as np

from ..tiles import Tile, lonlat_to_mercator

BUCKET = "overturemaps-us-west-2"
SOURCE_NAME = "Overture Maps buildings"
FLOOR_HEIGHT_M = 3.2
DEFAULT_HEIGHT_M = 6.0  # a typical one-to-two storey building when neither height nor floors is known


def estimate_height(height, floors) -> float:
    """Measured height if present, else storeys x 3.2 m, else a default."""
    if height is not None and height > 0:
        return float(height)
    if floors is not None and floors > 0:
        return float(floors) * FLOOR_HEIGHT_M
    return DEFAULT_HEIGHT_M


def latest_release() -> str:
    import pyarrow.fs as pafs

    fs = pafs.S3FileSystem(anonymous=True, region="us-west-2")
    infos = fs.get_file_info(pafs.FileSelector(f"{BUCKET}/release/", recursive=False))
    names = sorted(i.base_name for i in infos if i.type == pafs.FileType.Directory)
    if not names:
        raise RuntimeError("could not list Overture releases")
    return names[-1]


class OvertureBuildings:
    def __init__(self, release: str | None = None):
        self.release = release
        self._dataset = None

    def _ds(self):
        import pyarrow.dataset as ds
        import pyarrow.fs as pafs

        if self._dataset is None:
            self.release = self.release or latest_release()
            fs = pafs.S3FileSystem(anonymous=True, region="us-west-2")
            self._dataset = ds.dataset(f"{BUCKET}/release/{self.release}/theme=buildings/type=building/", filesystem=fs, format="parquet")
        return self._dataset

    def load(self, bbox):
        """Footprints touching (west, south, east, north) as (shapely geometries in Mercator metres, heights)."""
        import pyarrow.dataset as ds
        import shapely

        w, s, e, n = bbox
        flt = (ds.field("bbox", "xmin") <= e) & (ds.field("bbox", "xmax") >= w) & (ds.field("bbox", "ymin") <= n) & (ds.field("bbox", "ymax") >= s)
        tab = self._ds().to_table(columns=["geometry", "height", "num_floors", "is_underground"], filter=flt)
        if tab.num_rows == 0:
            return [], np.zeros(0)
        geoms = shapely.from_wkb(tab.column("geometry").to_pylist())
        heights = np.array([estimate_height(h, f) for h, f in zip(tab.column("height").to_pylist(), tab.column("num_floors").to_pylist())])
        keep = ~np.array([bool(u) for u in tab.column("is_underground").to_pylist()])
        geoms = np.asarray(geoms)[keep]
        heights = heights[keep]
        projected = shapely.transform(geoms, lambda xy: np.column_stack(lonlat_to_mercator(xy[:, 0], xy[:, 1])))
        return list(projected), heights

    @staticmethod
    def rasterize(tile: Tile, geoms, heights) -> np.ndarray:
        """Height of the tallest building touching each pixel (0 where none)."""
        from rasterio.features import rasterize

        if len(geoms) == 0:
            return np.zeros((256, 256), dtype=np.float32)
        order = np.argsort(heights)  # draw low buildings first so the tallest wins
        shapes = [(geoms[i], float(heights[i])) for i in order]
        return rasterize(shapes, out_shape=(256, 256), transform=tile.affine(), fill=0.0, all_touched=True, dtype="float32")

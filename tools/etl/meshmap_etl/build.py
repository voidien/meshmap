"""Building a pack: bare earth and clutter for every tile of an area."""

import json
import os
import sys
import time
import warnings
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from multiprocessing import get_context

import numpy as np

from . import __version__, pack
from .tiles import Tile, tiles_in_bbox


@dataclass
class Options:
    zoom: int = 13
    #: auto = lidar where it exists, canopy + buildings elsewhere; lidar / canopy = only that; none = bare earth only
    clutter: str = "auto"
    lidar_projects: list[str] = field(default_factory=list)
    lidar_depth: int = 7
    canopy_stat: str = "max"
    buildings: bool = True
    overture_release: str | None = None
    dem_url: str | None = None
    canopy_url: str | None = None
    block: int = 4  # tiles per side of a unit of work (buildings are fetched once per block)


def fill_missing(a: np.ndarray) -> np.ndarray:
    """Replace NaN with the average of neighbours, repeated; any that remain (no data anywhere) become 0 (sea level)."""
    a = a.astype(np.float64).copy()
    for _ in range(64):
        bad = np.isnan(a)
        if not bad.any():
            return a
        pad = np.pad(a, 1, constant_values=np.nan)
        stack = np.stack([pad[:-2, 1:-1], pad[2:, 1:-1], pad[1:-1, :-2], pad[1:-1, 2:]])
        with np.errstate(all="ignore"), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # "mean of empty slice" where all four neighbours are missing
            mean = np.nanmean(stack, axis=0)
        fill = bad & ~np.isnan(mean)
        if not fill.any():
            break
        a[fill] = mean[fill]
    return np.nan_to_num(a, nan=0.0)


class Sources:
    """The sources one worker process uses (opened lazily, kept for the whole run)."""

    def __init__(self, o: Options):
        from .sources.buildings import OvertureBuildings
        from .sources.canopy import CanopyHeight
        from .sources.dem3dep import Dem3dep

        self.o = o
        self.dem = Dem3dep(o.dem_url)
        self.canopy = CanopyHeight(o.canopy_url, o.canopy_stat) if o.clutter in ("auto", "canopy") else None
        self.buildings = OvertureBuildings(o.overture_release) if (o.buildings and o.clutter in ("auto", "canopy")) else None
        self.lidar = []
        if o.clutter in ("auto", "lidar"):
            from .sources.lidar import EptProject

            self.lidar = [EptProject(name, o.lidar_depth) for name in o.lidar_projects]


_SOURCES: dict = {}


def sources_for(o: Options) -> Sources:
    key = json.dumps(asdict(o), sort_keys=True)
    if key not in _SOURCES:
        _SOURCES[key] = Sources(o)
    return _SOURCES[key]


def build_tile(tile: Tile, src: Sources, bld=None):
    """Returns (bare, clutter or None, info dict) for one tile."""
    from .sources import lidar as lidar_mod

    bare_raw = src.dem.sample(tile)
    nan_share = float(np.isnan(bare_raw).mean())
    bare = fill_missing(bare_raw)

    parts, clutter, lidar_share = [], None, 0.0
    fallback = None
    if src.canopy is not None:
        canopy = src.canopy.cell_heights(tile)
        if canopy is not None:
            fallback = canopy.astype(np.float64)
            parts.append("canopy")
    if bld is not None:
        from .sources.buildings import OvertureBuildings

        b = OvertureBuildings.rasterize(tile, *bld)
        fallback = b.astype(np.float64) if fallback is None else np.maximum(fallback, b)
        parts.append("buildings")

    lidar_h = np.zeros((256, 256))
    lidar_ok = np.zeros((256, 256), dtype=bool)
    for proj in src.lidar:
        if not proj.covers(tile):
            continue
        x, y, z, cls = proj.tile_points(tile)
        h, ok = lidar_mod.clutter_from_points(tile, x, y, z, cls, bare)
        take = ok & ~lidar_ok
        lidar_h = np.where(take, h, lidar_h)
        lidar_ok |= ok
    if lidar_ok.any():
        lidar_share = float(lidar_ok.mean())
        base = fallback if fallback is not None else np.zeros((256, 256))
        clutter = np.where(lidar_ok, lidar_h, base)
        parts.insert(0, "lidar")
    elif fallback is not None:
        clutter = fallback

    info = {"x": tile.x, "y": tile.y, "clutter": "+".join(parts) if clutter is not None else "none", "lidar": round(lidar_share, 3), "noData": round(nan_share, 3)}
    return bare, (clutter.astype(np.float32) if clutter is not None else None), info


def run_block(args):
    """Worker: build the tiles of one block and write them. Returns their info dicts."""
    out_dir, tiles, opts_dict = args
    o = Options(**opts_dict)
    src = sources_for(o)
    bld = None
    if src.buildings is not None and tiles:
        ws, ss, es, ns = zip(*[t.bounds_lonlat for t in tiles])
        bld = src.buildings.load((min(ws), min(ss), max(es), max(ns)))
    infos = []
    for t in tiles:
        bare, clutter, info = build_tile(t, src, bld)
        info["bytes"] = pack.write_tile(out_dir, t.z, t.x, t.y, bare, clutter)
        infos.append(info)
    return infos


def blocks_of(tiles: list[Tile], size: int):
    groups = defaultdict(list)
    for t in tiles:
        groups[(t.x // size, t.y // size)].append(t)
    return [groups[k] for k in sorted(groups, key=lambda k: (k[1], k[0]))]


def build_pack(out_dir: str, pack_id: str, name: str, bbox, o: Options, workers: int = 2, resume: bool = True, limit: int | None = None, log=print):
    from .sources import buildings as bmod, canopy as cmod, dem3dep as dmod, lidar as lmod

    tiles = tiles_in_bbox(bbox, o.zoom)
    if limit:
        tiles = tiles[:limit]
    root = os.path.join(out_dir, pack_id)
    os.makedirs(root, exist_ok=True)
    partial = os.path.join(root, "tiles.partial.jsonl")
    done: dict[tuple[int, int], dict] = {}
    if resume and os.path.exists(partial):
        for line in open(partial):
            d = json.loads(line)
            if os.path.exists(pack.tile_path(root, o.zoom, d["x"], d["y"], "bare")):
                done[(d["x"], d["y"])] = d
    todo = [t for t in tiles if (t.x, t.y) not in done]
    log(f"{len(tiles)} tiles at zoom {o.zoom}: {len(done)} already built, {len(todo)} to do")

    started = time.time()
    work = [(root, blk, asdict(o)) for blk in blocks_of(todo, o.block)]
    finished = 0
    if workers <= 1 or len(work) <= 1:
        results = (run_block(w) for w in work)
    else:
        pool = ProcessPoolExecutor(max_workers=workers, mp_context=get_context("spawn"))
        results = (f.result() for f in as_completed([pool.submit(run_block, w) for w in work]))
    with open(partial, "a") as pf:
        for infos in results:
            for d in infos:
                done[(d["x"], d["y"])] = d
                pf.write(json.dumps(d) + "\n")
            pf.flush()
            finished += len(infos)
            log(f"  {finished}/{len(todo)} tiles ({time.time() - started:.0f} s)")

    entries = [done[(t.x, t.y)] for t in tiles if (t.x, t.y) in done]
    sources = [dmod.SOURCE_NAME]
    if any("lidar" in e["clutter"] for e in entries):
        sources.append(lmod.SOURCE_NAME + ": " + ", ".join(o.lidar_projects))
    if any("canopy" in e["clutter"] for e in entries):
        sources.append(cmod.SOURCE_NAME)
    if any("buildings" in e["clutter"] for e in entries):
        sources.append(bmod.SOURCE_NAME + (f" {o.overture_release}" if o.overture_release else ""))
    pack.write_manifest(
        root,
        {
            "id": pack_id,
            "name": name,
            "zoom": o.zoom,
            "bbox": list(bbox),
            "tool": f"meshmap-etl {__version__}",
            "bare": {"encoding": "rg16-dm-offset500", "source": dmod.SOURCE_NAME},
            "clutter": {"encoding": "gray8-half-metre", "sources": sources[1:], "options": {k: v for k, v in asdict(o).items() if k in ("clutter", "canopy_stat", "buildings", "lidar_projects")}},
            "bytes": sum(e.get("bytes", 0) for e in entries),
            "attribution": ["USGS 3DEP", "Meta/WRI canopy height (CC BY 4.0)", "Overture Maps Foundation (ODbL)"],
        },
        entries,
    )
    if os.path.exists(partial):
        os.remove(partial)
    log(f"pack written to {root}: {len(entries)} tiles, {sum(e.get('bytes', 0) for e in entries) / 1e6:.1f} MB")
    return root

import argparse
import json
import os
import sys

import numpy as np

from . import pack
from .build import Options, build_pack
from .states import STATES


def parse_bbox(text: str):
    w, s, e, n = (float(v) for v in text.split(","))
    if not (-180 <= w < e <= 180 and -85 <= s < n <= 85):
        raise argparse.ArgumentTypeError("bbox must be west,south,east,north in degrees with west < east and south < north")
    return (w, s, e, n)


def cmd_build(a) -> int:
    bbox = a.bbox or STATES.get(a.state.upper() if a.state else "")
    if bbox is None:
        print("give --bbox W,S,E,N or a two-letter --state", file=sys.stderr)
        return 2
    projects = [p for p in (a.lidar or "").split(",") if p]
    if a.lidar_prefix:
        from .sources.lidar import list_projects

        found = list_projects(a.lidar_prefix)
        print(f"{len(found)} lidar projects with prefix {a.lidar_prefix}: {', '.join(found[:12])}{' ...' if len(found) > 12 else ''}")
        projects += [p for p in found if p not in projects]
    o = Options(
        zoom=a.zoom,
        clutter=a.clutter,
        lidar_projects=projects,
        lidar_depth=a.lidar_depth,
        canopy_stat=a.canopy_stat,
        buildings=not a.no_buildings,
        buildings_over_lidar=a.buildings_over_lidar,
        overture_release=a.overture_release,
        dem_url=a.dem_url,
        block=a.block,
    )
    if o.clutter in ("auto", "lidar") and projects:
        # keep only projects that overlap the area: opening one is a single small request
        from .sources.lidar import EptProject

        keep = []
        for p in projects:
            try:
                ep = EptProject(p, o.lidar_depth)
            except Exception as e:
                print(f"  skipping lidar project {p}: {e}")
                continue
            w, s, e, n = bbox
            if not (ep.east < w or ep.west > e or ep.north < s or ep.south > n):
                keep.append(p)
        o.lidar_projects = keep
        print(f"lidar projects overlapping the area: {keep or 'none'}")
    build_pack(a.out, a.id, a.name or a.id, bbox, o, workers=a.workers, resume=not a.no_resume, limit=a.limit)
    return 0


def cmd_info(a) -> int:
    m = pack.read_manifest(a.pack)
    tiles = json.load(open(os.path.join(a.pack, "tiles.json")))
    print(json.dumps({k: m[k] for k in ("id", "name", "zoom", "bbox", "builtAt", "tileCount", "bytes") if k in m}, indent=2))
    kinds: dict[str, int] = {}
    for t in tiles:
        kinds[t["clutter"]] = kinds.get(t["clutter"], 0) + 1
    print("clutter data per tile:", kinds)
    return 0


def cmd_verify(a) -> int:
    m = pack.read_manifest(a.pack)
    tiles = json.load(open(os.path.join(a.pack, "tiles.json")))
    problems = []
    z = m["zoom"]
    for t in tiles:
        bare_p = pack.tile_path(a.pack, z, t["x"], t["y"], "bare")
        try:
            bare = pack.decode_bare(open(bare_p, "rb").read())
        except Exception as e:
            problems.append(f"{bare_p}: {e}")
            continue
        if bare.shape != (256, 256) or not np.isfinite(bare).all() or bare.min() < -500 or bare.max() > 6000:
            problems.append(f"{bare_p}: implausible elevations {bare.min():.0f}..{bare.max():.0f}")
        cp = pack.tile_path(a.pack, z, t["x"], t["y"], "clutter")
        has = os.path.exists(cp)
        if has != (t["clutter"] != "none"):
            problems.append(f"{cp}: clutter file and tiles.json disagree")
        elif has:
            c = pack.decode_clutter(open(cp, "rb").read())
            if c.shape != (256, 256) or c.max() > 127.5:
                problems.append(f"{cp}: bad clutter values")
    if len(tiles) != m["tileCount"]:
        problems.append(f"tiles.json has {len(tiles)} entries but pack.json says {m['tileCount']}")
    print(f"{len(tiles)} tiles checked, {len(problems)} problems")
    for p in problems[:20]:
        print("  " + p)
    return 1 if problems else 0


def cmd_lidar(a) -> int:
    from .sources.lidar import EptProject, list_projects

    for name in list_projects(a.prefix):
        try:
            p = EptProject(name)
            print(f"{name}: lon {p.west:.2f}..{p.east:.2f}, lat {p.south:.2f}..{p.north:.2f}")
        except Exception as e:
            print(f"{name}: {e}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="meshmap-etl", description="Build meshmap terrain packs.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="build a pack for a state or a bounding box")
    b.add_argument("--id", required=True, help="pack folder name, e.g. tn")
    b.add_argument("--name", help="display name")
    g = b.add_mutually_exclusive_group()
    g.add_argument("--state", help="two-letter state code, e.g. TN")
    g.add_argument("--bbox", type=parse_bbox, help="west,south,east,north in degrees")
    b.add_argument("--out", default="data/packs", help="folder the pack folder goes in")
    b.add_argument("--zoom", type=int, default=13, help="tile zoom (13 is about 15 m per pixel)")
    b.add_argument("--clutter", choices=["auto", "lidar", "canopy", "none"], default="auto")
    b.add_argument("--lidar", help="comma-separated USGS lidar project names (see `lidar-projects`)")
    b.add_argument("--lidar-prefix", help="use every lidar project whose name starts with this, e.g. TN_")
    b.add_argument("--lidar-depth", type=int, default=7, help="octree depth to read (7 is about 3.7 m between points: plenty for 15 m pixels; each level is 8x more data)")
    b.add_argument("--canopy-stat", default="max", choices=["max", "q3", "med", "average"], help="how 1 m canopy heights are summarised per pixel (max matched lidar best in the Nashville test)")
    b.add_argument("--no-buildings", action="store_true")
    b.add_argument("--buildings-over-lidar", action="store_true", help="also add Overture building footprints where the lidar saw open ground, so buildings put up since the survey appear (lidar buildings are kept as measured)")
    b.add_argument("--overture-release", help="Overture release (default: the latest)")
    b.add_argument("--dem-url", help="URL or path template with {name}, to use your own 3DEP files")
    b.add_argument("--workers", type=int, default=2)
    b.add_argument("--block", type=int, default=4, help="tiles per side of one unit of work")
    b.add_argument("--limit", type=int, help="only the first N tiles (for trying things out)")
    b.add_argument("--no-resume", action="store_true")
    b.set_defaults(fn=cmd_build)

    i = sub.add_parser("info", help="describe a pack folder")
    i.add_argument("pack")
    i.set_defaults(fn=cmd_info)
    v = sub.add_parser("verify", help="check every tile of a pack")
    v.add_argument("pack")
    v.set_defaults(fn=cmd_verify)
    l = sub.add_parser("lidar-projects", help="list USGS lidar projects with a name prefix")
    l.add_argument("prefix")
    l.set_defaults(fn=cmd_lidar)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())

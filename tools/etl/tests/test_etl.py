"""Unit tests for the ETL that need no network: tile maths, encodings, source maths, and a full build with fake sources."""

import json
import math
import os

import numpy as np
import pytest

from meshmap_etl import build, cli, pack
from meshmap_etl.sources import buildings, canopy, dem3dep, lidar
from meshmap_etl.states import STATES
from meshmap_etl.tiles import Tile, lonlat_to_mercator, mercator_to_lonlat, pixel_size_m, tile_for, tiles_in_bbox


# ---- tiles ----------------------------------------------------------------------------------------------------------

def test_tile_lookup_matches_known_slippy_tiles():
    # Nashville city hall: x = (lon + 180) / 360 * 2^13 = 2121.2, y = 3212.9
    assert tile_for(-86.7816, 36.1627, 13) == Tile(13, 2121, 3212)
    assert tile_for(0.0, 0.0, 1) == Tile(1, 1, 1)
    assert tile_for(-180.0, 84.0, 3).x == 0


def test_tile_bounds_roundtrip_and_pixel_size():
    t = Tile(13, 2121, 3212)
    w, s, e, n = t.bounds_lonlat
    assert w < -86.78 < e and s < 36.16 < n
    assert tile_for((w + e) / 2, (s + n) / 2, 13) == t
    # a z13 pixel is 19.1 m of Mercator, about 15.5 m on the ground at this latitude
    assert pixel_size_m(13) == pytest.approx(19.109, abs=0.001)
    mx, my = t.pixel_centres_m()
    assert mx.shape == (256, 256) and mx[0, 1] - mx[0, 0] == pytest.approx(pixel_size_m(13))
    assert my[0, 0] > my[1, 0]  # row 0 is the north row
    lon, lat = mercator_to_lonlat(*lonlat_to_mercator(-86.78, 36.16))
    assert (float(lon), float(lat)) == pytest.approx((-86.78, 36.16))


def test_tiles_in_bbox_counts_and_order():
    tiles = tiles_in_bbox((-86.800, 36.150, -86.765, 36.185), 13)
    assert len(tiles) == 4
    assert [(t.x, t.y) for t in tiles] == [(2120, 3211), (2121, 3211), (2120, 3212), (2121, 3212)]
    assert all(t.z == 13 for t in tiles)


def test_state_boxes_are_sane():
    assert len(STATES) == 51
    for code, (w, s, e, n) in STATES.items():
        assert -180 <= w < e <= -60 or code in ("AK", "HI"), code
        assert 18 <= s < n <= 72, code
    assert STATES["TN"][0] < -86.7 < STATES["TN"][2] and STATES["TN"][1] < 36.16 < STATES["TN"][3]


# ---- pack encodings ---------------------------------------------------------------------------------------------------

def test_bare_encoding_roundtrips_to_a_decimetre():
    rng = np.random.default_rng(1)
    a = rng.uniform(-100, 4400, (256, 256)).astype(np.float32)
    got = pack.decode_bare(pack.encode_bare(a))
    assert np.abs(got - a).max() <= 0.051
    assert pack.decode_bare(pack.encode_bare(np.full((256, 256), np.nan, np.float32))).max() == pytest.approx(-500.0)


def test_bare_encoding_matches_the_documented_bytes():
    from PIL import Image
    import io

    png = pack.encode_bare(np.full((256, 256), 123.4, np.float32))
    px = np.asarray(Image.open(io.BytesIO(png)))
    v = round((123.4 + 500) * 10)
    assert (px[0, 0, 0], px[0, 0, 1], px[0, 0, 2]) == (v >> 8, v & 255, 0)


def test_clutter_encoding_is_half_metres_and_clips():
    a = np.zeros((256, 256), np.float32)
    a[0, 0], a[0, 1], a[0, 2], a[0, 3] = 25.0, 0.3, 200.0, np.nan
    got = pack.decode_clutter(pack.encode_clutter(a))
    assert got[0, 0] == 25.0 and got[0, 1] == 0.5 and got[0, 2] == 127.5 and got[0, 3] == 0.0


def test_write_tile_and_manifest(tmp_path):
    root = str(tmp_path / "p")
    n = pack.write_tile(root, 13, 5, 6, np.zeros((256, 256)), np.ones((256, 256)))
    assert n > 0 and os.path.exists(pack.tile_path(root, 13, 5, 6, "clutter"))
    # rewriting without clutter removes the old clutter file
    pack.write_tile(root, 13, 5, 6, np.zeros((256, 256)), None)
    assert not os.path.exists(pack.tile_path(root, 13, 5, 6, "clutter"))
    pack.write_manifest(root, {"id": "p", "name": "P", "zoom": 13, "bbox": [0, 0, 1, 1]}, [{"x": 5, "y": 6, "clutter": "none", "lidar": 0}])
    m = pack.read_manifest(root)
    assert m["format"] == pack.FORMAT and m["tileCount"] == 1 and m["id"] == "p"


# ---- sources --------------------------------------------------------------------------------------------------------------

def test_dem_file_names_follow_the_north_west_corner_convention():
    assert dem3dep.file_name(-86.78, 36.165) == "n37w087"
    assert dem3dep.file_name(-86.0, 36.0) == "n37w086"
    assert dem3dep.file_name(-122.3, 47.6) == "n48w123"


def test_bilinear_is_exact_on_a_plane_and_propagates_nodata():
    r, c = np.mgrid[0:10, 0:10]
    plane = (2.0 * r + 3.0 * c).astype(np.float32)
    rows, cols = np.array([2.5, 7.25]), np.array([3.5, 1.75])
    assert dem3dep.bilinear(plane, rows, cols, None) == pytest.approx(2 * rows + 3 * cols)
    plane[2, 3] = -999999
    out = dem3dep.bilinear(plane, np.array([2.5, 7.25]), np.array([3.5, 1.75]), -999999)
    assert np.isnan(out[0]) and not np.isnan(out[1])


def test_quadkeys():
    assert canopy.quadkey(9, 0, 0) == "000000000"
    assert canopy.quadkey(1, 1, 1) == "3"
    assert canopy.quadkey(2, 3, 1) == "13"
    # the Nashville tile at z13 sits in this z9 tile (what the probe against the real bucket found)
    assert canopy.quadkey(9, 2120 >> 4, 3211 >> 4) == "032002100"


def test_building_heights_prefer_measured_then_floors_then_default():
    assert buildings.estimate_height(12.5, 3) == 12.5
    assert buildings.estimate_height(None, 4) == pytest.approx(12.8)
    assert buildings.estimate_height(0, None) == buildings.DEFAULT_HEIGHT_M


def test_buildings_rasterize_with_the_tallest_on_top():
    import shapely

    tile = Tile(13, 2120, 3211)
    minx, miny, maxx, maxy = tile.bounds_m
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    low = shapely.box(cx - 100, cy - 100, cx + 100, cy + 100)
    high = shapely.box(cx - 30, cy - 30, cx + 30, cy + 30)
    out = buildings.OvertureBuildings.rasterize(tile, [high, low], np.array([40.0, 8.0]))
    assert out[128, 128] == 40.0 and out[128, 131] == 8.0 and out[0, 0] == 0.0
    assert buildings.OvertureBuildings.rasterize(tile, [], np.zeros(0)).max() == 0.0


def test_group_percentile():
    cell = np.array([0, 0, 0, 0, 2, 2])
    vals = np.array([1.0, 2.0, 3.0, 100.0, 5.0, 7.0])
    out = lidar.group_percentile(cell, vals, 4, 0.5)
    assert out[0] == 2.0 and out[2] == 5.0 and np.isnan(out[1]) and np.isnan(out[3])
    assert lidar.group_percentile(cell, vals, 4, 1.0)[0] == 100.0
    assert np.isnan(lidar.group_percentile(np.zeros(0, int), np.zeros(0), 3, 0.5)).all()


def test_lidar_clutter_from_classified_points():
    tile = Tile(13, 2120, 3211)
    minx, miny, maxx, maxy = tile.bounds_m
    px = pixel_size_m(13)
    rng = np.random.default_rng(3)
    # pixel (row 10, col 20): ground at 100 m under a 15 m tree canopy; pixel (row 10, col 21): bare ground only
    def points(col, with_tree):
        x = minx + (col + rng.uniform(0.05, 0.95, 40)) * px
        y = maxy - (10 + rng.uniform(0.05, 0.95, 40)) * px
        z = np.full(40, 100.0)
        cls = np.full(40, lidar.GROUND)
        if with_tree:
            z[:20] = 115.0 + rng.uniform(-0.3, 0.3, 20)
            cls[:20] = 5
        return x, y, z, cls
    xs, ys, zs, cs = zip(*[points(20, True), points(21, False)])
    x, y, z, cls = (np.concatenate(a) for a in (xs, ys, zs, cs))
    # noise and water must be ignored; a stray high-noise point must not raise the surface
    x = np.append(x, x[0]); y = np.append(y, y[0]); z = np.append(z, 900.0); cls = np.append(cls, 18)
    h, ok = lidar.clutter_from_points(tile, x, y, z, cls, np.full((256, 256), 100.0))
    assert h[10, 20] == pytest.approx(15.0, abs=0.5)
    assert h[10, 21] == 0.0 and ok[10, 20] and ok[10, 21]
    assert not ok[0, 0] and h[0, 0] == 0.0  # no points there: no claim either way


# ---- a whole build with fake sources ------------------------------------------------------------------------------------------

class FakeDem:
    def sample(self, tile):
        a = np.full((256, 256), 200.0, np.float32)
        a[:5] = np.nan  # a strip of no-data to be filled
        return a


class FakeCanopy:
    def cell_heights(self, tile):
        a = np.zeros((256, 256), np.float32)
        a[100:120, 100:120] = 20.0
        return a


def fake_sources(clutter="auto"):
    s = build.Sources.__new__(build.Sources)
    s.o = build.Options(clutter=clutter)
    s.dem, s.canopy, s.buildings, s.lidar = FakeDem(), FakeCanopy() if clutter != "none" else None, None, []
    return s


def test_fill_missing_replaces_nan_and_leaves_valid_values():
    a = np.full((256, 256), 50.0)
    a[:5] = np.nan
    f = build.fill_missing(a)
    assert not np.isnan(f).any() and f[0, 0] == pytest.approx(50.0) and f[100, 100] == 50.0
    assert (build.fill_missing(np.full((256, 256), np.nan)) == 0).all()


def test_build_tile_with_fake_sources():
    bare, clutter, info = build.build_tile(Tile(13, 1, 1), fake_sources(), None)
    assert bare.min() == 200.0 and clutter[110, 110] == 20.0 and clutter[0, 0] == 0.0
    assert info["clutter"] == "canopy" and info["noData"] == pytest.approx(5 / 256, abs=1e-3)
    bare, clutter, info = build.build_tile(Tile(13, 1, 1), fake_sources("none"), None)
    assert clutter is None and info["clutter"] == "none"


class FakeLidar:
    def covers(self, tile):
        return True

    def tile_points(self, tile):
        return None, None, None, None


def lidar_sources(monkeypatch, clutter, over_lidar):
    from meshmap_etl.sources import buildings as bmod, lidar as lmod

    h = np.zeros((256, 256))
    h[50:60, 50:60] = 10.0  # a building that stood at survey time
    ok = np.ones((256, 256), dtype=bool)
    ok[:40, :] = False  # no lidar returns here
    monkeypatch.setattr(lmod, "clutter_from_points", lambda tile, x, y, z, cls, bare: (h, ok))
    b = np.zeros((256, 256), np.float32)
    b[50:60, 50:60] = 15.0  # the same building, a taller estimate
    b[200:210, 200:210] = 8.0  # a building put up since the survey
    b[20:30, 20:30] = 6.0  # a footprint where the lidar has no returns
    monkeypatch.setattr(bmod.OvertureBuildings, "rasterize", staticmethod(lambda tile, geoms, heights: b))
    s = build.Sources.__new__(build.Sources)
    s.o = build.Options(clutter=clutter, buildings_over_lidar=over_lidar)
    s.dem, s.canopy, s.buildings, s.lidar = FakeDem(), None, object(), [FakeLidar()]
    return s


def test_newer_buildings_are_added_on_open_ground_but_surveyed_ones_stay_as_measured(monkeypatch):
    s = lidar_sources(monkeypatch, "lidar", True)
    _, clutter, info = build.build_tile(Tile(13, 1, 1), s, ("g", "h"))
    assert clutter[55, 55] == 10.0, "a surveyed building keeps its lidar height"
    assert clutter[205, 205] == 8.0, "a footprint over open ground is a newer building"
    assert clutter[25, 25] == 0.0, "no lidar returns and lidar-only mode: left empty"
    assert info["buildingsAdded"] == pytest.approx(100 / 65536, abs=1e-4)
    assert "lidar" in info["clutter"] and "buildings" in info["clutter"]


def test_without_the_option_lidar_is_used_as_it_is(monkeypatch):
    s = lidar_sources(monkeypatch, "lidar", False)
    _, clutter, info = build.build_tile(Tile(13, 1, 1), s, ("g", "h"))
    assert clutter[205, 205] == 0.0 and clutter[55, 55] == 10.0
    assert info["buildingsAdded"] == 0.0


def test_auto_mode_fills_pixels_without_lidar_from_buildings(monkeypatch):
    s = lidar_sources(monkeypatch, "auto", True)
    _, clutter, _ = build.build_tile(Tile(13, 1, 1), s, ("g", "h"))
    assert clutter[25, 25] == 6.0 and clutter[205, 205] == 8.0 and clutter[55, 55] == 10.0


def test_cli_build_info_verify_on_a_tiny_pack(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(build, "sources_for", lambda o: fake_sources(o.clutter))
    out = str(tmp_path)
    rc = cli.main(["build", "--id", "tiny", "--bbox=-86.800,36.150,-86.790,36.160", "--out", out, "--workers", "1", "--no-buildings"])
    assert rc == 0
    root = os.path.join(out, "tiny")
    assert cli.main(["verify", root]) == 0
    assert cli.main(["info", root]) == 0
    assert "canopy" in capsys.readouterr().out
    # a damaged tile is reported
    tiles = json.load(open(os.path.join(root, "tiles.json")))
    open(pack.tile_path(root, 13, tiles[0]["x"], tiles[0]["y"], "bare"), "wb").write(b"junk")
    assert cli.main(["verify", root]) == 1


def test_resume_skips_tiles_that_are_already_built(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(build, "sources_for", lambda o: fake_sources(o.clutter))
    orig = build.build_tile
    monkeypatch.setattr(build, "build_tile", lambda t, s, b=None: (calls.append((t.x, t.y)), orig(t, s, b))[1])
    args = ["build", "--id", "r", "--bbox=-86.800,36.150,-86.765,36.185", "--out", str(tmp_path), "--workers", "1", "--no-buildings", "--block", "1"]
    assert cli.main(args + ["--limit", "2"]) == 0 and len(calls) == 2
    # the partial index is removed when a pack is finished, so resume only matters for interrupted builds; rebuilding redoes the work
    assert cli.main(args) == 0 and len(calls) == 2 + 4

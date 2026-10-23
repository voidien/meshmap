#!/usr/bin/env bash
# Terrain packs for the Nashville - Cumberland Plateau - Knoxville corridor, on top of the upper-cumberland pack
# (-85.75,35.80,-84.85,36.30). Run from the repository root:   tools/etl/build-corridor.sh [pack ...]
# Packs: south-cumberland  nashville-west  knoxville-east   (default: all, in that order)
# Each build resumes where it stopped, so it is safe to interrupt and run again. About 1,000 tiles in all (roughly 100 MB);
# expect many hours on a small server. Try one first with:  LIMIT=4 tools/etl/build-corridor.sh south-cumberland
set -euo pipefail
cd "$(dirname "$0")/../.."

LIMIT_ARG=()
[ -n "${LIMIT:-}" ] && LIMIT_ARG=(--limit "$LIMIT")
WORKERS="${WORKERS:-2}"

K="USGS_LPC_TN_27County"
build() { # id bbox lidar-projects
  echo "== $1"
  docker compose --profile etl run --rm etl build --id "$1" --bbox="$2" --lidar "$3" --buildings-over-lidar --workers "$WORKERS" "${LIMIT_ARG[@]}"
}

all=(south-cumberland nashville-west knoxville-east)
for p in "${@:-${all[@]}}"; do
  case "$p" in
    # south of Hinch down to 35.55 (Cumberland Plateau 2015-16 lidar, blocks 2-4)
    south-cumberland) build "$p" -85.75,35.55,-84.85,35.80 "${K}_blk2_2015_LAS_2017,${K}_blk3_2015_LAS_2017,${K}_blk4_2015_LAS_2018" ;;
    # Nashville to the Plateau edge (Middle Tennessee 2018 lidar; 27 County blocks cover the eastern strip)
    nashville-west) build "$p" -86.95,35.85,-85.75,36.35 "USGS_LPC_TN_Middle_B1_2018_LAS_2019,USGS_LPC_TN_Middle_B2_2018_LAS_2019,${K}_blk2_2015_LAS_2017,${K}_blk3_2015_LAS_2017" ;;
    # Plateau edge to Knoxville, plus the strip south of it
    knoxville-east) build "$p" -84.85,35.55,-83.70,36.35 "${K}_blk1_2015_LAS_2018,${K}_blk2_2015_LAS_2017,USGS_LPC_TN_Eastern_2_16_B16_Del2_2016_LAS_2017,USGS_LPC_TN_BlountCo_2015_LAS_2017" ;;
    *) echo "unknown pack $p (south-cumberland, nashville-west, knoxville-east)" >&2; exit 1 ;;
  esac
done

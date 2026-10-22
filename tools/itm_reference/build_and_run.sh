#!/usr/bin/env bash
# Regenerate crates/meshmap-itm/tests/data/golden.csv from the NTIA reference implementation.
#
#   tools/itm_reference/build_and_run.sh /path/to/NTIA-itm-clone [N cases]
#
# Needs g++ and python3. The reference is copied to a temp dir and patched only for Linux (Windows path
# separators and the DLL export attribute); no algorithm code is touched.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ref="${1:?path to a clone of https://github.com/NTIA/itm}"
n="${2:-1500}"
out="$here/../../crates/meshmap-itm/tests/data/golden.csv"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp -r "$ref/src" "$ref/include" "$work/"
sed -i 's#\\#/#g' "$work"/src/*.cpp "$work"/include/*.h
sed -i 's/__declspec(dllexport)//g' "$work"/include/itm.h
cp "$here/ref_driver.cpp" "$work/"
g++ -std=c++17 -O2 -ffp-contract=off -o "$work/ref_driver" "$work/ref_driver.cpp" "$work"/src/*.cpp

python3 "$here/gen_cases.py" "$n" > "$work/cases.txt"
"$work/ref_driver" < "$work/cases.txt" > "$work/results.txt"

# golden line = case line, then ";" and the reference outputs
paste -d';' "$work/cases.txt" "$work/results.txt" > "$out"
echo "wrote $(wc -l < "$out") cases to $out (reference commit: $(git -C "$ref" rev-parse HEAD 2>/dev/null || echo unknown))"

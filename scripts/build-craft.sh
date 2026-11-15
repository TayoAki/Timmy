#!/usr/bin/env bash
# Builds the Craft apps' web versions (storytold/wordcraft, gridcraft, deckcraft,
# pdfcraft), with Timmy's patches from scripts/patches, and copies them into
# public/craft/ for Timmy to host.
#
# Needs: git, a Rust toolchain with the wasm32-unknown-unknown target, and
# wasm-bindgen-cli 0.2.129 (the version all four lockfiles pin):
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.129 --locked
# Each app takes 5–8 minutes on 4 cores.
#
# Usage: npm run craft [-- wordcraft gridcraft …]   (default: all four)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${CRAFT_WORK:-$ROOT/.craft-build}"
APPS=("$@")
[ ${#APPS[@]} -eq 0 ] && APPS=(wordcraft gridcraft deckcraft pdfcraft)

# The commits public/craft was built from. Bump these to update an app.
declare -A REV=(
  [wordcraft]=cc90520b9d8fb0d1e6be2c2688e6f915319e850a
  [gridcraft]=44050e9447e12d5b2a5559e258ffea83b9891507
  [deckcraft]=0d5c0b854b125ae7f8550f0b4d6835b3eb0e8afc
  [pdfcraft]=e191b0ea69b7dcc4e554c1c4e51b6214bec1c590
)

export CARGO_NET_GIT_FETCH_WITH_CLI=true
mkdir -p "$WORK/out"
for app in "${APPS[@]}"; do
  repo="$WORK/$app"
  if [ ! -d "$repo/.git" ]; then
    git init -q "$repo"
    git -C "$repo" remote add origin "https://github.com/storytold/$app"
  fi
  git -C "$repo" fetch -q --depth 1 origin "${REV[$app]}"
  git -C "$repo" checkout -q --detach FETCH_HEAD
  # Timmy's changes for hosting (e.g. no community buttons): scripts/patches/<app>-*.patch
  for patch in "$ROOT"/scripts/patches/"$app"-*.patch; do
    [ -e "$patch" ] && git -C "$repo" apply "$patch"
  done

  echo "== $app: cargo build"
  # PdfCraft's release profile uses one codegen unit; 16 builds several times faster.
  if [ "$app" = pdfcraft ]; then export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16; else unset CARGO_PROFILE_RELEASE_CODEGEN_UNITS || true; fi
  (cd "$repo" && cargo build --release --target wasm32-unknown-unknown -p "$app-web")

  echo "== $app: wasm-bindgen"
  rm -rf "$WORK/out/$app"
  wasm-bindgen --target web --weak-refs --no-typescript --out-dir "$WORK/out/$app" --out-name "$app-web" \
    "$repo/target/wasm32-unknown-unknown/release/$app-web.wasm"
done

python3 "$ROOT/scripts/package-craft.py" "$WORK/out" "$WORK" "${APPS[@]}"

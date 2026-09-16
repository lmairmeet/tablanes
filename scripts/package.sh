#!/usr/bin/env bash
# Builds the Chrome Web Store upload package.
#
# The store rejects archives containing anything it cannot account for, so this
# works from an allowlist of shipped paths rather than by excluding dev files.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

version="$(node -p "require('./manifest.json').version")"
out="dist/tablanes-${version}.zip"

# Everything the extension loads at runtime, and nothing else.
paths=(
  manifest.json
  newtab.html
  icons/icon16.png
  icons/icon32.png
  icons/icon48.png
  icons/icon128.png
  src/app.js
  src/db.js
  src/dnd.js
  src/idb.js
  src/images.js
  src/modal.js
  src/store.js
  src/ui.js
  src/styles.css
  vendor/sql-wasm.js
  vendor/sql-wasm.wasm
)

for path in "${paths[@]}"; do
  [[ -f "$path" ]] || { echo "missing: $path" >&2; exit 1; }
done

# Every local file newtab.html pulls in must be in the allowlist, or the upload
# installs and then fails to boot.
while read -r ref; do
  [[ " ${paths[*]} " == *" $ref "* ]] || { echo "newtab.html references unpackaged file: $ref" >&2; exit 1; }
done < <(grep -oE '(src|href)="[^":]+"' newtab.html | cut -d'"' -f2)

mkdir -p dist
rm -f "$out"
# -X drops the macOS extended attributes that otherwise ride along as junk entries.
zip -q -X -r "$out" "${paths[@]}"

echo "$out ($(du -h "$out" | cut -f1), $(unzip -l "$out" | tail -1 | awk '{print $2}') files)"

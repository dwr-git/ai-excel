#!/usr/bin/env bash
# Build the browser version and zip it:  $DIST/ai-excel-web-<version>.zip
#
# Usage: packaging/web/package.sh [--skip-build]
#
# Needs: trunk (cargo install trunk --locked) and the wasm32-unknown-unknown target. The zip holds
# a self-contained static site in ai-excel-web-<version>/ that works from any URL path (any folder
# name). Hosting notes: packaging/web/README.md.
#
# The site holds the app's wasm gzipped and cut into parts (app/), started by the small
# gridcraft-web-boot module (shipped as ai-excel-<hash>.js), so no file is larger than a part and
# the page can show download progress (studio/loader.js reads data-app-bytes). dist/web still holds
# the app as Trunk builds it, in one .wasm.
set -euo pipefail
# shellcheck source=../env.sh
. "$(dirname "${BASH_SOURCE[0]}")/../env.sh"
HERE="$ROOT/packaging/web"

if [[ "${1:-}" != "--skip-build" ]]; then
  command -v trunk >/dev/null || { echo "error: trunk not found (cargo install trunk --locked)" >&2; exit 1; }
  (cd "$ROOT/apps/gridcraft-web" && trunk build --release)
  (cd "$ROOT/apps/gridcraft-web-boot" && trunk build --release)
fi

APP="$ROOT/dist/web"       # the app: index.html, wasm-bindgen glue, one .wasm
BOOT="$ROOT/dist/web-boot" # the page that ships, and the module that starts the app from parts
for site in "$APP" "$BOOT"; do
  [[ -f "$site/index.html" ]] || { echo "error: $site/index.html missing; run without --skip-build" >&2; exit 1; }
  # Paths must be relative so the site works under any prefix (public_url = "./" in Trunk.toml).
  if grep -Eq '(src|href)="/[^/]' "$site/index.html"; then
    echo "error: $site/index.html has root-absolute URLs; it would break when served from a sub-path" >&2
    exit 1
  fi
done

# Size limit: some hosts and CDNs reject single files over 25 MiB; parts stay well under it.
PART_BYTES="${AI_EXCEL_WEB_PART_BYTES:-20971520}" # 20 MiB

WASM=""
for wasm in "$APP"/*_bg.wasm; do
  [[ -f "$wasm" ]] || continue
  [[ -z "$WASM" ]] || { echo "error: more than one .wasm in $APP; remove it and run without --skip-build" >&2; exit 1; }
  WASM="$wasm"
done
[[ -n "$WASM" ]] || { echo "error: no .wasm in $APP" >&2; exit 1; }
STEM="$(basename "$WASM" _bg.wasm)" # gridcraft-web-<content hash>
GLUE="$APP/$STEM.js"
[[ -f "$GLUE" ]] || { echo "error: $GLUE missing" >&2; exit 1; }
# The shipped parts carry the product name: ai-excel-<content hash>.part-aa, ...
PART_STEM="ai-excel-${STEM#gridcraft-web-}"

NAME="ai-excel-web-$VERSION"
WORK="$CARGO_TARGET_DIR/web-package"
rm -rf "$WORK"
mkdir -p "$WORK/$NAME/app"
cp -R "$BOOT/." "$WORK/$NAME/"
# Fonts the app fetches on demand from ./fonts/ (craft-fonts builds only).
if [[ -d "$APP/fonts" ]]; then cp -R "$APP/fonts" "$WORK/$NAME/"; fi
# The app's glue by its content hash, named in parts.txt (`# loader …`): a fixed name could come
# from the browser's cache, or stay behind on the server, and an old glue can't start a new wasm.
# The fixed name stays too, for a page from before (its boot module imports that).
GLUE_NAME="ai-excel-${STEM#gridcraft-web-}.js"
cp "$GLUE" "$WORK/$NAME/app/$GLUE_NAME"
cp "$GLUE" "$WORK/$NAME/app/ai-excel.js"
# The parts keep the content hash, so they can be cached forever. Their extension is one no server
# knows: a server that recognised gzip might decode or label it, and the page inflates the parts.
gzip -9 -n -c "$WASM" | (cd "$WORK/$NAME/app" && split -b "$PART_BYTES" - "$PART_STEM.part-")
{
  echo "ai-excel-parts 1"
  echo "# loader $GLUE_NAME"
  for part in "$WORK/$NAME/app/$PART_STEM".part-*; do basename "$part"; done
} >"$WORK/$NAME/app/parts.txt"
size() { wc -c <"$1" | tr -d ' '; }
wasm_bytes=$(size "$WASM")
gzip_bytes=$(cat "$WORK/$NAME/app/$PART_STEM".part-* | wc -c | tr -d ' ')
# The page shows download progress against this total (studio/loader.js).
sed -i.bak "s/data-app-bytes=\"0\"/data-app-bytes=\"$gzip_bytes\"/" "$WORK/$NAME/index.html" && rm -f "$WORK/$NAME/index.html.bak"
grep -q "data-app-bytes=\"$gzip_bytes\"" "$WORK/$NAME/index.html" || { echo "error: the page does not know the download size" >&2; exit 1; }
part_count=$(($(wc -l <"$WORK/$NAME/app/parts.txt") - 2))
echo "$(basename "$WASM"): $wasm_bytes bytes, shipped as $gzip_bytes bytes of gzip in $part_count part(s) of up to $PART_BYTES"
# Sample server config (MIME types); harmless where unused.
cp "$HERE/.htaccess" "$WORK/$NAME/" 2>/dev/null || true
copy_docs "$WORK/$NAME"
rm -f "$DIST/$NAME.zip"
(cd "$WORK" && zip -qr9 "$DIST/$NAME.zip" "$NAME")
echo "wrote $DIST/$NAME.zip"
ls -lh "$DIST/$NAME.zip"

#!/usr/bin/env bash
# Builds AI-Excel: the browser app plus the assistant panel and its PHP, as one folder ready for
# the server, zipped:  $DIST/ai-excel-build-<N>-<date>.zip  →  ai-excel/
# The folder works under any name: every path in it is relative.
#
# Usage: studio/build/package.sh [--skip-build]
#   --skip-build  reuse the last trunk build
#
# Needs what packaging/web/package.sh needs (trunk, the wasm32 target) plus python3 and zip.
# The Russian command names for the assistant's search come from crates/ui-egui/src/i18n/ru.rs.
# CI runs it in .github/workflows/studio.yml; nobody needs Rust on the server.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../packaging/env.sh
. "$ROOT/packaging/env.sh"

"$ROOT/packaging/web/package.sh" "$@"

# The site packaging/web/package.sh assembled (ai-excel-web-<version>/ under web-package).
SITE="$CARGO_TARGET_DIR/web-package/ai-excel-web-$VERSION"
if [ ! -f "$SITE/index.html" ]; then
  SITE="$(dirname "$(ls -d "$CARGO_TARGET_DIR"/web-package/*/index.html 2>/dev/null | head -n 1)")"
fi
[ -f "$SITE/index.html" ] || { echo "error: no site with index.html under $CARGO_TARGET_DIR/web-package" >&2; exit 1; }

OUT="$CARGO_TARGET_DIR/studio-package"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$SITE" "$OUT/ai-excel"
APP="$OUT/ai-excel"
# Upstream hosting notes (they describe the original project); this folder has its own README.
rm -f "$APP/HOSTING.md"

# The panel: studio/ next to index.html.
mkdir -p "$APP/studio"
cp "$ROOT/studio/web/studio.js" "$ROOT/studio/web/studio.css" "$ROOT/studio/web/config.js" "$ROOT/studio/web/loader.js" "$APP/studio/"
cp "$ROOT/studio/web/.htaccess" "$APP/studio/"
# AI-Excel's own icon: a small sheet of cells in the frame the other AI- apps share.
cp "$ROOT/studio/web/favicon.png" "$ROOT/studio/web/apple-touch-icon.png" "$APP/"
python3 "$ROOT/studio/build/make_labels.py" "$APP/studio/ru-labels.json"

# The assistant's PHP: api/ next to index.html.
mkdir -p "$APP/api"
cp "$ROOT"/studio/api/*.php "$APP/api/"
cp "$ROOT/studio/api/.htaccess" "$APP/api/"

# Docs for whoever puts it on the server.
cp "$ROOT/studio/README.ru.md" "$APP/README.ru.md"
cp "$ROOT/studio/CHANGES.ru.md" "$APP/CHANGES.ru.md"
cp "$ROOT/studio/nginx.conf.example" "$APP/nginx.conf.example"

# The panel's files keep their names between releases: a version in the URL makes browsers
# fetch the new ones after an update (config.js is meant to be edited on the server, so it is
# served with no-cache instead, see studio/web/.htaccess).
STAMP="${GRIDCRAFT_BUILD_SHA:-${GITHUB_SHA:-}}"
STAMP="${STAMP:0:8}"
[ -n "$STAMP" ] || STAMP="$VERSION"
sed -i.bak \
  -e "s#href=\"studio/studio.css\"#href=\"studio/studio.css?v=$STAMP\"#" \
  -e "s#src=\"studio/studio.js\"#src=\"studio/studio.js?v=$STAMP\"#" \
  -e "s#src=\"studio/loader.js\"#src=\"studio/loader.js?v=$STAMP\"#" \
  "$APP/index.html"
rm -f "$APP/index.html.bak"
grep -q "studio/studio.js?v=$STAMP" "$APP/index.html" || { echo "error: the page does not load the assistant panel" >&2; exit 1; }
grep -q "studio/loader.js?v=$STAMP" "$APP/index.html" || { echo "error: the page does not load the start-up check" >&2; exit 1; }
# Nothing in the folder may load from another site: the app must work with no internet.
if grep -rIlE "(src|href)=\"(https?:)?//" "$APP" --include=*.html >/dev/null; then echo "error: a page loads something from another site" >&2; exit 1; fi
grep -q 'data-app-bytes="[1-9]' "$APP/index.html" || { echo "error: the page does not know the download size" >&2; exit 1; }

# Номер сборки (GitHub Actions передаёт AI_EXCEL_BUILD) и дата — в имени архива и внутри папки,
# чтобы было видно, какая версия скачана и какая стоит на сервере (панель помощника пишет её в шапке).
BUILD="${AI_EXCEL_BUILD:-local}"
BUILD_DATE="$(TZ=Europe/Minsk date +%Y-%m-%d)"
# Файлы, которые меняются от сборки к сборке, но могли бы сохранить прежний размер, получают
# «набивку» разной длины: программы заливки, которые пропускают файлы того же размера, всё равно
# их заменят (иначе на сервере остаётся старый список частей и редактор грузится старый).
PAD="$(printf '%*s' $(( (${BUILD//[^0-9]/} + 0) % 23 + 1 )) '' | tr ' ' '#')"
printf '{"build":"%s","date":"%s","commit":"%s","pad":"%s"}\n' "$BUILD" "$BUILD_DATE" "$STAMP" "$PAD" >"$APP/studio/version.json"
printf '# build %s, %s %s\n' "$BUILD" "$BUILD_DATE" "$PAD" >>"$APP/app/parts.txt"
# Номер сборки — и в самой странице: панель сравнит его с version.json на сервере и подскажет,
# если браузер показывает старую копию из кэша или на сервере остались файлы прошлой сборки.
sed -i.bak "s#<html lang=\"ru\"#<html lang=\"ru\" data-build=\"$BUILD\"#" "$APP/index.html" && rm -f "$APP/index.html.bak"
grep -q "data-build=\"$BUILD\"" "$APP/index.html" || { echo "error: the page has no build number" >&2; exit 1; }
# Каждая сборка — в своей папке b/<номер>/, index.php выбирает самую новую (studio/build/versioned.sh):
# обновление любой программой заливки не может смешать файлы разных сборок.
"$ROOT/studio/build/versioned.sh" "$APP" "$BUILD" "AI-Excel"
# Каждый текстовый файл с постоянным именем (страница, index.php, скрипты и стили панели, PHP
# помощника, файл запуска с постоянным именем) получает в конце строку с номером сборки и набивкой
# той же разной длины: иначе программа заливки, которая пропускает файлы того же размера, оставит
# на сервере старую страницу, и та запустит старый загрузчик. Файлы с отпечатком в имени не трогаем
# (их имя и так новое, а у части из них в странице записана контрольная сумма).
pad_file() {
  case "$1" in
    *.html) printf '\n<!-- build %s %s -->\n' "$BUILD" "$PAD" >>"$1" ;;
    *.js | *.css) printf '\n/* build %s %s */\n' "$BUILD" "$PAD" >>"$1" ;;
    *.php) tail -c 3 "$1" | grep -q '?>' || printf '\n// build %s %s\n' "$BUILD" "$PAD" >>"$1" ;;
  esac
}
while IFS= read -r f; do pad_file "$f"; done < <(find "$APP" -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.php' \) | grep -vE '[-_][0-9a-f]{16}[-_.][^/]*$')
cat "$APP"/b/*/index.html | grep -q "<!-- build $BUILD " || { echo "error: the page has no build padding" >&2; exit 1; }
ZIP="$DIST/ai-excel-build-$BUILD-$BUILD_DATE.zip"
rm -f "$ZIP"
(cd "$OUT" && zip -qr9 "$ZIP" ai-excel)
echo "wrote $ZIP"
ls -lh "$ZIP"

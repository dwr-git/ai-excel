#!/usr/bin/env bash
# Lay a packaged folder out so that an update can never mix two builds:
#
#   <app>/index.php        picks the newest complete build in b/ and serves its page (no cache)
#   <app>/index.html       sends the browser to index.php (for servers that prefer index.html)
#   <app>/studio/config.js the settings, edited on the server; kept between updates
#   <app>/api/             the PHP (its URLs stay the same; nginx rules name them)
#   <app>/b/<N>/           everything else of build N: page, start-up module, app parts, panel
#
# Every file of a build has a path no other build uses, so an upload tool that skips files "of
# the same size" or "not newer" can't leave an old start-up module next to new parts, and a
# browser can't take an old file from its cache. Old b/<N>/ folders are never used again.
#
# Usage: studio/build/versioned.sh <app folder> <build number> <product name>
set -euo pipefail
APP="${1:?app folder}"
N="${2//[^0-9]/}"
NAME="${3:?product name}"
[ -n "$N" ] || N=0
[ -f "$APP/index.html" ] || { echo "error: $APP/index.html missing" >&2; exit 1; }

FLAT="$(mktemp -d)"
cp -R "$APP/." "$FLAT/"
rm -rf "${APP:?}"/* "$APP"/.htaccess 2>/dev/null || true
mkdir -p "$APP/b/$N" "$APP/studio"

# Kept at the top: the PHP, the editable settings, the docs.
[ -d "$FLAT/api" ] && mv "$FLAT/api" "$APP/api"
[ -f "$FLAT/studio/config.js" ] && mv "$FLAT/studio/config.js" "$APP/studio/config.js"
[ -f "$FLAT/studio/.htaccess" ] && cp "$FLAT/studio/.htaccess" "$APP/studio/.htaccess"
for doc in README.ru.md CHANGES.ru.md nginx.conf.example; do
  [ -f "$FLAT/$doc" ] && mv "$FLAT/$doc" "$APP/$doc"
done
for icon in favicon.png apple-touch-icon.png; do
  [ -f "$FLAT/$icon" ] && cp "$FLAT/$icon" "$APP/$icon"
done
[ -f "$FLAT/.htaccess" ] && cp "$FLAT/.htaccess" "$APP/.htaccess"
rm -f "$FLAT/index.php"

# Everything else is this build's.
cp -R "$FLAT/." "$APP/b/$N/"
rm -rf "$FLAT"
# The page reads the settings from the top folder.
sed -i.bak 's#src="studio/config.js[^"]*"#src="../../studio/config.js"#' "$APP/b/$N/index.html" && rm -f "$APP/b/$N/index.html.bak"
grep -q 'src="../../studio/config.js"' "$APP/b/$N/index.html" || { echo "error: the page does not load studio/config.js" >&2; exit 1; }
# Written last: a build counts once its folder is complete (index.php ignores one still uploading).
echo "$N" >"$APP/b/$N/ready.txt"

cat >"$APP/index.php" <<PHP
<?php
// $NAME: страница редактора. Каждая сборка лежит в своей папке b/<номер>/, поэтому обновление
// не может смешать файлы разных сборок, а браузер — взять старый файл из кэша. Этот файл
// выбирает самую новую сборку, залитую целиком (есть b/<номер>/ready.txt), и отдаёт её страницу.
PHP
cat >>"$APP/index.php" <<'PHP'
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache, no-store, must-revalidate');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
$best = -1;
foreach (glob(__DIR__ . '/b/*/ready.txt') ?: [] as $ready) {
    $n = basename(dirname($ready));
    if (ctype_digit($n) && (int)$n > $best && is_file(dirname($ready) . '/index.html')) {
        $best = (int)$n;
    }
}
if ($best < 0) {
    http_response_code(500);
    echo '<!doctype html><meta charset="utf-8"><p style="font:15px system-ui;margin:2em">'
        . 'В папке нет ни одной сборки редактора (папки b/…). Залейте на сервер папку из архива целиком.</p>';
    exit;
}
$page = (string)file_get_contents(__DIR__ . "/b/$best/index.html");
// Все пути страницы — внутри папки сборки; настройки и PHP — на уровень приложения (STUDIO_ROOT).
$head = '<base href="b/' . $best . '/"><script>window.STUDIO_ROOT=new URL("../../",document.baseURI).href;</script>';
$page = preg_replace('~<head[^>]*>~i', '$0' . $head, $page, 1) ?? $page;
echo $page;
PHP

cat >"$APP/index.html" <<HTML
<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>$NAME</title>
<meta http-equiv="refresh" content="0;url=index.php">
<script>location.replace('index.php' + location.search + location.hash);</script>
</head><body><p><a href="index.php">Открыть $NAME</a></p></body></html>
HTML
echo "versioned: $APP/b/$N"

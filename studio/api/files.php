<?php
// studio/api/files.php — файлы AI-Excel на вашем сервере. У каждого пользователя своя папка.
//
//   GET  files.php                          → {ok, user, files: [{name, size, modified}], limit}
//   GET  files.php?action=load&name=…       → сама книга (.xlsx, .xls, .ods, .csv…), application/octet-stream
//   POST files.php?action=save&name=…[&overwrite=1]   тело — байты файла → {ok, name, size, modified}
//   POST files.php?action=rename  {name, to}   → {ok}
//   POST files.php?action=delete  {name}       → {ok}  (файл уходит в корзину .trash/ папки пользователя)
//
// Где лежат файлы: AI_EXCEL_DATA_DIR из .env, иначе storage/ai-excel рядом с корнем сайта
// (/app/storage/ai-excel при корне /app/src — вне корня, nginx её не отдаёт; создаётся сама),
// потом data/ai-excel, а если никуда нельзя писать — ai-excel-data рядом с папкой приложения
// (закройте её в nginx: см. nginx.conf.example).
// Имена файлов на диске случайные, список — в index.json папки пользователя.

declare(strict_types=1);

header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

function files_fail(int $http, string $message, array $extra = []): void
{
    http_response_code($http);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => $message] + $extra, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function files_ok(array $data): void
{
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => true] + $data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

ini_set('display_errors', '0');
set_exception_handler(static function (Throwable $e): void {
    error_log('ai-excel files: ' . $e->getMessage());
    files_fail(500, 'Внутренняя ошибка хранилища файлов. Подробности — в журнале PHP.');
});

$STUDIO = require __DIR__ . '/settings.php';

// ---------------------------------------------------------------- кто это
$user = 'local';
if ($STUDIO['auth_file'] !== '' && is_file($STUDIO['auth_file'])) {
    require_once $STUDIO['auth_file'];
    if (!function_exists('isLoggedIn') || !isLoggedIn()) {
        files_fail(401, 'Войдите в систему, чтобы открыть свои файлы.', ['login' => true]);
    }
    $u = function_exists('getCurrentUser') ? getCurrentUser() : null;
    $id = is_array($u) ? ($u['id'] ?? $u['login'] ?? null) : null;
    if ($id === null || $id === '') {
        files_fail(500, 'auth.php не сообщил, кто вошёл (getCurrentUser).');
    }
    $user = (string)$id;
} elseif (!$STUDIO['allow_anonymous']) {
    files_fail(500, 'Не найден auth.php системы. Укажите путь в AI_EXCEL_AUTH_FILE (см. README.ru.md).');
}
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}

// ---------------------------------------------------------------- где лежат файлы
function files_root(): string
{
    $env = studio_env('AI_EXCEL_DATA_DIR');
    if ($env !== '') {
        return rtrim($env, '/');
    }
    // Рядом с корнем сайта, но не внутри него: сначала папка storage (как /app/storage при корне
    // /app/src — туда же nginx пишет журналы), потом data. Берётся первая, куда PHP может писать.
    $docRoot = rtrim((string)($_SERVER['DOCUMENT_ROOT'] ?? ''), '/');
    $parent = $docRoot !== '' ? dirname($docRoot) : '';
    $candidates = [];
    if ($parent !== '' && $parent !== '/' && is_dir("$parent/storage")) {
        $candidates[] = "$parent/storage/ai-excel";
    }
    if ($parent !== '' && $parent !== '/') {
        $candidates[] = "$parent/data/ai-excel";
    }
    foreach ($candidates as $dir) {
        if ((is_dir($dir) && is_writable($dir)) || (!is_dir($dir) && @mkdir($dir, 0770, true))) {
            return $dir;
        }
    }
    return dirname(__DIR__, 2) . '/ai-excel-data';
}

$root = files_root();
if (!is_dir($root) && !@mkdir($root, 0770, true) && !is_dir($root)) {
    files_fail(500, "Не удалось создать папку для файлов: $root. Создайте её и дайте PHP право записи (или укажите AI_EXCEL_DATA_DIR).");
}
// Если папка всё же внутри сайта — закрываем её для Apache и не даём листать.
if (!is_file("$root/.htaccess")) {
    @file_put_contents("$root/.htaccess", "Require all denied\n");
}
if (!is_file("$root/index.html")) {
    @file_put_contents("$root/index.html", '');
}
$dir = $root . '/u-' . preg_replace('/[^A-Za-z0-9_-]/', '_', $user);
if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
    files_fail(500, 'Не удалось создать папку пользователя. Проверьте права PHP на ' . $root);
}

const FILES_MAX_BYTES = 512 * 1024 * 1024;
const FILES_MAX_COUNT = 2000;
/** Типы книг, которые хранятся (расширение имени на сервере и на диске). */
const FILES_EXTS = ['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'xlsb', 'ods', 'csv', 'tsv', 'txt'];
const FILES_STORED = '/^[0-9a-f]{32}\.(xlsx|xlsm|xltx|xltm|xls|xlsb|ods|csv|tsv|txt)$/';

/** Расширение книги по имени, в нижнем регистре ('' — неизвестное). */
function files_ext(string $name): string
{
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    return in_array($ext, FILES_EXTS, true) ? $ext : '';
}

/** Имя файла, как его видит пользователь: без путей и служебных символов. */
function files_name(?string $name): string
{
    $name = trim((string)$name);
    $name = preg_replace('/[\x00-\x1F\x7F\/\\\\]+/u', ' ', $name) ?? '';
    $name = trim(preg_replace('/\s+/u', ' ', $name) ?? '');
    if ($name === '' || $name === '.' || $name === '..') {
        files_fail(400, 'Пустое имя файла.');
    }
    if (mb_strlen($name) > 120) {
        $name = mb_substr($name, 0, 120);
    }
    // Книга без известного расширения сохраняется как .xlsx.
    if (files_ext($name) === '') {
        $name .= '.xlsx';
    }
    return $name;
}

/** Список файлов пользователя под блокировкой: $fn меняет его и возвращает результат. */
function files_index(string $dir, callable $fn)
{
    $lock = fopen("$dir/index.lock", 'c');
    if ($lock === false) {
        files_fail(500, 'Не удалось открыть список файлов.');
    }
    flock($lock, LOCK_EX);
    try {
        $raw = is_file("$dir/index.json") ? file_get_contents("$dir/index.json") : '';
        $index = $raw ? json_decode($raw, true) : [];
        if (!is_array($index)) {
            $index = [];
        }
        $before = $index;
        $result = $fn($index);
        if ($index !== $before) {
            $tmp = "$dir/index.json." . bin2hex(random_bytes(4));
            file_put_contents($tmp, json_encode($index, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
            rename($tmp, "$dir/index.json");
        }
        return $result;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function files_json_body(): array
{
    $j = json_decode((string)file_get_contents('php://input'), true);
    return is_array($j) ? $j : [];
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = (string)($_GET['action'] ?? ($method === 'GET' ? 'list' : ''));

switch ($action) {
    case 'list':
        $files = files_index($dir, static function (array &$index): array {
            $out = [];
            foreach ($index as $name => $f) {
                $out[] = ['name' => (string)$name, 'size' => (int)($f['size'] ?? 0), 'modified' => (int)($f['modified'] ?? 0)];
            }
            usort($out, static fn($a, $b) => $b['modified'] <=> $a['modified']);
            return $out;
        });
        files_ok(['user' => $user, 'files' => $files, 'limit' => FILES_MAX_BYTES]);

    case 'load':
        $name = files_name($_GET['name'] ?? '');
        $file = files_index($dir, static fn(array &$index) => $index[$name]['file'] ?? null);
        if (!is_string($file) || !preg_match(FILES_STORED, $file) || !is_file("$dir/$file")) {
            files_fail(404, "Файла «{$name}» нет.");
        }
        header('Content-Type: application/octet-stream');
        header('Content-Length: ' . filesize("$dir/$file"));
        readfile("$dir/$file");
        exit;

    case 'save':
        if ($method !== 'POST') {
            files_fail(405, 'Нужен POST.');
        }
        $name = files_name($_GET['name'] ?? '');
        $overwrite = ($_GET['overwrite'] ?? '') === '1';
        $declared = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($declared > FILES_MAX_BYTES) {
            files_fail(413, 'Файл больше 512 МБ.');
        }
        $tmp = "$dir/upload." . bin2hex(random_bytes(6));
        $in = fopen('php://input', 'rb');
        $out = fopen($tmp, 'wb');
        $size = ($in && $out) ? stream_copy_to_stream($in, $out, FILES_MAX_BYTES + 1) : false;
        if ($in) fclose($in);
        if ($out) fclose($out);
        if ($size === false || $size === 0) {
            @unlink($tmp);
            files_fail(400, $declared > 0
                ? 'Сервер не передал PHP содержимое файла. Скорее всего, файл больше post_max_size в настройках PHP — увеличьте post_max_size и upload_max_filesize.'
                : 'Пустой файл.');
        }
        if ($size > FILES_MAX_BYTES) {
            @unlink($tmp);
            files_fail(413, 'Файл больше 512 МБ.');
        }
        // .xlsx/.xlsm/.xlsb/.ods — zip (книга с паролем — составной файл OLE), .xls — OLE;
        // .csv/.tsv/.txt — текст: в нём не должно быть нулевых байтов.
        $ext = files_ext($name);
        $head = (string)file_get_contents($tmp, false, null, 0, 8);
        $zip = strncmp($head, "PK\x03\x04", 4) === 0 || strncmp($head, "PK\x05\x06", 4) === 0;
        $ole = $head === "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1";
        if (in_array($ext, ['csv', 'tsv', 'txt'], true)) {
            $probe = (string)file_get_contents($tmp, false, null, 0, 65536);
            $bom16 = strncmp($probe, "\xFF\xFE", 2) === 0 || strncmp($probe, "\xFE\xFF", 2) === 0;
            $ok = !$zip && !$ole && ($bom16 || strpos($probe, "\0") === false);
        } else {
            $ok = $zip || $ole;
        }
        if (!$ok) {
            @unlink($tmp);
            files_fail(400, 'Содержимое не похоже на книгу .' . $ext . '.');
        }
        $saved = files_index($dir, static function (array &$index) use ($dir, $name, $overwrite, $tmp, $size) {
            if (isset($index[$name]) && !$overwrite) {
                return ['exists' => true];
            }
            if (!isset($index[$name]) && count($index) >= FILES_MAX_COUNT) {
                return ['full' => true];
            }
            $old = (string)($index[$name]['file'] ?? '');
            $file = preg_match(FILES_STORED, $old) ? $old : (bin2hex(random_bytes(16)) . '.' . files_ext($name));
            if (!rename($tmp, "$dir/$file")) {
                return ['error' => true];
            }
            $index[$name] = ['file' => $file, 'size' => $size, 'modified' => time()];
            return ['modified' => $index[$name]['modified']];
        });
        if (!empty($saved['exists']) || !empty($saved['full']) || !empty($saved['error'])) {
            @unlink($tmp);
        }
        if (!empty($saved['exists'])) {
            files_fail(409, "Файл «{$name}» уже есть.", ['exists' => true]);
        }
        if (!empty($saved['full'])) {
            files_fail(507, 'Слишком много файлов. Удалите ненужные.');
        }
        if (!empty($saved['error'])) {
            files_fail(500, 'Не удалось записать файл на сервер. Проверьте права PHP на ' . $dir);
        }
        files_ok(['name' => $name, 'size' => $size, 'modified' => $saved['modified']]);

    case 'rename':
        if ($method !== 'POST') {
            files_fail(405, 'Нужен POST.');
        }
        $body = files_json_body();
        $name = files_name($body['name'] ?? '');
        $to = files_name($body['to'] ?? '');
        $r = files_index($dir, static function (array &$index) use ($name, $to) {
            if (!isset($index[$name])) return 'missing';
            if ($name === $to) return 'ok';
            if (isset($index[$to])) return 'exists';
            $index[$to] = $index[$name];
            unset($index[$name]);
            return 'ok';
        });
        if ($r === 'missing') files_fail(404, "Файла «{$name}» нет.");
        if ($r === 'exists') files_fail(409, "Файл «{$to}» уже есть.", ['exists' => true]);
        files_ok(['name' => $to]);

    case 'delete':
        if ($method !== 'POST') {
            files_fail(405, 'Нужен POST.');
        }
        $name = files_name(files_json_body()['name'] ?? '');
        $r = files_index($dir, static function (array &$index) use ($dir, $name) {
            if (!isset($index[$name])) return false;
            $file = (string)($index[$name]['file'] ?? '');
            if (preg_match(FILES_STORED, $file) && is_file("$dir/$file")) {
                @mkdir("$dir/.trash", 0770);
                @rename("$dir/$file", "$dir/.trash/" . date('Ymd-His') . '-' . $file);
            }
            unset($index[$name]);
            return true;
        });
        if (!$r) files_fail(404, "Файла «{$name}» нет.");
        files_ok([]);

    default:
        files_fail(400, 'Неизвестное действие.');
}

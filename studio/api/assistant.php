<?php
// studio/api/assistant.php — помощник AI-Excel: мост между панелью в браузере и Ollama.
//
//   GET  assistant.php            проверка: вошёл ли пользователь, какая модель, доступна ли она
//   POST assistant.php            {mode: "advice"|"act", messages: [...]} → {ok, message: {content, tool_calls}}
//   POST assistant.php            {mode: "text", op | custom, selection, sheet, workbook} → {ok, message: {content}}
//                                 (ИИ у выделенных ячеек: «Объяснить формулу», «Написать формулу», «Перевести»… — см. context.php)
//
// Инструменты (find_commands, run_command…) выполняет браузер: только он видит
// запущенный редактор. Здесь — авторизация, системная инструкция, список
// разрешённых инструментов и запрос к модели.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

/** Ответ с ошибкой и выход. */
function studio_fail(int $http, string $message, array $extra = []): void
{
    http_response_code($http);
    echo json_encode(['ok' => false, 'error' => $message] + $extra, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// Предупреждения PHP не должны ломать JSON-ответ.
ini_set('display_errors', '0');
set_exception_handler(static function (Throwable $e): void {
    error_log('ai-excel assistant: ' . $e->getMessage());
    studio_fail(500, 'Внутренняя ошибка помощника. Подробности — в журнале PHP.');
});

$STUDIO = require __DIR__ . '/settings.php';
require_once __DIR__ . '/tools.php';

// ---------------------------------------------------------------- авторизация
// auth.php системы подключает config.php: после него известны $url_ollama,
// $global_model, enrichLLMPayload() и setLLMApp().
$__authed = false;
if ($STUDIO['auth_file'] !== '' && is_file($STUDIO['auth_file'])) {
    require_once $STUDIO['auth_file'];
    if (!function_exists('isLoggedIn') || !isLoggedIn()) {
        studio_fail(401, 'Войдите в систему, чтобы пользоваться помощником.', ['login' => true]);
    }
    $__authed = true;
} elseif (!$STUDIO['allow_anonymous']) {
    studio_fail(500, 'Не найден auth.php системы. Укажите путь в AI_EXCEL_AUTH_FILE (см. studio/README.ru.md).');
}
// Сессия больше не нужна: отпускаем её блокировку, иначе пока модель думает,
// остальные страницы этого пользователя будут ждать.
if (session_status() === PHP_SESSION_ACTIVE) {
    session_write_close();
}
if (function_exists('setLLMApp')) {
    setLLMApp('ai-excel');
}

// ---------------------------------------------------------------- модель
$ollamaUrl = studio_env('AI_EXCEL_OLLAMA_URL');
if ($ollamaUrl === '') {
    $hostPort = (isset($url_ollama) && is_string($url_ollama) && trim($url_ollama, ':') !== '') ? $url_ollama : '';
    if ($hostPort === '') {
        $ip = studio_env('OLLAMA_IP', '127.0.0.1');
        $port = studio_env('OLLAMA_PORT', '11434');
        $hostPort = "$ip:$port";
    }
    $ollamaUrl = preg_match('#^https?://#i', $hostPort) ? $hostPort : 'http://' . $hostPort;
}
$ollamaUrl = rtrim($ollamaUrl, '/');
$model = studio_env('AI_EXCEL_MODEL') ?: ((isset($global_model) && is_string($global_model) && $global_model !== '') ? $global_model : studio_env('GLOBAL_MODEL', 'ministral-3:8b'));
$ctx = (int)(studio_env('AI_EXCEL_CONTEXT') ?: ((isset($ollama_ctxsize) && (int)$ollama_ctxsize > 0) ? $ollama_ctxsize : '32768'));

// ---------------------------------------------------------------- GET: проверка
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
    echo json_encode([
        'ok' => true,
        'model' => $model,
        'authenticated' => $__authed,
        'user' => ($__authed && function_exists('getCurrentUser')) ? (getCurrentUser()['login'] ?? null) : null,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    studio_fail(405, 'Метод не поддерживается.');
}

// ---------------------------------------------------------------- запрос
$len = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($len > $STUDIO['max_body_bytes']) {
    studio_fail(413, 'Слишком большой запрос (скриншот?). Попробуйте ещё раз — панель уменьшит снимок.');
}
$raw = file_get_contents('php://input', false, null, 0, $STUDIO['max_body_bytes'] + 1);
if ($raw === false || strlen($raw) > $STUDIO['max_body_bytes']) {
    studio_fail(413, 'Слишком большой запрос.');
}
$in = json_decode($raw, true, 64);
$mode = match ($in['mode'] ?? '') {
    'act' => 'act',
    'text' => 'text',
    default => 'advice',
};
if (!is_array($in) || ($mode !== 'text' && (!isset($in['messages']) || !is_array($in['messages'])))) {
    studio_fail(400, 'Неверный формат запроса: нужен JSON {mode, messages}.');
}

/** Оставляет в сообщениях только то, что понимает Ollama, и проверяет размеры. */
function studio_clean_messages(array $messages, array $limits): array
{
    if (count($messages) === 0) {
        studio_fail(400, 'Пустой диалог.');
    }
    // Старые сообщения отрезаем, системная инструкция добавляется сервером.
    $messages = array_slice(array_values($messages), -$limits['max_messages']);
    $out = [];
    $images = 0;
    foreach ($messages as $m) {
        if (!is_array($m)) {
            continue;
        }
        $role = (string)($m['role'] ?? '');
        if (!in_array($role, ['user', 'assistant', 'tool'], true)) {
            continue;
        }
        $content = $m['content'] ?? '';
        if (!is_string($content)) {
            $content = json_encode($content, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '';
        }
        $msg = ['role' => $role, 'content' => mb_substr($content, 0, 20000)];
        if ($role === 'user' && !empty($m['images']) && is_array($m['images'])) {
            $imgs = [];
            foreach ($m['images'] as $img) {
                if (!is_string($img)) {
                    continue;
                }
                $img = preg_replace('#^data:image/[a-z+]+;base64,#i', '', $img);
                if (strlen($img) > $limits['max_image_bytes'] || !preg_match('#^[A-Za-z0-9+/]+={0,2}$#', $img)) {
                    continue;
                }
                $imgs[] = $img;
            }
            // Картинки держим только в последних сообщениях: каждая занимает много контекста.
            if ($imgs) {
                $msg['images'] = $imgs;
                $images += count($imgs);
            }
        }
        if ($role === 'assistant' && !empty($m['tool_calls']) && is_array($m['tool_calls'])) {
            $calls = [];
            foreach (array_slice($m['tool_calls'], 0, 16) as $c) {
                $fn = $c['function'] ?? null;
                if (!is_array($fn) || !isset($fn['name']) || !is_string($fn['name'])) {
                    continue;
                }
                $args = $fn['arguments'] ?? [];
                if (is_string($args)) {
                    $decoded = json_decode($args, true);
                    $args = is_array($decoded) ? $decoded : [];
                }
                $calls[] = ['function' => ['name' => $fn['name'], 'arguments' => is_array($args) && $args ? $args : new stdClass()]];
            }
            if ($calls) {
                $msg['tool_calls'] = $calls;
            }
        }
        if ($role === 'tool') {
            $name = (string)($m['tool_name'] ?? $m['name'] ?? '');
            if ($name !== '') {
                $msg['tool_name'] = $name;
            }
        }
        $out[] = $msg;
    }
    // Не больше max_images картинок на запрос: оставляем самые свежие.
    if ($images > $limits['max_images']) {
        $keep = $limits['max_images'];
        for ($i = count($out) - 1; $i >= 0; $i--) {
            if (!isset($out[$i]['images'])) {
                continue;
            }
            if ($keep <= 0) {
                unset($out[$i]['images']);
                continue;
            }
            $out[$i]['images'] = array_slice($out[$i]['images'], -$keep);
            $keep -= count($out[$i]['images']);
        }
    }
    return $out;
}

$contextMode = null;
if ($mode === 'text') {
    require_once __DIR__ . '/context.php';
    [$textSystem, $textMessages, $contextMode] = studio_context_request($in);
}
$messages = $mode === 'text' ? $textMessages : studio_clean_messages($in['messages'], $STUDIO);
// Шлюз без поддержки инструментов (вызовы приходят текстом): историю вызовов и их результатов
// тоже передаём текстом, в том же виде, в каком модель их пишет.
$textTools = $mode !== 'text' && !empty($in['textTools']);
if ($textTools) {
    foreach ($messages as &$m) {
        if ($m['role'] === 'assistant' && !empty($m['tool_calls'])) {
            foreach ($m['tool_calls'] as $c) {
                $block = '<tool_call><function=' . $c['function']['name'] . '>';
                foreach ((array)$c['function']['arguments'] as $k => $v) {
                    $block .= '<parameter=' . $k . '>' . (is_string($v) ? $v : json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) . '</parameter>';
                }
                $m['content'] = trim($m['content'] . "\n" . $block . '</function></tool_call>');
            }
            unset($m['tool_calls']);
        } elseif ($m['role'] === 'tool') {
            $m = ['role' => 'user', 'content' => '[Результат инструмента ' . ($m['tool_name'] ?? '') . "]\n" . $m['content']];
        }
    }
    unset($m);
}
$tools = $mode === 'text' ? [] : studio_read_tools();
if ($mode === 'act') {
    $tools = array_merge($tools, studio_act_tools());
}
$system = $mode === 'text' ? $textSystem : studio_system_prompt($mode);

$payload = [
    'model' => $model,
    'messages' => array_merge([['role' => 'system', 'content' => $system]], $messages),
    'stream' => false,
    'think' => false,
    'options' => [
        'temperature' => $mode === 'text' ? 0.4 : 0.2,
        'num_predict' => max(256, $STUDIO['max_tokens']),
        'num_ctx' => max(4096, $ctx),
    ],
];
if ($tools) {
    $payload['tools'] = $tools;
}
if (function_exists('enrichLLMPayload')) {
    enrichLLMPayload($payload, 'ai-excel'); // трекинг на шлюзе, как у остальных приложений
}
// ИИ-талеры кабинета (если он есть рядом): цена операции и остаток, как в контекстном редакторе.
$__dwt = studio_env('AI_EXCEL_TALERS_FILE') ?: dirname(__DIR__, 2) . '/cabinet/talers.php';
if ($mode === 'text' && is_file($__dwt)) {
    require_once $__dwt;
    if (function_exists('dwt_begin')) {
        dwt_begin('ai-excel');
        if (function_exists('dwt_denied') && ($denied = dwt_denied())) {
            studio_fail(402, (string)$denied, function_exists('dwt_fields') ? dwt_fields() : []);
        }
    }
}

// ---------------------------------------------------------------- запрос к модели
$ch = curl_init($ollamaUrl . '/api/chat');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => max(30, $STUDIO['timeout']),
]);
$started = microtime(true);
// Пока модель думает, раз в 10 секунд отправляем в ответ пробел. Пробелы перед JSON
// ничего не ломают, а соединение не выглядит «зависшим»: роутеры, VPN и прокси между
// браузером и сервером часто рвут молчащие соединения, и браузер тогда пишет «Failed to fetch».
header('X-Accel-Buffering: no');
@ini_set('zlib.output_compression', '0');
while (ob_get_level() > 0) {
    @ob_end_flush();
}
$mh = curl_multi_init();
curl_multi_add_handle($mh, $ch);
$lastBeat = microtime(true);
do {
    $status = curl_multi_exec($mh, $running);
    if ($running) {
        curl_multi_select($mh, 1.0);
    }
    if (microtime(true) - $lastBeat >= 10) {
        echo ' ';
        flush();
        $lastBeat = microtime(true);
    }
} while ($running && $status === CURLM_OK);
$body = curl_multi_getcontent($ch);
$curlError = curl_error($ch);
if ($curlError === '') {
    $info = curl_multi_info_read($mh);
    if (is_array($info) && ($info['result'] ?? CURLE_OK) !== CURLE_OK) {
        $curlError = curl_strerror((int)$info['result']);
    }
}
$http = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_multi_remove_handle($mh, $ch);
curl_multi_close($mh);
curl_close($ch);
if ($http === 0 && $curlError === '') {
    $curlError = 'нет ответа от модели за ' . round(microtime(true) - $started) . ' с';
}

if ($body === null || $body === false || $curlError !== '') {
    studio_fail(502, 'Модель недоступна: ' . $curlError);
}
$res = json_decode((string)$body, true);
if (is_array($res) && function_exists('dwt_refused')) {
    dwt_refused($res);
}
if (!is_array($res)) {
    studio_fail(502, 'Модель вернула непонятный ответ (HTTP ' . $http . ').');
}
// Отказ шлюза или Ollama: {"error": "..."} или {"error": {"message": "..."}}
if (isset($res['error'])) {
    $err = is_array($res['error']) ? (string)($res['error']['message'] ?? json_encode($res['error'], JSON_UNESCAPED_UNICODE)) : (string)$res['error'];
    // Модель не умеет вызывать инструменты — скажем об этом понятно.
    if (stripos($err, 'does not support tools') !== false) {
        studio_fail(400, "Модель «{$model}» не умеет вызывать инструменты. Укажите в .env AI_EXCEL_MODEL с поддержкой tools (например ministral-3:8b или qwen3).");
    }
    if (stripos($err, 'image') !== false && stripos($err, 'support') !== false) {
        studio_fail(400, "Модель «{$model}» не принимает картинки. Выключите «глаз» в панели или укажите мультимодальную модель в AI_EXCEL_MODEL.", ['noVision' => true]);
    }
    studio_fail($http >= 400 ? $http : 502, '⚠️ ' . $err);
}

$msg = $res['message'] ?? [];
$calls = [];
foreach (($msg['tool_calls'] ?? []) as $c) {
    $fn = $c['function'] ?? null;
    if (!is_array($fn) || !isset($fn['name'])) {
        continue;
    }
    $args = $fn['arguments'] ?? [];
    if (is_string($args)) {
        $decoded = json_decode($args, true);
        $args = is_array($decoded) ? $decoded : [];
    }
    $calls[] = ['function' => ['name' => (string)$fn['name'], 'arguments' => $args ?: new stdClass()]];
}

// Шлюз мог вернуть вызовы инструментов текстом (Qwen XML или JSON в <tool_call>) — разбираем сами.
$content = (string)($msg['content'] ?? '');
$textCalls = [];
if ($mode !== 'text') {
    [$textCalls, $content] = studio_text_tool_calls($content);
    if (!$calls) {
        $calls = $textCalls;
    } else {
        $textCalls = [];
    }
}

echo json_encode([
    'ok' => true,
    'model' => $res['model'] ?? $model,
    'message' => [
        'role' => 'assistant',
        'content' => $content,
        'tool_calls' => $calls,
    ],
    // Вызовы пришли текстом: панель запомнит это и дальше будет присылать историю текстом.
    'textTools' => $textTools || count($textCalls) > 0,
    'finish' => (string)($res['done_reason'] ?? ''),
    'usage' => [
        'prompt_tokens' => (int)($res['prompt_eval_count'] ?? 0),
        'completion_tokens' => (int)($res['eval_count'] ?? 0),
    ],
    'seconds' => round(microtime(true) - $started, 2),
    'context' => $contextMode,
] + (function_exists('dwt_fields') ? dwt_fields() : []), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

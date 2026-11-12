<?php
// studio/api/assistant.php — помощник AI-Excel: мост между панелью в браузере и моделью.
//
//   GET  assistant.php            проверка: вошёл ли пользователь, какая модель и откуда она взята
//   POST assistant.php            {mode: "advice"|"act", messages: [...]} → {ok, message: {content, tool_calls}}
//   POST assistant.php            {mode: "suggest", messages}  → подсказки (если приложение их умеет)
//   POST assistant.php            {mode: "text", …}            → ИИ у выделения (если есть context.php)
//
// Инструменты (find_commands, run_command…) выполняет браузер: только он видит запущенный
// редактор. Здесь — авторизация, системная инструкция, список разрешённых инструментов и запрос
// к модели. Откуда берётся модель и как с ней говорить (Ollama или OpenAI-совместимый сервер) —
// в llm.php, одинаковом для всех наших приложений.

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

require_once __DIR__ . '/llm.php';
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
$LLM = studio_llm_config('AI_EXCEL');

// ---------------------------------------------------------------- GET: проверка
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
    echo json_encode([
        'ok' => true,
        'model' => $LLM['model'],
        'ctx' => $LLM['ctx'],
        'api' => $LLM['api'],
        'source' => studio_llm_describe($LLM),
        'notes' => $LLM['notes'],
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
$hasText = is_file(__DIR__ . '/context.php');
$hasSuggest = function_exists('studio_suggest_prompt');
$mode = match (is_array($in) ? ($in['mode'] ?? '') : '') {
    'act' => 'act',
    'text' => $hasText ? 'text' : 'advice',
    'suggest' => $hasSuggest ? 'suggest' : 'advice',
    default => 'advice',
};
if (!is_array($in) || ($mode !== 'text' && (!isset($in['messages']) || !is_array($in['messages'])))) {
    studio_fail(400, 'Неверный формат запроса: нужен JSON {mode, messages}.');
}

/** Оставляет в сообщениях только то, что понимает модель, и проверяет размеры. */
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
            if ($imgs) {
                $msg['images'] = $imgs;
                $images += count($imgs);
            }
        }
        if ($role === 'assistant' && !empty($m['tool_calls']) && is_array($m['tool_calls'])) {
            $calls = [];
            foreach (array_slice($m['tool_calls'], 0, 16) as $c) {
                $fn = is_array($c) ? ($c['function'] ?? null) : null;
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
    // Разговор начинается с пользователя: результаты шагов без своего вызова модель путают.
    while ($out && $out[0]['role'] !== 'user') {
        array_shift($out);
    }
    if (!$out) {
        studio_fail(400, 'Пустой диалог.');
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
$textTools = !in_array($mode, ['text', 'suggest'], true) && !empty($in['textTools']);
if ($textTools) {
    foreach ($messages as &$m) {
        if ($m['role'] === 'assistant' && !empty($m['tool_calls'])) {
            foreach ($m['tool_calls'] as $c) {
                $block = '<tool_call>' . json_encode(['name' => $c['function']['name'], 'arguments' => $c['function']['arguments']], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . '</tool_call>';
                $m['content'] = trim($m['content'] . "\n" . $block);
            }
            unset($m['tool_calls']);
        } elseif ($m['role'] === 'tool') {
            $m = ['role' => 'user', 'content' => '[Результат инструмента ' . ($m['tool_name'] ?? '') . "]\n" . $m['content']];
        }
    }
    unset($m);
}
$tools = in_array($mode, ['text', 'suggest'], true) ? [] : studio_read_tools();
if ($mode === 'act') {
    $tools = array_merge($tools, studio_act_tools());
}
$system = match ($mode) {
    'text' => $textSystem,
    'suggest' => studio_suggest_prompt(),
    default => studio_system_prompt($mode),
};
// Текстовый протокол вызовов: описания инструментов — в инструкции, а не отдельным полем.
if ($textTools && $tools) {
    $system .= studio_llm_text_tools_prompt($tools);
    $tools = [];
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
// Пока модель думает, раз в 10 секунд отправляем в ответ пробел. Пробелы перед JSON
// ничего не ломают, а соединение не выглядит «зависшим»: роутеры, VPN и прокси между
// браузером и сервером часто рвут молчащие соединения, и браузер тогда пишет «Failed to fetch».
header('X-Accel-Buffering: no');
@ini_set('zlib.output_compression', '0');
while (ob_get_level() > 0) {
    @ob_end_flush();
}
$started = microtime(true);
$r = studio_llm_chat(
    $LLM,
    array_merge([['role' => 'system', 'content' => $system]], $messages),
    $tools,
    [
        'temperature' => $mode === 'text' ? 0.4 : 0.2,
        'max_tokens' => $STUDIO['max_tokens'],
        'timeout' => $STUDIO['timeout'],
        'json' => $mode === 'suggest',
    ],
    static function (): void {
        echo ' ';
        flush();
    },
    function_exists('enrichLLMPayload') ? static function (array &$payload): void {
        enrichLLMPayload($payload, 'ai-excel'); // трекинг на шлюзе, как у остальных приложений
    } : null,
);
if (is_array($r['raw'] ?? null) && function_exists('dwt_refused')) {
    $res = $r['raw'];
    dwt_refused($res);
}
if (!$r['ok']) {
    $err = (string)$r['error'];
    $where = ' (' . studio_llm_describe($LLM) . ')';
    if (stripos($err, 'image') !== false && (stripos($err, 'support') !== false || stripos($err, 'vision') !== false)) {
        studio_fail(400, "Модель «{$LLM['model']}» не принимает картинки. Выключите «глаз» в панели или укажите мультимодальную модель в AI_EXCEL_MODEL.", ['noVision' => true]);
    }
    if (preg_match('/not found|does not exist|unknown model|no such model/i', $err)) {
        studio_fail(502, "Модели «{$LLM['model']}» нет на сервере модели{$where}. Проверьте имя модели в .env.");
    }
    if ((int)$r['http'] === 0) {
        studio_fail(502, 'Модель недоступна: ' . $err . $where);
    }
    studio_fail((int)$r['http'] >= 400 ? (int)$r['http'] : 502, '⚠️ ' . $err . $where);
}

$calls = $r['tool_calls'];
// Модель могла вернуть вызовы инструментов текстом (Qwen XML или JSON в <tool_call>) — разбираем сами.
$content = (string)$r['content'];
$textCalls = [];
if (!in_array($mode, ['text', 'suggest'], true)) {
    [$textCalls, $content] = studio_text_tool_calls($content);
    if (!$calls) {
        $calls = $textCalls;
    } else {
        $textCalls = [];
    }
}

echo json_encode([
    'ok' => true,
    'model' => $r['model'] !== '' ? $r['model'] : $LLM['model'],
    'message' => [
        'role' => 'assistant',
        'content' => $content,
        'tool_calls' => $calls,
    ],
    // Вызовы пришли текстом: панель запомнит это и дальше будет присылать историю текстом.
    'textTools' => $textTools || !empty($r['textTools']) || count($textCalls) > 0,
    'finish' => $r['finish'],
    'usage' => [
        'prompt_tokens' => $r['usage']['prompt'],
        'completion_tokens' => $r['usage']['completion'],
    ],
    'seconds' => round(microtime(true) - $started, 2),
    'context' => $contextMode,
] + (function_exists('dwt_fields') ? dwt_fields() : []), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

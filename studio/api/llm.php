<?php
// studio/api/llm.php — откуда помощник берёт модель и как с ней разговаривает.
// Один и тот же файл во всех наших приложениях (AI Текст, AI Таблицы, AI Презентации, AI PDF, AI Фото,
// AI Вектор, AI Вёрстка, AI Макеты, AI Чертежи, AI Анимация, AI Звук, AI Видео).
//
// Главный источник настроек — файл .env вашей системы. Он ищется сам: рядом с приложением и выше
// по папкам (…/ai-word/api → …/ai-word → корень сайта → его родитель…), а также по пути из
// переменной AI_ENV_FILE. Значения из .env важнее переменных окружения процесса: если сервер
// запущен со старыми переменными, а .env поменяли, работает то, что написано в .env.
//
// Порядок для каждого параметра (первое найденное):
//   адрес:   <APP>_LLM_URL, <APP>_OLLAMA_URL  →  LLM_URL, OLLAMA_URL, OPENAI_BASE_URL (берутся как есть);
//            без них — первый отвечающий из: OLLAMA_IP + OLLAMA_PORT, OLLAMA_HOST (без порта — OLLAMA_PORT
//            или 11434, как у самой Ollama), $url_ollama из config.php системы, http://127.0.0.1:11434
//   модель:  <APP>_MODEL  →  GLOBAL_MODEL, LLM_MODEL, OLLAMA_MODEL, CHAT_MODEL, DEFAULT_MODEL
//            →  $global_model из config.php  →  первая модель, которую отдаёт сам сервер модели
//   контекст: <APP>_CONTEXT  →  GLOBAL_MODEL_CONTEXT, LLM_CONTEXT, OLLAMA_CTXSIZE, OLLAMA_NUM_CTX
//            →  $ollama_ctxsize  →  32768
//   ключ:    <APP>_API_KEY  →  LLM_API_KEY, OPENAI_API_KEY, OLLAMA_API_KEY  (для шлюзов с ключом)
//   протокол: <APP>_LLM_API / LLM_API = ollama | openai; без них — сам: адрес с /v1 → OpenAI-совместимый
//            (vLLM, GLM, LM Studio…), иначе Ollama, а если /api/chat нет — пробуется /v1.
// (<APP> — приставка приложения: AI_WORD_, AI_EXCEL_, AI_PHOTOSHOP_ …)
//
// Модель сверяется со списком моделей сервера (кэш 5 минут; LLM_MODEL_CHECK=0 — не сверять). Если указанной там нет — берётся
// подходящая из списка, а в панели помощника (подсказка у строки «Модель: …») написано, откуда
// взята модель и почему. Если сервер не умеет вызывать инструменты, помощник переходит на
// текстовый протокол вызовов сам.

declare(strict_types=1);

/** Значения из .env системы: [имя => [значение, файл]]. Ищется один раз за запрос. */
function studio_dotenv(): array
{
    static $vars = null;
    if ($vars !== null) {
        return $vars;
    }
    $vars = [];
    $files = [];
    $explicit = getenv('AI_ENV_FILE') ?: getenv('STUDIO_ENV_FILE') ?: '';
    if ($explicit !== '') {
        $files[] = $explicit;
    }
    $dir = __DIR__;
    for ($i = 0; $i < 7 && $dir !== '' && $dir !== '/' && $dir !== '.'; $i++) {
        $dir = dirname($dir);
        $files[] = $dir . '/.env';
    }
    $doc = (string)($_SERVER['DOCUMENT_ROOT'] ?? '');
    if ($doc !== '') {
        $files[] = rtrim($doc, '/') . '/.env';
        $files[] = dirname(rtrim($doc, '/')) . '/.env';
    }
    foreach (['/app/.env', '/var/www/.env', '/var/www/html/.env'] as $f) {
        $files[] = $f;
    }
    foreach (array_unique($files) as $f) {
        if (!@is_file($f) || !@is_readable($f)) {
            continue;
        }
        $text = @file_get_contents($f, false, null, 0, 1024 * 1024);
        if (!is_string($text)) {
            continue;
        }
        foreach (preg_split('/\R/', $text) ?: [] as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#') {
                continue;
            }
            if (!preg_match('/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/', $line, $m)) {
                continue;
            }
            $v = trim($m[2]);
            if ($v !== '' && ($v[0] === '"' || $v[0] === "'")) {
                $q = $v[0];
                $end = strpos($v, $q, 1);
                $v = $end === false ? substr($v, 1) : substr($v, 1, $end - 1);
            } else {
                $v = trim((string)preg_replace('/\s+#.*$/', '', $v));
            }
            if (!isset($vars[$m[1]])) {
                $vars[$m[1]] = [$v, $f];
            }
        }
        // Первый найденный .env — главный (ближайший к приложению).
        break;
    }
    return $vars;
}

/** Первое непустое значение из списка имён: сначала .env, потом окружение. [значение, откуда]. */
function studio_setting(array $names): array
{
    $env = studio_dotenv();
    foreach ($names as $n) {
        if (isset($env[$n]) && $env[$n][0] !== '') {
            return [$env[$n][0], '.env (' . $env[$n][1] . '): ' . $n];
        }
    }
    foreach ($names as $n) {
        $v = getenv($n);
        if ($v === false || $v === '') {
            $v = $_ENV[$n] ?? ($_SERVER[$n] ?? '');
        }
        if (is_string($v) && $v !== '') {
            return [$v, 'переменная окружения ' . $n];
        }
    }
    return ['', ''];
}

// Настройки приложений (settings.php, files.php) читают переменные так же: сначала .env системы.
if (!function_exists('studio_env')) {
    function studio_env(string $name, string $default = ''): string
    {
        [$v] = studio_setting([$name]);
        return $v === '' ? $default : $v;
    }
}

/** Глобальная переменная из config.php системы (если подключён). */
function studio_global(string $name): string
{
    $v = $GLOBALS[$name] ?? null;
    return (is_string($v) || is_int($v)) && trim((string)$v, ': ') !== '' ? (string)$v : '';
}

/** Где кэшировать список моделей и то, что сервер умеет. */
function studio_llm_cache_file(string $key): string
{
    return rtrim(sys_get_temp_dir(), '/') . '/studio-llm-' . md5($key) . '.json';
}
function studio_llm_cache_get(string $key, int $ttl): ?array
{
    $f = studio_llm_cache_file($key);
    $t = @filemtime($f);
    if ($t === false || time() - $t > $ttl) {
        return null;
    }
    $j = json_decode((string)@file_get_contents($f), true);
    return is_array($j) ? $j : null;
}
function studio_llm_cache_put(string $key, array $value): void
{
    // Кэш — только ускорение: не записался, значит, в следующий раз спросим сервер снова.
    @file_put_contents(studio_llm_cache_file($key), json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
}

/** Адрес с http:// в начале и без / в конце. $defaultPort — порт, если в адресе его нет ('' — не добавлять). */
function studio_llm_norm_url(string $url, string $defaultPort): string
{
    $url = trim($url);
    if (!preg_match('#^https?://#i', $url)) {
        $url = 'http://' . $url;
    }
    $url = rtrim($url, '/');
    $p = parse_url($url);
    if (!is_array($p) || !isset($p['host'])) {
        return $url;
    }
    $host = $p['host'] === '0.0.0.0' ? '127.0.0.1' : $p['host']; // 0.0.0.0 — адрес прослушивания, не адрес сервера
    $port = isset($p['port']) ? (string)$p['port'] : $defaultPort;
    return strtolower((string)($p['scheme'] ?? 'http')) . '://' . $host . ($port !== '' ? ':' . $port : '') . ($p['path'] ?? '');
}

/** Кандидаты адреса сервера модели, когда явный адрес не задан: [[адрес, откуда], …] по порядку. */
function studio_llm_url_candidates(): array
{
    $out = [];
    [$port] = studio_setting(['OLLAMA_PORT']);
    $port = preg_match('/^\d{1,5}$/', $port) ? $port : '11434';
    [$ip, $fromIp] = studio_setting(['OLLAMA_IP']);
    if ($ip !== '') {
        $out[] = [studio_llm_norm_url($ip, $port), $fromIp . ' + OLLAMA_PORT'];
    }
    [$host, $fromHost] = studio_setting(['OLLAMA_HOST']);
    if ($host !== '') {
        // Как у самой Ollama: в OLLAMA_HOST без порта подразумевается OLLAMA_PORT / 11434.
        $out[] = [studio_llm_norm_url($host, $port), $fromHost . ($port !== '11434' ? ' + OLLAMA_PORT' : ' (порт 11434)')];
        $out[] = [studio_llm_norm_url($host, ''), $fromHost];
    }
    if (($g = studio_global('url_ollama')) !== '') {
        $out[] = [studio_llm_norm_url($g, ''), 'config.php системы ($url_ollama)'];
    }
    $out[] = ['http://127.0.0.1:11434', 'по умолчанию'];
    $seen = [];
    return array_values(array_filter($out, function ($c) use (&$seen) {
        if (isset($seen[$c[0]])) {
            return false;
        }
        $seen[$c[0]] = true;
        return true;
    }));
}

/** Первый кандидат, который отвечает как сервер модели (/api/tags или /v1/models); кэш 5 минут. */
function studio_llm_pick_url(array $cands): array
{
    if (count($cands) === 1) {
        return $cands[0];
    }
    $cacheKey = 'url|' . implode('|', array_column($cands, 0));
    $cached = studio_llm_cache_get($cacheKey, 300);
    if ($cached !== null && isset($cached['i'], $cands[$cached['i']])) {
        return $cands[$cached['i']];
    }
    [$key] = studio_setting(['LLM_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_API_KEY']);
    $probe = ['key' => $key];
    $pick = 0;
    foreach ($cands as $i => [$u]) {
        foreach ([$u . '/api/tags', studio_llm_openai_base($u) . '/models'] as $test) {
            [$code, $body] = studio_llm_http($probe, 'GET', $test, null, 4, 2);
            $j = json_decode($body, true);
            if ($code === 200 && is_array($j) && (isset($j['models']) || isset($j['data']))) {
                $pick = $i;
                break 2;
            }
        }
    }
    // Если не ответил никто, $pick = 0: берём первый, и ошибка в панели покажет, куда шли.
    studio_llm_cache_put($cacheKey, ['i' => $pick]);
    return $cands[$pick];
}

/** Настройки модели для приложения с приставкой $prefix (например AI_WORD). */
function studio_llm_config(string $prefix): array
{
    $src = [];
    // ----- адрес
    // Явный адрес (<APP>_LLM_URL, <APP>_OLLAMA_URL, LLM_URL, OLLAMA_URL, OPENAI_BASE_URL) берётся как есть.
    // Иначе собираются кандидаты — OLLAMA_IP + OLLAMA_PORT, OLLAMA_HOST, $url_ollama из config.php,
    // http://127.0.0.1:11434 — и берётся первый, который действительно отвечает как сервер модели.
    [$url, $from] = studio_setting(["{$prefix}_LLM_URL", "{$prefix}_OLLAMA_URL"]);
    if ($url === '') {
        [$url, $from] = studio_setting(['LLM_URL', 'OLLAMA_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE']);
    }
    if ($url !== '') {
        $url = studio_llm_norm_url($url, '');
    } else {
        [$url, $from] = studio_llm_pick_url(studio_llm_url_candidates());
    }
    $src['url'] = $from;

    // ----- протокол
    [$api] = studio_setting(["{$prefix}_LLM_API", 'LLM_API']);
    $api = strtolower($api);
    if (!in_array($api, ['ollama', 'openai'], true)) {
        $api = preg_match('#/v\d+$#', $url) ? 'openai' : 'auto';
    }

    // ----- ключ
    [$key] = studio_setting(["{$prefix}_API_KEY", 'LLM_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_API_KEY']);

    // ----- контекст
    [$ctx, $fromCtx] = studio_setting(["{$prefix}_CONTEXT", 'GLOBAL_MODEL_CONTEXT', 'LLM_CONTEXT', 'OLLAMA_CTXSIZE', 'OLLAMA_NUM_CTX']);
    if ((int)$ctx <= 0 && (int)studio_global('ollama_ctxsize') > 0) {
        [$ctx, $fromCtx] = [studio_global('ollama_ctxsize'), 'config.php системы ($ollama_ctxsize)'];
    }
    if ((int)$ctx <= 0) {
        [$ctx, $fromCtx] = ['32768', 'по умолчанию'];
    }
    $src['ctx'] = $fromCtx;

    // ----- модель
    [$model, $fromModel] = studio_setting(["{$prefix}_MODEL"]);
    if ($model === '') {
        [$model, $fromModel] = studio_setting(['GLOBAL_MODEL', 'LLM_MODEL', 'OLLAMA_MODEL', 'CHAT_MODEL', 'DEFAULT_MODEL']);
    }
    if ($model === '' && ($g = studio_global('global_model')) !== '') {
        [$model, $fromModel] = [$g, 'config.php системы ($global_model)'];
    }
    $src['model'] = $fromModel !== '' ? $fromModel : 'не указана';

    $cfg = [
        'url' => $url,
        'api' => $api,
        'key' => $key,
        'ctx' => max(4096, min(1048576, (int)$ctx)),
        'model' => $model,
        'sources' => $src,
        'notes' => [],
    ];
    return studio_llm_check_model($cfg);
}

/** HTTP-запрос к серверу модели. [код, тело, ошибка curl]. */
function studio_llm_http(array $cfg, string $method, string $url, ?string $body, int $timeout, int $connect = 5): array
{
    $ch = curl_init($url);
    $headers = ['Accept: application/json'];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
    }
    if (($cfg['key'] ?? '') !== '') {
        $headers[] = 'Authorization: Bearer ' . $cfg['key'];
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CONNECTTIMEOUT => $connect,
        CURLOPT_TIMEOUT => $timeout,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    $out = curl_exec($ch);
    $err = curl_error($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$code, is_string($out) ? $out : '', $err];
}

/** Адрес OpenAI-совместимого API: …/v1 (если в адресе его нет — добавляется). */
function studio_llm_openai_base(string $url): string
{
    return preg_match('#/v\d+$#', $url) ? $url : $url . '/v1';
}

/** Модели, которые отдаёт сервер (кэш 5 минут). null — список получить не удалось. */
function studio_llm_models(array &$cfg): ?array
{
    $cacheKey = 'models|' . $cfg['url'] . '|' . $cfg['api'];
    $cached = studio_llm_cache_get($cacheKey, 300);
    if ($cached !== null) {
        if (($cached['api'] ?? '') !== '' && $cfg['api'] === 'auto') {
            $cfg['api'] = $cached['api'];
        }
        return is_array($cached['models'] ?? null) ? $cached['models'] : null;
    }
    $models = null;
    $found = $cfg['api'];
    if ($cfg['api'] !== 'openai') {
        [$code, $body] = studio_llm_http($cfg, 'GET', $cfg['url'] . '/api/tags', null, 6);
        $j = json_decode($body, true);
        if ($code === 200 && is_array($j) && isset($j['models']) && is_array($j['models'])) {
            $models = [];
            foreach ($j['models'] as $m) {
                $n = is_array($m) ? (string)($m['name'] ?? $m['model'] ?? '') : '';
                if ($n !== '') {
                    $models[] = $n;
                }
            }
            $found = 'ollama';
        }
    }
    if ($models === null && $cfg['api'] !== 'ollama') {
        [$code, $body] = studio_llm_http($cfg, 'GET', studio_llm_openai_base($cfg['url']) . '/models', null, 6);
        $j = json_decode($body, true);
        if ($code === 200 && is_array($j) && isset($j['data']) && is_array($j['data'])) {
            $models = [];
            foreach ($j['data'] as $m) {
                $n = is_array($m) ? (string)($m['id'] ?? '') : '';
                if ($n !== '') {
                    $models[] = $n;
                }
            }
            $found = 'openai';
        }
    }
    if ($cfg['api'] === 'auto' && $found !== 'auto') {
        $cfg['api'] = $found;
    }
    studio_llm_cache_put($cacheKey, ['models' => $models, 'api' => $found === 'auto' ? '' : $found]);
    return $models;
}

/** Сверяет модель со списком сервера; если её там нет (или она не указана) — берёт подходящую. */
function studio_llm_check_model(array $cfg): array
{
    // LLM_MODEL_CHECK=0 — не сверять (шлюз принимает имена-псевдонимы, которых нет в его списке).
    [$check] = studio_setting(['LLM_MODEL_CHECK']);
    if ($check === '0' && $cfg['model'] !== '') {
        return $cfg;
    }
    $models = studio_llm_models($cfg);
    if ($models === null || !$models) {
        if ($cfg['model'] === '') {
            $cfg['model'] = 'chat';
            $cfg['sources']['model'] = 'не указана, а список моделей сервер не отдал — пробую «chat»';
        }
        return $cfg;
    }
    $want = $cfg['model'];
    $norm = static fn(string $n): string => strtolower(preg_replace('/:latest$/i', '', $n) ?? $n);
    foreach ($models as $m) {
        if ($want !== '' && $norm($m) === $norm($want)) {
            $cfg['model'] = $m;
            return $cfg;
        }
    }
    // Не для чата: эмбеддинги, переранжирование, распознавание речи.
    $chat = array_values(array_filter($models, static fn(string $m): bool => !preg_match('/embed|bge|rerank|whisper|e5-|minilm|nomic/i', $m)));
    $pool = $chat ?: $models;
    $pick = $pool[0];
    if ($want !== '') {
        $base = $norm(preg_replace('/[:@].*$/', '', $want) ?? $want);
        foreach ($pool as $m) {
            if ($base !== '' && str_contains($norm($m), $base)) {
                $pick = $m;
                break;
            }
        }
        $cfg['notes'][] = "Модели «{$want}» ({$cfg['sources']['model']}) на сервере нет — беру «{$pick}». Есть: " . implode(', ', array_slice($models, 0, 12));
        $cfg['sources']['model'] = "«{$want}» нет на сервере, взята «{$pick}» из списка сервера";
    } else {
        $cfg['sources']['model'] = 'не указана — первая модель сервера';
    }
    $cfg['model'] = $pick;
    return $cfg;
}

/** Кратко, откуда взяты настройки (для подсказки в панели и для сообщений об ошибках). */
function studio_llm_describe(array $cfg): string
{
    $s = $cfg['sources'];
    return "модель — {$s['model']}; адрес {$cfg['url']} — {$s['url']}; контекст {$cfg['ctx']} — {$s['ctx']}"
        . ($cfg['api'] !== 'auto' ? '; протокол ' . ($cfg['api'] === 'openai' ? 'OpenAI-совместимый' : 'Ollama') : '');
}

/** Изображение base64 → data:URL с правильным типом. */
function studio_llm_data_url(string $b64): string
{
    $type = str_starts_with($b64, '/9j/') ? 'image/jpeg' : (str_starts_with($b64, 'UklGR') ? 'image/webp' : 'image/png');
    return 'data:' . $type . ';base64,' . $b64;
}

/** Сообщения в формате Ollama → формат OpenAI (id вызовов, картинки, результаты инструментов). */
function studio_llm_to_openai(array $messages): array
{
    $out = [];
    $pending = [];
    $n = 0;
    foreach ($messages as $m) {
        $role = (string)($m['role'] ?? 'user');
        $content = (string)($m['content'] ?? '');
        if ($role === 'assistant') {
            $o = ['role' => 'assistant', 'content' => $content];
            $pending = [];
            if (!empty($m['tool_calls']) && is_array($m['tool_calls'])) {
                $o['tool_calls'] = [];
                foreach ($m['tool_calls'] as $c) {
                    $name = (string)($c['function']['name'] ?? '');
                    if ($name === '') {
                        continue;
                    }
                    $id = 'call_' . (++$n);
                    $pending[] = [$id, $name];
                    $args = $c['function']['arguments'] ?? [];
                    $o['tool_calls'][] = ['id' => $id, 'type' => 'function', 'function' => [
                        'name' => $name,
                        'arguments' => is_string($args) ? $args : (json_encode($args ?: new stdClass(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}'),
                    ]];
                }
                if (!$o['tool_calls']) {
                    unset($o['tool_calls']);
                } elseif ($content === '') {
                    $o['content'] = null;
                }
            }
            $out[] = $o;
        } elseif ($role === 'tool') {
            $name = (string)($m['tool_name'] ?? '');
            $idx = null;
            foreach ($pending as $i => [$pid, $pname]) {
                if ($pname === $name) {
                    $idx = $i;
                    break;
                }
            }
            if ($idx === null && $pending) {
                $idx = array_key_first($pending);
            }
            if ($idx === null) {
                // Результат без вызова (история сокращена): передаём как обычный текст.
                $out[] = ['role' => 'user', 'content' => '[Результат инструмента ' . $name . "]\n" . $content];
                continue;
            }
            $out[] = ['role' => 'tool', 'tool_call_id' => $pending[$idx][0], 'content' => $content];
            unset($pending[$idx]);
        } else {
            if (!empty($m['images']) && is_array($m['images'])) {
                $parts = [['type' => 'text', 'text' => $content]];
                foreach ($m['images'] as $img) {
                    $parts[] = ['type' => 'image_url', 'image_url' => ['url' => studio_llm_data_url((string)$img)]];
                }
                $out[] = ['role' => $role, 'content' => $parts];
            } else {
                $out[] = ['role' => $role, 'content' => $content];
            }
        }
    }
    return $out;
}

/** Инструменты текстом — для серверов, которые не принимают tools. */
function studio_llm_text_tools_prompt(array $tools): string
{
    $lines = [];
    foreach ($tools as $t) {
        $f = $t['function'] ?? [];
        $lines[] = '- ' . ($f['name'] ?? '') . ': ' . ($f['description'] ?? '') . "\n  параметры: "
            . (json_encode($f['parameters'] ?? new stdClass(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}');
    }
    return "\n\nИНСТРУМЕНТЫ. Чтобы вызвать инструмент, напиши в ответе блок\n"
        . "<tool_call>{\"name\": \"ИМЯ\", \"arguments\": {…}}</tool_call>\n"
        . "(можно несколько блоков подряд) и больше ничего не пиши в этом ответе — результат придёт следующим сообщением. "
        . "Когда задача выполнена, ответь обычным текстом без блоков. Доступные инструменты:\n" . implode("\n", $lines);
}

/** История вызовов инструментов — текстом (для текстового протокола). */
function studio_llm_history_as_text(array $messages): array
{
    foreach ($messages as &$m) {
        if (($m['role'] ?? '') === 'assistant' && !empty($m['tool_calls'])) {
            foreach ($m['tool_calls'] as $c) {
                $m['content'] = trim((string)($m['content'] ?? '') . "\n<tool_call>"
                    . json_encode(['name' => $c['function']['name'] ?? '', 'arguments' => $c['function']['arguments'] ?? new stdClass()], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
                    . '</tool_call>');
            }
            unset($m['tool_calls']);
        } elseif (($m['role'] ?? '') === 'tool') {
            $m = ['role' => 'user', 'content' => '[Результат инструмента ' . ($m['tool_name'] ?? '') . "]\n" . (string)($m['content'] ?? '')];
        }
    }
    unset($m);
    return $messages;
}

/** Сервер явно отказался принимать инструменты? */
function studio_llm_no_tools_error(string $err): bool
{
    return (bool)preg_match('/does not support tools|tool.?choice|enable-auto-tool-choice|tools? (are|is) not supported|unsupported.*tool|tool.*not supported|no tool parser/i', $err);
}

/**
 * Один запрос к модели. $messages — в формате Ollama (с system первым), $tools — описания
 * (как у Ollama/OpenAI). Пока модель думает, раз в 10 секунд вызывается $beat (держит соединение).
 * Возвращает ['ok', 'http', 'error', 'content', 'tool_calls' (формат Ollama), 'model', 'finish',
 * 'usage' => [prompt, completion], 'raw', 'textTools' (инструменты ушли текстом)].
 */
function studio_llm_chat(array &$cfg, array $messages, array $tools, array $opt, ?callable $beat = null, ?callable $enrich = null): array
{
    $noTools = studio_llm_cache_get('notools|' . $cfg['url'] . '|' . $cfg['model'], 86400) !== null;
    $textTools = false;
    if ($tools && $noTools) {
        $messages = studio_llm_history_as_text($messages);
        $messages[0]['content'] = (string)$messages[0]['content'] . studio_llm_text_tools_prompt($tools);
        $tools = [];
        $textTools = true;
    }
    $attempts = $cfg['api'] === 'auto' ? ['ollama', 'openai'] : [$cfg['api']];
    $last = ['ok' => false, 'http' => 0, 'error' => 'нет ответа', 'raw' => null];
    foreach ($attempts as $api) {
        if ($api === 'ollama') {
            $payload = [
                'model' => $cfg['model'],
                'messages' => $messages,
                'stream' => false,
                'think' => false,
                'options' => [
                    'temperature' => $opt['temperature'] ?? 0.2,
                    'num_predict' => max(256, (int)($opt['max_tokens'] ?? 2048)),
                    'num_ctx' => $cfg['ctx'],
                ],
            ];
            if (!empty($opt['json'])) {
                $payload['format'] = 'json';
            }
            if ($tools) {
                $payload['tools'] = $tools;
            }
            $endpoint = $cfg['url'] . '/api/chat';
        } else {
            $payload = [
                'model' => $cfg['model'],
                'messages' => studio_llm_to_openai($messages),
                'stream' => false,
                'temperature' => $opt['temperature'] ?? 0.2,
                'max_tokens' => max(256, (int)($opt['max_tokens'] ?? 2048)),
            ];
            if (!empty($opt['json'])) {
                $payload['response_format'] = ['type' => 'json_object'];
            }
            if ($tools) {
                $payload['tools'] = $tools;
                $payload['tool_choice'] = 'auto';
            }
            $endpoint = studio_llm_openai_base($cfg['url']) . '/chat/completions';
        }
        if ($enrich) {
            $enrich($payload);
        }
        $r = studio_llm_post($cfg, $endpoint, $payload, (int)($opt['timeout'] ?? 180), $beat);
        // Протокол не тот (нет такого адреса) — пробуем следующий.
        if (($r['http'] === 404 || $r['http'] === 405) && count($attempts) > 1 && $api === 'ollama') {
            $last = $r;
            continue;
        }
        $res = $r['raw'];
        if ($r['error'] === '' && is_array($res) && !isset($res['error'])) {
            if ($cfg['api'] === 'auto') {
                $cfg['api'] = $api;
                studio_llm_cache_put('models|' . $cfg['url'] . '|auto', ['models' => null, 'api' => $api]);
            }
            return studio_llm_normalize($api, $res, $cfg['model'], $r['http'], $textTools);
        }
        $err = $r['error'];
        if (is_array($res) && isset($res['error'])) {
            $err = is_array($res['error']) ? (string)($res['error']['message'] ?? json_encode($res['error'], JSON_UNESCAPED_UNICODE)) : (string)$res['error'];
        } elseif ($err === '' && is_string($res ?? null)) {
            $err = $res;
        }
        // Сервер не принимает инструменты — запоминаем и повторяем с текстовым протоколом.
        if ($tools && studio_llm_no_tools_error($err)) {
            studio_llm_cache_put('notools|' . $cfg['url'] . '|' . $cfg['model'], ['since' => time()]);
            $messages = studio_llm_history_as_text($messages);
            $messages[0]['content'] = (string)$messages[0]['content'] . studio_llm_text_tools_prompt($tools);
            $tools = [];
            $textTools = true;
            $r2 = studio_llm_chat_once($cfg, $api, $messages, $opt, $beat, $enrich);
            $r2['textTools'] = true;
            return $r2;
        }
        return ['ok' => false, 'http' => $r['http'], 'error' => $err !== '' ? $err : ('HTTP ' . $r['http']), 'raw' => $res, 'textTools' => $textTools];
    }
    return $last + ['textTools' => $textTools];
}

/** Повтор запроса тем же протоколом без инструментов. */
function studio_llm_chat_once(array &$cfg, string $api, array $messages, array $opt, ?callable $beat, ?callable $enrich): array
{
    $saved = $cfg['api'];
    $cfg['api'] = $api;
    $r = studio_llm_chat($cfg, $messages, [], $opt, $beat, $enrich);
    if ($saved !== 'auto') {
        $cfg['api'] = $saved;
    }
    return $r;
}

/** POST с «пульсом»: пока модель думает, $beat вызывается раз в 10 секунд. */
function studio_llm_post(array $cfg, string $url, array $payload, int $timeout, ?callable $beat): array
{
    $ch = curl_init($url);
    $headers = ['Content-Type: application/json', 'Accept: application/json'];
    if (($cfg['key'] ?? '') !== '') {
        $headers[] = 'Authorization: Bearer ' . $cfg['key'];
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE),
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => max(30, $timeout),
    ]);
    $started = microtime(true);
    $mh = curl_multi_init();
    curl_multi_add_handle($mh, $ch);
    $lastBeat = microtime(true);
    do {
        $status = curl_multi_exec($mh, $running);
        if ($running) {
            curl_multi_select($mh, 1.0);
        }
        if ($beat && microtime(true) - $lastBeat >= 10) {
            $beat();
            $lastBeat = microtime(true);
        }
    } while ($running && $status === CURLM_OK);
    $body = curl_multi_getcontent($ch);
    $err = curl_error($ch);
    if ($err === '') {
        $info = curl_multi_info_read($mh);
        if (is_array($info) && ($info['result'] ?? CURLE_OK) !== CURLE_OK) {
            $err = curl_strerror((int)$info['result']);
        }
    }
    $http = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_multi_remove_handle($mh, $ch);
    curl_multi_close($mh);
    curl_close($ch);
    if ($http === 0 && $err === '') {
        $err = 'нет ответа от модели за ' . round(microtime(true) - $started) . ' с';
    }
    $raw = null;
    if (is_string($body) && $body !== '') {
        $raw = json_decode($body, true);
        if (!is_array($raw)) {
            $raw = $http >= 400 ? mb_substr(trim(strip_tags($body)), 0, 300) : null;
        }
    }
    if ($err === '' && $raw === null) {
        $err = $http >= 300 && $http < 400
            ? 'по этому адресу отвечает не сервер модели, а веб-сайт (переадресация, HTTP ' . $http . '): проверьте адрес и порт — у Ollama обычно :11434'
            : 'модель вернула непонятный ответ (HTTP ' . $http . ')';
    }
    return ['http' => $http, 'error' => $err, 'raw' => $raw];
}

/** Ответ Ollama или OpenAI → общий вид. */
function studio_llm_normalize(string $api, array $res, string $model, int $http, bool $textTools): array
{
    if ($api === 'openai') {
        $choice = $res['choices'][0] ?? [];
        $msg = is_array($choice['message'] ?? null) ? $choice['message'] : [];
        $usage = ['prompt' => (int)($res['usage']['prompt_tokens'] ?? 0), 'completion' => (int)($res['usage']['completion_tokens'] ?? 0)];
        $finish = (string)($choice['finish_reason'] ?? '');
    } else {
        $msg = is_array($res['message'] ?? null) ? $res['message'] : [];
        $usage = ['prompt' => (int)($res['prompt_eval_count'] ?? 0), 'completion' => (int)($res['eval_count'] ?? 0)];
        $finish = (string)($res['done_reason'] ?? '');
    }
    $calls = [];
    foreach ((array)($msg['tool_calls'] ?? []) as $c) {
        $fn = is_array($c) ? ($c['function'] ?? null) : null;
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
    $content = $msg['content'] ?? '';
    if (is_array($content)) {
        $text = '';
        foreach ($content as $part) {
            $text .= is_array($part) ? (string)($part['text'] ?? '') : (string)$part;
        }
        $content = $text;
    }
    // Размышления модели (<think>…</think>) пользователю не показываем.
    $content = trim((string)preg_replace('#<think>[\s\S]*?</think>#', '', (string)$content));
    return [
        'ok' => true,
        'http' => $http,
        'error' => '',
        'content' => $content,
        'tool_calls' => $calls,
        'model' => (string)($res['model'] ?? $model),
        'finish' => $finish,
        'usage' => $usage,
        'raw' => $res,
        'textTools' => $textTools,
    ];
}

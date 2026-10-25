<?php
// studio/api/settings.php — настройки помощника AI-Excel.
//
// Всё читается из окружения (.env вашей системы), поэтому этот файл обычно
// трогать не нужно. Любую строку можно переопределить переменной окружения.
//
//   AI_EXCEL_AUTH_FILE       путь к auth.php системы (по умолчанию ищется
//                            на два уровня выше: /app/src/auth.php)
//   AI_EXCEL_ALLOW_ANON      1 — работать без входа (только для теста на localhost!)
//   AI_EXCEL_OLLAMA_URL      адрес Ollama/шлюза, например http://10.0.0.5:11434
//                            (по умолчанию берётся OLLAMA_IP:OLLAMA_PORT из config.php)
//   AI_EXCEL_MODEL           модель помощника (по умолчанию GLOBAL_MODEL)
//   AI_EXCEL_CONTEXT         размер контекста (по умолчанию GLOBAL_MODEL_CONTEXT или 32768)
//   AI_EXCEL_TIMEOUT         сколько секунд ждать ответа модели (по умолчанию 180)
//   AI_EXCEL_MAX_TOKENS      максимум токенов в ответе (по умолчанию 2048)
//

if (!function_exists('studio_env')) {
    function studio_env(string $name, string $default = ''): string
    {
        $v = getenv($name);
        if ($v === false || $v === '') {
            $v = $_ENV[$name] ?? '';
        }
        return ($v === '' || $v === false) ? $default : (string)$v;
    }
}

$__studioAuth = studio_env('AI_EXCEL_AUTH_FILE');
if ($__studioAuth === '') {
    foreach ([__DIR__ . '/../../auth.php', __DIR__ . '/../../../auth.php', '/app/src/auth.php'] as $__p) {
        if (is_file($__p)) { $__studioAuth = $__p; break; }
    }
}

return [
    // Файл авторизации системы. Пусто — не найден.
    'auth_file'       => $__studioAuth,
    // Без входа работать нельзя, если явно не разрешено.
    'allow_anonymous' => studio_env('AI_EXCEL_ALLOW_ANON') === '1',
    // Ограничения запроса от браузера.
    'max_body_bytes'  => 16 * 1024 * 1024,   // скриншоты в base64 тяжёлые
    'max_messages'    => 80,
    'max_images'      => 2,
    'max_image_bytes' => 6 * 1024 * 1024,
    // Модель и время ожидания (адрес и модель досчитываются в assistant.php
    // после подключения config.php системы).
    'timeout'         => (int)studio_env('AI_EXCEL_TIMEOUT', '180'),
    'max_tokens'      => (int)studio_env('AI_EXCEL_MAX_TOKENS', '2048'),
];

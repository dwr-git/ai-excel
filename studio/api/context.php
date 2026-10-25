<?php
// studio/api/context.php — ИИ-помощник у выделенных ячеек («ИИ» у выделения и «ИИ-помощник…» в
// контекстном меню ячеек). Подключается из assistant.php для запросов
// {mode: "text", op, custom?, extra?, selection: {range, sheet, values, formulas}, context, workbook}.
//
// Модель видит выделенные ячейки и (для смысла) начало листа, а отвечает в виде, который панель
// умеет вставить обратно: таблицей JSON той же формы, одной формулой, текстом или описанием диаграммы.

declare(strict_types=1);

/** Больше этого символов выделения и контекста листа не передаём. */
const STUDIO_CONTEXT_SELECTION_CHARS = 60000;
const STUDIO_CONTEXT_SHEET_CHARS = 24000;

/** Что возвращает операция: grid (JSON-таблица той же формы), formula, text или chart. */
function studio_context_kind(string $op): string
{
    if (str_starts_with($op, 'translate_') || in_array($op, ['clean', 'fix_typos', 'extract_numbers', 'proper_names'], true)) {
        return 'grid';
    }
    if ($op === 'categorize') {
        return 'column';
    }
    if (in_array($op, ['write_formula', 'fix_formula'], true)) {
        return 'formula';
    }
    if ($op === 'suggest_chart') {
        return 'chart';
    }
    return 'text';
}

/** Задания операций меню. Ключи — id пунктов меню в studio.js. */
function studio_context_prompt(string $op): ?string
{
    $grid = ' Верни ТОЛЬКО JSON-массив строк той же формы, что выделение (столько же строк и столбцов), '
        . 'например [["…","…"],["…","…"]]. Числа — числами, пустые ячейки — пустой строкой. Формулы (значения, начинающиеся с «=») не меняй. Без пояснений и без ```.';
    $p = [
        'explain_formula' => 'Объясни простыми словами, что считают формулы в выделенных ячейках: по шагам, какие диапазоны и функции участвуют и что получится. Если формул нет — объясни, что за данные выделены.',
        'write_formula' => 'Напиши ОДНУ формулу Excel для активной ячейки по описанию пользователя. Имена функций — английские (SUM, IF, VLOOKUP, XLOOKUP, SUMIFS, COUNTIF, TEXT, DATE…), аргументы через запятую, адреса — из листа ниже. '
            . 'Верни ТОЛЬКО формулу, начиная со знака «=», одной строкой, без пояснений и без ```.',
        'fix_formula' => 'Найди ошибку в формуле активной ячейки (или объясни, почему она даёт ошибку) и верни исправленную формулу. '
            . 'Имена функций — английские, аргументы через запятую. Верни ТОЛЬКО формулу, начиная со знака «=», одной строкой.',
        'clean' => 'Очисти и приведи к единому виду значения: убери лишние пробелы и мусорные символы, единообразно запиши даты (ДД.ММ.ГГГГ), числа (без пробелов-разделителей, десятичная точка), телефоны и названия.' . $grid,
        'fix_typos' => 'Исправь опечатки и ошибки в тексте ячеек, ничего больше не меняя.' . $grid,
        'proper_names' => 'Приведи регистр к правильному: ФИО и названия — с заглавной буквы, остальной текст — как в предложении.' . $grid,
        'extract_numbers' => 'Извлеки из текста каждой ячейки число (сумму, количество) и верни его числом; если числа нет — пустую строку.' . $grid,
        'categorize' => 'Отнеси каждую строку выделения к понятной категории (3–8 категорий на всё выделение, короткие русские названия). '
            . 'Верни ТОЛЬКО JSON-массив строк из одного столбца — по категории на строку выделения, например [["Продукты"],["Транспорт"]]. Без пояснений.',
        'summarize' => 'Кратко опиши данные: что это за таблица, сколько строк, ключевые итоги (суммы, средние, максимумы) и 3–5 главных наблюдений. Маркированным списком Markdown.',
        'insights' => 'Найди в данных тренды, сезонность, лидеров и отстающих, резкие изменения. 3–7 выводов с конкретными числами, маркированным списком Markdown.',
        'check_data' => 'Проверь данные: пропуски, дубликаты, выбросы, числа, записанные текстом, несогласованные форматы дат и единиц, подозрительные значения. '
            . 'Для каждой находки — адрес ячейки или строки и что не так, списком Markdown. Если проблем нет — напиши «Проблем не найдено».',
        'suggest_chart' => 'Подбери лучшую диаграмму для выделенных данных. Верни ТОЛЬКО JSON-объект: '
            . '{"type": "column|bar|line|pie|area|scatter|doughnut", "title": "заголовок по-русски", "reason": "одно предложение, почему эта диаграмма"}. Без ```.',
    ];
    $langs = ['translate_ru' => 'русский', 'translate_en' => 'английский', 'translate_be' => 'белорусский',
        'translate_de' => 'немецкий', 'translate_fr' => 'французский', 'translate_es' => 'испанский', 'translate_zh' => 'китайский'];
    if (isset($langs[$op])) {
        return "Переведи текст ячеек на {$langs[$op]} язык. Числа, даты, коды и формулы не меняй." . $grid;
    }
    return $p[$op] ?? null;
}

/** Таблица значений в текст TSV с номерами строк и буквами столбцов, не длиннее $limit символов. */
function studio_context_tsv(array $rows, string $origin, int $limit): string
{
    [$col0, $row0] = studio_context_origin($origin);
    $out = [];
    $size = 0;
    $width = 0;
    foreach ($rows as $r) {
        if (is_array($r)) {
            $width = max($width, count($r));
        }
    }
    $width = min($width, 60);
    $head = "\t";
    for ($c = 0; $c < $width; $c++) {
        $head .= studio_context_col($col0 + $c) . ($c + 1 < $width ? "\t" : '');
    }
    $out[] = $head;
    foreach (array_values($rows) as $i => $r) {
        if (!is_array($r)) {
            continue;
        }
        $cells = [];
        foreach (array_slice(array_values($r), 0, $width) as $v) {
            if (is_array($v)) {
                $v = isset($v['error']) ? (string)$v['error'] : json_encode($v, JSON_UNESCAPED_UNICODE);
            } elseif (is_bool($v)) {
                $v = $v ? 'TRUE' : 'FALSE';
            } elseif ($v === null) {
                $v = '';
            }
            $cells[] = str_replace(["\t", "\r", "\n"], ' ', mb_substr((string)$v, 0, 300, 'UTF-8'));
        }
        $line = ($row0 + $i) . "\t" . implode("\t", $cells);
        $size += mb_strlen($line, 'UTF-8') + 1;
        if ($size > $limit) {
            $out[] = '… (дальше строки не показаны)';
            break;
        }
        $out[] = $line;
    }
    return implode("\n", $out);
}

/** Буквы столбца по номеру с 0 (0 → A, 26 → AA). */
function studio_context_col(int $n): string
{
    $s = '';
    $n = max(0, min($n, 16383)) + 1;
    while ($n > 0) {
        $m = ($n - 1) % 26;
        $s = chr(65 + $m) . $s;
        $n = intdiv($n - 1, 26);
    }
    return $s;
}

/** Левая верхняя ячейка диапазона «B2:D9» (или «Лист!B2:D9») → [столбец с 0, строка с 1]. */
function studio_context_origin(string $range): array
{
    $range = preg_replace('/^.*!/u', '', $range) ?? '';
    if (!preg_match('/^\$?([A-Za-z]{1,3})\$?(\d{1,7})/', $range, $m)) {
        return [0, 1];
    }
    $col = 0;
    foreach (str_split(strtoupper($m[1])) as $ch) {
        $col = $col * 26 + (ord($ch) - 64);
    }
    return [max(0, $col - 1), max(1, (int)$m[2])];
}

/**
 * Системная инструкция и сообщения для модели по запросу панели.
 * Возвращает [system, messages, contextMode]; при ошибке завершает запрос через studio_fail.
 */
function studio_context_request(array $in): array
{
    $op = is_string($in['op'] ?? null) ? trim($in['op']) : '';
    $custom = is_string($in['custom'] ?? null) ? trim(mb_substr($in['custom'], 0, 4000, 'UTF-8')) : '';
    $extra = is_string($in['extra'] ?? null) ? trim(mb_substr($in['extra'], 0, 2000, 'UTF-8')) : '';
    $sel = is_array($in['selection'] ?? null) ? $in['selection'] : [];
    $range = is_string($sel['range'] ?? null) ? mb_substr($sel['range'], 0, 200, 'UTF-8') : '';
    $sheet = is_string($sel['sheet'] ?? null) ? mb_substr($sel['sheet'], 0, 100, 'UTF-8') : '';
    $active = is_string($sel['active'] ?? null) ? mb_substr($sel['active'], 0, 20, 'UTF-8') : '';
    $values = is_array($sel['values'] ?? null) ? $sel['values'] : [];
    $formulas = is_array($sel['formulas'] ?? null) ? $sel['formulas'] : [];
    $ctx = is_array($in['context'] ?? null) ? $in['context'] : [];
    $ctxRange = is_string($ctx['range'] ?? null) ? mb_substr($ctx['range'], 0, 200, 'UTF-8') : '';
    $ctxValues = is_array($ctx['values'] ?? null) ? $ctx['values'] : [];
    $sheets = is_array($in['workbook']['sheets'] ?? null) ? array_slice(array_filter($in['workbook']['sheets'], 'is_string'), 0, 50) : [];

    if ($custom !== '') {
        $task = $op === 'write_formula'
            ? studio_context_prompt('write_formula') . "\n\nОписание: " . $custom
            : $custom;
    } else {
        $task = studio_context_prompt($op);
        if ($task === null) {
            studio_fail(400, 'Неизвестная операция: ' . $op);
        }
    }
    if ($extra !== '') {
        $task .= "\n\nДополнительное пожелание: " . $extra;
    }
    if ($custom !== '' && $op !== 'write_formula') {
        $task .= "\n\nЕсли ответ — новые значения для выделенных ячеек, верни ТОЛЬКО JSON-массив строк той же формы, что выделение. "
            . 'Если ответ — одна формула, верни только её, начиная со «=». Иначе отвечай коротким текстом (Markdown).';
    }

    $system = implode("\n", [
        'Ты — ИИ-помощник, встроенный в табличный редактор AI-Excel (по возможностям как Microsoft Excel).',
        'Ты видишь выделенные ячейки и начало листа, работаешь только с выделением.',
        'Формулы — с английскими именами функций и запятой между аргументами (=SUM(B2:B9)): так их понимает редактор.',
        'Отвечай без вступлений вроде «Вот результат:», без извинений и комментариев о себе. Текст — по-русски, если задача не перевод.',
    ]);

    $parts = [];
    if ($sheets) {
        $parts[] = 'Листы книги: ' . implode(', ', $sheets) . ($sheet !== '' ? "; активный — «{$sheet}»." : '.');
    }
    $mode = 'selection';
    if ($ctxValues && $ctxRange !== '') {
        $parts[] = "=== НАЧАЛО ЛИСТА ({$ctxRange}) — для контекста ===\n" . studio_context_tsv($ctxValues, $ctxRange, STUDIO_CONTEXT_SHEET_CHARS) . "\n=== КОНЕЦ ===";
        $mode = 'sheet';
    }
    if ($values && $range !== '') {
        $rows = count($values);
        $cols = 0;
        foreach ($values as $r) {
            if (is_array($r)) {
                $cols = max($cols, count($r));
            }
        }
        $parts[] = "=== ВЫДЕЛЕНИЕ {$range} ({$rows} × {$cols})" . ($active !== '' ? ", активная ячейка {$active}" : '') . " — значения ===\n"
            . studio_context_tsv($values, $range, STUDIO_CONTEXT_SELECTION_CHARS) . "\n=== КОНЕЦ ===";
        $hasFormula = false;
        foreach ($formulas as $r) {
            foreach (is_array($r) ? $r : [] as $v) {
                if (is_string($v) && str_starts_with($v, '=')) {
                    $hasFormula = true;
                    break 2;
                }
            }
        }
        if ($hasFormula) {
            $parts[] = "=== ФОРМУЛЫ В ВЫДЕЛЕНИИ ===\n" . studio_context_tsv($formulas, $range, STUDIO_CONTEXT_SELECTION_CHARS) . "\n=== КОНЕЦ ===";
        }
    } else {
        $parts[] = 'Выделение пустое' . ($active !== '' ? " (активная ячейка {$active})" : '') . '.';
    }
    $user = implode("\n\n", $parts) . "\n\n=== ЗАДАЧА ===\n" . $task;
    return [$system, [['role' => 'user', 'content' => $user]], $mode . ':' . studio_context_kind($op)];
}

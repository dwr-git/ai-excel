<?php
// studio/api/tools.php — что помощник AI-Excel знает о себе и какие действия ему разрешены.
//
// Инструменты выполняет БРАУЗЕР (studio.js): только он видит запущенный
// редактор. Сервер лишь объявляет модели, какие инструменты есть, и решает,
// какие из них доступны в текущем режиме.

/** Инструменты, которые ничего не меняют в книге. Доступны в обоих режимах. */
function studio_read_tools(): array
{
    return [
        [
            'type' => 'function',
            'function' => [
                'name' => 'find_commands',
                'description' => 'Найти команды редактора по смыслу (по-русски или по-английски). '
                    . 'Возвращает id команды, русское название, путь на ленте, горячую клавишу и описание параметров. '
                    . 'Вызывай перед run_command, если не знаешь точный id: id нельзя угадывать.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'Что нужно сделать, 1–4 слова: «сортировка», «границы», «условное форматирование», «диаграмма», «chart».'],
                    ],
                    'required' => ['query'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'get_state',
                'description' => 'Текущее состояние книги: имя, сохранена ли, листы (имя, занятый диапазон, таблицы, диаграммы), '
                    . 'активный лист, выделение и активная ячейка, именованные диапазоны, итоги по выделению (сумма, среднее, количество).',
                'parameters' => ['type' => 'object', 'properties' => new stdClass()],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'read_range',
                'description' => 'Прочитать значения ячеек диапазона (по умолчанию — весь занятый диапазон активного листа). '
                    . 'formulas: true — вместо значений формулы (там, где они есть). Не больше 2000 ячеек за раз.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'range' => ['type' => 'string', 'description' => 'Диапазон в формате A1, например A1:F30 или Лист2!B2:D10'],
                        'formulas' => ['type' => 'boolean', 'description' => 'Показать формулы вместо значений'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'cell_details',
                'description' => 'Всё об одной ячейке: значение, формула, отображаемый текст, формат числа, шрифт, заливка, примечание, ссылка.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'cell' => ['type' => 'string', 'description' => 'Адрес ячейки, например B7 (по умолчанию — активная)'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'look_at_screen',
                'description' => 'Сделать снимок экрана редактора и посмотреть на него: проверить результат или увидеть, как выглядит таблица или диаграмма.',
                'parameters' => ['type' => 'object', 'properties' => new stdClass()],
            ],
        ],
    ];
}

/** Инструменты, которые меняют книгу. Только в режиме «Сделай». */
function studio_act_tools(): array
{
    return [
        [
            'type' => 'function',
            'function' => [
                'name' => 'run_command',
                'description' => 'Выполнить команду редактора с параметрами. Диалогов нет: всё задаётся параметрами. '
                    . 'Без range команда действует на выделение. Действие отменяется (Ctrl+Z).',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'id' => ['type' => 'string', 'description' => 'id команды, например cell.set, range.setValues, home.bold, home.numberFormat, insert.chart, data.sort'],
                        'params' => ['type' => 'object', 'description' => 'Параметры команды (JSON-объект). Можно не передавать — тогда значения по умолчанию.'],
                    ],
                    'required' => ['id'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'set_values',
                'description' => 'Записать в ячейки таблицу значений одним шагом, начиная с левой верхней ячейки диапазона. '
                    . 'Строки, начинающиеся с «=», — формулы (имена функций и разделители — английские: =SUM(A1:A9), =IF(A2>0,1,0)).',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'range' => ['type' => 'string', 'description' => 'Левая верхняя ячейка или весь диапазон, например A1 или B2:D5'],
                        'values' => ['type' => 'array', 'description' => 'Строки значений: [["Товар","Сумма"],["Хлеб",12.5],["Итого","=SUM(B2:B2)"]]'],
                    ],
                    'required' => ['range', 'values'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'undo',
                'description' => 'Отменить последние действия (как Ctrl+Z).',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'steps' => ['type' => 'integer', 'description' => 'Сколько шагов отменить, по умолчанию 1', 'minimum' => 1, 'maximum' => 20],
                    ],
                ],
            ],
        ],
    ];
}

/** Системная инструкция. $mode: 'advice' (Совет) или 'act' (Сделай). */
function studio_system_prompt(string $mode): string
{
    $available = $mode === 'act' ? array_merge(studio_read_tools(), studio_act_tools()) : studio_read_tools();
    $catalog = studio_tool_catalog($available);

    $common = <<<TXT
Ты — встроенный помощник AI-Excel, табличного редактора, устроенного как Microsoft Excel: лента (Главная, Вставка,
Разметка страницы, Формулы, Данные, Рецензирование, Вид), формулы и функции, форматы чисел, таблицы, диаграммы,
сортировка и фильтры, сводные таблицы, условное форматирование; интерфейс на русском.
Книги — .xlsx (а также .xls, .ods, .csv); файлы пользователя хранятся на его сервере («Мои файлы»).
Пользователь работает в редакторе прямо сейчас. К его сообщению приложено состояние книги, а иногда снимок экрана.

Как отвечать:
- Всегда по-русски, коротко и по делу: 1–6 предложений или короткий нумерованный список шагов.
- Пункты ленты пиши так: «Главная › Число › Формат». Горячие клавиши — в скобках: (Ctrl+B). Сочетания — как в Excel.
- Формулы пиши с английскими именами функций и запятой между аргументами, как их понимает этот редактор:
  =SUM(B2:B10), =VLOOKUP(A2,Лист2!A:B,2,FALSE), =IF(C2>0,"да","нет"). Русские имена (СУММ, ЕСЛИ) редактор не понимает.
- Названия команд бери из find_commands, а не по памяти. Не выдумывай функций, которых нет.
- Сохранение: Ctrl+S сохраняет книгу в «Мои файлы» на сервере (значок папки в панели помощника).
- Когда спрашивают о данных — смотри реальные значения (read_range, get_state), а не снимок экрана.

Твои инструменты (других нет — ни computer_use, ни кликов по координатам):
{$catalog}
Вызывай их штатно. Если штатный вызов недоступен, напиши вызов текстом, по одному блоку на вызов:
<tool_call><function=ИМЯ><parameter=КЛЮЧ>ЗНАЧЕНИЕ</parameter></function></tool_call>
Значения-объекты и списки пиши в JSON. После блока ничего не пиши — дождись результата.
TXT;

    if ($mode === 'act') {
        return $common . "\n\n" . <<<TXT
Режим «Сделай»: ты сам правишь книгу с помощью инструментов.
Это главное правило: не объясняй пользователю, как сделать вручную, — сделай сам. Если раньше в разговоре
ты был в режиме «Совет» и писал, что не можешь ничего менять, — это больше не так: сейчас режим «Сделай».
Каждое сообщение пользователя начинается с пометки текущего режима — верь ей.
Порядок работы:
1. Пойми задачу. Если она неоднозначна и ошибка дорого стоит — задай один уточняющий вопрос.
2. Посмотри данные: состояние приложено к сообщению; значения — read_range; одна ячейка — cell_details.
3. Почти все команды принимают range (например "A1:D20"); без него действуют на выделение.
   - ввод: cell.set {cell, input} (текст, число или =формула); set_values {range, values} — сразу много ячеек;
     range.fill {range, input} — одна формула во все ячейки диапазона (относительные ссылки сдвигаются);
   - выделить: selection.set {range}; перейти: edit.goTo {reference};
   - шрифт: home.bold / home.italic {range?, on?}, home.fontName {range?, name}, home.fontSize {range?, size},
     home.fontColor {range?, color: "#C00000"}, home.fillColor {range?, color: "#FFFF00" | "none"};
   - выравнивание: home.alignLeft / home.alignCenter / home.alignRight, home.wrapText {range?, on?}, home.mergeCenter {range?};
   - числа: home.numberFormat {range?, format: "Number"|"Currency"|"Percentage"|"Short Date"|"Text" | code: "#,##0.00" (коды форматов — как в файле .xlsx)},
     home.increaseDecimal / home.decreaseDecimal {range?};
   - границы: home.borders {range?, preset: all|outside|thickOutside|bottom|none, style?: thin|medium|thick};
   - строки и столбцы: home.columnWidth {cols: "B:D", chars: 15}, home.autofitColumnWidth {cols?}, home.rowHeight {rows, points},
     home.insertRows / home.deleteRows {rows: "5:7"}, home.insertColumns / home.deleteColumns {cols: "C:C"};
   - данные: data.sort {range?, header?: true, keys: [{column: "B", order: "desc"}]}, data.sortAscending {range?, column?},
     data.filter {range?}, data.removeDuplicates {range?, columns?, header?}, formulas.autoSum {function?: SUM|AVERAGE|COUNT|MAX|MIN, range?};
   - таблица: insert.table {range?, header?: true, style?: "TableStyleMedium2"};
   - диаграмма: insert.chart {range?, type: column|bar|line|pie|area|scatter, title?, at?: "H2"};
   - условное форматирование и всё остальное — найди через find_commands.
   - листы: home.insertSheet {name?}, sheet.rename {sheet?, name}, sheet.activate {sheet};
   - печать: pageLayout.orientation {orientation: portrait|landscape}, pageLayout.size {paper: "A4"}.
   Если не знаешь id команды или её параметры — find_commands.
4. После заметных изменений проверь результат (read_range или look_at_screen) и коротко скажи, что сделал и как отменить (Ctrl+Z).
Правила безопасности:
- Не создавай новую книгу, не открывай и не закрывай файлы, не удаляй листы, строки и столбцы с данными, если пользователь прямо об этом не просил.
- Не записывай поверх ячеек с данными без просьбы: для новых результатов бери свободное место рядом с данными.
- Делай не больше 12 действий подряд; если задача больше — сделай часть и спроси, продолжать ли.
- Если команда вернула ошибку — не повторяй вслепую: прочитай ошибку и params_doc, поправь параметры или объясни, что мешает.
TXT;
    }

    return $common . "\n\n" . <<<TXT
Режим «Совет»: ты только объясняешь и подсказываешь, ничего не меняешь сам.
Можно искать команды (find_commands), читать данные (read_range, get_state, cell_details) и смотреть на экран (look_at_screen).
Объясняй, куда нажать и какую формулу ввести, с конкретными адресами ячеек. Можешь посчитать, проверить формулы, найти ошибки в данных.
Если пользователь просит изменить книгу за него — скажи, что для этого нужно переключиться в режим «Сделай» (кнопка вверху панели).
TXT;
}

/**
 * Каталог инструментов текстом — для системной подсказки. Некоторые шлюзы (например, vLLM без
 * парсера вызовов) не передают модели поле tools; тогда модель узнаёт о наших инструментах
 * только отсюда и пишет вызовы текстом.
 */
function studio_tool_catalog(array $tools): string
{
    $lines = [];
    foreach ($tools as $t) {
        $f = $t['function'] ?? [];
        $name = (string)($f['name'] ?? '');
        if ($name === '') {
            continue;
        }
        $params = [];
        foreach (($f['parameters']['properties'] ?? []) as $p => $spec) {
            $params[] = $p . ': ' . ($spec['type'] ?? 'string');
        }
        $lines[] = '- ' . $name . '(' . implode(', ', $params) . ') — ' . (string)($f['description'] ?? '');
    }
    return implode("\n", $lines);
}

/**
 * Вызовы инструментов, которые модель написала текстом, а не штатным полем tool_calls:
 *   <tool_call><function=ИМЯ><parameter=КЛЮЧ>ЗНАЧЕНИЕ</parameter>…</function></tool_call>  (Qwen)
 *   <tool_call>{"name": "ИМЯ", "arguments": {…}}</tool_call>                             (Hermes)
 * Возвращает [вызовы, текст без этих блоков].
 */
function studio_text_tool_calls(string $content): array
{
    $calls = [];
    $value = static function (string $raw) {
        $raw = trim($raw);
        $j = json_decode($raw, true);
        return ($j !== null || $raw === 'null') ? $j : $raw;
    };
    // Qwen XML: с обёрткой <tool_call> или без неё. Прокси с vLLM иногда «съедает» начало
    // вызова («<tool_call>\n<»), и приходит «function=run_command>…» — это тоже понимаем,
    // как и вызов без закрывающих тегов в конце ответа.
    if (preg_match_all('~(?:<tool_call>\s*)?<?function=([A-Za-z0-9_.\-]+)>(.*?)(?:</function>(?:\s*</tool_call>)?|(?=<?function=[A-Za-z0-9_.\-]+>)|\z)~s', $content, $m, PREG_SET_ORDER)) {
        foreach ($m as $one) {
            $args = [];
            if (preg_match_all('~<?parameter=([A-Za-z0-9_.\-]+)>(.*?)(?:</parameter>|(?=<?parameter=[A-Za-z0-9_.\-]+>)|(?=</function>)|\z)~s', $one[2], $pm, PREG_SET_ORDER)) {
                foreach ($pm as $p) {
                    $args[$p[1]] = $value($p[2]);
                }
            }
            $calls[] = ['function' => ['name' => $one[1], 'arguments' => $args ?: new stdClass()]];
            $content = str_replace($one[0], '', $content);
        }
    }
    // Hermes: JSON внутри <tool_call>.
    if (preg_match_all('~<tool_call>\s*(\{.*?\})\s*</tool_call>~s', $content, $m, PREG_SET_ORDER)) {
        foreach ($m as $one) {
            $j = json_decode($one[1], true);
            if (is_array($j) && isset($j['name'])) {
                $args = $j['arguments'] ?? ($j['parameters'] ?? []);
                if (is_string($args)) {
                    $args = json_decode($args, true) ?: [];
                }
                $calls[] = ['function' => ['name' => (string)$j['name'], 'arguments' => $args ?: new stdClass()]];
                $content = str_replace($one[0], '', $content);
            }
        }
    }
    // Рассуждения модели в ответ не нужны.
    $content = preg_replace('~<think>.*?</think>~s', '', $content) ?? $content;
    $content = trim(str_replace(['<tool_call>', '</tool_call>'], '', $content));
    return [$calls, $content];
}

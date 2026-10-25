/* AI-Excel — помощник и файлы на сервере внутри табличного редактора.
 *
 * Панель в браузере разговаривает с моделью через api/assistant.php, а действия
 * выполняет в самом редакторе через window.aiexcel (apps/gridcraft-web/src/web/bridge.rs):
 * те же методы, что у десктопного канала управления (crates/ui-egui/src/control.rs).
 * Файлы хранятся на вашем сервере (api/files.php), у каждого пользователя свои.
 *
 * Без сборщиков и зависимостей: один файл, подключается из index.html.
 */
(() => {
  'use strict';

  const CFG = Object.assign({
    api: 'api/assistant.php',
    files: 'api/files.php',
    homeUrl: '../',
    labels: 'studio/ru-labels.json',
    autosaveSeconds: 60,       // автосохранение на сервер книги, которая там уже лежит (0 — выключить)
    maxSteps: 14,              // сколько шагов подряд помощник может сделать за один запрос
    screenshotMax: 1280,       // длинная сторона снимка экрана для модели, px
    aiMaxCells: 2000,          // сколько ячеек выделения отправлять модели («ИИ у выделения»)
    openOnStart: false,
    filesOnStart: true,
  }, window.STUDIO_CONFIG || {});
  // Страница сборки лежит в b/<номер>/ (studio/build/versioned.sh); адреса из настроек — от папки приложения.
  const fromRoot = (p) => { try { return new URL(p, window.STUDIO_ROOT || document.baseURI).href; } catch { return p; } };
  CFG.api = fromRoot(CFG.api);
  CFG.files = CFG.files ? fromRoot(CFG.files) : CFG.files;
  CFG.homeUrl = fromRoot(CFG.homeUrl || '../');
  // Редактор сам читает адрес домика из настроек.
  window.STUDIO_CONFIG = Object.assign(window.STUDIO_CONFIG || {}, { homeUrl: CFG.homeUrl });

  const CANVAS_ID = 'gridcraft_canvas';
  const READ_TOOLS = new Set(['find_commands', 'get_state', 'read_range', 'cell_details', 'look_at_screen']);
  // Никогда: файлы (их делает панель), служебное и интерфейс, печать, сценарии, внешние подключения, пароли.
  const DENY = /^(app\.|ui\.|help\.|file\.|window\.|print|automate\.|options\.|account\.|data\.(refreshAll|queriesConnections)|review\.(protect|unprotect))/i;
  // Только после подтверждения пользователя.
  const CONFIRM = /^(home\.delete(Rows|Columns|Cells|Sheet)|edit\.(clearAll|clearContents|cut|replace)|data\.removeDuplicates|sheet\.hide)/i;

  // ------------------------------------------------------------------ мост к редактору
  const VC = () => window.aiexcel;
  const PC = {
    ready: () => !!(VC() && typeof VC().request === 'function'),
    async call(method, params) {
      if (!PC.ready()) throw new Error('Редактор ещё загружается');
      return VC().request(method, params ?? {});
    },
    exec(id, params) {
      const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
      return PC.call('engine.execute', { command: id, params: p });
    },
  };
  // Для своих скриптов и отладки из консоли: await aiexcelStudio.exec('cell.set', {cell: 'A1', input: '=1+2'})
  window.aiexcelStudio = { call: PC.call, exec: PC.exec };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(what + ': нет ответа'); })]);
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…[обрезано]' : s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('aiexcel.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('aiexcel.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  };

  // ------------------------------------------------------------------ адреса ячеек
  const colNum = (letters) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const colName = (n) => { let s = ''; n = Math.max(0, Math.min(16383, n)) + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  // «B2:D9» (или «Лист!B2:D9», или одна ячейка) → {c0, r0, c1, r1} (столбцы с 0, строки с 1); null — не диапазон ячеек.
  function parseRange(a1) {
    const s = String(a1 || '').replace(/^.*!/, '').replace(/\$/g, '').trim();
    const m = s.match(/^([A-Za-z]{1,3})(\d{1,7})(?::([A-Za-z]{1,3})(\d{1,7}))?$/);
    if (!m) return null;
    const a = { c: colNum(m[1]), r: +m[2] };
    const b = m[3] ? { c: colNum(m[3]), r: +m[4] } : a;
    return { c0: Math.min(a.c, b.c), r0: Math.min(a.r, b.r), c1: Math.max(a.c, b.c), r1: Math.max(a.r, b.r) };
  }
  const a1 = (c, r) => colName(c) + r;
  const rangeA1 = (g) => (g.c0 === g.c1 && g.r0 === g.r1 ? a1(g.c0, g.r0) : a1(g.c0, g.r0) + ':' + a1(g.c1, g.r1));
  const cellsOf = (g) => (g.c1 - g.c0 + 1) * (g.r1 - g.r0 + 1);
  // Не больше max ячеек: лишние строки снизу отрезаются.
  function capRange(g, max) {
    const w = g.c1 - g.c0 + 1;
    const c1 = w > 200 ? g.c0 + 199 : g.c1;
    const rows = Math.max(1, Math.floor(max / (c1 - g.c0 + 1)));
    return { c0: g.c0, r0: g.r0, c1, r1: Math.min(g.r1, g.r0 + rows - 1) };
  }

  // ------------------------------------------------------------------ русские названия
  let L = { text: {} };
  const labelsLoaded = fetch(CFG.labels).then((r) => (r.ok ? r.json() : L)).then((j) => { L = j && j.text ? j : L; }).catch(() => {});
  function ru(label) {
    if (!label) return '';
    if (L.text[label]) return L.text[label];
    const bare = label.replace(/…$/, '');
    if (bare !== label && L.text[bare]) return L.text[bare] + '…';
    return label;
  }
  const menuOf = (c) => (Array.isArray(c.menu) ? c.menu : String(c.location || c.menu || '').split('›')).map((x) => String(x).trim()).filter(Boolean);
  const ruName = (c) => ru(c.label);
  const ruPath = (c) => [...menuOf(c).map(ru), ruName(c)].join(' › ');

  // ------------------------------------------------------------------ поиск команд
  let catalog = null;
  let catalogAt = 0;
  async function commands() {
    if (!catalog || Date.now() - catalogAt > 30000) {
      const r = await PC.call('engine.commands');
      catalog = Array.isArray(r) ? r : (r && Array.isArray(r.commands) ? r.commands : []);
      catalogAt = Date.now();
    }
    return catalog;
  }
  // Частые просьбы → слова, которыми такие команды называются.
  const SYN = [
    [/сортир|упорядоч/, 'sort'], [/фильтр|отбор/, 'filter'], [/дубл|повтор/, 'duplicates remove'], [/сумм|итог/, 'sum autosum total subtotal'],
    [/диаграм|график/, 'chart'], [/сводн/, 'pivot'], [/таблиц/, 'table'], [/границ|рамк/, 'borders'], [/залив|фон/, 'fill color'],
    [/цвет шрифт|цвет текст/, 'font color'], [/шрифт/, 'font'], [/жирн/, 'bold'], [/курсив/, 'italic'], [/подчерк/, 'underline'],
    [/выровн|по центру/, 'align center'], [/перенос/, 'wrap'], [/объедин/, 'merge'], [/формат|числ/, 'number format'], [/процент/, 'percent'],
    [/денежн|валют|рубл/, 'currency accounting'], [/дат/, 'date'], [/ширин|столбц|колонк/, 'column width'], [/высот|строк/, 'row height'],
    [/вставить строк|добав.*строк/, 'insert rows'], [/удалить строк/, 'delete rows'], [/вставить столб|добав.*столб/, 'insert columns'],
    [/закреп/, 'freeze'], [/условн/, 'conditional formatting'], [/проверк данн|список/, 'validation'], [/имя|имен/, 'name define'],
    [/лист/, 'sheet'], [/примечан|коммент/, 'comment note'], [/найти|поиск/, 'find'], [/замен/, 'replace'], [/ссылк/, 'link'],
    [/печат|страниц|альбомн|книжн|поля/, 'page layout orientation margins print'], [/групп|структур/, 'group outline'], [/отмен/, 'undo'],
    [/масштаб/, 'zoom'], [/текст по столбц|разделить/, 'text to columns'], [/мгновенн|автозаполн/, 'flash fill'], [/спарклайн/, 'sparkline'],
  ];
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
  async function findCommands(query) {
    const all = await commands();
    await labelsLoaded;
    const q = norm(query).trim();
    if (!q) return { results: [], hint: 'Пустой запрос' };
    const terms = new Set(q.split(/[^\p{L}\p{N}.]+/u).filter((t) => t.length > 1));
    for (const [re, words] of SYN) if (re.test(q)) words.split(' ').forEach((w) => terms.add(w));
    const scored = [];
    for (const c of all) {
      if (DENY.test(c.id)) continue;
      const name = norm(ruName(c));
      const en = norm(c.label);
      const path = norm(menuOf(c).map(ru).join(' ') + ' ' + menuOf(c).join(' '));
      const id = norm(c.id);
      let s = 0;
      if (name === q || en === q) s += 20;
      else if (name.includes(q) || en.includes(q)) s += 10;
      for (const t of terms) {
        if (name.includes(t)) s += name.startsWith(t) ? 7 : 5;
        if (en.includes(t)) s += en.startsWith(t) ? 6 : 4;
        if (id.includes(t)) s += 3;
        if (path.includes(t)) s += 1;
      }
      if (s > 0) scored.push([s + (c.params && c.params !== '{}' ? 1 : 0), c]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const results = scored.slice(0, 10).map(([, c]) => ({
      id: c.id,
      name: ruName(c),
      menu: ruPath(c),
      shortcut: c.shortcut || undefined,
      params: c.params && c.params !== '{}' ? clip(String(c.params), 600) : undefined,
    }));
    return results.length ? { results } : { results: [], hint: 'Ничего не найдено. Попробуй другие слова, можно по-английски (например: sort, chart, borders, number format, conditional).' };
  }

  // ------------------------------------------------------------------ состояние книги и снимок экрана
  async function workbook() {
    const d = await PC.call('document.inspect');
    const sheets = Array.isArray(d.sheets) ? d.sheets : [];
    const sheet = sheets[d.activeSheet] || {};
    return { d, sheets, sheet };
  }
  // Короткая таблица значений для модели: строки «номер<TAB>значения».
  function grid2text(values, g, maxChars) {
    const out = [];
    let size = 0;
    (values || []).forEach((row, i) => {
      if (size > maxChars) return;
      const line = (g.r0 + i) + '\t' + (row || []).map((v) => (v === null || v === undefined ? '' : typeof v === 'object' ? (v.error || JSON.stringify(v)) : String(v))).join('\t');
      size += line.length;
      out.push(size > maxChars ? '…' : line);
    });
    return out.join('\n');
  }
  async function snapshot() {
    const state = {};
    try {
      const { d, sheets, sheet } = await workbook();
      state.title = d.title;
      state.unsaved = !!d.dirty;
      state.onServer = !!Files.current();
      state.sheets = sheets.map((s) => ({ name: s.name, used: s.usedRange || 'пусто', tables: (s.tables || []).map((t) => t.name + ' ' + t.range), charts: (s.charts || []).length || undefined }));
      state.activeSheet = sheet.name;
      state.selection = d.selection;
      state.activeCell = d.activeCell;
      if ((d.names || []).length) state.names = d.names.slice(0, 20).map((n) => n.name + ' ' + n.refersTo);
      try {
        const st = await PC.exec('selection.stats');
        if (st && st.count > 1) state.selectionStats = st;
      } catch { /* не важно */ }
      // Начало активного листа: модель сразу видит заголовки и вид данных.
      const used = parseRange(sheet.usedRange);
      if (used) {
        const g = { c0: used.c0, r0: used.r0, c1: Math.min(used.c1, used.c0 + 11), r1: Math.min(used.r1, used.r0 + 11) };
        const r = await PC.exec('sheet.read', { range: rangeA1(g), formatted: true });
        state.preview = `${rangeA1(g)} (столбцы ${colName(g.c0)}…${colName(g.c1)}):\n` + grid2text(r.values, g, 1800);
      }
    } catch (e) {
      state.note = 'Книга не открыта (начальный экран). Можно создать новую: Файл › Создать.';
    }
    return state;
  }
  async function readRange(range, formulas) {
    const { sheet } = await workbook();
    let g = parseRange(range || sheet.usedRange);
    const prefix = String(range || '').includes('!') ? String(range).replace(/!.*$/, '!') : '';
    if (!g) {
      if (range) return PC.exec('sheet.read', { range: String(range), formulas: !!formulas, formatted: !formulas });
      return { range: null, values: [], note: 'Лист пустой' };
    }
    let note;
    if (cellsOf(g) > 2000) {
      const all = rangeA1(g);
      g = capRange(g, 2000);
      note = `Диапазон ${all} большой: показаны ${rangeA1(g)}. Дальше — read_range {range: "${a1(g.c0, g.r1 + 1)}:…"}.`;
    }
    const r = await PC.exec('sheet.read', { range: prefix + rangeA1(g), formulas: !!formulas, formatted: !formulas });
    return { range: r.range, sheet: r.sheet, text: grid2text(r.values, g, 24000), note };
  }

  function downscale(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, CFG.screenshotMax / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.75).split(',')[1]);
      };
      img.onerror = () => reject(new Error('не удалось прочитать снимок'));
      img.src = src;
    });
  }
  async function screenshot() {
    if (!PC.ready()) return null;
    try {
      const r = await withTimeout(VC().screenshot(), 9000, 'снимок');
      const b64 = r && (r.base64 || r.png || r.data);
      if (typeof b64 === 'string' && b64.length > 100) return await downscale('data:image/png;base64,' + b64);
    } catch { /* ниже */ }
    return null;
  }

  // ------------------------------------------------------------------ интерфейс
  const ICON = {
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
    bulb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>',
    hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6-9 9H5v-6z"/><path d="M12.5 5.5l6 6"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2.2a2 2 0 0 0-1.4 3.4A1.6 1.6 0 0 1 12 22z"/><circle cx="7.5" cy="10.5" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16.5" cy="10.5" r="1.2"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 5l7 7-7 7M5 5l7 7-7 7"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    // Мозг — контур из набора Tabler Icons (MIT), нарисованный градиентом #st-brain-grad.
    brain: '<svg class="st-brain-svg" viewBox="0 0 24 24" fill="none" stroke="url(#st-brain-grad)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 13a3.5 3.5 0 0 0 -3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8"/><path d="M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1 -7 0v-1.8"/><path d="M17.5 16a3.5 3.5 0 0 0 0 -7h-.5"/><path d="M19 9.3v-2.8a3.5 3.5 0 0 0 -7 0"/><path d="M6.5 16a3.5 3.5 0 0 1 0 -7h.5"/><path d="M5 9.3v-2.8a3.5 3.5 0 0 1 7 0v10"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    layout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3l-8 11h6l-1 7 8-11h-6z"/></svg>',
  };
  // Живой контур: мозг градиентом и три точки на орбите, пока помощник работает.
  const BRAIN = `${ICON.brain}<b class="st-orbit" aria-hidden="true"><i></i><i></i><i></i></b>`;

  const root = document.createElement('div');
  root.id = 'studio-root';
  root.dataset.theme = 'light';
  root.innerHTML = `
    <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="st-brain-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8fa2ff"/><stop offset=".55" stop-color="#9b7cf0"/><stop offset="1" stop-color="#ff77c6"/></linearGradient></defs></svg>
    <div class="st-veil" aria-hidden="true"></div>
    <div class="st-drop" aria-hidden="true"><span>Отпустите, чтобы открыть в редакторе</span></div>
    <aside class="st-panel" aria-label="Помощник">
      <header class="st-head">
        <div class="st-logo st-brain st-raised-sm" aria-hidden="true">${BRAIN}</div>
        <div class="st-title"><b>Помощник</b><small data-ref="sub">Загрузка редактора…</small></div>
        <button class="st-icon-btn" data-ref="galleryBtn" title="Быстрые задачи: таблица, сортировка, форматы, диаграмма…" aria-label="Быстрые задачи">${ICON.layout}</button>
        <button class="st-icon-btn" data-ref="filesBtn" title="Мои файлы (на сервере)" aria-label="Мои файлы">${ICON.folder}</button>
        <button class="st-icon-btn" data-ref="barBtn" title="Быстрая строка (Ctrl+Shift+Пробел)" aria-label="Быстрая строка">${ICON.bolt}</button>
        <div class="st-theme-wrap">
          <button class="st-icon-btn" data-ref="theme" title="Тема оформления" aria-label="Тема оформления" aria-haspopup="menu" aria-expanded="false">${ICON.palette}</button>
          <div class="st-theme-menu" data-ref="themeMenu" role="menu" hidden></div>
        </div>
        <button class="st-icon-btn" data-ref="hide" title="Свернуть панель" aria-label="Свернуть панель">${ICON.close}</button>
      </header>
      <div class="st-seg st-pressed" role="group" aria-label="Режим помощника">
        <button data-mode="advice" aria-pressed="true">${ICON.bulb}Совет</button>
        <button data-mode="act" aria-pressed="false">${ICON.hand}Сделай</button>
      </div>
      <div class="st-mode-hint" data-ref="hint"></div>
      <div class="st-log" data-ref="log" role="log" aria-live="polite"></div>
      <div class="st-composer">
        <div class="st-input st-pressed">
          <button class="st-icon-btn" data-ref="eye" aria-pressed="true" title="Показывать помощнику экран" aria-label="Показывать помощнику экран">${ICON.eye}</button>
          <textarea data-ref="input" rows="1" placeholder="Спросите или попросите…" aria-label="Сообщение помощнику"></textarea>
          <button class="st-send" data-ref="send" title="Отправить (Enter)" aria-label="Отправить">${ICON.send}</button>
        </div>
        <div class="st-foot"><span>Ctrl+Z — отменить · Ctrl+Shift+Пробел — строка</span><button data-ref="clear">Новый разговор</button></div>
      </div>
    </aside>
    <div class="st-files" data-ref="files" role="dialog" aria-modal="true" aria-label="Мои книги" hidden>
      <div class="st-files-box">
        <header class="st-files-head">
          <b>Мои книги</b><small data-ref="filesWho"></small>
          <button class="st-icon-btn" data-ref="filesClose" title="Закрыть (Esc)" aria-label="Закрыть">${ICON.x}</button>
        </header>
        <div class="st-files-tools">
          <input data-ref="filesSearch" type="search" placeholder="Поиск по имени" aria-label="Поиск по имени">
          <button class="st-mini" data-ref="filesNew">Новый файл</button>
          <button class="st-mini" data-ref="filesUpload" title=".xlsx, .xls, .ods, .csv">С компьютера…</button>
        </div>
        <div class="st-files-list" data-ref="filesList"></div>
        <footer class="st-files-foot">
          <span data-ref="filesCurrent"></span>
          <button class="st-mini" data-ref="filesSaveAs">Сохранить как…</button>
          <button class="st-mini primary" data-ref="filesSave">Сохранить</button>
        </footer>
      </div>
    </div>
    <div class="st-files st-gallery" data-ref="gallery" role="dialog" aria-modal="true" aria-label="Быстрые задачи" hidden>
      <div class="st-files-box st-gallery-box">
        <header class="st-files-head">
          <b>Быстрые задачи</b>
          <small>В одно нажатие. Действуют на выделенные ячейки (а без выделения — на таблицу вокруг активной ячейки).</small>
          <button class="st-icon-btn" data-ref="galleryClose" title="Закрыть (Esc)" aria-label="Закрыть">${ICON.x}</button>
        </header>
        <div class="st-gpane"><div class="st-gtasks" data-ref="gTasks"></div></div>
      </div>
    </div>
    <div class="st-ask" data-ref="ask" role="dialog" aria-modal="true" hidden>
      <form class="st-ask-box">
        <b data-ref="askTitle"></b>
        <input data-ref="askInput" type="text" maxlength="120">
        <small data-ref="askNote"></small>
        <div class="st-row"><button type="button" class="st-mini" data-ref="askCancel">Отмена</button><button type="submit" class="st-mini primary" data-ref="askOk">OK</button></div>
      </form>
    </div>
    <button class="st-fab st-brain" data-ref="fab" title="Помощник" aria-label="Открыть помощника">${BRAIN}<span class="st-badge" aria-hidden="true"></span></button>
    <div class="st-bar" data-ref="bar" role="dialog" aria-label="Быстрая строка помощника">
      <div class="st-bar-answer" data-ref="barAnswer"></div>
      <div class="st-bar-row">
        <button class="st-bar-mode" data-ref="barMode" title="Режим: Совет или Сделай"></button>
        <input data-ref="barInput" type="text" placeholder="Что посчитать или поправить? Enter — отправить, Esc — закрыть" aria-label="Запрос помощнику">
        <button class="st-send" data-ref="barSend" aria-label="Отправить">${ICON.send}</button>
      </div>
    </div>`;
  const $ = (name) => root.querySelector(`[data-ref="${name}"]`);
  const log = $('log');
  const input = $('input');

  // Клавиши, набранные в панели, не должны доходить до редактора (иначе «B» выберет кисть).
  for (const type of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut']) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }

  let mode = store.get('mode', 'advice');
  let attachScreen = store.get('eye', true);
  let busy = false;
  let stopRequested = false;
  let convo = [];

  const HINTS = {
    advice: 'Объясняю и подсказываю, ничего не меняю в книге.',
    act: 'Делаю сам: заполняю ячейки, пишу формулы, сортирую и фильтрую, оформляю таблицы и диаграммы. Всё отменяется Ctrl+Z.',
  };
  // Модель видит всю переписку. Если раньше она писала «я в режиме Совет», то по инерции продолжает
  // так отвечать и после переключения. Поэтому смена режима отмечается прямо в разговоре,
  // а каждое сообщение пользователя несёт текущий режим.
  const MODE_NOTE = {
    act: '[Режим переключён на «Сделай». Теперь ты сам выполняешь просьбы инструментами (read_range, run_command, set_values…). Всё, что ты раньше писал про режим «Совет», больше не действует.]',
    advice: '[Режим переключён на «Совет». Теперь только объясняй и подсказывай, ничего не меняй в книге.]',
  };
  const MODE_TAG = {
    act: '[Режим сейчас: «Сделай» — выполни это сам, инструментами]',
    advice: '[Режим сейчас: «Совет» — объясни, как сделать, ничего не меняя]',
  };
  function setMode(m) {
    const next = m === 'act' ? 'act' : 'advice';
    if (next !== mode && convo.length) convo.push({ role: 'user', content: MODE_NOTE[next] });
    mode = next;
    store.set('mode', mode);
    root.querySelectorAll('.st-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    $('hint').textContent = HINTS[mode];
    const bm = root.querySelector('[data-ref="barMode"]');
    if (bm) bm.textContent = mode === 'act' ? 'Сделай' : 'Совет';
  }
  function setEye(on) {
    attachScreen = !!on;
    store.set('eye', attachScreen);
    $('eye').setAttribute('aria-pressed', String(attachScreen));
    $('eye').title = attachScreen ? 'Помощник видит экран' : 'Помощник не видит экран';
  }
  function setOpen(open) {
    root.classList.toggle('open', open);
    document.body.classList.toggle('studio-open', open);
    setTimeout(syncBackdrop, 60);
    setTimeout(syncBackdrop, 400);
    store.set('open', open);
    // eframe подхватывает новый размер canvas на следующем кадре
    window.dispatchEvent(new Event('resize'));
    if (open) { setTimeout(() => input.focus(), 200); root.classList.remove('has-hints'); }
  }
  function setBusy(on) {
    busy = on;
    root.classList.toggle('busy', on);
    $('send').innerHTML = on ? ICON.stop : ICON.send;
    $('send').title = on ? 'Остановить' : 'Отправить (Enter)';
  }
  function scroll() { log.scrollTop = log.scrollHeight; }

  function format(text) {
    // Строки списка «- …» / «* …» — с точкой; короткая строка, оканчивающаяся двоеточием, — заголовок.
    text = text.trim().split('\n').map((line) => {
      const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (li) return '\u0001' + (/^\s*\d/.test(line) ? line.trim().match(/^\d+[.)]/)[0] + ' ' : '• ') + li[1] + '\u0002';
      const head = line.match(/^\s*(?:#{1,4}\s*)?\**([^*:]{2,60}):\**\s*$/);
      if (head) return '\u0003' + head[1] + ':\u0004';
      return line.replace(/^#{1,4}\s+/, '');
    }).join('\n').replace(/\u0002\n/g, '\u0002');  // пункт списка — блок: перенос после него лишний
    let h = esc(text);
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/\((Ctrl|Shift|Alt|Cmd|⌘|⇧|⌥)([^)\n]{0,24})\)/g, '(<kbd>$1$2</kbd>)');
    // «Изображение › Коррекция › Кривые» — путь в меню
    // Сегменты — слова через одиночные пробелы: конечный пробел не должен «съедать» разделитель.
    const C = '[^\\s›«»"():.,!?;<>&]';
    const word = `${C}+`;
    const path = new RegExp(`([А-ЯЁA-Z]${C}*(?: ${word}){0,2}(?: › ${word}(?: ${word}){0,3}){1,4})`, 'g');
    h = h.replace(path, '<span class="st-path">$1</span>');
    h = h.replace(/\u0001/g, '<span class="st-li">').replace(/\u0002/g, '</span>')
      .replace(/\u0003/g, '<span class="st-h">').replace(/\u0004/g, '</span>');
    return h;
  }
  function add(el) { log.querySelector('.st-empty')?.remove(); log.appendChild(el); scroll(); return el; }
  function msg(cls, html) { const d = document.createElement('div'); d.className = 'st-msg ' + cls; d.innerHTML = html; return add(d); }
  function typing(on) {
    log.querySelector('.st-typing')?.remove();
    if (on) { const t = document.createElement('div'); t.className = 'st-typing st-raised-sm'; t.innerHTML = '<i></i><i></i><i></i>'; add(t); }
  }

  const ACTION_TEXT = {
    find_commands: (a) => ['Ищу команду', a.query],
    get_state: () => ['Смотрю книгу', ''],
    read_range: (a) => ['Читаю ячейки', a.range || 'весь лист'],
    cell_details: (a) => ['Смотрю ячейку', String(a.cell ?? '')],
    look_at_screen: () => ['Смотрю на экран', ''],
    set_values: (a) => ['Заполняю ячейки', String(a.range ?? '')],
    undo: (a) => ['Отменяю', `${a.steps || 1} шаг(а)`],
  };
  function card(name, args, label) {
    const d = document.createElement('div');
    const [title, detail] = label || (ACTION_TEXT[name] ? ACTION_TEXT[name](args) : [name, '']);
    d.className = 'st-act' + (READ_TOOLS.has(name) ? ' read' : '');
    d.innerHTML = `<span class="st-dot"></span><div class="st-act-text"><b>${esc(title)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;
    return add(d);
  }
  function cardResult(d, ok, error, undoable) {
    if (!ok) {
      d.classList.add('fail');
      const s = d.querySelector('small') || d.querySelector('.st-act-text').appendChild(document.createElement('small'));
      s.textContent = error;
      return;
    }
    if (undoable) {
      const b = document.createElement('button');
      b.className = 'st-mini';
      b.textContent = 'Отменить';
      b.onclick = async () => {
        b.disabled = true;
        try { await PC.exec('edit.undo'); b.textContent = 'Отменено'; } catch (e) { b.textContent = 'Не вышло'; b.title = e.message; }
      };
      d.appendChild(b);
    }
  }
  function confirmAction(text) {
    return new Promise((resolve) => {
      const d = document.createElement('div');
      d.className = 'st-confirm st-raised';
      d.innerHTML = `<p>${esc(text)}</p><div class="st-row"><button class="st-mini danger" data-a="no">Не надо</button><button class="st-mini" data-a="yes">Разрешить</button></div>`;
      add(d);
      d.querySelectorAll('button').forEach((b) => {
        b.onclick = () => { d.remove(); resolve(b.dataset.a === 'yes'); };
      });
    });
  }

  function showEmpty() {
    log.innerHTML = `<div class="st-empty">
      <h3>Чем помочь?</h3>
      <p>Спросите, где найти функцию в AI-Excel, или попросите посчитать, проверить, оформить таблицу или построить диаграмму за вас.</p>
      <button class="st-mini primary st-start-tpl">Быстрые задачи</button>
      <div class="st-chips">
        <button class="st-chip" data-act="1">Оформи данные как таблицу, добавь строку итогов и подбери ширину столбцов</button>
        <button class="st-chip">Какие выводы можно сделать по этим данным?</button>
        <button class="st-chip" data-act="1">Найди и удали дубликаты строк</button>
        <button class="st-chip">Как посчитать сумму по условию?</button>
        <button class="st-chip" data-act="1">Построй диаграмму по выделенным данным</button>
      </div></div>`;
    const st = log.querySelector('.st-start-tpl');
    if (st) st.onclick = () => Gallery.show(true);
    log.querySelectorAll('.st-chip').forEach((c) => {
      c.onclick = () => {
        if (c.dataset.act) setMode('act');
        input.value = c.textContent;
        send();
      };
    });
  }

  // ------------------------------------------------------------------ инструменты для модели
  async function commandById(id) {
    const c = (await commands()).find((x) => x.id === id);
    if (!c) throw new Error(`Нет команды «${id}». Найди нужную через find_commands.`);
    if (DENY.test(id)) throw new Error('Эту команду помощнику выполнять нельзя (файлы, интерфейс и служебное делает панель или сам пользователь).');
    return c;
  }
  const short = (v) => (v === undefined || v === null ? { ok: true } : { ok: true, result: v });
  const trimmed = (r) => (r && typeof r === 'object' ? JSON.parse(clip(JSON.stringify(r), 3000).replace(/…\[обрезано\]$/, '') || 'null') : r);
  // Ответ команды целиком бывает огромным (base64 книги или PDF) — модели он не нужен.
  const forModel = (r) => {
    if (r && typeof r === 'object' && typeof r.base64 === 'string') { const { base64, ...rest } = r; void base64; return rest; }
    return r;
  };
  // Строки значений для range.setValues: прямоугольник, не больше 20 000 ячеек.
  function cleanValues(values) {
    if (!Array.isArray(values) || !values.length) throw new Error('values: нужен непустой массив строк [[…], […]]');
    const rows = values.map((r) => (Array.isArray(r) ? r : [r]));
    const width = Math.max(...rows.map((r) => r.length));
    if (rows.length * width > 20000) throw new Error('Слишком много ячеек за один раз (больше 20 000): разбей на части.');
    return rows.map((r) => Array.from({ length: width }, (_, i) => {
      const v = r[i];
      return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : v;
    }));
  }

  async function runTool(name, args) {
    if (mode !== 'act' && !READ_TOOLS.has(name)) {
      return { ok: false, error: 'Сейчас режим «Совет»: действия выключены. Объясни пользователю, как сделать это самому, или предложи переключиться в «Сделай».' };
    }
    switch (name) {
      case 'find_commands': {
        const d = card(name, args);
        const r = await findCommands(String(args.query || ''));
        cardResult(d, true);
        return r;
      }
      case 'get_state': {
        card(name, args);
        return await snapshot();
      }
      case 'read_range': {
        const d = card(name, args);
        try { const r = await readRange(args.range ? String(args.range) : '', !!args.formulas); cardResult(d, true); return r; } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
      }
      case 'cell_details': {
        const d = card(name, args);
        try {
          const r = await PC.exec('cell.get', args.cell ? { cell: String(args.cell) } : {});
          cardResult(d, true);
          return short(trimmed(r));
        } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
      }
      case 'look_at_screen': {
        const d = card(name, args);
        const img = await screenshot();
        cardResult(d, !!img, 'Снимок не получился');
        return img ? { ok: true, note: 'Снимок приложен следующим сообщением.', __image: img } : { ok: false, error: 'Снимок экрана не получился' };
      }
      case 'run_command': {
        const c = await commandById(String(args.id || ''));
        if (CONFIRM.test(c.id) && !(await confirmAction(`Помощник хочет выполнить «${ruPath(c)}». Разрешить?`))) {
          card(name, args, ['Пропущено пользователем', ruPath(c)]).classList.add('fail');
          return { ok: false, error: 'Пользователь не разрешил это действие. Не повторяй его, спроси, как поступить.' };
        }
        const d = card(name, args, ['Выполняю', ruPath(c)]);
        root.classList.add('acting');
        try {
          const r = await PC.exec(c.id, args.params && typeof args.params === 'object' ? args.params : null);
          cardResult(d, true, '', !/^(selection\.|edit\.(goTo|find)|sheet\.(activate|next|previous|read)|cell\.get|document\.|view\.|history\.)/.test(c.id));
          return short(trimmed(forModel(r)));
        } catch (e) {
          cardResult(d, false, e.message);
          return { ok: false, error: e.message, params_doc: c.params ? clip(String(c.params), 800) : undefined };
        } finally {
          root.classList.remove('acting');
        }
      }
      case 'set_values': {
        const d = card(name, args);
        root.classList.add('acting');
        try {
          const r = await PC.exec('range.setValues', { range: String(args.range || 'A1'), values: cleanValues(args.values) });
          cardResult(d, true, '', true);
          return short(trimmed(r));
        } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
        finally { root.classList.remove('acting'); }
      }
      case 'undo': {
        const n = Math.max(1, Math.min(20, parseInt(args.steps, 10) || 1));
        const d = card(name, { steps: n });
        try { await PC.exec('edit.undo', { steps: n }); cardResult(d, true); return { ok: true }; } catch (e) { cardResult(d, false, e.message); return { ok: false, error: e.message }; }
      }
      default:
        return { ok: false, error: `Инструмента «${name}» нет. Доступны только: ${TOOL_NAMES.join(', ')}. Кликов по координатам нет: найди команду через find_commands и выполни её run_command.` };
    }
  }

  // Модель иногда пишет вызов инструмента текстом вместо tool_calls — подхватываем его.
  const TOOL_NAMES = ['find_commands', 'get_state', 'read_range', 'cell_details', 'look_at_screen', 'run_command', 'set_values', 'undo'];
  function inlineCalls(text) {
    if (!text || !/[{[]/.test(text)) return [];
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      const o = JSON.parse(m[0]);
      const list = Array.isArray(o) ? o : [o];
      return list
        .filter((x) => x && TOOL_NAMES.includes(x.name))
        .map((x) => ({ function: { name: x.name, arguments: x.arguments || x.parameters || {} } }));
    } catch { return []; }
  }

  // ------------------------------------------------------------------ разговор с моделью
  function outgoing() {
    // Картинки тяжёлые и занимают много контекста: отправляем только последний снимок.
    const out = convo.slice(-60).map((m) => ({ ...m }));
    let images = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      if (!out[i].images) continue;
      if (images >= 1) delete out[i].images; else images += out[i].images.length;
    }
    return out;
  }

  // Запрос к серверу помощника. Если сервер не принимает запрос со снимком экрана (nginx по
  // умолчанию берёт не больше 1 МБ и при большем просто обрывает соединение — браузер пишет
  // «Failed to fetch»), запрос повторяется без снимка, и дальше снимки не отправляются.
  const BODY_LIMIT = 900 * 1024;
  let imagesBlocked = false;
  const withoutImages = (payload) => ({ ...payload, messages: payload.messages.map((m) => { const { images, ...rest } = m; void images; return rest; }) });
  const hasImages = (payload) => payload.messages.some((m) => m.images && m.images.length);
  function tellImagesBlocked() {
    if (imagesBlocked) return;
    imagesBlocked = true;
    msg('note', 'Сервер не принял запрос со снимком экрана, поэтому помощник отвечает без него. ' +
      'Чтобы он видел экран, добавьте в nginx для api/assistant.php строку <code>client_max_body_size 20m;</code> (готовый блок — в nginx.conf.example).');
  }
  async function explainNoAnswer(seconds) {
    try {
      const r = await fetch(CFG.api, { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        const when = seconds >= 1 ? ` через ${Math.round(seconds)} с` : ' сразу';
        const why = seconds >= 45
          ? 'Похоже, сервер не дождался модели: для api/assistant.php нужна строка fastcgi_read_timeout 200s; (и такой же таймаут у прокси перед сервером, если он есть).'
          : 'Обычно так бывает, когда запрос больше, чем разрешает сервер (client_max_body_size 20m; для api/assistant.php), или его блокирует защита сервера.';
        return `Сервер оборвал соединение${when} и ничего не ответил, хотя сам помощник доступен. ${why} Готовый блок — в nginx.conf.example.`;
      }
      return `Сервер помощника ответил «${r.status}». Проверьте, что PHP обрабатывает файлы в папке api/.`;
    } catch {
      return 'Нет связи с сервером помощника: страница не может достучаться до api/assistant.php. Проверьте подключение и обновите страницу.';
    }
  }
  async function postApi(payload) {
    const post = (p) => fetch(CFG.api, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    if (imagesBlocked && hasImages(payload)) payload = withoutImages(payload);
    if (hasImages(payload) && JSON.stringify(payload).length > BODY_LIMIT) payload = withoutImages(payload);
    let r;
    const t0 = performance.now();
    const took = () => (performance.now() - t0) / 1000;
    try {
      r = await post(payload);
    } catch (e) {
      console.warn('AI-Excel: запрос к помощнику оборвался', e);
      if (!hasImages(payload)) throw new Error(await explainNoAnswer(took()));
      try { r = await post(withoutImages(payload)); } catch { throw new Error(await explainNoAnswer(took())); }
      tellImagesBlocked();
      return r;
    }
    if (r.status === 413 && hasImages(payload)) {
      r = await post(withoutImages(payload));
      tellImagesBlocked();
    }
    return r;
  }
  async function readAnswer(r) {
    let j;
    try { j = await r.json(); } catch {
      if (r.status === 413) throw new Error('Сервер не принял такой большой запрос (413). Нужна строка client_max_body_size 20m; в nginx — см. nginx.conf.example.');
      if (r.status === 502 || r.status === 504) throw new Error(`Сервер не дождался ответа модели (${r.status}). Нужна строка fastcgi_read_timeout 200s; в nginx — см. nginx.conf.example.`);
      throw new Error(`Сервер помощника ответил не JSON (HTTP ${r.status}). Проверьте, что PHP работает в папке api/.`);
    }
    return j;
  }
  // Шлюз модели не передаёт инструменты штатно (вызовы приходят текстом) — запоминаем это.
  let textTools = store.get('textTools', false);
  async function ask() {
    const r = await postApi({ mode, messages: outgoing(), textTools });
    const j = await readAnswer(r);
    if (j && j.ok && j.textTools && !textTools) { textTools = true; store.set('textTools', true); }
    if (!j.ok) {
      const e = new Error(j.error || 'Ошибка помощника');
      e.noVision = !!j.noVision;
      throw e;
    }
    return j;
  }

  async function send(fromBar) {
    if (busy) { stopRequested = true; return; }
    const field = typeof fromBar === 'string' ? null : input;
    const text = (typeof fromBar === 'string' ? fromBar : input.value).trim();
    if (!text) return;
    if (field) { field.value = ''; autosize(); }
    setBusy(true);
    stopRequested = false;
    msg('user', esc(text));
    try {
      let state = null;
      let image = null;
      if (PC.ready()) {
        state = await snapshot().catch((e) => ({ error: e.message }));
        if (attachScreen) image = await screenshot();
      }
      convo.push({
        role: 'user',
        content: MODE_TAG[mode] + '\n' + text + '\n\n[Состояние редактора — автоматически]\n' + clip(JSON.stringify(state ?? { note: 'Редактор ещё загружается' }), 4000),
        ...(image ? { images: [image] } : {}),
      });
      for (let step = 0; step < CFG.maxSteps; step++) {
        if (stopRequested) { msg('bot', 'Остановлено.'); break; }
        typing(true);
        const j = await ask();
        typing(false);
        const m = j.message || {};
        let calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        let content = (m.content || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/<think>[\s\S]*?<\/think>/g, '')
          .replace(/<?function=[\w.-]+>[\s\S]*?(<\/function>|$)/g, '').replace(/<\/?tool_call>/g, '').trim();
        if (!calls.length) {
          calls = inlineCalls(content);
          if (calls.length) content = content.replace(/\{[\s\S]*\}/, '').trim();
        }
        // «Сделай», а модель всё равно ответила как в «Совете» — одна попытка её поправить.
        if (mode === 'act' && !calls.length && step === 0 && /режим\S*\s*«?Совет/i.test(content)) {
          convo.push({ role: 'assistant', content: m.content || '' });
          convo.push({ role: 'user', content: MODE_NOTE.act + ' Выполни просьбу сейчас.' });
          continue;
        }
        convo.push({ role: 'assistant', content: m.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (content) msg('bot', format(content));
        if (!calls.length) break;
        let pendingImage = null;
        for (const c of calls) {
          if (stopRequested) break;
          const fname = c.function && c.function.name;
          let a = (c.function && c.function.arguments) || {};
          if (typeof a === 'string') { try { a = JSON.parse(a || '{}'); } catch { a = {}; } }
          let result;
          try { result = await runTool(fname, a || {}); } catch (e) { result = { ok: false, error: e.message || String(e) }; }
          if (result && result.__image) { pendingImage = result.__image; delete result.__image; }
          convo.push({ role: 'tool', tool_name: fname, content: clip(JSON.stringify(result ?? { ok: true }), 6000) });
        }
        if (pendingImage) convo.push({ role: 'user', content: '[Снимок экрана после действий — прислан автоматически]', images: [pendingImage] });
        if (step === CFG.maxSteps - 1) msg('bot', `Сделал ${CFG.maxSteps} шагов подряд и остановился. Напишите «продолжай», если нужно дальше.`);
      }
    } catch (e) {
      typing(false);
      if (e.noVision) setEye(false);
      msg('err', esc(e.message || String(e)));
    } finally {
      typing(false);
      setBusy(false);
      root.classList.remove('acting');
      updateBarAnswer();
    }
  }
  // ------------------------------------------------------------------ быстрая строка
  // Ctrl+Shift+Пробел: поле внизу над холстом. Ответ всплывает над ним; вся история — в панели.
  const bar = $('bar');
  const barInput = $('barInput');
  const barAnswer = $('barAnswer');
  function setBar(open) {
    root.classList.toggle('bar-open', open);
    if (open) { setTimeout(() => barInput.focus(), 30); updateBarAnswer(); }
  }
  function updateBarAnswer() {
    if (!root.classList.contains('bar-open')) return;
    if (busy) { barAnswer.innerHTML = '<div class="st-typing"><i></i><i></i><i></i></div>'; barAnswer.hidden = false; return; }
    const last = [...log.querySelectorAll('.st-msg.bot, .st-msg.err')].pop();
    if (!last || !barSent) { barAnswer.hidden = true; return; }
    barAnswer.hidden = false;
    barAnswer.innerHTML = `<div class="st-bar-text ${last.classList.contains('err') ? 'err' : ''}">${last.innerHTML}</div><button class="st-link" data-a="panel">Открыть в панели</button>`;
    barAnswer.querySelector('[data-a="panel"]').onclick = () => { setBar(false); setOpen(true); };
  }
  let barSent = false;
  async function sendFromBar() {
    const text = barInput.value.trim();
    if (!text || busy) return;
    barInput.value = '';
    barSent = true;
    const done = send(text);
    updateBarAnswer();
    await done;
    updateBarAnswer();
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      setBar(!root.classList.contains('bar-open'));
    }
  }, true);

  // ------------------------------------------------------------------ сообщения и перетаскивание
  function setBadge(on) { root.classList.toggle('has-hints', on); }
  function toast(text, error) {
    let t = root.querySelector('.st-toast');
    if (!t) { t = document.createElement('div'); t.className = 'st-toast'; root.appendChild(t); }
    t.textContent = text;
    t.classList.toggle('err', !!error);
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // Файлы, брошенные на таблицу, редактор принимает сам. Брошенные на панель помощника или край
  // страницы браузер открыл бы вместо редактора — передаём их редактору.
  const isFileDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dropHideTimer = 0;
  function showDrop(on) {
    root.classList.toggle('dropping', on);
    clearTimeout(dropHideTimer);
    if (on) dropHideTimer = setTimeout(() => root.classList.remove('dropping'), 400);
  }
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    const canvas = document.getElementById(CANVAS_ID);
    if (canvas && e.target === canvas) return;
    e.preventDefault();
    showDrop(true);
  });
  window.addEventListener('drop', async (e) => {
    showDrop(false);
    if (!isFileDrag(e)) return;
    const canvas = document.getElementById(CANVAS_ID);
    if (canvas && e.target === canvas) return;
    e.preventDefault();
    const f = [...e.dataTransfer.files][0];
    if (!f || !PC.ready()) return;
    try { VC().open(f.name, new Uint8Array(await f.arrayBuffer())); Files.forget(); toast('Открываю ' + f.name); }
    catch (err) { toast('Не удалось открыть ' + f.name + ': ' + (err.message || err), true); }
  });
  // ------------------------------------------------------------------ файлы на сервере
  // Новая пустая книга — и сразу к ней (закрыть «Файл»).
  async function newWorkbook() {
    await PC.exec('file.new');
    await PC.exec('ui.backstage', { page: 'close' }).catch(() => {});
  }
  const fmtSize = (n) => (n < 1024 ? n + ' Б' : n < 1048576 ? Math.round(n / 1024) + ' КБ' : (n / 1048576).toFixed(1).replace('.', ',') + ' МБ');
  const fmtDate = (t) => {
    if (!t) return '';
    const d = new Date(t * 1000), now = new Date();
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return 'сегодня, ' + time;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ', ' + time;
  };
  const BOOK_EXT = /\.(xlsx|xlsm|xltx|xltm|xls|xlsb|ods|csv|tsv|txt)$/i;
  const XLSX = /\.xlsx$/i;

  // Окно с одним полем: имя файла.
  function askName(title, value, note) {
    return new Promise((resolve) => {
      const box = $('ask');
      $('askTitle').textContent = title;
      $('askNote').textContent = note || '';
      const field = $('askInput');
      field.value = value || '';
      box.hidden = false;
      setTimeout(() => { field.focus(); const dot = field.value.lastIndexOf('.'); field.setSelectionRange(0, dot > 0 ? dot : field.value.length); }, 30);
      const done = (v) => { box.hidden = true; form.onsubmit = null; $('askCancel').onclick = null; box.onkeydown = null; resolve(v); };
      const form = box.querySelector('form');
      form.onsubmit = (e) => { e.preventDefault(); done(field.value.trim() || null); };
      $('askCancel').onclick = () => done(null);
      box.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    });
  }

  // Копия в браузере, если сохранить на сервер не вышло (нет связи, сервер не принял файл).
  const Recovery = (() => {
    const open = () => new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('нет IndexedDB')); return; }
      const r = indexedDB.open('aiexcel', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('recovery');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('recovery', mode);
        const req = fn(tx.objectStore('recovery'));
        tx.oncomplete = () => { db.close(); resolve(req && req.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    };
    return {
      put: (v) => run('readwrite', (s) => s.put(v, 'last')).catch(() => {}),
      get: () => run('readonly', (s) => s.get('last')).catch(() => null),
      clear: () => run('readwrite', (s) => s.delete('last')).catch(() => {}),
    };
  })();

  const Files = (() => {
    let list = [];
    // Книги этой вкладки, которые лежат на сервере под тем же именем: Ctrl+S перезаписывает их там
    // молча. Имя — как его даёт редактор при сохранении (заголовок книги с .xlsx).
    const known = new Set();
    let server = null;        // последняя книга с сервера (для подписи внизу окна)
    let dirty = false;
    let saveAsNext = false;   // «Сохранить как» из панели
    let quietNext = false;    // автосохранение
    let saving = false;
    const api = (q) => CFG.files + (q ? '?' + q : '');
    async function json(r) {
      let j = null;
      try { j = await r.json(); } catch { /* ниже */ }
      if (!j) throw new Error(r.status === 413 ? 'Файл слишком большой для сервера: увеличьте client_max_body_size в nginx и post_max_size в PHP.' : `Сервер ответил ${r.status}: проверьте, что PHP обрабатывает api/files.php.`);
      if (!j.ok) { const e = new Error(j.error || 'Ошибка сервера'); e.exists = !!j.exists; e.login = !!j.login; throw e; }
      return j;
    }
    async function refresh() {
      const j = await json(await fetch(api(''), { credentials: 'same-origin', cache: 'no-store' }));
      list = Array.isArray(j.files) ? j.files : [];
      $('filesWho').textContent = j.user && j.user !== 'local' ? 'на сервере · пользователь ' + j.user : 'на сервере';
      return list;
    }
    const stem = (n) => String(n || '').replace(BOOK_EXT, '');
    function render() {
      const q = norm($('filesSearch').value).trim();
      const rows = list.filter((f) => !q || norm(f.name).includes(q));
      const box = $('filesList');
      if (!list.length) { box.innerHTML = '<p class="st-files-empty">Здесь будут ваши книги. Сохраните открытую книгу кнопкой «Сохранить» или Ctrl+S.</p>'; return; }
      if (!rows.length) { box.innerHTML = '<p class="st-files-empty">Ничего не найдено.</p>'; return; }
      box.innerHTML = rows.map((f, i) => `<div class="st-file" data-i="${i}" tabindex="0">
          <span class="st-file-icon">${ICON.file}</span>
          <span class="st-file-name">${esc(f.name)}</span>
          <span class="st-file-meta">${esc(fmtDate(f.modified))} · ${esc(fmtSize(f.size))}</span>
          <span class="st-file-acts"><button class="st-link" data-a="rename">Переименовать</button><button class="st-link danger" data-a="delete">Удалить</button></span>
        </div>`).join('');
      box.querySelectorAll('.st-file').forEach((row) => {
        const f = rows[+row.dataset.i];
        row.onclick = (e) => { if (!e.target.closest('button')) load(f.name); };
        row.onkeydown = (e) => { if (e.key === 'Enter') load(f.name); };
        row.querySelector('[data-a="rename"]').onclick = () => rename(f.name);
        row.querySelector('[data-a="delete"]').onclick = () => remove(f.name);
      });
    }
    function updateFoot() {
      $('filesCurrent').textContent = server ? `Открыт «${server}»` + (dirty ? ' · есть изменения' : '') : (dirty ? 'Книга ещё не сохранена на сервере' : '');
    }
    async function show(on = true) {
      $('files').hidden = !on;
      if (!on) return;
      $('filesList').innerHTML = '<p class="st-files-empty">Загружаю список…</p>';
      updateFoot();
      try { await refresh(); render(); } catch (e) { $('filesList').innerHTML = `<p class="st-files-empty err">${esc(e.message)}</p>`; }
      setTimeout(() => $('filesSearch').focus(), 30);
    }
    async function load(name) {
      try {
        toast('Открываю «' + name + '»…');
        const r = await fetch(api('action=load&name=' + encodeURIComponent(name)), { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) await json(r);
        const bytes = new Uint8Array(await r.arrayBuffer());
        VC().open(name, bytes);
        server = name;
        // Книгу .xlsx редактор называет так же, как файл: её Ctrl+S перезапишет. Импорт (.xls, .csv…)
        // сохраняется новой книгой .xlsx — под именем, которое спросим.
        if (XLSX.test(name)) known.add(name);
        show(false);
        PC.exec('ui.backstage', { page: 'close' }).catch(() => {});
      } catch (e) { toast('Не удалось открыть: ' + e.message, true); }
    }
    async function upload(name, bytes, overwrite) {
      const r = await fetch(api('action=save&name=' + encodeURIComponent(name) + (overwrite ? '&overwrite=1' : '')), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
      });
      return json(r);
    }
    // Сохранение из редактора (Ctrl+S, Файл › Сохранить, «Сохранить как»): книга .xlsx приходит сюда.
    async function onSave(detail) {
      const quiet = quietNext;
      const asked = saveAsNext || !!detail.saveAs;
      quietNext = false;
      saveAsNext = false;
      const bytes = detail.bytes;
      const own = String(detail.name || '');
      let name = !asked && known.has(own) ? own : null;
      try {
        saving = true;
        if (!name) {
          if (quiet) return;
          name = await askName(asked ? 'Сохранить как' : 'Сохранить на сервере', stem(own || 'Книга') + '.xlsx', 'Книга появится в «Моих книгах».');
          if (!name) { dirty = true; return; }
          // Редактор сохраняет книгу в формате .xlsx — и имя такое же.
          name = stem(name) + '.xlsx';
          if (!list.length) await refresh().catch(() => {});
          if (list.some((f) => f.name === name) && !known.has(name) && !window.confirm(`Книга «${name}» уже есть. Заменить её?`)) { dirty = true; return; }
        }
        const r = await upload(name, bytes, true);
        if (r.name !== own) await PC.exec('file.rename', { name: r.name }).catch(() => {});
        known.add(r.name);
        server = r.name;
        Recovery.clear();
        if (!quiet) toast('Сохранено: «' + r.name + '»');
        if (!$('files').hidden) { await refresh().catch(() => {}); render(); updateFoot(); }
      } catch (e) {
        Recovery.put({ name: name || own, data: bytes, time: Date.now() });
        if (e.login) toast('Войдите в систему, чтобы сохранять книги на сервере. Копия осталась в браузере.', true);
        else toast((quiet ? 'Автосохранение не удалось: ' : 'Не удалось сохранить: ') + e.message + '. Копия осталась в браузере.', true);
      } finally { saving = false; }
    }
    async function save(saveAs) {
      if (!PC.ready()) return;
      saveAsNext = !!saveAs;
      try { await PC.exec(saveAs ? 'file.saveAs' : 'file.save'); } catch (e) { saveAsNext = false; toast('Не удалось сохранить: ' + e.message, true); }
    }
    async function rename(name) {
      const to0 = await askName('Переименовать', name);
      if (!to0 || to0 === name) return;
      const ext = (String(name).match(BOOK_EXT) || ['.xlsx'])[0];
      const to = BOOK_EXT.test(to0) ? to0 : to0 + ext;
      try {
        await json(await fetch(api('action=rename'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, to }) }));
        if (known.has(name)) {
          known.delete(name);
          known.add(to);
          if (XLSX.test(to)) await PC.exec('file.rename', { name: to }).catch(() => {});
        }
        if (server === name) server = to;
        await refresh(); render(); updateFoot();
      } catch (e) { toast('Не удалось переименовать: ' + e.message, true); }
    }
    async function remove(name) {
      if (!window.confirm(`Удалить «${name}»? Файл уйдёт в корзину на сервере.`)) return;
      try {
        await json(await fetch(api('action=delete'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }));
        known.delete(name);
        if (server === name) server = null;
        await refresh(); render();
      } catch (e) { toast('Не удалось удалить: ' + e.message, true); }
    }
    function pickLocal() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.xlsx,.xlsm,.xltx,.xls,.xlsb,.ods,.csv,.tsv,.txt';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try { VC().open(f.name, new Uint8Array(await f.arrayBuffer())); server = null; show(false); toast('Открыта «' + f.name + '». Сохраните её (Ctrl+S), чтобы она появилась в «Моих книгах».'); }
        catch (e) { toast('Не удалось открыть ' + f.name + ': ' + e.message, true); }
      };
      input.click();
    }
    async function offerRecovery() {
      const r = await Recovery.get();
      if (!r || !r.data) return;
      const when = new Date(r.time).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const d = msg('note', `Книгу «${esc(r.name)}» от ${esc(when)} не удалось сохранить на сервер — её копия осталась в браузере. ` +
        '<span class="st-row"><button class="st-mini" data-a="open">Открыть копию</button><button class="st-mini danger" data-a="drop">Удалить копию</button></span>');
      d.querySelector('[data-a="open"]').onclick = () => {
        try { VC().open(r.name, r.data); server = null; d.remove(); toast('Копия открыта. Сохраните её (Ctrl+S).'); }
        catch (e) { toast('Не удалось открыть копию: ' + e.message, true); }
      };
      d.querySelector('[data-a="drop"]').onclick = () => { Recovery.clear(); d.remove(); };
      setOpen(true);
    }
    // Раз в autosaveSeconds: книга, которая уже лежит на сервере, сохраняется туда сама.
    async function tick() {
      for (;;) {
        await sleep(Math.max(15, CFG.autosaveSeconds || 60) * 1000);
        if (!CFG.autosaveSeconds || document.hidden || !PC.ready() || saving || !known.size || !dirty) continue;
        // Пока ячейка редактируется, не сохраняем: введённое ещё не в книге.
        if (VC().wantsKeyboard && VC().wantsKeyboard()) continue;
        quietNext = true;
        await PC.exec('file.save').catch(() => { quietNext = false; });
      }
    }
    function start() {
      VC().takesSaves = true;
      window.addEventListener('aiexcel:save', (e) => onSave(e.detail || {}));
      window.addEventListener('aiexcel:dirty', (e) => { dirty = !!(e.detail && e.detail.dirty); if (!$('files').hidden) updateFoot(); });
      $('filesBtn').onclick = () => show(true);
      $('filesClose').onclick = () => show(false);
      $('files').addEventListener('pointerdown', (e) => { if (e.target === $('files')) show(false); });
      $('files').addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('ask').hidden) { e.preventDefault(); show(false); } });
      $('filesSearch').addEventListener('input', render);
      $('filesNew').onclick = async () => { try { await newWorkbook(); show(false); } catch (e) { toast(e.message, true); } };
      $('filesUpload').onclick = pickLocal;
      $('filesSave').onclick = () => save(false);
      $('filesSaveAs').onclick = () => save(true);
      // Браузер не должен предлагать «Сохранить страницу как…».
      window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) e.preventDefault(); }, true);
      offerRecovery();
      tick();
      if (CFG.filesOnStart) refresh().then((l) => { if (l.length) show(true); }).catch(() => {});
    }
    return { start, show, save, current: () => server, forget: () => { server = null; } };
  })();
  // ------------------------------------------------------------------ быстрые задачи
  const needBook = async () => {
    try { await PC.call('document.inspect'); } catch { throw new Error('Сначала откройте или создайте книгу.'); }
  };
  // Команда для выделенных ячеек (без range — редактор берёт выделение).
  const onSel = (id, params) => async () => { await needBook(); await PC.exec(id, params || {}); };
  // Быстрые задачи: те, что делаются командами, — сразу; остальные — через помощника (! — сделать, ? — объяснить).
  const TASKS = [
    ['Оформление', [
      ['Оформить как таблицу', 'Заголовки, полосы, фильтры — для данных вокруг активной ячейки', onSel('insert.table', { header: true })],
      ['Границы всех ячеек', 'Тонкие линии вокруг каждой выделенной ячейки', onSel('home.borders', { preset: 'all' })],
      ['Полужирный', 'Для выделенных ячеек (например, заголовков)', onSel('home.bold', { on: true })],
      ['Подобрать ширину столбцов', 'По содержимому, на всём листе', onSel('home.autofitColumnWidth')],
      ['Перенос текста', 'Длинный текст — в несколько строк ячейки', onSel('home.wrapText', { on: true })],
      ['Закрепить верхнюю строку', 'Заголовки видны при прокрутке', onSel('view.freezeTopRow')],
    ]],
    ['Числа', [
      ['Денежный формат', 'Выделенные ячейки', onSel('home.numberFormat', { format: 'Currency' })],
      ['Два знака после запятой', 'Числовой формат 0,00 с разделителем групп', onSel('home.numberFormat', { code: '#,##0.00' })],
      ['Проценты', 'Выделенные ячейки', onSel('home.percent')],
      ['Дата', 'Краткий формат даты', onSel('home.numberFormat', { format: 'Short Date' })],
      ['Автосумма', 'Сумма под выделенными числами', onSel('formulas.autoSum', { function: 'SUM' })],
    ]],
    ['Данные', [
      ['Сортировать по возрастанию', 'По столбцу активной ячейки', onSel('data.sortAscending')],
      ['Сортировать по убыванию', 'По столбцу активной ячейки', onSel('data.sortDescending')],
      ['Фильтр', 'Кнопки фильтра в заголовках', onSel('data.filter')],
      ['Удалить дубликаты', 'Повторяющиеся строки выделенного диапазона', async () => {
        if (!window.confirm('Удалить повторяющиеся строки в выделенном диапазоне? Отменить можно Ctrl+Z.')) throw new Error('Отменено');
        await onSel('data.removeDuplicates')();
      }],
      ['Диаграмма', 'Гистограмма по выделенным данным', onSel('insert.chart', { type: 'column' })],
      ['Новый лист', 'В конец книги', onSel('home.insertSheet')],
    ]],
    ['Печать и файл', [
      ['Альбомная ориентация', 'Для активного листа', onSel('pageLayout.orientation', { orientation: 'landscape' })],
      ['Бумага A4', 'Для активного листа', onSel('pageLayout.size', { paper: 'A4' })],
      ['Сохранить на сервер', 'Ctrl+S', async () => { await Files.save(false); }],
      ['Сохранить как…', 'Под другим именем в «Моих книгах»', async () => { await Files.save(true); }],
      ['Скачать PDF', 'Активный лист, как будет напечатан', async () => { await needBook(); await PC.exec('file.exportPdf'); }],
      ['Новая книга', 'Пустая книга', async () => { await newWorkbook(); }],
    ]],
    ['Попросить помощника', [
      ['Выводы по данным', 'Тренды, лидеры, резкие изменения', '?Посмотри данные на активном листе и сделай 3–7 выводов с конкретными числами.'],
      ['Найти ошибки в данных', 'Пропуски, дубликаты, выбросы, числа текстом', '?Проверь данные на активном листе: пропуски, дубликаты, выбросы, числа, записанные текстом, несогласованные даты. Перечисли с адресами ячеек.'],
      ['Строка итогов', 'Суммы под каждым числовым столбцом', '!Добавь под данными на активном листе строку «Итого» с суммами по каждому числовому столбцу (формулами SUM) и выдели её полужирным.'],
      ['Сводка по категориям', 'Новая таблица: категория → сумма', '!Сделай рядом с данными сводку: по каждой категории (первый текстовый столбец) сумма по числовому столбцу, формулами SUMIF. Спроси, какие столбцы взять, если неочевидно.'],
      ['Составить таблицу', 'Новая таблица по описанию', '!Составь таблицу на новом листе: '],
      ['Объяснить формулы', 'Что считают формулы на листе', '?Объясни простыми словами, что считают формулы на активном листе.'],
    ]],
  ];
  const Gallery = (() => {
    function show(on = true) {
      $('gallery').hidden = !on;
      if (on) renderTasks();
    }
    function renderTasks() {
      $('gTasks').innerHTML = TASKS.map(([group, items], gi) => `<section><h4>${esc(group)}</h4><div>${items.map(([n, d], i) => `<button class="st-task" data-g="${gi}" data-i="${i}"><b>${esc(n)}</b><small>${esc(d)}</small></button>`).join('')}</div></section>`).join('');
      $('gTasks').querySelectorAll('.st-task').forEach((b) => {
        const [, , run] = TASKS[+b.dataset.g][1][+b.dataset.i];
        b.onclick = async () => {
          if (typeof run === 'string') {
            show(false);
            setOpen(true);
            setMode(run.startsWith('?') ? 'advice' : 'act');
            const text = run.replace(/^[!?]/, '');
            input.value = text;
            if (/[.:]\s*$/.test(text) && text.endsWith(': ')) { autosize(); input.focus(); input.setSelectionRange(text.length, text.length); }
            else send();
            return;
          }
          b.disabled = true;
          try { await run(); show(false); toast('Готово: ' + b.querySelector('b').textContent + '. Ctrl+Z — отменить.'); }
          catch (e) { toast(e.message, true); }
          finally { b.disabled = false; }
        };
      });
    }
    function start() {
      $('galleryBtn').onclick = () => show(true);
      $('galleryClose').onclick = () => show(false);
      $('gallery').addEventListener('pointerdown', (e) => { if (e.target === $('gallery')) show(false); });
      $('gallery').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); show(false); } });
    }
    return { start, show };
  })();
  // Markdown модели → простой HTML: абзацы, подзаголовки, списки, таблицы, полужирный и курсив.
  function mdToHtml(md) {
    const inline = (s) => esc(s)
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(«])\*([^*\s][^*\n]*?)\*(?=[\s.,;:!?)»]|$)/g, '$1<i>$2</i>')
      .replace(/`([^`\n]+)`/g, '$1');
    const out = [];
    let list = null;
    let rows = null;
    const close = () => {
      if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; }
      if (rows) {
        const [head, ...body] = rows;
        const cells = (r, t) => r.map((c) => `<${t}>${inline(c)}</${t}>`).join('');
        out.push(`<table border="1" style="border-collapse:collapse"><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody></table>`);
        rows = null;
      }
    };
    for (const raw of String(md).replace(/\r/g, '').split('\n')) {
      const line = raw.trimEnd();
      let m;
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (list) close();
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')) continue; // строка-разделитель
        rows = rows || [];
        rows.push(line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      } else if ((m = line.match(/^\s*[-*•–]\s+(.*)$/))) {
        if (rows || (list && list.tag !== 'ul')) close();
        list = list || { tag: 'ul', items: [] };
        list.items.push(m[1]);
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        if (rows || (list && list.tag !== 'ol')) close();
        list = list || { tag: 'ol', items: [] };
        list.items.push(m[1]);
      } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        close();
        const level = Math.min(4, Math.max(2, m[1].length));
        out.push(`<h${level}>${inline(m[2].replace(/#+\s*$/, ''))}</h${level}>`);
      } else if (!line.trim()) {
        close();
      } else {
        close();
        out.push(`<p>${inline(line.trim())}</p>`);
      }
    }
    close();
    return out.join('');
  }
  const mdPlain = (md) => String(md).replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '').trim();
  const mdStructured = (md) => /^\s*([-*•–]\s|\d+[.)]\s|#{1,6}\s|\|)/m.test(md);
  // ------------------------------------------------------------------ ИИ у выделения
  // Кнопка «ИИ» у выделенных ячеек и «ИИ-помощник…» в контекстном меню ячеек присылают событие
  // aiexcel:ai; Ctrl+Alt+Пробел открывает то же меню у выделения. Модель видит выделенные ячейки
  // (их значения и формулы) и начало листа. Результат не попадает в книгу сам: его можно заменить,
  // вставить рядом или скопировать.
  const AI_MENU = [
    ['Формулы', [['explain_formula', 'Объяснить формулу'], ['write_formula', 'Написать формулу…'], ['fix_formula', 'Исправить формулу']]],
    ['Очистка', [['clean', 'Очистить и привести к виду'], ['fix_typos', 'Исправить опечатки'], ['proper_names', 'Регистр: имена с заглавной'], ['extract_numbers', 'Числа из текста']]],
    ['Перевод', [['translate_ru', 'На русский'], ['translate_en', 'На английский'], ['translate_be', 'На белорусский'], ['translate_de', 'На немецкий'], ['translate_fr', 'На французский'], ['translate_es', 'На испанский'], ['translate_zh', 'На китайский']]],
    ['Анализ', [['summarize', 'Кратко о данных'], ['insights', 'Выводы и тренды'], ['check_data', 'Найти ошибки'], ['categorize', 'Разложить по категориям']]],
    ['Диаграмма', [['suggest_chart', 'Подобрать диаграмму']]],
  ];
  const AI_LABEL = Object.fromEntries(AI_MENU.flatMap((g) => g[1]));
  const CHART_RU = { column: 'гистограмма', bar: 'линейчатая', line: 'график', pie: 'круговая', doughnut: 'кольцевая', area: 'с областями', scatter: 'точечная' };

  const ai = { pop: null, sel: null, op: null, custom: '', result: '', kind: 'text', parsed: null, abort: null, anchor: null, formulaMode: false };

  // Ответ модели как таблица значений: JSON-массив строк (в ```…``` или без), иначе таблица Markdown.
  function parseGrid(text) {
    const t = String(text || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
    const a = t.indexOf('['); const b = t.lastIndexOf(']');
    if (a >= 0 && b > a) {
      try {
        const j = JSON.parse(t.slice(a, b + 1));
        if (Array.isArray(j) && j.length) {
          const rows = j.map((r) => (Array.isArray(r) ? r : [r]));
          if (rows.every((r) => r.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)))) return rows;
        }
      } catch { /* ниже */ }
    }
    const lines = t.split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|?[\s:|-]+\|?\s*$/.test(l));
    if (lines.length) return lines.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    return null;
  }
  const parseFormula = (text) => {
    const t = String(text || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').replace(/`/g, '').trim();
    const line = t.split('\n').map((l) => l.trim()).find((l) => l.startsWith('='));
    return line || null;
  };
  function parseChart(text) {
    const t = String(text || '');
    const a = t.indexOf('{'); const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      const j = JSON.parse(t.slice(a, b + 1));
      const type = String(j.type || '').toLowerCase();
      return CHART_RU[type] ? { type, title: String(j.title || '').slice(0, 200), reason: String(j.reason || '').slice(0, 400) } : null;
    } catch { return null; }
  }
  const gridHtml = (rows) => `<table border="1" style="border-collapse:collapse"><tbody>${rows.slice(0, 60).map((r) => `<tr>${r.slice(0, 20).map((v) => `<td>${esc(v === null ? '' : v)}</td>`).join('')}</tr>`).join('')}</tbody></table>` +
    (rows.length > 60 ? `<p>…ещё ${rows.length - 60} строк</p>` : '');
  const gridTsv = (rows) => rows.map((r) => r.map((v) => (v === null ? '' : String(v))).join('\t')).join('\n');

  function aiClose() {
    if (ai.abort) ai.abort.abort();
    ai.abort = null;
    ai.pop?.remove();
    ai.pop = null;
  }
  function aiPlace(x, y) {
    const pop = ai.pop;
    if (!pop) return;
    const w = pop.offsetWidth; const h = pop.offsetHeight;
    const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    const top = y + h + 8 <= window.innerHeight ? y : Math.max(8, Math.min(y - h - 12, window.innerHeight - h - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  // Что выделено: диапазон (последняя область), лист, значения и формулы (не больше aiMaxCells ячеек).
  async function readSelection() {
    const { d, sheets, sheet } = await workbook();
    const areas = String(d.selection || d.activeCell || 'A1').split(',');
    let g = parseRange(areas[areas.length - 1]) || parseRange(d.activeCell) || { c0: 0, r0: 1, c1: 0, r1: 1 };
    const full = rangeA1(g);
    const cut = cellsOf(g) > CFG.aiMaxCells;
    // Целые столбцы и строки — только в пределах заполненного.
    const used = parseRange(sheet.usedRange);
    if (used && cellsOf(g) > 1) {
      g = { c0: Math.max(g.c0, used.c0), r0: Math.max(g.r0, used.r0), c1: Math.min(g.c1, used.c1), r1: Math.min(g.r1, used.r1) };
      if (g.c0 > g.c1 || g.r0 > g.r1) g = parseRange(d.activeCell) || { c0: 0, r0: 1, c1: 0, r1: 1 };
    }
    if (cellsOf(g) > CFG.aiMaxCells) g = capRange(g, CFG.aiMaxCells);
    const range = rangeA1(g);
    const [vals, forms] = await Promise.all([
      PC.exec('sheet.read', { range, formatted: true }).catch(() => ({ values: [] })),
      PC.exec('sheet.read', { range, formulas: true }).catch(() => ({ values: [] })),
    ]);
    // Начало листа — для смысла (заголовки), если выделение его не покрывает.
    let context = null;
    if (used && !(g.r0 <= used.r0 && g.c0 <= used.c0 && cellsOf(g) >= Math.min(cellsOf(used), 800))) {
      const cg = { c0: used.c0, r0: used.r0, c1: Math.min(used.c1, used.c0 + 19), r1: Math.min(used.r1, used.r0 + 29) };
      const r = await PC.exec('sheet.read', { range: rangeA1(cg), formatted: true }).catch(() => null);
      if (r && Array.isArray(r.values)) context = { range: rangeA1(cg), values: r.values };
    }
    const values = Array.isArray(vals.values) ? vals.values : [];
    const formulas = Array.isArray(forms.values) ? forms.values : [];
    const empty = !values.some((r) => (r || []).some((v) => v !== null && v !== ''));
    return { g, range, full, cut, sheet: sheet.name || '', sheets: sheets.map((s) => s.name), active: d.activeCell, values, formulas, context, empty };
  }
  async function aiOpen(x, y) {
    aiClose();
    if (!PC.ready()) return;
    let sel;
    try { sel = await readSelection(); } catch { toast('Сначала откройте или создайте книгу.', true); return; }
    ai.sel = sel;
    ai.formulaMode = false;
    const n = cellsOf(sel.g);
    const pop = document.createElement('div');
    pop.className = 'st-ai-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'ИИ-помощник');
    const scope = n > 1
      ? `Выделено: <b>${esc(sel.range)}</b> · ${sel.g.r1 - sel.g.r0 + 1} × ${sel.g.c1 - sel.g.c0 + 1}` + (sel.cut ? ` (из ${esc(sel.full)} — первые ${n} ${plural(n, 'ячейка', 'ячейки', 'ячеек')})` : '')
      : `Ячейка <b>${esc(sel.range)}</b>` + (sel.empty ? ' — пустая' : '');
    pop.innerHTML = `
      <div class="st-ai-head">
        <span class="st-ai-mark">${ICON.spark}</span>
        <input class="st-ai-input" type="text" placeholder="Что сделать с выделенным? Например: посчитай рост в процентах" aria-label="Свой запрос или поиск по меню" autocomplete="off">
        <button class="st-ai-x" title="Закрыть (Esc)" aria-label="Закрыть">${ICON.x}</button>
      </div>
      <div class="st-ai-scope">${scope}</div>
      <div class="st-ai-body"></div>
      <div class="st-ai-foot">Enter — свой запрос · Esc — закрыть · Ctrl+Alt+Пробел — открыть у выделения</div>`;
    root.appendChild(pop);
    ai.pop = pop;
    const input = pop.querySelector('.st-ai-input');
    pop.querySelector('.st-ai-x').onclick = aiClose;
    input.addEventListener('input', () => { if (!ai.formulaMode) aiMenu(input.value); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); aiClose(); }
      if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); aiRun(ai.formulaMode ? 'write_formula' : 'custom', input.value.trim()); }
      if (e.key === 'ArrowDown') { e.preventDefault(); pop.querySelector('.st-ai-item')?.focus(); }
    });
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); aiClose(); }
      const items = [...pop.querySelectorAll('.st-ai-item')];
      const i = items.indexOf(document.activeElement);
      if (i >= 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault(); e.stopPropagation();
        (items[i + (e.key === 'ArrowDown' ? 1 : -1)] || (e.key === 'ArrowUp' ? input : items[i])).focus();
      }
    });
    aiMenu('');
    ai.anchor = [x, y];
    aiPlace(x, y);
    input.focus();
  }
  function plural(n, one, few, many) {
    const d = n % 10; const h = n % 100;
    return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
  }
  function aiMenu(query) {
    const body = ai.pop?.querySelector('.st-ai-body');
    if (!body) return;
    const q = query.trim().toLowerCase();
    const groups = AI_MENU.map(([g, items]) => [g, items.filter(([, label]) => !q || label.toLowerCase().includes(q) || g.toLowerCase().includes(q))]).filter((g) => g[1].length);
    body.innerHTML = groups.length
      ? groups.map(([g, items]) => `<div class="st-ai-group"><div class="st-ai-gt">${esc(g)}</div><div class="st-ai-items">${items.map(([id, label]) => `<button class="st-ai-item" data-op="${id}">${esc(label)}</button>`).join('')}</div></div>`).join('')
      : `<button class="st-ai-item st-ai-custom" data-op="custom">${ICON.send}<span>Выполнить: «${esc(query.trim())}»</span></button>`;
    body.querySelectorAll('.st-ai-item').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.op === 'custom') { aiRun('custom', query.trim()); return; }
        if (b.dataset.op === 'write_formula') { aiAskFormula(); return; }
        aiRun(b.dataset.op, '');
      };
    });
    if (ai.anchor) aiPlace(...ai.anchor);
  }
  // «Написать формулу…»: поле запроса становится описанием формулы.
  function aiAskFormula() {
    if (!ai.pop) return;
    ai.formulaMode = true;
    const input = ai.pop.querySelector('.st-ai-input');
    input.value = '';
    input.placeholder = `Что посчитать в ${ai.sel?.active || 'ячейке'}? Например: сумма столбца C, где в B «Минск»`;
    ai.pop.querySelector('.st-ai-body').innerHTML = '<p class="st-ai-hint">Опишите словами, что должна считать формула, и нажмите Enter. Формула появится здесь — вставите её сами.</p>';
    input.focus();
    aiPlace(...ai.anchor);
  }
  async function aiRun(op, custom) {
    if (!ai.pop) return;
    ai.op = op; ai.custom = custom;
    const body = ai.pop.querySelector('.st-ai-body');
    const title = op === 'custom' ? custom : op === 'write_formula' ? 'Формула: ' + custom : (AI_LABEL[op] || op);
    body.innerHTML = `<div class="st-ai-res"><div class="st-ai-rt">${esc(title)}</div><div class="st-ai-wait"><div class="st-typing"><i></i><i></i><i></i></div><span>Думаю над данными…</span><button class="st-mini" data-a="stop">Отменить</button></div></div>`;
    ai.pop.querySelector('.st-ai-foot').hidden = true;
    body.querySelector('[data-a="stop"]').onclick = () => { ai.abort?.abort(); aiBack(); };
    aiPlace(...ai.anchor);
    const s = ai.sel;
    ai.abort = new AbortController();
    const payload = {
      mode: 'text',
      op: op === 'custom' ? '' : op,
      custom: op === 'custom' || op === 'write_formula' ? custom : '',
      selection: { range: s.range, sheet: s.sheet, active: s.active, values: s.values, formulas: s.formulas },
      context: s.context,
      workbook: { sheets: s.sheets },
    };
    let j;
    try {
      const r = await fetch(CFG.api, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ai.abort.signal });
      j = await readAnswer(r);
    } catch (e) {
      if (e.name === 'AbortError') return;
      j = { ok: false, error: e.message };
    }
    ai.abort = null;
    if (!ai.pop) return;
    if (!j || !j.ok) {
      body.innerHTML = `<div class="st-ai-res"><div class="st-ai-rt">${esc(title)}</div><p class="st-ai-err">${esc((j && j.error) || 'Модель не ответила.')}</p><div class="st-ai-acts"><button class="st-mini" data-a="back">Назад</button><button class="st-mini" data-a="again">Ещё раз</button></div></div>`;
    } else {
      ai.result = String(j.message?.content || '').trim();
      let kind = String(j.context || '').split(':')[1] || 'text';
      let parsed = null;
      if (kind === 'grid' || kind === 'column') parsed = parseGrid(ai.result);
      else if (kind === 'formula') parsed = parseFormula(ai.result);
      else if (kind === 'chart') parsed = parseChart(ai.result);
      if (op === 'custom') {
        // Свой запрос: что пришло — то и предлагаем вставить.
        const f = parseFormula(ai.result);
        const g = !f && /^\s*(```[a-z]*\s*)?\[/.test(ai.result) ? parseGrid(ai.result) : null;
        if (f && ai.result.trim().split('\n').length <= 2) { kind = 'formula'; parsed = f; } else if (g) { kind = 'grid'; parsed = g; } else kind = 'text';
      }
      if (!parsed && kind !== 'text') kind = 'text';
      ai.kind = kind; ai.parsed = parsed;
      const rows = s.g.r1 - s.g.r0 + 1; const cols = s.g.c1 - s.g.c0 + 1;
      const sameShape = kind === 'grid' && parsed.length === rows && parsed.every((r) => r.length === cols);
      let out; let acts = '';
      if (kind === 'grid' || kind === 'column') {
        out = gridHtml(parsed);
        if (sameShape) acts += '<button class="st-mini primary" data-a="replace">Заменить выделенное</button>';
        acts += `<button class="st-mini ${sameShape ? '' : 'primary'}" data-a="right">Вставить справа</button>`;
        if (kind === 'grid' && !sameShape) out = `<p class="st-ai-note">Ответ — ${parsed.length} × ${Math.max(...parsed.map((r) => r.length))}, а выделено ${rows} × ${cols}: заменить нельзя, можно вставить справа.</p>` + out;
      } else if (kind === 'formula') {
        out = `<p><code class="st-ai-formula">${esc(parsed)}</code></p>`;
        acts += `<button class="st-mini primary" data-a="formula">Вставить в ${esc(s.active || 'ячейку')}</button>`;
      } else if (kind === 'chart') {
        out = `<p><b>${esc(CHART_RU[parsed.type])}</b>${parsed.title ? ' — «' + esc(parsed.title) + '»' : ''}</p>${parsed.reason ? `<p>${esc(parsed.reason)}</p>` : ''}`;
        acts += '<button class="st-mini primary" data-a="chart">Вставить диаграмму</button>';
      } else {
        out = mdToHtml(ai.result) || '<p>(пустой ответ)</p>';
        acts += '<button class="st-mini primary" data-a="below">Вставить под выделением</button>';
      }
      body.innerHTML = `<div class="st-ai-res">
        <div class="st-ai-rt">${esc(title)}<small>${esc(s.context ? 'учтены выделение и начало листа' : 'учтено выделение')}</small></div>
        <div class="st-ai-out">${out}</div>
        <div class="st-ai-acts">
          ${acts}
          <button class="st-mini" data-a="copy">Копировать</button>
          <button class="st-mini" data-a="again" title="Другой вариант">Ещё вариант</button>
          <button class="st-mini" data-a="back">Назад</button>
        </div></div>`;
    }
    body.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => aiAction(b.dataset.a); });
    aiPlace(...ai.anchor);
    body.querySelector('.primary, [data-a="again"]')?.focus();
  }
  function aiBack() {
    if (!ai.pop) return;
    ai.formulaMode = false;
    const input = ai.pop.querySelector('.st-ai-input');
    input.placeholder = 'Что сделать с выделенным? Например: посчитай рост в процентах';
    aiMenu(input.value);
    ai.pop.querySelector('.st-ai-foot').hidden = false;
  }
  // Значения для записи: ячейки с формулами в выделении остаются формулами.
  function keepFormulas(rows, s) {
    return rows.map((r, i) => r.map((v, k) => {
      const f = s.formulas[i] && s.formulas[i][k];
      return typeof f === 'string' && f.startsWith('=') ? f : v === null ? '' : v;
    }));
  }
  async function aiAction(a) {
    if (a === 'back') { aiBack(); return; }
    if (a === 'again') { aiRun(ai.op, ai.custom); return; }
    const s = ai.sel;
    if (a === 'copy') {
      const text = ai.kind === 'grid' || ai.kind === 'column' ? gridTsv(ai.parsed) : ai.kind === 'formula' ? ai.parsed : mdPlain(ai.result);
      try { await navigator.clipboard.writeText(text); } catch {
        const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); } catch { /* нет доступа к буферу */ }
        t.remove();
      }
      toast('Скопировано');
      return;
    }
    // Всё — на активном листе (меню открыто у выделения на нём).
    const sheet = '';
    try {
      if (a === 'replace') {
        await PC.exec('range.setValues', { range: sheet + s.range, values: cleanValues(keepFormulas(ai.parsed, s)), parse: false });
      } else if (a === 'right') {
        const at = sheet + a1(s.g.c1 + 1, s.g.r0);
        await PC.exec('range.setValues', { range: at, values: cleanValues(ai.parsed), parse: false });
      } else if (a === 'formula') {
        await PC.exec('cell.set', { cell: s.active || a1(s.g.c0, s.g.r0), input: ai.parsed });
      } else if (a === 'chart') {
        await PC.exec('insert.chart', { range: sheet + s.range, type: ai.parsed.type, ...(ai.parsed.title ? { title: ai.parsed.title } : {}) });
      } else if (a === 'below') {
        const lines = mdPlain(ai.result).split('\n').map((l) => l.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, '').trim()).filter(Boolean).slice(0, 200);
        await PC.exec('range.setValues', { range: sheet + a1(s.g.c0, s.g.r1 + 2), values: lines.map((l) => [l]), parse: false });
      }
      aiClose();
      toast('Готово. Отменить — Ctrl+Z');
    } catch (e) {
      toast('Не получилось вставить: ' + e.message, true);
    }
  }
  const canvasRect = () => {
    const c = document.getElementById(CANVAS_ID);
    return c ? c.getBoundingClientRect() : { left: 0, top: 0 };
  };
  window.addEventListener('aiexcel:ai', (e) => {
    const r = canvasRect();
    const d = e.detail || {};
    aiOpen(r.left + (Number(d.x) || 0), r.top + (Number(d.y) || 0));
  });
  window.addEventListener('keydown', async (e) => {
    if (e.code === 'Space' && e.altKey && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      let x = 120; let y = 120;
      try {
        const st = await PC.call('ui.inspect');
        const r = canvasRect();
        const zoom = ((st.ui && +st.ui.interfaceScale) || 100) / 100;
        const s = st.selectionRect;
        if (s) { x = r.left + (s.x + s.w) * zoom + 4; y = r.top + (s.y + s.h) * zoom + 6; }
      } catch { /* у левого верхнего угла */ }
      aiOpen(x, y);
    }
  }, true);
  document.addEventListener('pointerdown', (e) => { if (ai.pop && !ai.pop.contains(e.target) && !ai.abort) aiClose(); }, true);

  // ------------------------------------------------------------------ тема
  // Тема редактора: фирменная (по умолчанию), светлая, тёмная или как в системе. Панель — в тон.
  const THEMES = [['brand', 'Фирменная'], ['light', 'Светлая'], ['dark', 'Тёмная'], ['system', 'Как в системе']];
  const systemDark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  function applyPanelTheme(themeId) {
    root.dataset.theme = themeId === 'brand' ? 'brand' : (themeId === 'dark' || (themeId === 'system' && systemDark()) ? 'dark' : 'light');
    document.documentElement.classList.toggle('studio-brand', themeId === 'brand');
    renderThemeMenu(themeId);
  }
  const syncBackdrop = () => {};
  function renderThemeMenu(current) {
    const menu = $('themeMenu');
    if (!menu) return;
    menu.innerHTML = THEMES.map((t) => `<button role="menuitemradio" aria-checked="${t[0] === current}" data-theme-id="${t[0]}">${esc(t[1])}</button>`).join('');
    menu.querySelectorAll('button').forEach((b) => { b.onclick = () => { toggleThemeMenu(false); setTheme(b.dataset.themeId); }; });
  }
  function toggleThemeMenu(open) {
    const menu = $('themeMenu');
    if (!menu) return;
    const show = open == null ? menu.hidden : open;
    menu.hidden = !show;
    $('theme').setAttribute('aria-expanded', String(show));
  }
  async function setTheme(themeId) {
    applyPanelTheme(themeId);
    if (PC.ready()) await PC.call('ui.theme', { value: themeId }).catch(() => {});
  }
  // Тема, которая сейчас в редакторе, как бы её ни выбрали (Файл › Параметры, список в панели).
  async function watchTheme() {
    for (;;) {
      if (!document.hidden && PC.ready()) {
        try {
          const ui = await PC.call('ui.inspect');
          const id = ui && ui.theme;
          if (typeof id === 'string') applyPanelTheme(id.toLowerCase());
          // Заголовок вкладки браузера — имя документа (окно браузера редактор сам не переименует).
          if (ui && typeof ui.title === 'string') document.title = ui.title ? `${ui.title}${ui.dirty ? ' •' : ''} — AI-Excel` : 'AI-Excel';
        } catch { /* не важно */ }
      }
      await sleep(2000);
    }
  }

  async function status() {
    try {
      const r = await fetch(CFG.api, { credentials: 'same-origin' });
      const j = await r.json();
      if (j.ok) {
        $('sub').textContent = 'Модель: ' + j.model;
        fetch('studio/version.json', { cache: 'no-store' }).then((v) => (v.ok ? v.json() : null)).then((v) => {
          if (!v || !v.build) return;
          const d = String(v.date || '').split('-').reverse().join('.');
          $('sub').textContent = 'Модель: ' + j.model + ' · сборка ' + v.build + (d ? ' от ' + d : '');
          const pageBuild = document.documentElement.dataset.build;
          if (pageBuild && pageBuild !== String(v.build)) {
            const page = +pageBuild, server = +v.build;
            if (page > server) {
              msg('note', `Страница — от сборки ${esc(pageBuild)}, а файлы на сервере частично остались от сборки ${esc(String(v.build))}: ` +
                'программа заливки, похоже, пропустила файлы того же размера. Удалите старую папку на сервере целиком и залейте новую ' +
                '(или включите в программе «перезаписывать всегда»).');
            } else {
              msg('note', `Открыта старая копия страницы из кэша браузера (сборка ${esc(pageBuild)}), а на сервере уже сборка ${esc(String(v.build))}. Нажмите <b>Ctrl+F5</b>, чтобы загрузить новую.`);
            }
          }
        }).catch(() => {});
      }
      else $('sub').textContent = j.login ? 'Нужно войти в систему' : (j.error || 'Нет связи с помощником');
    } catch {
      $('sub').textContent = 'Нет связи с сервером помощника';
    }
  }

  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; }

  function mount() {
    document.body.appendChild(root);
    root.querySelectorAll('.st-seg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    $('eye').onclick = () => setEye(!attachScreen);
    $('hide').onclick = () => setOpen(false);
    $('fab').onclick = () => { setOpen(true); setBadge(false); };
    $('send').onclick = () => send();
    $('barBtn').onclick = () => setBar(!root.classList.contains('bar-open'));
    $('barSend').onclick = () => (busy ? send() : sendFromBar());
    $('barMode').onclick = () => setMode(mode === 'act' ? 'advice' : 'act');
    barInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendFromBar(); }
      if (e.key === 'Escape') { e.preventDefault(); setBar(false); }
    });
    $('clear').onclick = () => { if (!busy) { convo = []; showEmpty(); } };
    // Луна/солнце — между светлой и тёмной неоморфными; из фирменной — в светлую.
    $('theme').onclick = (e) => { e.stopPropagation(); toggleThemeMenu(); };
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest || !e.target.closest('.st-theme-wrap')) toggleThemeMenu(false); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleThemeMenu(false); });
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    setMode(mode);
    setEye(attachScreen);
    applyPanelTheme('brand');
    showEmpty();
    status();
  }

  async function boot() {
    mount();
    // Ждём, пока WebAssembly загрузится и поставит window.aiexcel.
    while (!PC.ready()) await sleep(200);
    Files.start();
    await sleep(300);
    root.classList.add('ready');
    if (store.get('open', CFG.openOnStart)) setOpen(true);
    commands().catch(() => {});
    watchTheme();
    Gallery.start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
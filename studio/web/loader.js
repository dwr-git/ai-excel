/* AI-Excel — самопроверка загрузки.
 *
 * Пока приложение скачивается, страница показывает, сколько уже получено. Если запуск не удался,
 * здесь же видно, какой файл не пришёл и почему (а не только «Загрузка идёт дольше обычного»).
 *
 * Всё приложение берётся только из этой папки: ни интернет, ни сторонние сайты не нужны.
 * Скрипт обычный (не модуль) и стоит в <head> первым, поэтому успевает подключиться раньше,
 * чем загрузчик приложения начнёт скачивать свои части.
 */
(function () {
  'use strict';
  var total = +document.documentElement.getAttribute('data-app-bytes') || 0;
  var got = 0;
  var problems = [];
  var lastByteAt = Date.now();

  function $(id) { return document.getElementById(id); }
  function loading() { return $('gridcraft_loading'); }
  function rel(u) {
    try {
      var a = new URL(u, location.href).href, base = new URL('.', location.href).href;
      return a.indexOf(base) === 0 ? a.slice(base.length).split('?')[0] : a;
    } catch (e) { return String(u); }
  }
  function mb(n) { return (n / 1048576).toFixed(1).replace('.', ','); }

  // The app's own loader may replace the text of the loading block («пробую ещё раз»), so the
  // progress line and the problem box are re-created when they are gone.
  function el(id) {
    var e = $(id), box = loading();
    if (!e && box) { e = document.createElement('p'); e.id = id; box.appendChild(e); }
    return e;
  }
  function render() {
    if (!loading()) return;
    var bar = $('ap_bar'), txt = el('ap_progress'), box = problems.length ? el('ap_problem') : $('ap_problem');
    if (txt) txt.textContent = !got ? '' : total && got >= total ? 'Скачано ' + mb(total) + ' МБ, запускается…' : 'Скачано ' + (total ? mb(got) + ' из ' + mb(total) + ' МБ' : mb(got) + ' МБ');
    if (bar) bar.style.width = total ? Math.min(100, got / total * 100) + '%' : (got ? '100%' : '0');
    if (box && problems.length) {
      box.hidden = false;
      box.textContent = '';
      var head = document.createElement('strong');
      head.textContent = 'Что пошло не так:';
      box.appendChild(head);
      problems.forEach(function (p) {
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode('• ' + p));
      });
    }
  }
  function problem(text) {
    if (problems.indexOf(text) < 0 && problems.length < 6) {
      problems.push(text);
      if (window.console && console.warn) console.warn('AI-Excel:', text);
      render();
    }
  }
  window.__aiExcelProblem = problem;
  document.addEventListener('DOMContentLoaded', function () {
    var box = loading();
    if (box && window.MutationObserver) new MutationObserver(function () { if (got || problems.length) render(); }).observe(box, { childList: true });
  });

  // 1. Файлы, которые браузер не смог подключить (скрипты, стили, модули).
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      var u = t.src || t.href;
      problem('Не загрузился файл ' + rel(u) + '.');
      if (/\.js(\?|$)/.test(u) && nativeFetch) check(u, true);
    }
    else if (e.message && loading()) problem('Ошибка при запуске: ' + e.message);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    if (!loading()) return;
    var r = e.reason;
    problem('Не удалось запустить: ' + (r && r.message ? r.message : String(r)));
  });
  // Загрузчик приложения сообщает о сбое в консоль — повторяем это на странице.
  var consoleError = console.error;
  console.error = function () {
    try {
      var text = Array.prototype.map.call(arguments, function (a) { return a && a.message ? a.message : String(a); }).join(' ');
      if (loading() && !problems.length && /-boot|could not start|HTTP \d|web page|WebAssembly|damaged|parts list/.test(text)) problem('Загрузчик сообщил: ' + text.replace(/^[\w-]+-boot: could not start [^:]+: /, ''));
    } catch (err) { /* только для показа */ }
    return consoleError.apply(console, arguments);
  };

  // 2. Скачивание частей приложения: прогресс и ответы сервера.
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      return nativeFetch.apply(this, arguments).then(function (r) {
        var name = rel(r.url || url), type = r.headers.get('Content-Type') || '';
        var ours = /(^|\/)app\/|\.wasm$/.test(name);
        if (ours && !r.ok) {
          problem('Сервер ответил «' + r.status + (r.statusText ? ' ' + r.statusText : '') + '» на файл ' + name + '.' +
            (r.status === 404 ? ' Похоже, папка скопирована не целиком — скопируйте её заново со всеми вложенными папками.' :
              r.status === 403 ? ' Доступ к файлу запрещён настройками сервера.' : ''));
        } else if (ours && type.indexOf('text/html') === 0) {
          problem('Вместо файла ' + name + ' сервер прислал веб-страницу. Обычно так бывает, когда правило сервера перенаправляет запросы этой папки на другую страницу (например, на вход или на главную).');
        }
        if (r.ok && /\.part-[a-z]+$/.test(name) && type.indexOf('text/html') !== 0 && r.body && window.ReadableStream && window.Response) {
          var reader = r.body.getReader();
          var counted = new ReadableStream({
            pull: function (c) {
              return reader.read().then(function (x) {
                if (x.done) { c.close(); return; }
                got += x.value.byteLength; lastByteAt = Date.now(); render();
                c.enqueue(x.value);
              });
            },
            cancel: function (why) { return reader.cancel(why); }
          });
          return new Response(counted, { status: r.status, statusText: r.statusText, headers: r.headers });
        }
        return r;
      }, function (err) {
        if (/(^|\/)app\/|\.wasm$/.test(rel(url))) problem('Не удалось скачать ' + rel(url) + ': ' + (err && err.message ? err.message : err) + '.');
        throw err;
      });
    };
  }

  // 3. Если за 12 секунд не пришло ни байта и ошибок нет — проверяем файлы сами.
  function check(url, wantScript) {
    return nativeFetch(url, { cache: 'no-store' }).then(function (r) {
      var type = (r.headers.get('Content-Type') || '').toLowerCase();
      if (!r.ok) problem('Файл ' + rel(url) + ' недоступен: сервер ответил «' + r.status + '».');
      else if (type.indexOf('text/html') === 0) problem('Вместо файла ' + rel(url) + ' сервер присылает веб-страницу.');
      else if (wantScript && !/javascript|ecmascript/.test(type)) {
        problem('Файл ' + rel(url) + ' сервер отдаёт с типом «' + (type || 'не указан') + '», а браузер запускает модули только с типом JavaScript. ' +
          'В nginx проверьте, что в блоке http подключён include mime.types; (тип application/javascript для .js).');
      }
    }, function (err) { problem('Файл ' + rel(url) + ' не скачивается: ' + (err && err.message ? err.message : err) + '.'); });
  }
  setTimeout(function () {
    if (!loading() || got > 0 || problems.length || !nativeFetch) return;
    var checks = [];
    var boot = document.querySelector('link[rel="modulepreload"]');
    if (boot && boot.href) checks.push(check(boot.href, true));
    var wasm = document.querySelector('link[rel="preload"][href$=".wasm"]');
    if (wasm && wasm.href) checks.push(check(wasm.href, false));
    checks.push(check('app/parts.txt', false));
    checks.push(check('app/ai-excel.js', true));
    Promise.all(checks).then(function () {
      if (loading() && !problems.length && got === 0) {
        problem('Файлы на сервере в порядке, но запуск не начался. Попробуйте обновить страницу с очисткой кэша (Ctrl+Shift+R) или другой браузер — нужен Chrome, Edge, Firefox или Safari свежей версии.');
      }
    });
  }, 12000);

  // 4. Скачивание началось, но замерло.
  setInterval(function () {
    if (loading() && got > 0 && (!total || got < total) && Date.now() - lastByteAt > 20000 && !problems.length) {
      problem('Скачивание остановилось на ' + mb(got) + ' МБ. Проверьте соединение с сервером и обновите страницу.');
    }
  }, 5000);
})();

/**
 * Открыть пустую вкладку СИНХРОННО в обработчике клика (до первого await).
 *
 * Браузер разрешает window.open только в пределах пользовательского жеста. Если
 * звать его ПОСЛЕ await (загрузка pdfmake ~2МБ / дозагрузка данных) — popup
 * блокируется и выходит пустая белая вкладка (классическая «второй клик — белый
 * экран»). Поэтому вкладку открываем здесь, синхронно в onClick, а готовый PDF
 * подставляем в неё позже (см. openDoc в lib/pdf). Если popup всё же заблокирован —
 * вернёт null, и openDoc скачает файл (надёжный fallback).
 *
 * Лёгкий модуль БЕЗ зависимостей — статик-импорт не тянет pdfmake/штрихкод в бандл.
 */
export function openPrintWindow(): Window | null {
  const win = window.open('', '_blank');
  if (win) {
    try {
      win.document.write(
        '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Документ…</title></head>' +
          '<body style="margin:0;font-family:system-ui,-apple-system,sans-serif;display:grid;' +
          'place-items:center;height:100vh;color:#64748b;font-size:15px">Готовим документ…</body></html>',
      );
      win.document.close();
    } catch {
      /* окно могло закрыться/стать кросс-ориджин — не критично */
    }
  }
  return win;
}

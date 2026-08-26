/** Запрос с повторами на 429 и 5xx. Экспоненциальная пауза. */
export async function запрос(url, опции = {}, { попыток = 5, пауза = 1000, имя = url } = {}) {
  let ждать = пауза;

  for (let i = 1; i <= попыток; i += 1) {
    const ответ = await fetch(url, опции);
    const текст = await ответ.text();

    if (ответ.ok) return текст ? JSON.parse(текст) : {};

    const повторим = ответ.status === 429 || ответ.status === 409 || ответ.status >= 500;
    if (!повторим || i === попыток) {
      throw new Error(`${имя} вернул ${ответ.status}: ${текст.slice(0, 400)}`);
    }

    await сон(ждать);
    ждать *= 2;
  }

  throw new Error(`${имя}: не ответил за ${попыток} попыток`);
}

export const сон = (мс) => new Promise((r) => setTimeout(r, мс));

/** Даты для API: ISO с Z. */
export const iso = (д) => new Date(д).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Смещение Москвы. Круглый год UTC+3, перевода часов нет с 2014-го.
 * Держим здесь, чтобы вся работа со временем в проекте считалась от одной константы.
 */
export const МСК_СМЕЩЕНИЕ = 3 * 3600 * 1000;

/**
 * Дата для таблицы: Google Sheets понимает такой формат как дату.
 * Считаем по Москве, а не по поясу сервера: на Railway он UTC, и время в книге
 * отставало от кабинетов маркетплейсов на три часа. Сдвигаем метку и читаем
 * UTC-геттерами — так результат не зависит от того, где запущен сервис.
 */
export function вТаблицу(значение) {
  if (!значение) return '-';
  const д = значение instanceof Date ? значение : new Date(значение);
  if (Number.isNaN(д.getTime())) return '-';
  const м = new Date(д.getTime() + МСК_СМЕЩЕНИЕ);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(м.getUTCDate())}.${p(м.getUTCMonth() + 1)}.${м.getUTCFullYear()} ${p(м.getUTCHours())}:${p(м.getUTCMinutes())}`;
}

export const число = (з) => {
  if (з === null || з === undefined) return 0;
  if (typeof з === 'object') return Number(з.amount) || 0;
  return Number(з) || 0;
};

export const флаг = (з) => (з === true ? 'да' : '-');

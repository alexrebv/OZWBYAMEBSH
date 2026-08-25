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

/** Дата для таблицы: Google Sheets понимает такой формат как дату. */
export function вТаблицу(значение) {
  if (!значение) return '-';
  const д = значение instanceof Date ? значение : new Date(значение);
  if (Number.isNaN(д.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(д.getDate())}.${p(д.getMonth() + 1)}.${д.getFullYear()} ${p(д.getHours())}:${p(д.getMinutes())}`;
}

export const число = (з) => {
  if (з === null || з === undefined) return 0;
  if (typeof з === 'object') return Number(з.amount) || 0;
  return Number(з) || 0;
};

export const флаг = (з) => (з === true ? 'да' : '-');

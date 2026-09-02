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

/**
 * Дата из ячейки настроек («С даты»). Ячейку заполняют руками текстом «01.08.2026»,
 * но Google может распознать её как настоящую дату и вернуть уже в своём виде,
 * поэтому разбираем оба случая. Возвращаем null, если разобрать нечего.
 */
export function изЯчейки(значение) {
  if (значение === null || значение === undefined) return null;
  const с = String(значение).trim();
  if (!с) return null;

  // ДД.ММ.ГГГГ — и рукописный текст, и то, как Sheets рендерит дату в русской локали.
  // Ведущие нули Sheets срезает, поэтому допускаем одну или две цифры. Время после даты
  // Sheets тоже дописывает («01.08.2026, 0:00:00») — принимаем и отбрасываем: нужен день.
  const м = с.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[,\s]|$)/);
  if (м) return new Date(Date.UTC(+м[3], +м[2] - 1, +м[1]) - МСК_СМЕЩЕНИЕ);

  // голое число new Date разобрал бы как год («42» → 2042), а это не дата
  if (/^\d+([.,]\d+)?$/.test(с)) return null;

  // остальное — через изМосквы: она вернёт московскую полночь для «2026-08-01»
  // и не тронет строку с явным поясом
  return изМосквы(с);
}

/**
 * Метка времени без указания пояса. WB Statistics и Яндекс Маркет отдают московское
 * время без суффикса, а new Date() разбирает такую строку в поясе сервера — на Railway
 * это UTC, и время уезжает на три часа. Если пояс в строке указан явно, доверяем ему.
 */
export function изМосквы(значение) {
  if (!значение) return null;
  if (значение instanceof Date) return Number.isNaN(значение.getTime()) ? null : значение;

  const с = String(значение).trim();
  if (!с) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(с)) return new Date(с);

  // время необязательно: «2026-08-05» — это московская полночь, а не UTC-полночь,
  // иначе дата без времени печатается в книге с фантомными 03:00
  const м = с.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (м) {
    return new Date(
      Date.UTC(+м[1], +м[2] - 1, +м[3], +(м[4] || 0), +(м[5] || 0), +(м[6] || 0)) - МСК_СМЕЩЕНИЕ,
    );
  }

  const д = new Date(с);
  return Number.isNaN(д.getTime()) ? null : д;
}

/** «ГГГГ-ММ-ДДTЧЧ:ММ:СС» по Москве — WB Statistics ждёт местное время без пояса. */
export function мскISO(д) {
  return new Date(д.getTime() + МСК_СМЕЩЕНИЕ).toISOString().slice(0, 19);
}

/**
 * Режет период на окна не длиннее заданного числа суток.
 * WB /api/v3/orders разрешает «максимум 30 календарных дней одним запросом»,
 * Яндекс /orders отвечает «interval between dateFrom and dateTo is more than 30 days».
 * Берём с запасом, чтобы не спорить с тем, как каждый из них считает календарные сутки.
 */
export function окнами(с, по, дней) {
  const начало = с instanceof Date ? с.getTime() : new Date(с).getTime();
  const конец = по instanceof Date ? по.getTime() : new Date(по).getTime();
  if (!(начало < конец)) return [[new Date(начало), new Date(конец)]];

  const шаг = дней * 24 * 3600 * 1000;
  const окна = [];
  for (let а = начало; а < конец; а += шаг) {
    окна.push([new Date(а), new Date(Math.min(а + шаг, конец))]);
  }
  return окна;
}

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

import { SHEETS } from './schemas.js';
import { сохранить, читать, штрихкодыИзСправочника } from './sheets.js';
import { требовать } from './config.js';
import { запрос, сон, вТаблицу, флаг } from './http.js';

const ХОСТ = 'https://marketplace-api.wildberries.ru';
const ПАУЗА = 250;   // лимит 300 запросов в минуту на категорию «Маркетплейс»

const СТАТУСЫ_ПРОДАВЦА = {
  new: 'Новое', confirm: 'На сборке', complete: 'В доставке', cancel: 'Отменено продавцом',
};

const СТАТУСЫ_WB = {
  waiting: 'Ожидает', sorted: 'Отсортировано', sold: 'Получено покупателем',
  canceled: 'Отменено', canceled_by_client: 'Отменено покупателем',
  declined_by_client: 'Отказ при получении', defect: 'Брак', ready_for_pickup: 'Прибыло на ПВЗ',
};

const ФИНАЛЬНЫЕ = new Set(['sold', 'canceled', 'canceled_by_client', 'declined_by_client', 'defect']);

const ТИПЫ_ДОСТАВКИ = { fbs: 'FBS', dbs: 'DBS', edbs: 'ЭDBS', wbgo: 'WBGo' };

function вызов(параметры, метод, глагол = 'GET', тело = null) {
  const [ключ] = требовать(параметры, 'WB Api-Key');
  const опции = { method: глагол, headers: { Authorization: ключ } };
  if (тело) {
    опции.headers['Content-Type'] = 'application/json';
    опции.body = JSON.stringify(тело);
  }
  return запрос(ХОСТ + метод, опции, { имя: `WB ${метод}`, пауза: 2000 });
}

// ─────────────────────── ПРОДАЖИ ───────────────────────

export async function продажи(параметры, задача) {
  const глубина = задача.глубина || 7;
  const по = Math.floor(Date.now() / 1000);
  const с = по - глубина * 24 * 3600;

  const задания = [];
  let next = 0;

  for (let страниц = 0; страниц < 200; страниц += 1) {
    const url = `/api/v3/orders?limit=1000&next=${next}&dateFrom=${с}&dateTo=${по}`;
    const ответ = await вызов(параметры, url);
    const пачка = ответ.orders || [];
    задания.push(...пачка);

    if (!пачка.length || !ответ.next || ответ.next === next) break;
    next = ответ.next;
    await сон(ПАУЗА);
  }

  const отметка = вТаблицу(new Date());
  const строки = задания.map((з) => строкаИзЗадания(з, отметка));
  const итог = await сохранить(SHEETS.WB_ПРОДАЖИ, строки);

  const освежено = await обновитьСтатусы(параметры);
  return `заданий ${итог.всего}, новых ${итог.новых}, статусов ${освежено}`;
}

function строкаИзЗадания(з, отметка) {
  const копейки = (в) => (Number(в) || 0) / 100;
  return [
    String(з.id),
    вТаблицу(з.createdAt),
    з.article || '-',
    з.nmId || '-',
    з.chrtId || '-',
    (з.skus || []).length ? String(з.skus[0]) : '-',
    копейки(з.price),
    копейки(з.convertedPrice ?? з.price),
    з.currencyCode || з.convertedCurrencyCode || '-',
    '-',   // статус продавца приходит отдельным методом
    '-',   // статус WB
    з.warehouseId || '-',
    з.supplyId || '-',
    ТИПЫ_ДОСТАВКИ[з.deliveryType] || з.deliveryType || '-',
    флаг(з.cargoType > 1),
    вТаблицу(з.ddate),
    копейки(з.dprice),
    флаг(з.options?.isB2B),
    з.comment || '-',
    отметка,
  ];
}

/**
 * Метод списка отдаёт задания без актуального статуса, поэтому статусы
 * добираются отдельно — только по тем заданиям, которые ещё не закрыты.
 */
async function обновитьСтатусы(параметры, максимум = 5000) {
  const финальныеРу = new Set([...ФИНАЛЬНЫЕ].map((к) => СТАТУСЫ_WB[к]));
  const данные = await читать(SHEETS.WB_ПРОДАЖИ, 'A2:K');
  if (!данные.length) return 0;

  const кОбновлению = [];
  for (let i = данные.length - 1; i >= 0 && кОбновлению.length < максимум; i -= 1) {
    const id = данные[i][0];
    const статус = данные[i][10];
    if (id && !финальныеРу.has(статус)) кОбновлению.push({ id: Number(id), строка: i });
  }
  if (!кОбновлению.length) return 0;

  const найдено = new Map();
  for (let i = 0; i < кОбновлению.length; i += 1000) {
    const пачка = кОбновлению.slice(i, i + 1000);
    const ответ = await вызов(параметры, '/api/v3/orders/status', 'POST', {
      orders: пачка.map((э) => э.id),
    });
    for (const о of ответ.orders || []) {
      найдено.set(String(о.id), [
        СТАТУСЫ_ПРОДАВЦА[о.supplierStatus] || о.supplierStatus || '-',
        СТАТУСЫ_WB[о.wbStatus] || о.wbStatus || '-',
      ]);
    }
    await сон(ПАУЗА);
  }

  const колонки = данные.map((р) => [р[9] ?? '-', р[10] ?? '-']);
  let обновлено = 0;
  for (const э of кОбновлению) {
    const н = найдено.get(String(э.id));
    if (н) { колонки[э.строка] = н; обновлено += 1; }
  }

  const { писать } = await import('./sheets.js');
  await писать(SHEETS.WB_ПРОДАЖИ, `J2:K${колонки.length + 1}`, колонки);
  return обновлено;
}

// ─────────────────────── ОСТАТКИ ───────────────────────

export async function остатки(параметры) {
  const склады = await вызов(параметры, '/api/v3/warehouses');
  const список = (Array.isArray(склады) ? склады : склады.warehouses || [])
    .filter((с) => с.id);

  const баркоды = await штрихкодыИзСправочника();
  if (!список.length) throw new Error('У продавца не найдено складов FBS');
  if (!баркоды.length) throw new Error('В справочнике «Общая инфо» нет штрихкодов');

  const отметка = вТаблицу(new Date());
  const строки = [];

  for (const склад of список) {
    for (let i = 0; i < баркоды.length; i += 1000) {
      const пачка = баркоды.slice(i, i + 1000);
      const ответ = await вызов(параметры, `/api/v3/stocks/${склад.id}`, 'POST', { skus: пачка });

      for (const о of ответ.stocks || []) {
        const кол = Number(о.amount) || 0;
        if (!кол) continue;
        строки.push([String(о.sku), склад.name || String(склад.id), кол, отметка]);
      }
      await сон(ПАУЗА);
    }
  }

  await сохранить(SHEETS.WB_ОСТАТКИ, строки);
  return `складов ${список.length}, баркодов ${баркоды.length}, строк ${строки.length}`;
}

import { SHEETS } from './schemas.js';
import { сохранить } from './sheets.js';
import { требовать } from './config.js';
import { запрос, сон, iso, вТаблицу, число, флаг } from './http.js';

const ХОСТ = 'https://api-seller.ozon.ru';
const ЛИМИТ = 100;               // потолок v4/posting/fbs/list
const ПАУЗА = 200;
const ОКНО_СОЗДАНИЯ_ДНЕЙ = 60;   // since/to обязательны, поэтому берём широкий период

const СТАТУСЫ = {
  acceptance_in_progress: 'Идёт приёмка',
  arbitration: 'Арбитраж',
  awaiting_approve: 'Ожидает подтверждения',
  awaiting_deliver: 'Ожидает отгрузки',
  awaiting_packaging: 'Ожидает упаковки',
  awaiting_registration: 'Ожидает регистрации',
  awaiting_verification: 'Создано',
  cancelled: 'Отменено',
  cancelled_from_split_pending: 'Отменено при разделении',
  client_arbitration: 'Клиентский арбитраж',
  delivered: 'Доставлено',
  delivering: 'Доставляется',
  driver_pickup: 'У водителя',
  not_accepted: 'Не принято на сортировке',
};

const ТИПЫ_ОТМЕН = {
  seller: 'Продавец', client: 'Покупатель', customer: 'Покупатель',
  ozon: 'Ozon', system: 'Система', delivery: 'Служба доставки',
};

const ТИПЫ_ТАРИФА = {
  discount: 'Скидка', surcharge: 'Надбавка', markup: 'Надбавка', commission: 'Комиссия',
};

function вызов(параметры, метод, тело) {
  const [clientId, apiKey] = требовать(параметры, 'OZON Client-Id', 'OZON Api-Key');
  return запрос(ХОСТ + метод, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Id': clientId, 'Api-Key': apiKey },
    body: JSON.stringify(тело),
  }, { имя: `Ozon ${метод}` });
}

// ─────────────────────── ПРОДАЖИ ───────────────────────

export async function продажи(параметры, задача) {
  const глубина = задача.глубина || 3;
  const по = new Date();
  const статусС = new Date(по.getTime() - глубина * 24 * 3600 * 1000);
  const созданС = new Date(по.getTime() - ОКНО_СОЗДАНИЯ_ДНЕЙ * 24 * 3600 * 1000);

  const отправления = [];
  let курсор = '';

  for (let страниц = 0; страниц < 500; страниц += 1) {
    const ответ = await вызов(параметры, '/v4/posting/fbs/list', {
      sort_dir: 'ASC',
      limit: ЛИМИТ,
      cursor: курсор,
      filter: {
        // since/to метод требует всегда, даже когда фильтруем по смене статуса
        since: iso(созданС),
        to: iso(по),
        last_changed_status_date: { from: iso(статусС), to: iso(по) },
      },
      with: { analytics_data: true, financial_data: true },
    });

    отправления.push(...(ответ.postings || []));

    if (!ответ.has_next || !ответ.cursor || ответ.cursor === курсор) break;
    курсор = ответ.cursor;
    await сон(ПАУЗА);
  }

  const отметка = вТаблицу(new Date());
  const строки = отправления.flatMap((о) => строкиИзОтправления(о, отметка));
  const итог = await сохранить(SHEETS.OZON_ПРОДАЖИ, строки);

  return `отправлений ${отправления.length}, строк ${итог.всего}, новых ${итог.новых}`;
}

function строкиИзОтправления(о, отметка) {
  const товары = о.products || [];
  if (!товары.length) return [];

  const фд = о.financial_data || {};
  const финансы = new Map((фд.products || []).map((ф) => [String(ф.product_id), ф]));

  const а = о.analytics_data || {};
  const отмена = о.cancellation || {};
  const тф = о.tariffication || {};

  const общее = [
    ТИПЫ_ТАРИФА[тф.current_tariff_type] || тф.current_tariff_type || '-',
    число(тф.current_tariff_charge), число(тф.current_tariff_min_charge),
    Number(тф.current_tariff_rate) || 0,
    ТИПЫ_ТАРИФА[тф.next_tariff_type] || тф.next_tariff_type || '-',
    число(тф.next_tariff_charge), число(тф.next_tariff_min_charge),
    Number(тф.next_tariff_rate) || 0,
    вТаблицу(тф.next_tariff_starts_at),

    фд.cluster_from || '-',
    фд.cluster_to || '-',

    а.delivery_type || '-',
    а.tpl_provider || '-',
    а.warehouse || о.delivery_method?.name || '-',
    а.payment_type_group_name || '-',
    флаг(а.is_premium),

    отмена.cancel_reason || '-',
    отмена.cancellation_initiator || '-',
    ТИПЫ_ОТМЕН[отмена.cancellation_type] || отмена.cancellation_type || '-',
    флаг(отмена.cancelled_after_ship),
    флаг(отмена.affect_cancellation_rating),
  ];

  return товары.map((т) => {
    const ф = финансы.get(String(т.sku)) || {};
    const комиссия = ф.commission || {};

    return [
      о.posting_number,
      о.order_number || '-',
      СТАТУСЫ[о.status] || о.status,
      вТаблицу(о.in_process_at),
      вТаблицу(о.shipment_date),
      вТаблицу(о.delivering_date),
      вТаблицу(а.client_delivery_date_end || а.delivery_date_end),
      т.offer_id || '-',
      String(т.sku),
      Number(т.quantity) || 0,
      число(ф.price ?? т.price),
      число(ф.old_price),
      число(ф.total_discount_value),
      число(ф.customer_price),
      число(комиссия.amount ?? ф.commission_amount),
      Number(комиссия.percent) || 0,
      число(ф.payout),
      (ф.actions || []).length ? ф.actions.join(', ') : '-',
      ...общее,
      отметка,
    ];
  });
}

// ─────────────────────── ОСТАТКИ ───────────────────────

export async function остатки(параметры) {
  const товары = [];
  let курсор = '';

  for (let страниц = 0; страниц < 200; страниц += 1) {
    const ответ = await вызов(параметры, '/v4/product/info/stocks', {
      cursor: курсор, limit: 1000, filter: { visibility: 'ALL' },
    });
    const тело = ответ.result || ответ;
    const пачка = тело.items || [];
    товары.push(...пачка);

    if (!пачка.length || !тело.cursor || тело.cursor === курсор) break;
    курсор = тело.cursor;
    await сон(ПАУЗА);
  }

  // итоги FBS по товару. sku в ответе заполняется не всегда,
  // поэтому запоминаем и артикул, и то, что удалось найти как идентификатор
  const итогиFBS = [];
  const артикулПоSku = new Map();

  for (const т of товары) {
    let есть = 0;
    let резерв = 0;
    let sku = '';

    for (const о of т.stocks || []) {
      if (String(о.type).toLowerCase() !== 'fbs') continue;
      есть += Number(о.present) || 0;
      резерв += Number(о.reserved) || 0;
      if (о.sku) sku = String(о.sku);
    }

    if (!sku && т.product_id) sku = String(т.product_id);
    if (!есть && !резерв) continue;

    if (sku) артикулПоSku.set(sku, т.offer_id || '-');
    итогиFBS.push({ offer_id: т.offer_id || '-', sku, есть, резерв });
  }

  const отметка = вТаблицу(new Date());
  const строки = [];

  // разбивка по складам: v1 отдаёт ошибку крупным продавцам, поэтому начинаем с v2
  let метод = '/v2/product/info/stocks-by-warehouse/fbs';
  const ску = итогиFBS.map((и) => Number(и.sku)).filter((s) => Number.isFinite(s) && s > 0);

  for (let i = 0; i < ску.length; i += 1000) {
    const пачка = ску.slice(i, i + 1000);
    let ответ;

    try {
      ответ = await вызов(параметры, метод, { sku: пачка, limit: 1000, cursor: '' });
    } catch (ош) {
      if (метод.includes('/v2/')) {
        метод = '/v1/product/info/stocks-by-warehouse/fbs';
        ответ = await вызов(параметры, метод, { sku: пачка });
      } else {
        throw ош;
      }
    }

    const тело = ответ.result || ответ;
    const записи = Array.isArray(тело) ? тело : (тело.result || тело.items || []);

    for (const з of записи) {
      const s = String(з.sku);
      строки.push([
        артикулПоSku.get(s) || з.offer_id || '-',
        s,
        з.warehouse_name || з.warehouse_id || '-',
        Number(з.present) || 0,
        Number(з.reserved) || 0,
        отметка,
      ]);
    }

    await сон(ПАУЗА);
  }

  // если разбивка не отработала — пишем итоги по товару, чтобы расчёт не остался пустым
  let источник = 'по складам';
  if (!строки.length && итогиFBS.length) {
    источник = 'итоги без складов';
    for (const и of итогиFBS) {
      строки.push([и.offer_id, и.sku || '-', 'Все склады', и.есть, и.резерв, отметка]);
    }
  }

  await сохранить(SHEETS.OZON_ОСТАТКИ, строки);
  return `товаров ${товары.length}, с остатком FBS ${итогиFBS.length}, строк ${строки.length} (${источник})`;
}

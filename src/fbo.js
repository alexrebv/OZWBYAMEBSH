import { SHEETS } from './schemas.js';
import { сохранить, читать } from './sheets.js';
import { требовать } from './config.js';
import { запрос, сон, iso, вТаблицу, число, изЯчейки, изМосквы, мскISO, окнами, МСК_СМЕЩЕНИЕ } from './http.js';

/**
 * Выгрузка FBO: заказы и остатки на складах маркетплейсов.
 * Схемы называются по-разному — FBO у Ozon, «склады WB» у Wildberries,
 * FBY у Яндекса, — но смысл один: товар лежит у площадки.
 */

const ПАУЗА = 300;
const ЛИМИТ_ОТПРАВЛЕНИЙ = 100;   // потолок v3/posting/fbo/list, выше — 400
const ОКНО_ДНЕЙ = 29;            // Яндекс отказывает на периоде длиннее 30 суток

// ═══════════════════════ OZON ═══════════════════════
// Заказы:  POST /v3/posting/fbo/list   (v2 отключён 31.08.2026)
// Остатки: POST /v2/analytics/stock_on_warehouses

const OZ_ХОСТ = 'https://api-seller.ozon.ru';

function ozonВызов(параметры, метод, тело) {
  const [clientId, apiKey] = требовать(параметры, 'OZON Client-Id', 'OZON Api-Key');
  return запрос(OZ_ХОСТ + метод, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Id': clientId, 'Api-Key': apiKey },
    body: JSON.stringify(тело),
  }, { имя: `Ozon ${метод}` });
}

export async function ozonFboПродажи(параметры, задача) {
  const глубина = задача.глубина || 30;
  const по = new Date();
  // «С даты» на листе настроек перебивает глубину — нужна для разовой перезаливки
  const с = изЯчейки(задача.сдаты) || new Date(по.getTime() - глубина * 24 * 3600 * 1000);

  const отправления = [];
  const виденные = new Set();
  // Метод курсорный: принимает cursor и sort_dir, а offset и dir просто игнорирует —
  // из-за этого он бесконечно отдавал одну и ту же первую страницу.
  let курсор = '';

  for (let страниц = 0; страниц < 500; страниц += 1) {
    const ответ = await ozonВызов(параметры, '/v3/posting/fbo/list', {
      sort_dir: 'ASC',
      limit: ЛИМИТ_ОТПРАВЛЕНИЙ,
      cursor: курсор,
      filter: { since: iso(с), to: iso(по) },
      with: { analytics_data: true, financial_data: true },
    });
    const тело = ответ.result || ответ;
    const пачка = Array.isArray(тело) ? тело : (тело.postings || тело.result || []);

    // подстраховка от неподвижной выдачи: страница без новых номеров завершает выборку
    const новые = пачка.filter((о) => о.posting_number && !виденные.has(о.posting_number));
    for (const о of новые) виденные.add(о.posting_number);
    отправления.push(...новые);

    if (!новые.length || !тело.has_next || !тело.cursor || тело.cursor === курсор) break;
    курсор = тело.cursor;
    await сон(ПАУЗА);
  }

  const отметка = вТаблицу(new Date());
  const строки = отправления.flatMap((о) => {
    const а = о.analytics_data || {};
    return (о.products || []).map((т) => [
      о.posting_number,
      о.order_number || '-',
      о.status || '-',
      вТаблицу(о.created_at || о.in_process_at),
      т.offer_id || '-',
      String(т.sku),
      Number(т.quantity) || 0,
      число(т.price),
      (о.financial_data || {}).cluster_to || а.cluster_to || '-',
      а.warehouse_name || '-',
      а.region || '-',
      отметка,
    ]);
  });

  const итог = await сохранить(SHEETS.OZON_FBO_ПРОДАЖИ, строки);
  return `отправлений ${отправления.length}, строк ${итог.всего}, новых ${итог.новых}`;
}

export async function ozonFboОстатки(параметры) {
  const строки = [];
  const отметка = вТаблицу(new Date());
  let offset = 0;

  for (let страниц = 0; страниц < 200; страниц += 1) {
    const ответ = await ozonВызов(параметры, '/v2/analytics/stock_on_warehouses', {
      limit: 1000, offset, warehouse_type: 'ALL',
    });
    const тело = ответ.result || ответ;
    const пачка = тело.rows || тело.items || [];
    for (const с of пачка) {
      строки.push([
        с.item_code || с.offer_id || '-',
        String(с.sku ?? ''),
        с.warehouse_name || '-',
        с.cluster_name || с.warehouse_name || '-',
        Number(с.free_to_sell_amount) || 0,
        Number(с.promised_amount) || 0,
        Number(с.reserved_amount) || 0,
        отметка,
      ]);
    }
    if (пачка.length < 1000) break;
    offset += 1000;
    await сон(ПАУЗА);
  }

  await сохранить(SHEETS.OZON_FBO_ОСТАТКИ, строки);
  return `строк ${строки.length}`;
}

// ═══════════════════════ WILDBERRIES ═══════════════════════
// Три разных хоста со своими лимитами.
// Заказы:   GET  statistics-api      /api/v1/supplier/orders?dateFrom=&flag=0   1 запрос в минуту
// Остатки:  POST seller-analytics-api /api/analytics/v1/stocks-report/wb-warehouses  3 в минуту
// Карточки: POST content-api          /content/v2/get/cards/list                100 в минуту
//
// Прежний /api/v1/supplier/stocks отключён 23.06.2026 и отвечает 404.
// Пришедший на замену метод не отдаёт ни штрихкод, ни артикул продавца — только
// nmId и chrtId, поэтому артикул и баркод добираются из карточек товаров.

const WB_СТАТ = 'https://statistics-api.wildberries.ru';
const WB_АНАЛИТИКА = 'https://seller-analytics-api.wildberries.ru';
const WB_КОНТЕНТ = 'https://content-api.wildberries.ru';

const ЛИМИТ_КАРТОЧЕК = 100;      // потолок cursor.limit у карточек
const ЛИМИТ_ОСТАТКОВ = 250000;   // потолок limit у остатков — весь каталог за один запрос
const ПАУЗА_АНАЛИТИКИ = 20000;   // 3 запроса в минуту

function wbСтат(параметры, путь) {
  const [ключ] = требовать(параметры, 'WB Api-Key');
  return запрос(WB_СТАТ + путь, { headers: { Authorization: ключ } },
    { имя: `WB ${путь}`, пауза: 20000, попыток: 4 });
}

function wbПост(параметры, хост, путь, тело, опции = {}) {
  const [ключ] = требовать(параметры, 'WB Api-Key');
  return запрос(хост + путь, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ключ },
    body: JSON.stringify(тело),
  }, { имя: `WB ${путь}`, ...опции });
}

export async function wbFboПродажи(параметры, задача) {
  const глубина = задача.глубина || 30;
  const с = изЯчейки(задача.сдаты) || new Date(Date.now() - глубина * 24 * 3600 * 1000);
  // WB Statistics ждёт московское местное время без пояса
  const дата = мскISO(с);

  // flag=0 — всё, что менялось с dateFrom и позже, одним ответом. Именно это нужно
  // для заливки периода. flag=1 отдал бы только одну календарную дату dateFrom.
  const ответ = await wbСтат(параметры, `/api/v1/supplier/orders?dateFrom=${дата}&flag=0`);
  const отметка = вТаблицу(new Date());

  // на ошибке WB отвечает 200 с объектом, а не массивом — .map по нему упал бы
  const заказы = Array.isArray(ответ) ? ответ : [];
  const строки = заказы
    // без идентификатора строка схлопнула бы все безымянные в одну: ключ upsert — srid
    .filter((з) => з.srid || з.odid)
    .map((з) => [
    String(з.srid || з.odid || ''),
    // date приходит без пояса и означает московское время
    вТаблицу(изМосквы(з.date)),
    з.supplierArticle || '-',
    з.nmId || '-',
    String(з.barcode || ''),
    1,
    Number(з.finishedPrice ?? з.totalPrice) || 0,
    з.warehouseName || '-',
    з.oblastOkrugName || з.regionName || '-',
    з.isCancel ? 'да' : '-',
    отметка,
  ]);

  const итог = await сохранить(SHEETS.WB_FBO_ПРОДАЖИ, строки);
  return `заказов ${строки.length}, новых ${итог.новых}`;
}

/**
 * Кэш карточек в памяти процесса.
 *
 * Каталог меняется редко, а выгрузка стоит полутора десятков запросов. Дёргать её
 * на каждом прогоне незачем: при частом расписании это сотни обращений в час
 * к content-api, и WB начинает глушить соединения молча — обрыв на этапе connect,
 * хотя остальные его хосты (это тот же IP) отвечают нормально.
 *
 * Второй смысл кэша — устойчивость: если выгрузка не далась, а прошлая лежит
 * в памяти, задача отработает на ней вместо того, чтобы падать.
 */
const КЭШ_КАРТОЧЕК_МС = 6 * 3600 * 1000;
let карточкиКэш = { когда: 0, поРазмеру: null };

/**
 * Карточки товаров: chrtId (размер) → артикул продавца и баркод.
 * Метод остатков этих полей не отдаёт, а на листе они есть и по ним идёт стыковка
 * со справочником, поэтому забираем их отдельно.
 */
async function wbКарточки(параметры) {
  if (карточкиКэш.поРазмеру && Date.now() - карточкиКэш.когда < КЭШ_КАРТОЧЕК_МС) {
    return { поРазмеру: карточкиКэш.поРазмеру, оборвалось: null, изКэша: true };
  }

  const поРазмеру = new Map();
  let курсор = { limit: ЛИМИТ_КАРТОЧЕК };
  let оборвалось = null;

  for (let страниц = 0; страниц < 500; страниц += 1) {
    let ответ;
    try {
      ответ = await wbПост(параметры, WB_КОНТЕНТ, '/content/v2/get/cards/list', {
        settings: { sort: { ascending: true }, filter: { withPhoto: -1 }, cursor: курсор },
      }, { пауза: 3000, попыток: 8 });
    } catch (ош) {
      // страница не далась. Не теряем то, что уже собрали: решение, можно ли писать
      // лист неполными карточками, принимает вызывающий — лист снапшотный
      оборвалось = String(ош.message || ош);
      break;
    }

    const карточки = ответ.cards || [];
    for (const к of карточки) {
      for (const р of к.sizes || []) {
        поРазмеру.set(String(р.chrtID), {
          артикул: к.vendorCode || '-',
          баркод: String((р.skus || [])[0] || ''),
        });
      }
    }

    // WB велит листать, пока total в курсоре ответа не станет меньше запрошенного limit
    const с = ответ.cursor || {};
    if (!карточки.length || Number(с.total) < ЛИМИТ_КАРТОЧЕК) break;
    курсор = { limit: ЛИМИТ_КАРТОЧЕК, updatedAt: с.updatedAt, nmID: с.nmID };
    await сон(ПАУЗА);
  }

  if (поРазмеру.size && !оборвалось) карточкиКэш = { когда: Date.now(), поРазмеру };

  // выгрузка не далась, но прошлая лежит в памяти — она лучше, чем ничего:
  // артикулы меняются редко, а без них лист пришлось бы не обновлять вовсе
  if (оборвалось && поРазмеру.size < (карточкиКэш.поРазмеру?.size || 0)) {
    return { поРазмеру: карточкиКэш.поРазмеру, оборвалось, изКэша: true };
  }

  return { поРазмеру, оборвалось };
}

export async function wbFboОстатки(параметры) {
  const { поРазмеру, оборвалось, изКэша } = await wbКарточки(параметры);

  // ни одной карточки — писать нечем: лист снапшотный, и строки без штрихкода
  // и артикула затёрли бы прошлый исправный снимок. Лучше упасть и сохранить его
  if (оборвалось && !поРазмеру.size) {
    throw new Error(`карточки товаров не выгрузились, лист не тронут: ${оборвалось}`);
  }

  const позиции = [];
  for (let страниц = 0; страниц < 20; страниц += 1) {
    const ответ = await wbПост(параметры, WB_АНАЛИТИКА, '/api/analytics/v1/stocks-report/wb-warehouses', {
      limit: ЛИМИТ_ОСТАТКОВ, offset: страниц * ЛИМИТ_ОСТАТКОВ,
    }, { пауза: ПАУЗА_АНАЛИТИКИ, попыток: 4 });

    // при 204 «нет данных» тело пустое и запрос вернёт {}
    const пачка = ((ответ.data || ответ).items) || [];
    позиции.push(...пачка);
    if (пачка.length < ЛИМИТ_ОСТАТКОВ) break;
    await сон(ПАУЗА_АНАЛИТИКИ);
  }

  const отметка = вТаблицу(new Date());
  const строки = позиции
    .filter((п) => Number(п.quantity) > 0 || Number(п.inWayToClient) > 0)
    .map((п) => {
      const к = поРазмеру.get(String(п.chrtId)) || {};
      return [
        к.баркод || '',
        к.артикул || '-',
        п.nmId || '-',
        // сейчас WB отдаёт здесь единственное значение «Склад WB»: разбивки по складам
        // в новом методе пока нет
        п.warehouseName || '-',
        Number(п.quantity) || 0,
        Number(п.inWayToClient) || 0,
        Number(п.inWayFromClient) || 0,
        отметка,
      ];
    });

  await сохранить(SHEETS.WB_FBO_ОСТАТКИ, строки);

  const безАртикула = строки.filter((с) => с[1] === '-').length;
  return `карточек ${поРазмеру.size}${изКэша ? ' из кэша' : ''}, строк ${строки.length}`
    + (безАртикула ? `, без артикула ${безАртикула}` : '')
    + (оборвалось ? ` | КАРТОЧКИ НЕ ОБНОВИЛИСЬ: ${оборвалось}` : '');
}

// ═══════════════════════ ЯНДЕКС МАРКЕТ ═══════════════════════
// FBY — отдельная кампания. Методы те же, но campaignId другой.
// Заказы:  GET  /v2/campaigns/{FBY}/orders
// Остатки: POST /v2/campaigns/{FBY}/offers/stocks

const ЯМ_ХОСТ = 'https://api.partner.market.yandex.ru';

function ямВызов(параметры, путь, глагол = 'GET', тело = null) {
  const [ключ, кампания] = требовать(параметры, 'Яндекс Api-Key', 'Яндекс campaignId FBY');
  const опции = { method: глагол, headers: { 'Api-Key': ключ } };
  if (тело) {
    опции.headers['Content-Type'] = 'application/json';
    опции.body = JSON.stringify(тело);
  }
  return запрос(`${ЯМ_ХОСТ}/v2/campaigns/${кампания}${путь}`, опции,
    { имя: `ЯМ FBY ${путь}`, пауза: 2000 });
}

const датаЯМ = (д) => {
  // границу суток считаем по Москве: на UTC-сервере иначе теряется вечер последнего дня
  const м = new Date(д.getTime() + МСК_СМЕЩЕНИЕ);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(м.getUTCDate())}-${p(м.getUTCMonth() + 1)}-${м.getUTCFullYear()}`;
};

function изЯМ(строка) {
  if (!строка) return null;
  const м = String(строка).match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (!м) return изМосквы(строка);
  // Яндекс отдаёт московское время без указания пояса: собираем через Date.UTC
  // со сдвигом, иначе на UTC-сервере метка уезжает на три часа
  return new Date(
    Date.UTC(+м[3], +м[2] - 1, +м[1], +(м[4] || 0), +(м[5] || 0), +(м[6] || 0)) - МСК_СМЕЩЕНИЕ,
  );
}

export async function ямFboПродажи(параметры, задача) {
  const глубина = задача.глубина || 30;
  const по = new Date();
  const с = изЯчейки(задача.сдаты) || new Date(по.getTime() - глубина * 24 * 3600 * 1000);

  const заказы = [];
  // Яндекс отказывает на интервале длиннее 30 суток, поэтому идём окнами
  for (const [а, б] of окнами(с, по, ОКНО_ДНЕЙ)) {
    let токен = '';
    for (let страниц = 0; страниц < 400; страниц += 1) {
      const п = new URLSearchParams({ fromDate: датаЯМ(а), toDate: датаЯМ(б), limit: '50' });
      if (токен) п.set('page_token', токен);
      const ответ = await ямВызов(параметры, `/orders?${п}`);
      const тело = ответ.result || ответ;
      const пачка = тело.orders || [];
      заказы.push(...пачка);
      const след = тело.paging?.nextPageToken;
      if (!след || след === токен || !пачка.length) break;
      токен = след;
      await сон(ПАУЗА);
    }
  }

  const отметка = вТаблицу(new Date());
  const строки = заказы
    .filter((з) => з.fake !== true)
    .flatMap((з) => (з.items || []).map((т) => [
      String(з.id),
      вТаблицу(изЯМ(з.creationDate)),
      т.offerId || т.shopSku || '-',
      Number(т.count) || 0,
      Number(т.price ?? т.buyerPrice) || 0,
      з.status || '-',
      з.delivery?.region?.name || '-',
      з.delivery?.shipments?.[0]?.warehouse?.name || '-',
      отметка,
    ]));

  const итог = await сохранить(SHEETS.ЯМ_FBO_ПРОДАЖИ, строки);
  return `заказов ${заказы.length}, строк ${итог.всего}, новых ${итог.новых}`;
}

export async function ямFboОстатки(параметры) {
  const склады = new Map();
  let токен = '';
  for (let страниц = 0; страниц < 500; страниц += 1) {
    const п = new URLSearchParams({ limit: '200' });
    if (токен) п.set('page_token', токен);
    const ответ = await ямВызов(параметры, `/offers/stocks?${п}`, 'POST', { withTurnover: true });
    const тело = ответ.result || ответ;
    for (const с of тело.warehouses || []) {
      const ид = String(с.warehouseId);
      if (!склады.has(ид)) склады.set(ид, { name: с.name || ид, offers: [] });
      склады.get(ид).offers.push(...(с.offers || []));
    }
    const след = тело.paging?.nextPageToken;
    if (!след || след === токен) break;
    токен = след;
    await сон(ПАУЗА);
  }

  // FBY и FBS — разные магазины: с чужим campaignId метод отвечает пустотой без ошибки,
  // и снапшот стёр бы лист остатков целиком. Лучше упасть с внятным текстом.
  if (!склады.size) throw new Error('ЯМ FBY: не пришло ни одного склада — проверьте «Яндекс campaignId FBY»');

  const отметка = вТаблицу(new Date());
  const строки = [];
  for (const склад of склады.values()) {
    for (const т of склад.offers) {
      let доступно = 0;
      let заморожено = 0;
      let всего = 0;
      for (const о of т.stocks || []) {
        const кол = Number(о.count) || 0;
        всего += кол;
        if (о.type === 'AVAILABLE' || о.type === 'FIT') доступно += кол;
        if (о.type === 'FREEZE') заморожено += кол;
      }
      if (!всего) continue;
      строки.push([т.offerId || '-', склад.name, доступно, заморожено, всего, отметка]);
    }
  }

  await сохранить(SHEETS.ЯМ_FBO_ОСТАТКИ, строки);
  return `складов ${склады.size}, строк ${строки.length}`;
}

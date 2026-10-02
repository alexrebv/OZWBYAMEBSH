import { SHEETS } from './schemas.js';
import { сохранить } from './sheets.js';
import { требовать } from './config.js';
import { запрос, сон, вТаблицу, изЯчейки, изМосквы, окнами, МСК_СМЕЩЕНИЕ } from './http.js';

const ХОСТ = 'https://api.partner.market.yandex.ru';
const ПАУЗА = 300;
const ОКНО_ДНЕЙ = 29;   // /orders отвечает 400, если интервал длиннее 30 суток

const СТАТУСЫ = {
  PLACING: 'Оформляется', RESERVED: 'Зарезервирован', UNPAID: 'Не оплачен',
  PENDING: 'Ожидает подтверждения', PROCESSING: 'В обработке', DELIVERY: 'Доставляется',
  PICKUP: 'В пункте выдачи', DELIVERED: 'Доставлен',
  CANCELLED: 'Отменён', CANCELLED_BEFORE_PROCESSING: 'Отменён',
};

const ПОДСТАТУСЫ = {
  STARTED: 'Начата обработка', READY_TO_SHIP: 'Готов к отгрузке', SHIPPED: 'Передан в доставку',
  RESERVATION_EXPIRED: 'Резерв истёк', USER_NOT_PAID: 'Покупатель не оплатил',
  USER_CANCELED: 'Отменён покупателем', SHOP_FAILED: 'Магазин не смог выполнить',
  USER_REFUSED_DELIVERY: 'Отказ от доставки', USER_REFUSED_PRODUCT: 'Отказ от товара',
  USER_REFUSED_QUALITY: 'Отказ по качеству', REPLACING_ORDER: 'Заменён',
  DELIVERY_SERVICE_UNDELIVERED: 'Служба не доставила',
};

function вызов(параметры, путь, глагол = 'GET', тело = null) {
  const [ключ, кампания] = требовать(параметры, 'Яндекс Api-Key', 'Яндекс campaignId');
  const url = `${ХОСТ}/v2/campaigns/${кампания}${путь}`;
  const опции = { method: глагол, headers: { 'Api-Key': ключ } };
  if (тело) {
    опции.headers['Content-Type'] = 'application/json';
    опции.body = JSON.stringify(тело);
  }
  return запрос(url, опции, { имя: `ЯМ ${путь}`, пауза: 2000 });
}

/** Яндекс ждёт и отдаёт даты как ДД-ММ-ГГГГ. new Date() такое разбирает неверно. */
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

// ─────────────────────── ПРОДАЖИ ───────────────────────

export async function продажи(параметры, задача) {
  const глубина = задача.глубина || 14;
  const по = new Date();
  const с = изЯчейки(задача.сдаты) || new Date(по.getTime() - глубина * 24 * 3600 * 1000);

  const заказы = [];

  // период режем на окна: длиннее 30 суток метод не принимает
  for (const [а, б] of окнами(с, по, ОКНО_ДНЕЙ)) {
    let токен = '';

    for (let страниц = 0; страниц < 400; страниц += 1) {
      const п = new URLSearchParams({
        fromDate: датаЯМ(а), toDate: датаЯМ(б), limit: '50',
      });
      if (токен) п.set('page_token', токен);

      const ответ = await вызов(параметры, `/orders?${п}`);
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
  const строки = заказы.flatMap((з) => строкиИзЗаказа(з, отметка));
  const итог = await сохранить(SHEETS.ЯМ_ПРОДАЖИ, строки);

  return `заказов ${заказы.length}, строк ${итог.всего}, новых ${итог.новых}`;
}

function строкиИзЗаказа(з, отметка) {
  if (з.fake === true) return [];          // тестовые заказы в спрос не идут
  const товары = з.items || [];
  if (!товары.length) return [];

  const д = з.delivery || {};
  const регион = д.region?.name || д.address?.city || '-';
  const отгрузка = д.shipments?.length ? вТаблицу(изЯМ(д.shipments[0].shipmentDate)) : '-';
  const создан = вТаблицу(изЯМ(з.creationDate));

  return товары.map((т) => [
    String(з.id),
    создан,
    т.offerId || т.shopSku || '-',
    Number(т.count) || 0,
    Number(т.price ?? т.buyerPrice) || 0,
    СТАТУСЫ[з.status] || з.status || '-',
    ПОДСТАТУСЫ[з.substatus] || з.substatus || '-',
    регион,
    отгрузка,
    отметка,
  ]);
}

// ─────────────────────── ОСТАТКИ ───────────────────────

/**
 * Разбор остатков одного товара на складе.
 *
 * Типы остатков у Яндекса не равноправные ведра, а иерархия, и складывать их
 * подряд нельзя:
 *   FIT       — весь годный товар: и свободный, и уже зарезервированный;
 *   AVAILABLE — его свободная часть («Доступный к заказу» в кабинете);
 *   FREEZE    — его зарезервированная часть.
 * То есть FIT = AVAILABLE + FREEZE, и Яндекс присылает все три сразу.
 * Прежний код считал их тремя независимыми величинами, поэтому «Всего»
 * получалось ровно вдвое больше настоящего: FIT + AVAILABLE + FREEZE = 2 × FIT.
 * По той же причине удваивалось и «Доступно» — там складывались AVAILABLE и FIT.
 *
 * Брак (DEFECT, EXPIRED, QUARANTINE, UTILIZATION) в FIT не входит — это
 * отдельный физический товар, его в «Всего» добавляем.
 */
const ЧАСТИ_ГОДНОГО = new Set(['AVAILABLE', 'FREEZE']);
const БРАК = new Set(['DEFECT', 'EXPIRED', 'QUARANTINE', 'UTILIZATION']);

export function разобратьОстатки(stocks) {
  const поТипу = new Map();
  for (const о of stocks || []) {
    const тип = String(о.type || '');
    поТипу.set(тип, (поТипу.get(тип) || 0) + (Number(о.count) || 0));
  }
  const кол = (тип) => поТипу.get(тип) || 0;

  const заморожено = кол('FREEZE');
  // FIT — источник истины по годному товару. Если его не прислали, собираем
  // годное из частей: свободное плюс зарезервированное
  const годный = поТипу.has('FIT') ? кол('FIT') : кол('AVAILABLE') + заморожено;
  // AVAILABLE считается от FIT, а не наоборот: без него свободное — это
  // годное минус резерв
  const доступно = поТипу.has('AVAILABLE') ? кол('AVAILABLE') : Math.max(годный - заморожено, 0);

  let брак = 0;
  let прочее = 0;
  const неизвестные = [];
  for (const [тип, сколько] of поТипу) {
    if (тип === 'FIT' || ЧАСТИ_ГОДНОГО.has(тип)) continue;
    if (БРАК.has(тип)) { брак += сколько; continue; }
    // новый тип в API: в «Всего» он попадёт, но молча в «Брак» его валить нельзя
    прочее += сколько;
    if (тип) неизвестные.push(тип);
  }

  return { доступно, заморожено, брак, прочее, неизвестные, всего: годный + брак + прочее };
}

export async function остатки(параметры) {
  const склады = new Map();
  let токен = '';

  for (let страниц = 0; страниц < 500; страниц += 1) {
    const п = new URLSearchParams({ limit: '200' });
    if (токен) п.set('page_token', токен);

    const ответ = await вызов(параметры, `/offers/stocks?${п}`, 'POST', { withTurnover: false });
    const тело = ответ.result || ответ;

    for (const с of тело.warehouses || []) {
      const ид = String(с.warehouseId);
      if (!склады.has(ид)) склады.set(ид, { name: с.name || ид, offers: new Map() });
      const куда = склады.get(ид).offers;
      for (const т of с.offers || []) {
        // один товар на складе — одна запись. Если страницы перекрылись и товар
        // пришёл дважды, второй раз заменяет первый, а не добавляется к нему:
        // иначе на листе было бы две строки с одним ключом и сводная их сложила
        куда.set(т.offerId || т.shopSku || `#${куда.size}`, т);
      }
    }

    const след = тело.paging?.nextPageToken;
    if (!след || след === токен) break;
    токен = след;
    await сон(ПАУЗА);
  }

  const отметка = вТаблицу(new Date());
  const строки = [];
  const неизвестные = new Set();

  for (const склад of склады.values()) {
    for (const т of склад.offers.values()) {
      const о = разобратьОстатки(т.stocks);
      о.неизвестные.forEach((тип) => неизвестные.add(тип));

      if (!о.всего) continue;
      строки.push([
        т.offerId || '-', склад.name,
        о.доступно, о.заморожено, о.брак, о.всего, отметка,
      ]);
    }
  }

  await сохранить(SHEETS.ЯМ_ОСТАТКИ, строки);
  return `складов ${склады.size}, строк ${строки.length}`
    + (неизвестные.size ? `, неизвестные типы остатков: ${[...неизвестные].join(', ')}` : '');
}

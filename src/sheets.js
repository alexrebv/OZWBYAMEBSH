import { google } from 'googleapis';
import { COLUMNS, KEYS, SHEETS, SNAPSHOT } from './schemas.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let api = null;

function credentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Нет GOOGLE_SERVICE_ACCOUNT_JSON в переменных окружения');
  const text = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(text);
}

export async function sheets() {
  if (api) return api;
  const creds = credentials();
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });
  await auth.authorize();
  api = google.sheets({ version: 'v4', auth });
  return api;
}

const SHEET_ID = () => {
  const id = process.env.SHEET_ID;
  if (!id) throw new Error('Нет SHEET_ID в переменных окружения');
  return id;
};

/** Номер колонки → буква: A, B, ... Z, AA. Нужна там, где ширина считается на лету. */
export function буква(n) {
  let s = '';
  while (n > 0) {
    const о = (n - 1) % 26;
    s = String.fromCharCode(65 + о) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function читать(лист, диапазон) {
  const api = await sheets();
  const r = await api.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `'${лист}'!${диапазон}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  return r.data.values || [];
}

export async function писать(лист, диапазон, значения) {
  const api = await sheets();
  await api.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `'${лист}'!${диапазон}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: значения },
  });
}

export async function чистить(лист, диапазон) {
  const api = await sheets();
  await api.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID(),
    range: `'${лист}'!${диапазон}`,
  });
}

/** Создаёт лист с шапкой, если его ещё нет. */
export async function обеспечитьЛист(лист) {
  const api = await sheets();
  const книга = await api.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const есть = книга.data.sheets.some((s) => s.properties.title === лист);
  if (есть) return;

  await api.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID(),
    requestBody: { requests: [{ addSheet: { properties: { title: лист } } }] },
  });

  const шапка = COLUMNS[лист];
  if (шапка) {
    await писать(лист, `A1:${буква(шапка.length)}1`, [шапка]);
  }
}

/**
 * Записывает строки на лист.
 * Для листов из SNAPSHOT — полная перезапись блока данных.
 * Для остальных — upsert по ключу из KEYS: существующие строки обновляются,
 * новые дописываются в конец. Колонки правее схемы не трогаются никогда.
 */
export async function сохранить(лист, строки) {
  await обеспечитьЛист(лист);

  const схема = COLUMNS[лист];
  const ширина = схема.length;
  const конец = буква(ширина);

  if (SNAPSHOT.has(лист)) {
    await чистить(лист, `A2:${конец}`);
    if (строки.length) {
      await писать(лист, `A2:${конец}${строки.length + 1}`, строки);
    }
    return { всего: строки.length, новых: строки.length, обновлено: 0 };
  }

  if (!строки.length) return { всего: 0, новых: 0, обновлено: 0 };

  const ключи = KEYS[лист] || [0];
  const ключ = (r) => ключи.map((i) => String(r[i] ?? '')).join('|');

  const было = await читать(лист, `A2:${конец}`);
  const индекс = new Map();
  было.forEach((r, i) => индекс.set(ключ(r), i));

  const таблица = было.map((r) => {
    const копия = r.slice(0, ширина);
    while (копия.length < ширина) копия.push('');
    return копия;
  });

  let новых = 0;
  let обновлено = 0;

  for (const с of строки) {
    const k = ключ(с);
    if (индекс.has(k)) {
      таблица[индекс.get(k)] = с;
      обновлено += 1;
    } else {
      индекс.set(k, таблица.length);
      таблица.push(с);
      новых += 1;
    }
  }

  await писать(лист, `A2:${конец}${таблица.length + 1}`, таблица);
  return { всего: строки.length, новых, обновлено };
}

/** Штрихкоды из справочника — нужны WB, метод остатков спрашивает по списку. */
export async function штрихкодыИзСправочника() {
  const строки = await читать(SHEETS.СПРАВОЧНИК, 'A2:A');
  const набор = new Set();
  for (const [б] of строки) {
    if (б === undefined || б === null || б === '' || б === '-') continue;
    набор.add(typeof б === 'number' ? б.toFixed(0) : String(б).trim());
  }
  return [...набор];
}

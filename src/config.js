import { SHEETS } from './schemas.js';
import { читать, писать } from './sheets.js';

/**
 * Лист «Настройки» устроен так:
 *
 *   A2:C..   блок параметров:  Параметр | Значение | Комментарий
 *   A20:G..  блок задач:       Задача | Вкл | Каждые, мин | Глубина, дней | Последний запуск | Результат
 *
 * Включение задачи — цифра 1 в колонке «Вкл». Пусто или 0 — выключено.
 */

const ПАРАМЕТРЫ_ОТ = 2;
const ПАРАМЕТРЫ_ДО = 18;
const ЗАДАЧИ_ОТ = 21;
const ЗАДАЧИ_ДО = 40;

/** Переменная окружения перебивает значение из таблицы: ключи лучше держать в Railway. */
const ИЗ_ОКРУЖЕНИЯ = {
  'OZON Client-Id': 'OZON_CLIENT_ID',
  'OZON Api-Key': 'OZON_API_KEY',
  'WB Api-Key': 'WB_API_KEY',
  'Яндекс Api-Key': 'YM_API_KEY',
  'Яндекс campaignId': 'YM_CAMPAIGN_ID',
};

export async function читатьНастройки() {
  const параметры = {};
  const строкиП = await читать(SHEETS.НАСТРОЙКИ, `A${ПАРАМЕТРЫ_ОТ}:B${ПАРАМЕТРЫ_ДО}`);

  for (const [имя, значение] of строкиП) {
    if (!имя) continue;
    параметры[String(имя).trim()] = значение === undefined ? '' : String(значение).trim();
  }

  for (const [имя, пер] of Object.entries(ИЗ_ОКРУЖЕНИЯ)) {
    if (process.env[пер]) параметры[имя] = process.env[пер].trim();
  }

  const задачи = [];
  const строкиЗ = await читать(SHEETS.НАСТРОЙКИ, `A${ЗАДАЧИ_ОТ}:F${ЗАДАЧИ_ДО}`);

  строкиЗ.forEach((р, i) => {
    const имя = р[0];
    if (!имя) return;
    задачи.push({
      имя: String(имя).trim(),
      включена: String(р[1] ?? '').trim() === '1',
      каждые: Number(р[2]) || 60,
      глубина: Number(р[3]) || 0,
      последний: р[4] ? String(р[4]) : '',
      строка: ЗАДАЧИ_ОТ + i,
    });
  });

  return { параметры, задачи };
}

/** Пишет в строку задачи время запуска и результат. Колонки E и F. */
export async function отметитьЗапуск(задача, результат) {
  const когда = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  await писать(SHEETS.НАСТРОЙКИ, `E${задача.строка}:F${задача.строка}`, [[когда, результат]]);
}

export function требовать(параметры, ...имена) {
  const нет = имена.filter((и) => !параметры[и]);
  if (нет.length) {
    throw new Error(`Не заполнено в настройках: ${нет.join(', ')}`);
  }
  return имена.map((и) => параметры[и]);
}

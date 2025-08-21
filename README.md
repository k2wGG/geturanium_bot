# 🤖 GetUranium Bot

![Статус GitHub Actions](https://img.shields.io/badge/статус-активен-brightgreen)
![Лицензия](https://img.shields.io/badge/лицензия-MIT-blue.svg)
![Версия Node.js](https://img.shields.io/badge/node-v22.14.0%2B-brightgreen)
![Версия Puppeteer](https://img.shields.io/badge/puppeteer-^22.0.0-blue)
![Puppeteer Extra Stealth](https://img.shields.io/badge/stealth-плагин-lightgrey)

Автоматизированный бот для [`geturanium.io`](https://geturanium.io).  
Выполняет игровые действия автоматически:

- 🌟 Автосбор
- 💠 Множитель осколков
- ⚡ Ускоритель конвейера
- 🌾 Сбор наград с фермы
- 🔄 Запуск переработки

Бот работает через **Puppeteer** и `puppeteer-extra` со `stealth-plugin`, чтобы выглядеть максимально «человечно».

---

## ✨ Возможности

- **🌐 Автоматизация браузера** — управление Chromium через Puppeteer.  
- **👻 Скрытый режим** — плагин `puppeteer-extra-plugin-stealth`.  
- **⚙️ Настраиваемые действия:**
  - `autoAC`: авто-сборщик
  - `autoSM`: множитель осколков
  - `autoCB`: ускоритель конвейера
  - `autoFarm`: сбор с фермы
  - `autoRefine`: запуск переработки
- **🖱️ Реалистичные клики** — имитация движений мыши и задержек.  
- **✅ Проверка клика** — бот проверяет, что кнопка реально нажалась.  
- **🚫 Без лишних переходов** — бот остаётся на `refinery`, не прыгает по страницам.  
- **🍪 Сохранение сессии** — `cookies.json`.  
- **🛡️ Защита от бана** — обработка 403/429, паузы при перегрузке.  
- **💖 Keep-Alive** — поддержание активности.  
- **📊 Логи и статистика** — `stats.json` + консоль.  
- **🌍 Поддержка прокси** — `http/socks5`, с логином и паролем.  

---

## 🚀 Установка и запуск

### Требования

- Node.js `v22.14.0+`  
- npm (Node Package Manager)

### Установка

```bash
git clone https://github.com/k2wGG/geturanium_bot.git
cd geturanium_bot
npm install
```

### Конфигурация

Бот использует `config.json`. Если файла нет — он создаётся автоматически.

#### Пример `config.json`

```json
{
  "enabled": true,
  "autoAC": true,
  "autoSM": true,
  "autoCB": true,
  "autoFarm": true,
  "autoRefine": true,
  "keepAlive": true,
  "autoReload": true,
  "reloadMinutes": 50,
  "logEach": 2,
  "headless": false,
  "slowMo": 0,
  "cookiesFilePath": "./cookies.json",
  "configFilePath": "./config.json",
  "statsFilePath": "./stats.json",
  "backoffUntil": 0,
  "proxyRotation": "random",
  "proxies": [
    "http://user:pass@host:port",
    "socks5://user:pass@host:port"
  ]
}
```

#### Таблица параметров

| Параметр        | Тип    | Описание                    |
| --------------- | ------ | --------------------------- |
| `autoAC`        | bool   | Авто-сборщик                |
| `autoSM`        | bool   | Множитель осколков          |
| `autoCB`        | bool   | Ускоритель конвейера        |
| `autoFarm`      | bool   | Сбор с фермы                |
| `autoRefine`    | bool   | Переработка                 |
| `keepAlive`     | bool   | Поддержание активности      |
| `autoReload`    | bool   | Автоперезагрузка страницы   |
| `reloadMinutes` | number | Интервал перезагрузки (мин) |
| `logEach`       | number | Интервал логов (сек)        |
| `headless`      | bool   | Режим браузера              |
| `slowMo`        | number | Замедление (мс)             |
| `proxies`       | array  | Список прокси (http/socks5) |
| `proxyRotation` | string | `random` или `sequential`   |

---

### Запуск

* **GUI (окно браузера):**

```bash
npm run start:gui
```

* **Headless (фон):**

```bash
npm run start:headless
```

* **По `config.json`:**

```bash
npm run start
```

---

## 📁 Структура проекта

* `bot.cjs` — основной код
* `config.json` — конфигурация
* `cookies.json` — сохранение сессии
* `stats.json` — статистика
* `browser_profile/` — профиль браузера
* `screenshots/` — (опционально) скриншоты

---

## 🛠️ Отладка

* Все события пишутся в консоль с префиксами `ℹ️`, `⚡`, `🐞`.
* Включить подробный debug-режим Puppeteer:

  ```bash
  DEBUG=puppeteer:* npm run start:gui
  ```

---

## 🔎 Управление логами

В коде определены уровни логирования:

```js
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const MIN_LOG_LEVEL_INDEX = 0;
```

Можно выбрать минимальный уровень лога:

* `0` — показывать всё (включая `debug`)
* `1` — скрыть `debug`, оставить `info`, `warn`, `error`
* `2` — только `warn` и `error`
* `3` — только `error`

Например, чтобы отключить лишний шум и оставить только важное:

```js
const MIN_LOG_LEVEL_INDEX = 2; // будет выводить только warn и error
```

---

## 📄 Лицензия

Проект распространяется под лицензией **MIT**.
Подробнее см. в файле [LICENSE](./LICENSE).

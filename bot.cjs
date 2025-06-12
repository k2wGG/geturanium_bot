// bot.cjs
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer-extra'); // <--- Используем puppeteer-extra
const StealthPlugin = require('puppeteer-extra-plugin-stealth'); // <--- Импортируем StealthPlugin

puppeteer.use(StealthPlugin()); // <--- Применяем StealthPlugin

/* ===== 1. Конфигурация по-умолчанию =================== */
const DEF = {
  enabled:true,
  autoAC:true, autoSM:true, autoCB:true, autoFarm:true, autoRefine:true,
  keepAlive:true,
  autoReload:true, reloadMinutes:50,
  logEach:60, // Логирование в консоль Node.js каждые N секунд (для клиентского логирования).
  headless:false, // Значение по умолчанию для config.json
  slowMo:0,
  cookiesFilePath:'./cookies.json',
  configFilePath :'./config.json',
  statsFilePath  :'./stats.json',
  backoffUntil:0 // Передаем это значение в клиентский скрипт
};

/* ===== 2. Состояние ================================= */
let config = { ...DEF };
let stats  = { reloadCount:0,
               clickCount:{autoAC:0,autoSM:0,autoCB:0,autoFarm:0,autoRefine:0}};
let cookies=[], navigating=false;
let lastCookieSave = Date.now();
let browser, page; // Убрали gameFrame, так как работаем в page

// Для передачи данных из клиента в Node.js
let clientBackoffUntil = 0; // Теперь это просто Node.js переменная

/* ===== 3. Логгер =================================== */
const COLOR = { info: 34, warn: 33, error: 31, debug: 36, success: 32 }; // Добавил success
// Установите 0 для вывода всех логов (включая debug), 1 для info+, 2 для warn+, 3 для error+
const MIN_LOG_LEVEL_INDEX = 0; // Временно 0 для полной отладки. После отладки можно изменить на 1 или 2.
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function log(msg, level = 'info') {
  const levelIndex = LOG_LEVELS.indexOf(level);
  if (levelIndex < MIN_LOG_LEVEL_INDEX) {
    return; // Пропускаем логи, если их уровень ниже минимально разрешенного
  }

  const time = new Date().toLocaleTimeString('ru-RU');
  const prefix = { info:'ℹ️', warn:'⚠️', error:'🚨', debug:'🐞', success:'✅' }[level] || ' ';
  console.log(`\x1b[${COLOR[level]||37}m[${time}] ${prefix} ${msg}\x1b[0m`);
}

/* ===== 4. Утилиты ================================== */
const rnd = (min, max) => min + Math.random() * (max - min) | 0; // Исправил название аргументов на min/max
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ===== 5. Файловые операции ======================= */
async function ensureDir(file) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive:true });
}
async function load(file, def) {
  try { return JSON.parse(await fs.readFile(path.resolve(file), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') {
      log(`ℹ️ Файл ${file} не найден, использую значение по умолчанию.`, 'info');
      return def;
    }
    log(`❌ Error loading ${file}: ${e.message}`, 'error');
    return def;
  }
}
async function save(file, data) {
  await ensureDir(file);
  await fs.writeFile(path.resolve(file), JSON.stringify(data, null, 2), 'utf8');
  // log(`💾 ${file} сохранен.`, 'debug'); // Избыточный лог, можно отключить
}

/* ===== 6. Запуск Puppeteer ======================== */
const PROFILE_DIR = path.resolve(__dirname, 'browser_profile');
async function launch() {
  if (browser) {
    log('ℹ️ Закрываю старый браузер...', 'info');
    try {
      await browser.close();
    } catch (e) {
      log(`❌ Ошибка при закрытии браузера: ${e.message}`, 'error');
    }
  }

  log('ℹ️ Запуск браузера...', 'info');
  try {
    // --- ИЗМЕНЕННАЯ ЛОГИКА ДЛЯ HEADLESS РЕЖИМА ---
    // Если переменная окружения HEADLESS установлена в 'true', используем 'new' (новый headless режим).
    // Если установлена в 'false', используем false (GUI режим).
    // В противном случае, используем значение из config.json.
    let finalHeadlessMode;
    if (process.env.HEADLESS === 'true') {
        finalHeadlessMode = 'new';
    } else if (process.env.HEADLESS === 'false') {
        finalHeadlessMode = false;
    } else {
        // Если переменная окружения не установлена, используем значение из конфига
        finalHeadlessMode = config.headless === true ? 'new' : config.headless;
    }

    log(`🐞 Debug: Вычисленное значение headless для Puppeteer: "${finalHeadlessMode}"`, 'debug');
    // --- КОНЕЦ ИЗМЕНЕННОЙ ЛОГИКИ ---

    browser = await puppeteer.launch({
      headless: finalHeadlessMode, // <-- Используем вычисленное значение
      slowMo: config.slowMo,
      userDataDir: PROFILE_DIR,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
        '--disable-notifications', // Для подавления уведомлений
        '--disable-popup-blocking', // Для подавления всплывающих окон
        '--ignore-certificate-errors', // Игнорировать ошибки сертификатов
      ]
    });
    page = await browser.newPage();
    await page.setViewport({ width:1920, height:1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );

    // Здесь не будет слушателей навигации, так как мы управляем navigating вручную

    await page.evaluateOnNewDocument(() => {
      // Патчи для isTrusted, requestAnimationFrame, setTimeout/setInterval, hasFocus
      if (!Event.prototype.__ab_trusted) {
        [Event, MouseEvent, KeyboardEvent, UIEvent].forEach(C=>{
          Object.defineProperty(C.prototype,'isTrusted',{
            get(){return true;}, configurable:true
          });
        });
        Event.prototype.__ab_trusted = true;
      }
      if (window.requestAnimationFrame && !window.requestAnimationFrame.__ab_patched) {
        const orig = window.requestAnimationFrame;
        let last = performance.now();
        const MIN = 1000/60;
        window.requestAnimationFrame = cb => {
          const now = performance.now();
          if (document.hidden && now - last >= MIN) {
            last = now;
            try { cb(now); } catch {}
          }
          return orig(cb);
        };
        window.requestAnimationFrame.__ab_patched = true;
      }
      if (!window.__ab_timers_patched) {
        const MIN = 4;
        const oTO = window.setTimeout, oTI = window.setInterval;
        window.setTimeout = (cb, d=0, ...a) => oTO(cb, Math.max(d,MIN), ...a);
        window.setInterval= (cb, d=0, ...a) => oTI(cb, Math.max(d,MIN), ...a);
        window.__ab_timers_patched = true;
      }
      if (document.hasFocus && !document.hasFocus.__ab_patched) {
        document.hasFocus = ()=> true;
        document.hasFocus.__ab_patched = true;
      }
    });

    // Expose functions to the main page context
    await page.exposeFunction('doPuppeteerClick', async (x,y) => {
      try {
        await page.mouse.move(x,y,{steps:rnd(10,20)});
        await page.mouse.down();
        await sleep(rnd(40,120));
        await page.mouse.up();
      } catch (e) {
          if (!e.message.includes('Session closed') && !e.message.includes('Target closed')) {
              log(`❌ Ошибка doPuppeteerClick: ${e.message}`, 'error');
          }
      }
    });
    // --- ИСПРАВЛЕНИЕ ДЛЯ ДВОЙНЫХ [Client] ---
    await page.exposeFunction('logFromClient', (msg, lvl='info') => {
      const cleanedMsg = msg.startsWith('[Client] ') ? msg.substring('[Client] '.length) : msg;
      log(`[Client] ${cleanedMsg}`, lvl);
    });
    // --- КОНЕЦ ИСПРАВЛЕНИЯ ---
  } catch (error) {
    log(`❌ Ошибка при инициализации браузера: ${error.message}`, 'error');
    throw error; // Бросаем ошибку, чтобы она была поймана в mainLoop
  }
}

/* ===== 7. Слушатели =============================== */
function listeners() {
  page.on('console', msg => { // Добавляем обработчик console.log со страницы
    if (msg.text().includes('Unable to preventDefault inside passive event listener invocation.') ||
        msg.text().includes('Touch event suppression') ||
        msg.text().includes('The default unity loader module is not available on this platform') ||
        msg.text().includes('DevTools listening on')) {
      return;
    }
    log(`[PAGE CONSOLE] ${msg.text()}`, 'debug');
  });
  page.on('pageerror', err => {
    if (!/Minified React error #\d+|TypeError: Cannot set properties of null|ResizeObserver loop limit exceeded/.test(err.message))
      log(`❌ JS Error: ${err.message}`, 'error');
  });
  page.on('requestfailed', req => {
    if (req.failure()?.errorText !== 'net::ERR_ABORTED')
      log(`⚠️ Request Failed: ${req.url()} – ${req.failure()?.errorText}`, 'warn');
  });
}

/* ===== 8. Жёсткая перезагрузка =================== */
let reloadTimer = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

async function hardReload() {
  log('🚨 Жёсткая перезагрузка...', 'warn');
  stats.reloadCount++;
  await save(config.statsFilePath, stats);
  clearTimeout(reloadTimer);
  navigating = true; // Устанавливаем navigating в true перед перезагрузкой

  // Делаем скриншот перед перезагрузкой для отладки
  try {
      await fs.mkdir('./screenshots', { recursive: true });
      await page.screenshot({ path: `./screenshots/reload_before_${Date.now()}.png` });
      log('📸 Скриншот сделан перед перезагрузкой.', 'debug');
  } catch (e) {
      log(`❌ Ошибка при создании скриншота перед перезагрузкой: ${e.message}`, 'error');
  }

  try {
    await page.goto('about:blank');
    await page.goto(`https://geturanium.io/?_=${Date.now()}`, { waitUntil:'networkidle2', timeout:60000 }); // Ждем полной загрузки сети
    log(`ℹ️ URL после перезагрузки: ${page.url()}`, 'info');

    // Проверяем, не на странице авторизации ли мы
    if (page.url().includes('/auth')) {
      log('🔑 После перезагрузки оказались на странице авторизации, ждём входа…', 'info');
      await page.waitForNavigation({ waitUntil:'networkidle2', timeout:180000 })
          .catch(e => log(`⌛ Тайм-аут ожидания авторизации после перезагрузки: ${e.message}`, 'warn'));
      log('✅ Авторизация после перезагрузки завершена', 'info');
      // Сохранение куки уже происходит в конце цикла или при SIGINT
    } else {
      log('✅ После перезагрузки сессия активна.', 'info');
    }

  } catch (error) {
    log(`❌ Ошибка при выполнении goto во время hardReload: ${error.message}`, 'error');
    // Если даже goto не сработало, то нужно полностью перезапустить браузер
    await launch(); // Перезапускаем браузер
  }
  navigating = false; // Сбрасываем navigating после goto
  await sleep(3000); // Даем странице немного времени устаканиться
  scheduleReload();
}
function scheduleReload() {
  clearTimeout(reloadTimer);
  if (config.autoReload) {
    log(`⏰ Следующая авто-перезагрузка через ${config.reloadMinutes} мин.`, 'info');
    reloadTimer = setTimeout(hardReload, config.reloadMinutes*60000);
  }
}

/* ===== 9. Основной цикл ========================== */
async function mainLoop() {
  let lastXu = 0, lastTS = Date.now();
  let navigationStuckTimer = null;

  log('✅ mainLoop: Запуск основного цикла.', 'success');

  while (true) {
    if (navigating) {
      log('mainLoop: Навигация активна, ждем...', 'debug');
      if (!navigationStuckTimer) {
          navigationStuckTimer = setTimeout(async () => {
              log('⚠️ mainLoop: Навигация зависла более 15 секунд. Принудительная перезагрузка.', 'warn');
              await hardReload();
              navigationStuckTimer = null;
          }, 15000);
      }
      await sleep(500);
      continue;
    } else {
        if (navigationStuckTimer) {
            clearTimeout(navigationStuckTimer);
            navigationStuckTimer = null;
        }
    }

    // 2) Выполнить клиентский скрипт в контексте основной страницы
    let updatedClientData;
    try {
        updatedClientData = await page.evaluate(async (cfg, initialStats) => {
            const LABELS={
              autoAC:'auto collector',
              autoSM:'shard multiplier',
              autoCB:'conveyor booster',
              autoFarm:'farm reward',
              autoRefine:'start refining'
            };
            let _lastClick = window._ab_lastClick || {};
            let _stats = window._ab_stats || initialStats;
            let _backoffUntil = window._ab_backoffUntil || 0;
            let _nextLogValue = window._ab_nextLogValue || Date.now();

            const rnd = (min,max)=> min + Math.random()*(max-min)|0;

            // Умный clientLog: логирует warn/error всегда, info/debug по расписанию
            const clientLog = (msg, level='info') => {
              const now = Date.now();
              if (level === 'error' || level === 'warn') {
                if (window.logFromClient) {
                  window.logFromClient(msg, level);
                }
              } else if (cfg.logEach > 0 && now >= _nextLogValue) {
                if (window.logFromClient) {
                  window.logFromClient(msg, level);
                }
                _nextLogValue = now + cfg.logEach * 1000;
              }
            };

            async function clientDoClick(el) {
              if (!el) { clientLog('[Client] Попытка клика по несуществующему элементу.', 'warn'); return; }
              const rect = el.getBoundingClientRect();
              if (!rect.width || !rect.height) { clientLog('[Client] Попытка клика по невидимому элементу (нулевая ширина/высота).', 'warn'); return; }
              const x = rect.left + Math.random() * rect.width;
              const y = rect.top + Math.random() * rect.height;
              if (window.doPuppeteerClick) { // Проверяем наличие exposed функции
                await window.doPuppeteerClick(x, y);
              } else {
                clientLog(`[Client WARN] doPuppeteerClick не доступен. Попытка нативного клика.`, 'warn');
                el.click();
              }
            }

            // findBtn: Находит текстовый элемент, затем ищет ближайшую кнопку.
            function findBtn(text){
              const normalizedSearchText = text.toLowerCase().trim();
              const potentialTextElements = [...document.querySelectorAll('h3, div, span, p')].filter(el => {
                  return el.innerText && el.innerText.toLowerCase().includes(normalizedSearchText);
              });

              // clientLog(`[Client Debug] Searching for "${text}". Found ${potentialTextElements.length} potential text elements.`, 'debug');

              for (const el of potentialTextElements) {
                  const elText = el.innerText?.toLowerCase().trim();
                  if (elText === normalizedSearchText || elText.startsWith(normalizedSearchText + ' ') || elText.startsWith(normalizedSearchText + '\n')) {
                      const button = el.closest('button');
                      if (button) {
                          // clientLog(`[Client Debug] Найден текстовый элемент "${el.innerText.trim()}" и ближайшая кнопка для "${text}".`, 'debug');
                          return button;
                      } else {
                          // Закомментируйте эту строку, так как она вызывает флуд
                          // clientLog(`[Client Warn] Найден текстовый элемент "${el.innerText.trim()}" для "${text}", но без ближайшей кнопки.`, 'warn');
                      }
                  }
              }
              // clientLog(`[Client Debug] Не найден соответствующий текстовый элемент для "${text}".`, 'debug');
              return null;
            }


            function getCooldown(btn){
              if(!btn || btn.disabled===false) return 0;
              if(/activating/i.test(btn.innerText)) return 3000;
              const m = /(\d+)\s*m.*?(\d+)\s*s/i.exec(btn.innerText);if(m)return(+m[1]*60+ +m[2])*1e3;
              const s = /(\d+)\s*s/i.exec(btn.innerText);return s? +s[1]*1e3:600000;
            }

            // --- Перехват fetch для 429 / 403 ---
            if (!window.__ab_fetch_patched) {
                const nativeFetch = window.fetch.bind(window);
                window.fetch = async (...args) => {
                    try {
                        const res = await nativeFetch(...args);
                        if (res.status === 429) {
                            _backoffUntil = Date.now() + 5 * 60 * 1000;
                            clientLog('[Client] Обнаружен 429 (Too Many Requests) → ставим паузу 5 мин.', 'warn');
                        }
                        if (res.status === 403) {
                            clientLog('[Client] Обнаружен 403 (Forbidden) → требуется перезагрузка.', 'warn');
                            return Promise.reject(new Error('403 Forbidden detected.'));
                        }
                        return res;
                    } catch (error) {
                        clientLog('[Client] Ошибка при выполнении fetch запроса: ' + error.message, 'error');
                        throw error;
                    }
                };
                window.__ab_fetch_patched = true;
            }

            // --- Основная логика кликов и проверки кнопок ---
            const now = Date.now();
            if (now < _backoffUntil) {
                clientLog(`[Client] В режиме паузы до ${new Date(_backoffUntil).toLocaleTimeString()}.`);
                return {
                    updatedStats: _stats,
                    updatedLastClick: _lastClick,
                    updatedBackoffUntil: _backoffUntil,
                    updatedNextLogValue: _nextLogValue,
                    action: 'waiting_backoff',
                    waitDuration: _backoffUntil - now // Передаем оставшееся время паузы
                };
            }

            let actionTaken = false;
            let minWaitDuration = Infinity; // Отслеживаем минимальный кулдаун/задержку

            for (const key of Object.keys(LABELS)) {
                if (!cfg[key]) continue;

                if (key === 'autoFarm') {
                    const eightHoursMs = 8 * 60 * 60 * 1000;
                    const nextFarmTime = (_lastClick[key] || 0) + eightHoursMs;

                    if (now < nextFarmTime) {
                        const remaining = nextFarmTime - now;
                        clientLog(`⏳ ${LABELS[key]}: следующий сбор через ${Math.round(remaining / 1000 / 60)} мин.`);
                        minWaitDuration = Math.min(minWaitDuration, remaining); // Обновляем minWaitDuration
                        continue;
                    }
                }

                const btn = findBtn(LABELS[key]);
                if (!btn) {
                    continue; // Кнопка не найдена, переходим к следующей
                }

                const cooldown = getCooldown(btn);
                // clientLog(`[Client Debug] Кнопка "${LABELS[key]}": найдена, disabled: ${btn.disabled}, кулдаун: ${cooldown / 1000}s.`, 'debug');

                // Логика для autoRefine
                if (key === 'autoRefine') {
                    let currentPoints = 0;
                    let requiredPoints = 0;

                    const yourShardsLabel = [...document.querySelectorAll('span.font-bold')].find(el => el.innerText.includes('Your Shards'));
                    const requiredShardsLabel = [...document.querySelectorAll('span.font-bold')].find(el => el.innerText.includes('Required Shards'));

                    if (yourShardsLabel && yourShardsLabel.nextElementSibling) {
                        currentPoints = parseInt(yourShardsLabel.nextElementSibling.innerText.replace(/[^0-9]/g, '')) || 0;
                        clientLog(`[Client Debug] Refinery: Current Shards: ${currentPoints}`, 'debug');
                    }
                    if (requiredShardsLabel && requiredShardsLabel.nextElementSibling) {
                        requiredPoints = parseInt(requiredShardsLabel.nextElementSibling.innerText.replace(/[^0-9]/g, '')) || 0;
                        clientLog(`[Client Debug] Refinery: Required Shards: ${requiredPoints}`, 'debug');
                    }

                    if (btn.disabled && currentPoints < requiredPoints) {
                        clientLog(`Refinery: Недостаточно шардов. Нужно ${requiredPoints}, у вас ${currentPoints}.`, 'info');
                        minWaitDuration = Math.min(minWaitDuration, 5000); // Например, 5 секунд
                        continue;
                    }
                    if (currentPoints >= requiredPoints && !btn.disabled) {
                        const since = now - (_lastClick[key] || 0);
                        const gap = 5000 + rnd(0, 2000);
                        if (since > gap) {
                            clientLog(`Refinery: Кнопка активна, шардов достаточно. Попытка клика.`, 'info');
                            await clientDoClick(btn);
                            _lastClick[key] = now;
                            _stats.clickCount[key]++;
                            clientLog(`⚡ ${key} кликнут. Шардов: ${currentPoints}, Требуется: ${requiredPoints}.`, 'info');
                            actionTaken = true;
                            return { // Возвращаемся сразу после успешного клика
                                updatedStats: _stats, updatedLastClick: _lastClick,
                                updatedBackoffUntil: _backoffUntil, updatedNextLogValue: _nextLogValue,
                                action: 'clicked'
                            };
                        } else {
                            clientLog(`Refinery: Кнопка активна, шардов достаточно, но слишком рано (осталось ${((gap - since) / 1000).toFixed(1)}s).`, 'info');
                            minWaitDuration = Math.min(minWaitDuration, gap - since);
                        }
                    } else {
                        clientLog(`Refinery: Кнопка "${LABELS[key]}" недоступна или ожидает. Шардов: ${currentPoints}, Требуется: ${requiredPoints}.`, 'info');
                        minWaitDuration = Math.min(minWaitDuration, cooldown > 0 ? cooldown : 5000); // Используем cooldown или 5 сек по умолчанию
                        continue;
                    }
                }

                // Общая логика для других кнопок (autoAC, autoSM, autoCB)
                if (btn.disabled && cooldown > 0) {
                    clientLog(`[Client] Кнопка "${LABELS[key]}" на кулдауне или отключена.`, 'info');
                    minWaitDuration = Math.min(minWaitDuration, cooldown);
                    continue; // Кнопка неактивна, переходим к следующей
                }

                // Если кнопка активна и не disabled, проверяем задержку
                if (!btn.disabled) {
                    const since = now - (_lastClick[key] || 0);
                    const gap = 8000 + rnd(0, 2000); // 8-10 секунд задержка между кликами для бустеров

                    if (since > gap) {
                        clientLog(`[Client] Кнопка "${LABELS[key]}" активна и прошло достаточно времени. Попытка клика.`, 'info');
                        await clientDoClick(btn);
                        _lastClick[key] = now;
                        _stats.clickCount[key]++;
                        clientLog(`⚡ ${LABELS[key]} кликнут.`, 'info');
                        actionTaken = true;
                        return { // Возвращаемся сразу после успешного клика
                            updatedStats: _stats, updatedLastClick: _lastClick,
                            updatedBackoffUntil: _backoffUntil, updatedNextLogValue: _nextLogValue,
                            action: 'clicked'
                        };
                    } else {
                        // Кнопка активна, но еще не время кликать
                        const remaining = gap - since;
                        clientLog(`[Client] Кнопка "${LABELS[key]}" активна, но слишком рано (осталось ${((remaining) / 1000).toFixed(1)}s).`, 'info');
                        minWaitDuration = Math.min(minWaitDuration, remaining);
                    }
                }
            }

            // --- Keep-Alive ---
            if(cfg.keepAlive && rnd(0,10)<2){ // 20% шанс каждый цикл
              fetch('/favicon.ico',{cache:'no-store',mode:'no-cors'}).catch(()=>{}); // Фоновый запрос
              const body = document.body;
              if (body) {
                const rect = body.getBoundingClientRect();
                const x = rect.left + Math.random()*rect.width;
                const y = rect.top  + Math.random()*rect.height;
                // Имитация движения мыши
                body.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, clientX:x, clientY:y }));
                // Имитация скролла
                window.scrollBy(0, rnd(-1,1));
              }
              // Имитация фокуса/блюра
              document.dispatchEvent(new Event('focus', {bubbles:true}));
              document.dispatchEvent(new Event('blur', {bubbles:true}));
              clientLog('ℹ️ Keep-Alive активность выполнена (client-side).');
            }

            // Сохраняем состояния в глобальный window
            window._ab_lastClick = _lastClick;
            window._ab_stats = _stats;
            window._ab_backoffUntil = _backoffUntil;
            window._ab_nextLogValue = _nextLogValue;

            // Если никаких кликов не было, возвращаем информацию о минимальной задержке
            return {
                updatedStats: _stats,
                updatedLastClick: _lastClick,
                updatedBackoffUntil: _backoffUntil,
                updatedNextLogValue: _nextLogValue,
                action: 'no_action',
                // Если minWaitDuration остался Infinity, значит, нет активных кулдаунов,
                // ждем дефолтное время (например, 10-15 секунд)
                waitDuration: minWaitDuration === Infinity ? 10000 + rnd(0, 5000) : minWaitDuration + rnd(500, 2000)
            };

        }, config, stats); // Передаем актуальные config и stats из Node.js

        // Применяем обновления из клиента (result)
        stats = updatedClientData.updatedStats;
        clientBackoffUntil = updatedClientData.updatedBackoffUntil;
        consecutiveErrors = 0; // Сбрасываем счетчик ошибок при успешном выполнении

        // Обработка действия, выполненного клиентом
        if (updatedClientData.action === 'clicked') {
            log('mainLoop: Клиент сообщил о клике, короткая пауза.', 'debug');
            await sleep(rnd(2000, 5000)); // Короткая пауза после клика
        } else if (updatedClientData.action === 'no_action' || updatedClientData.action === 'waiting_backoff') {
            // Пауза, основанная на рассчитанной клиентом минимальной задержке
            const calculatedSleep = Math.max(1000, Math.min(updatedClientData.waitDuration, 60000)); // Максимум 1 минута, минимум 1 секунда
            log(`mainLoop: Нет действий, пауза на ${Math.round(calculatedSleep / 1000)} сек.`, 'debug');
            await sleep(calculatedSleep);
        } else {
            // В случае, если клиент вернул неизвестное действие (не должно происходить)
            log(`mainLoop: Неизвестное действие от клиента: ${updatedClientData.action}, пауза 1 сек.`, 'warn');
            await sleep(1000);
        }

    } catch (e) {
        log(`❌ mainLoop: Ошибка при выполнении клиентского скрипта (main page): ${e.message}`, 'error');
        consecutiveErrors++; // Увеличиваем счетчик ошибок

        if (e.message.includes('403 Forbidden detected') || e.message.includes('ERR_CONNECTION_REFUSED')) {
            log('❌ Обнаружен 403 / Отказ соединения. Выполняю жесткую перезагрузку.', 'error');
            await hardReload();
            consecutiveErrors = 0; // Сброс после жесткой перезагрузки
        } else if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            log(`❌ Достигнуто ${MAX_CONSECUTIVE_ERRORS} последовательных ошибок. Выполняю жесткую перезагрузку.`, 'error');
            await hardReload();
            consecutiveErrors = 0; // Сбрасываем счетчик после перезагрузки
        } else {
            // Если это другая критическая ошибка, просто ждем и повторяем
            log('❌ Не критическая ошибка. Ждем 5 секунд и повторяем.', 'warn');
            await sleep(5000); // Короткая пауза при ошибке, чтобы не спамить
        }
    }

    // 3) Проверка XU вне iframe - эта часть остается как есть
    try {
      const xu = await page.evaluate(()=>+document.querySelector('span.text-sm.font-medium.text-amber-400.drop-shadow-sm.tracking-wide')?.textContent.replace(/\s/g,'').replace(',','.')||0);
      if(xu!==lastXu){lastXu=xu;lastTS=Date.now();}
      if(Date.now()-lastTS>300000 && xu > 0){
        log('🛑 XU статичен 5 мин – reload','warn');
        await hardReload();
        lastTS=Date.Now();
      }
    } catch(e) {
      log(`❌ mainLoop: Ошибка проверки XU (вне iframe): ${e.message}`, 'error');
    }

    // 4) Периодическое сохранение cookies
    if (Date.now() - lastCookieSave > 5 * 60 * 1000) {
      try {
        const cookiesToSave = await page.browser().defaultBrowserContext().cookies();
        await save(config.cookiesFilePath, cookiesToSave);
        log(`💾 Cookies сохранены (${cookiesToSave.length})`, 'info');
        lastCookieSave = Date.now();
      } catch (e) {
        log(`❌ mainLoop: Ошибка при периодическом сохранении куки: ${e.message}`, 'error');
      }
    }

    // 5) Сохраняем stats на диск
    await save(config.statsFilePath, stats);

    // Удален sleep(1000) здесь, так как он заменен динамической паузой выше
  }
}

/* ===== 10. Запуск всего ========================== */
(async () => {
  process.on('unhandledRejection', (reason, promise) => {
      log(`🚨 Unhandled Rejection at: ${promise}, reason: ${reason}`, 'error');
      if (browser) {
          browser.close().catch(e => log(`❌ Ошибка при закрытии браузера из unhandledRejection: ${e.message}`, 'error'));
      }
      process.exit(1);
  });

  log('ℹ️ Загрузка конфига/статистики...', 'info');
  config = {...DEF, ...(await load(DEF.configFilePath, {}))};
  stats  = {...stats, ...(await load(DEF.statsFilePath, {}))};

  log('ℹ️ Запуск браузера...', 'info');
  try {
    await launch();
    listeners();

    log('ℹ️ Переходим на geturanium.io...', 'info');
    navigating = true;
    await page.goto('https://geturanium.io', { waitUntil:'networkidle2', timeout:60000 });
    navigating = false;
    log(`ℹ️ URL: ${page.url()}`, 'info');

    if (page.url().includes('/auth')) {
      log('🔑 На странице авторизации, ждём входа…', 'info');
      navigating = true;
      await page.waitForNavigation({ waitUntil:'networkidle2', timeout:180000 })
        .catch(e => log(`⌛ Тайм-аут ожидания авторизации: ${e.message}`, 'warn'));
      navigating = false;
      log('✅ Авторизация завершена', 'info');
      const cook = await page.browser().defaultBrowserContext().cookies();
      await save(config.cookiesFilePath, cook);
      lastCookieSave = Date.now();
    } else {
      log('ℹ️ Сессия активна, сохраняем текущие куки', 'info');
      const cook = await page.browser().defaultBrowserContext().cookies();
      await save(config.cookiesFilePath, cook);
      lastCookieSave = Date.now();
    }

    await sleep(3000);
    process.on('SIGINT', async () => {
      log('SIGINT, сохраняем и выходим...', 'info');
      const cook = await page.browser().defaultBrowserContext().cookies().catch(()=>[]);
      await save(config.cookiesFilePath, cook);
      await save(config.configFilePath, config);
      await save(config.statsFilePath, stats);
      if (browser) await browser.close();
      process.exit(0);
    });

    scheduleReload();
    await mainLoop();

  } catch (initialError) {
    log(`❌ Критическая ошибка при старте: ${initialError.message}`, 'error');
    if (browser) {
      await browser.close().catch(e => log(`❌ Ошибка при закрытии браузера после критической ошибки: ${e.message}`, 'error'));
    }
    process.exit(1);
  }
})();
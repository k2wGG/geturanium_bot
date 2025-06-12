// bot.cjs
const fs    = require('fs').promises;
const path  = require('path');
const puppeteer = require('puppeteer');

/* ===== 1. Конфигурация по-умолчанию =================== */
const DEF = {
  enabled:true,
  autoAC:true, autoSM:true, autoCB:true, autoFarm:true, autoRefine:true,
  keepAlive:true,
  autoReload:true, reloadMinutes:50,
  logEach:250, // Логирование в консоль Node.js каждые N секунд (для клиентского логирования). Установите 2 для отладки.
  headless:false, // <--- Убедитесь, что здесь false для первого запуска!
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
// let gameFrame; // Больше не нужен

// Для передачи данных из клиента в Node.js
let clientBackoffUntil = 0;
let clientStats = {};
let clientLastClick = {};

/* ===== 3. Логгер =================================== */
const COLOR = { info: 34, warn: 33, error: 31, debug: 36 };
// Установите 0 для вывода всех логов (включая debug), 1 для info+, 2 для warn+, 3 для error+
const MIN_LOG_LEVEL_INDEX = 0; // Временно 0 для полной отладки. После отладки можно изменить на 1.
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function log(msg, level = 'info') {
  const levelIndex = LOG_LEVELS.indexOf(level);
  if (levelIndex < MIN_LOG_LEVEL_INDEX) {
    return; // Пропускаем логи, если их уровень ниже минимально разрешенного
  }

  const time = new Date().toLocaleTimeString('ru-RU');
  const prefix = { info:'ℹ️', warn:'⚠️', error:'🚨', debug:'🐞' }[level] || ' ';
  console.log(`\x1b[${COLOR[level]||37}m[${time}] ${prefix} ${msg}\x1b[0m`);
}

/* ===== 4. Утилиты ================================== */
const rnd = (a,b) => Math.floor(a + Math.random()*(b-a)|0);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ===== 5. Файловые операции ======================= */
async function ensureDir(file) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive:true });
}
async function load(file, def) {
  try { return JSON.parse(await fs.readFile(path.resolve(file), 'utf8')); }
  catch (e) {
      log(`Error loading ${file}: ${e.message}`, 'warn');
      return def;
  }
}
async function save(file, data) {
  await ensureDir(file);
  await fs.writeFile(path.resolve(file), JSON.stringify(data, null, 2), 'utf8');
}

/* ===== 6. Запуск Puppeteer ======================== */
const PROFILE_DIR = path.resolve(__dirname, 'browser_profile');
async function launch() {
  browser = await puppeteer.launch({
    headless: process.env.HEADLESS ? 'new' : config.headless,
    slowMo:   +process.env.SLOWMO || config.slowMo,
    userDataDir: PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled'
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
    // Остальные патчи остаются
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
  await page.exposeFunction('logFromClient', (msg, lvl='info') => {
    log(`[Client] ${msg}`, lvl);
  });
}

/* ===== 7. Слушатели =============================== */
function listeners() {
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
async function hardReload() {
  log('🚨 Жёсткая перезагрузка...', 'warn');
  stats.reloadCount++;
  await save(config.statsFilePath, stats);
  clearTimeout(reloadTimer);
  navigating = true; // Устанавливаем navigating в true перед перезагрузкой
  // gameFrame = null; // Больше не нужен
  // Делаем скриншот перед перезагрузкой для отладки
  try {
      await fs.mkdir('./screenshots', { recursive: true });
      await page.screenshot({ path: `./screenshots/reload_before_${Date.now()}.png` });
      log('📸 Скриншот сделан перед перезагрузкой.', 'debug');
  } catch (e) {
      log(`❌ Ошибка при создании скриншота перед перезагрузкой: ${e.message}`, 'error');
  }

  await page.goto('about:blank');
  await page.goto(`https://geturanium.io/?_=${Date.now()}`, { waitUntil:'networkidle2', timeout:60000 }); // Ждем полной загрузки сети
  navigating = false; // Сбрасываем navigating после goto
  await sleep(3000);
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

  log('✅ mainLoop: Запуск основного цикла.', 'debug');

  while (true) {
    // В этом сценарии, navigating будет true только во время page.goto()
    // и затем сразу сбросится. Так что этот блок должен срабатывать редко.
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

    // 1) Больше не ищем iframe, работаем напрямую с page
    // log('mainLoop: Проверяем gameFrame.', 'debug'); // Этот лог больше не нужен
    // if (!gameFrame) { ... } // Этот блок кода больше не нужен

    log('mainLoop: Страница готова, выполняем клиентский скрипт.', 'debug');

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
            const cdParse = s=>{
              let m=/(\d+)\s*m.*?(\d+)\s*s/i.exec(s);if(m)return(+m[1]*60+ +m[2])*1e3;
              m=/(\d+)\s*s/i.exec(s);return m? +s[1]*1e3:600000;
            };

            // Теперь clientLog и clientDoClick вызывают exposeFunction напрямую из `window` (page context)
            const clientLog = (msg, level='info') => {
              const now = Date.now();
              if (level === 'error' || level === 'warn' || (cfg.logEach > 0 && now >= _nextLogValue)) {
                if (window.logFromClient) { // Проверяем наличие exposed функции
                  window.logFromClient(msg, level);
                }
                if (level !== 'error' && level !== 'warn') {
                    _nextLogValue = now + cfg.logEach * 1000;
                }
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

            // *** ИСПРАВЛЕННАЯ ФУНКЦИЯ findBtn: теперь ищет текст в h3, div, span, p ***
            function findBtn(text){
              const normalizedSearchText = text.toLowerCase().trim();
              const potentialTextElements = [...document.querySelectorAll('h3, div, span, p')].filter(el => {
                  return el.innerText && el.innerText.toLowerCase().includes(normalizedSearchText);
              });

              clientLog(`[Client Debug] Searching for "${text}". Found ${potentialTextElements.length} potential text elements.`, 'debug');

              for (const el of potentialTextElements) {
                  const elText = el.innerText?.toLowerCase().trim();
                  if (elText === normalizedSearchText || elText.startsWith(normalizedSearchText + ' ') || elText.startsWith(normalizedSearchText + '\n')) {
                      const button = el.closest('button');
                      if (button) {
                          clientLog(`[Client Debug] Найден текстовый элемент "${el.innerText.trim()}" и ближайшая кнопка для "${text}".`, 'debug');
                          return button;
                      } else {
                          clientLog(`[Client Warn] Найден текстовый элемент "${el.innerText.trim()}" для "${text}", но без ближайшей кнопки.`, 'warn');
                      }
                  }
              }
              clientLog(`[Client Debug] Не найден соответствующий текстовый элемент для "${text}".`, 'debug');
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
                        clientLog('[Client] Ошибка при выполнении fetch запроса:', error.message, 'error');
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
                    action: 'waiting_backoff'
                };
            }

            let actionTaken = false;
            for (const key of Object.keys(LABELS)) {
                if (!cfg[key]) continue;

                if (key === 'autoFarm') {
                    const eightHoursMs = 8 * 60 * 60 * 1000;
                    const nextFarmTime = (_lastClick[key] || 0) + eightHoursMs;

                    if (now < nextFarmTime) {
                        const remaining = nextFarmTime - now;
                        clientLog(`⏳ ${key}: следующий сбор через ${Math.round(remaining / 1000 / 60)} мин.`);
                        continue;
                    }
                }

                const btn = findBtn(LABELS[key]);
                if (!btn) {
                    continue;
                }

                const cooldown = getCooldown(btn);
                clientLog(`[Client] Кнопка "${LABELS[key]}": найдена, disabled: ${btn.disabled}, кулдаун: ${cooldown / 1000}s.`, 'debug');

                if (btn.disabled && cooldown > 0) {
                    clientLog(`[Client] Кнопка "${LABELS[key]}" на кулдауне или отключена.`, 'info');
                    continue;
                }

                // Логика для autoRefine
                if (key === 'autoRefine') {
                    // Используем более универсальный поиск для значений шардов
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

                    if (btn && btn.disabled && currentPoints < requiredPoints) {
                        clientLog(`Refinery: Недостаточно шардов. Нужно ${requiredPoints}, у вас ${currentPoints}.`, 'info');
                        continue;
                    }
                    if (currentPoints >= requiredPoints && btn && !btn.disabled) {
                        const since = now - (_lastClick[key] || 0);
                        const gap = 5000 + rnd(0, 2000);
                        if (since > gap) {
                            clientLog(`Refinery: Кнопка активна, шардов достаточно. Попытка клика.`, 'info');
                            await clientDoClick(btn);
                            _lastClick[key] = now;
                            _stats.clickCount[key]++;
                            clientLog(`⚡ ${key} кликнут. Шардов: ${currentPoints}, Требуется: ${requiredPoints}.`, 'info');
                            actionTaken = true;
                            return {
                                updatedStats: _stats, updatedLastClick: _lastClick,
                                updatedBackoffUntil: _backoffUntil, updatedNextLogValue: _nextLogValue,
                                action: 'clicked'
                            };
                        } else {
                            clientLog(`Refinery: Кнопка активна, шардов достаточно, но слишком рано (осталось ${((gap - since) / 1000).toFixed(1)}s).`, 'info');
                        }
                    } else {
                        clientLog(`Refinery: Кнопка "${LABELS[key]}" недоступна или ожидает. Шардов: ${currentPoints}, Требуется: ${requiredPoints}.`, 'info');
                        continue;
                    }
                }

                // Общая логика для других кнопок
                const since = now - (_lastClick[key] || 0);
                const gap = 8000 + rnd(0, 2000);

                if (cfg[key] && btn && !btn.disabled && since > gap) {
                    clientLog(`[Client] Кнопка "${LABELS[key]}" активна и прошло достаточно времени. Попытка клика.`, 'info');
                    await clientDoClick(btn);
                    _lastClick[key] = now;
                    _stats.clickCount[key]++;
                    clientLog(`⚡ ${key} кликнут.`, 'info');
                    actionTaken = true;
                    return {
                        updatedStats: _stats, updatedLastClick: _lastClick,
                        updatedBackoffUntil: _backoffUntil, updatedNextLogValue: _nextLogValue,
                        action: 'clicked'
                    };
                } else if (btn && !btn.disabled) {
                    clientLog(`[Client] Кнопка "${LABELS[key]}" активна, но слишком рано (осталось ${((gap - since) / 1000).toFixed(1)}s).`, 'info');
                }
            }

            // --- Keep-Alive ---
            if(cfg.keepAlive && rnd(0,10)<2){
              fetch('/favicon.ico',{cache:'no-store',mode:'no-cors'}).catch(()=>{});
              const body = document.body;
              if (body) {
                const rect = body.getBoundingClientRect();
                const x = rect.left + Math.random()*rect.width;
                const y = rect.top  + Math.random()*rect.height;
                body.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, clientX:x, clientY:y }));
                window.scrollBy(0, rnd(-1,1));
              }
              document.dispatchEvent(new Event('focus', {bubbles:true}));
              document.dispatchEvent(new Event('blur', {bubbles:true}));
              clientLog('ℹ️ Keep-Alive активность выполнена (client-side).');
            }

            window._ab_lastClick = _lastClick;
            window._ab_stats = _stats;
            window._ab_backoffUntil = _backoffUntil;
            window._ab_nextLogValue = _nextLogValue;

            return {
                updatedStats: _stats,
                updatedLastClick: _lastClick,
                updatedBackoffUntil: _backoffUntil,
                updatedNextLogValue: _nextLogValue,
                action: 'no_action'
            };

        }, config, stats); // Передаем актуальные config и stats из Node.js

        // Применяем обновления из клиента (result)
        stats = updatedClientData.updatedStats;
        clientBackoffUntil = updatedClientData.updatedBackoffUntil;

        // Если клиентский скрипт сообщил о клике, делаем небольшую паузу
        if (updatedClientData.action === 'clicked') {
            log('mainLoop: Клиент сообщил о клике, короткая пауза.', 'debug');
            await sleep(rnd(2000, 5000)); // Короткая пауза после клика
        }
    } catch (e) {
        log(`❌ mainLoop: Ошибка при выполнении клиентского скрипта (main page): ${e.message}`, 'error');
        if (e.message.includes('403 Forbidden detected')) {
            log('❌ Обнаружен 403 от клиента. Выполняю жесткую перезагрузку.', 'error');
            await hardReload();
        } else { // Если это другая критическая ошибка, перезагружаем
            await hardReload();
        }
    }

    // 3) Проверка XU вне iframe - эта часть остается как есть
    try {
      const xu = await page.evaluate(()=>+document.querySelector('span.text-sm.font-medium.text-amber-400.drop-shadow-sm.tracking-wide')?.textContent.replace(/\s/g,'').replace(',','.')||0);
      if(xu!==lastXu){lastXu=xu;lastTS=Date.now();}
      if(Date.now()-lastTS>300000 && xu > 0){
        log('🛑 XU статичен 5 мин – reload','warn');
        await hardReload();
        lastTS=Date.now();
      }
    } catch(e) {
      log(`❌ mainLoop: Ошибка проверки XU (вне iframe): ${e.message}`, 'error');
    }

    // 4) Периодическое сохранение cookies
    if (Date.now() - lastCookieSave > 5 * 60 * 1000) {
      let cookiesToSave = [];
      try {
        cookiesToSave = await page.browser().defaultBrowserContext().cookies();
        await save(DEF.cookiesFilePath, cookiesToSave);
        log(`💾 Cookies сохранены (${cookiesToSave.length})`, 'info');
        lastCookieSave = Date.now();
      } catch (e) {
        log(`❌ mainLoop: Ошибка при периодическом сохранении куки: ${e.message}`, 'error');
      }
    }

    // 5) Сохраняем stats на диск
    await save(DEF.statsFilePath, stats);

    await sleep(1000);
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
  await launch();
  listeners();

  log('ℹ️ Переходим на geturanium.io...', 'info');
  navigating = true;
  await page.goto('https://geturanium.io', { waitUntil:'networkidle2', timeout:60000 }); // Вернул networkidle2 для начальной загрузки
  navigating = false; // После успешной загрузки основной страницы, сбрасываем
  log(`ℹ️ URL: ${page.url()}`, 'info');

  if (page.url().includes('/auth')) {
    log('🔑 На странице авторизации, ждём входа…', 'info');
    navigating = true; // Устанавливаем navigating, если перешли на страницу авторизации
    await page.waitForNavigation({ waitUntil:'networkidle2', timeout:180000 })
        .catch(e => log(`⌛ Тайм-аут ожидания авторизации: ${e.message}`, 'warn'));
    navigating = false; // Сбрасываем navigating после авторизации
    log('✅ Авторизация завершена', 'info');
    const cook = await page.browser().defaultBrowserContext().cookies();
    await save(DEF.cookiesFilePath, cook);
    lastCookieSave = Date.now();
  } else {
    log('ℹ️ Сессия активна, сохраняем текущие куки', 'info');
    const cook = await page.browser().defaultBrowserContext().cookies();
    await save(DEF.cookiesFilePath, cook);
    lastCookieSave = Date.now();
  }

  await sleep(3000);
  process.on('SIGINT', async () => {
    log('SIGINT, сохраняем и выходим...', 'info');
    const cook = await page.browser().defaultBrowserContext().cookies().catch(()=>[]);
    await save(DEF.cookiesFilePath, cook);
    await save(DEF.configFilePath,  config);
    await save(DEF.statsFilePath,   stats);
    if (browser) await browser.close();
    process.exit(0);
  });

  scheduleReload();
  await mainLoop();
})();
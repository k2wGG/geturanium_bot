// bot.cjs
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

/* ===== 1. Конфигурация по-умолчанию =================== */
const DEF = {
  enabled: true,
  // Тогглы действий
  autoAC: true,         // Auto Collector
  autoSM: true,         // Shard Multiplier
  autoCB: true,         // Conveyor Booster
  autoFarm: true,       // (резерв)
  autoRefine: true,     // Initiate Uranium Refining (раз в 8ч)
  // Стабильность
  keepAlive: true,
  autoReload: true, reloadMinutes: 50,
  logEach: 300,         // частота info/debug с клиентской стороны
  // Браузер
  headless: false, slowMo: 0,
  useSystemChrome: true, chromePath: '',
  acceptLanguage: 'en-US,en;q=0.9',
  timezone: 'Europe/Berlin',
  // Интервалы бустов (главная)
  boostIntervalMs: 300000,     // 5 минут
  boostJitterMs: 15000,        // ±15с
  // Пути
  cookiesFilePath: './cookies.json',
  configFilePath: './config.json',
  statsFilePath: './stats.json',
  backoffUntil: 0,
  // Прокси
  proxies: [],                 // строки "login:pass@host:port" или "http://login:pass@host:port"
  proxyRotation: 'perLaunch',  // 'perLaunch' | 'sequential'
  rotateProxyOnReload: true
};

/* ===== 2. Состояние ================================= */
let config = { ...DEF };
let stats  = {
  reloadCount: 0,
  clickCount: { autoAC:0, autoSM:0, autoCB:0, autoFarm:0, autoRefine:0 },
  lastClick:  { autoAC:0, autoSM:0, autoCB:0, autoFarm:0, autoRefine:0 } // ПЕРСИСТЕНТНО!
};

let browser, page;
let navigating = false;
let lastCookieSave = Date.now();

// Локальное зеркало lastClick (страница пишет сюда; перед выходом пишем в stats.lastClick)
let lastClick = { autoAC:0, autoSM:0, autoCB:0, autoFarm:0, autoRefine:0 };
let clientBackoffUntil = 0;

// Планировщик для /refinery: когда снова туда идти
let nextRefineryVisitAt = 0;   // timestamp (ms)

/* ===== Proxy helpers ================================ */
let __proxyIndex = 0;
function pickProxy() {
  const list = Array.isArray(config.proxies) ? config.proxies : [];
  if (!list.length) return null;
  if (config.proxyRotation === 'sequential') {
    const p = list[__proxyIndex % list.length]; __proxyIndex++; return p;
  }
  return list[Math.floor(Math.random() * list.length)];
}

/** Нормализация прокси строки.
 * Принимает: "login:pass@host:port" или "http://login:pass@host:port"
 * Возвращает: { serverArg: "http://host:port", auth: {username, password} } либо null
 */
function normalizeProxy(p) {
  try {
    if (!p) return null;
    let s = String(p).trim();
    if (!/^[a-z]+:\/\//i.test(s)) s = 'http://' + s; // по умолчанию http://
    const u = new URL(s);
    const scheme = u.protocol.replace(':','').toLowerCase(); // http/https/socks5
    const host = u.hostname;
    const port = u.port;
    if (!host || !port) return null;
    const auth = (u.username || u.password) ? {
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password)
    } : null;
    return { serverArg: `${scheme}://${host}:${port}`, auth };
  } catch {
    return null;
  }
}

/* ===== 3. Логгер =================================== */
const COLOR = { info:34, warn:33, error:31, debug:36, success:32 };
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const MIN_LOG_LEVEL_INDEX = 1;

function log(msg, level='info') {
  const levelIndex = LOG_LEVELS.indexOf(level);
  if (levelIndex < MIN_LOG_LEVEL_INDEX) return;
  const time = new Date().toLocaleTimeString('ru-RU');
  const prefix = { info:'ℹ️', warn:'⚠️', error:'🚨', debug:'🐞', success:'✅' }[level] || ' ';
  console.log(`\x1b[${COLOR[level]||37}m[${time}] ${prefix} ${msg}\x1b[0m`);
}

/* ===== 4. Утилиты ================================== */
const rnd   = (min, max) => (min + Math.random() * (max - min)) | 0;
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
}

/* ===== 6. Запуск Puppeteer ======================== */
const PROFILE_DIR = path.resolve(__dirname, 'browser_profile');
async function launch() {
  if (browser) {
    log('ℹ️ Закрываю старый браузер...', 'info');
    try { await browser.close(); } catch (e) { log(`❌ Ошибка при закрытии браузера: ${e.message}`, 'error'); }
  }

  log('ℹ️ Запуск браузера...', 'info');
  try {
    // headless режим
    let finalHeadlessMode;
    if (process.env.HEADLESS === 'true') finalHeadlessMode = 'new';
    else if (process.env.HEADLESS === 'false') finalHeadlessMode = false;
    else finalHeadlessMode = config.headless === true ? 'new' : config.headless;
    log(`🐞 Debug: Вычисленное значение headless для Puppeteer: "${finalHeadlessMode}"`, 'debug');

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--disable-popup-blocking',
      '--ignore-certificate-errors'
    ];

    // применяем прокси
    const rawProxy    = pickProxy();
    const parsedProxy = normalizeProxy(rawProxy);
    if (parsedProxy) {
      launchArgs.push(`--proxy-server=${parsedProxy.serverArg}`);
      log(`🌐 Proxy: ${parsedProxy.serverArg} ${parsedProxy.auth ? '(with auth)' : ''}`, 'info');
    } else if (rawProxy) {
      log(`⚠️ Некорректная строка прокси: "${rawProxy}"`, 'warn');
    }

    browser = await puppeteer.launch({
      headless: finalHeadlessMode,
      slowMo: config.slowMo,
      userDataDir: PROFILE_DIR,
      executablePath: (config.useSystemChrome && (config.chromePath || process.env.CHROME_PATH)) || undefined,
      args: launchArgs
    });

    page = await browser.newPage();
    await page.setViewport({ width:1920, height:1080 });

    // User-Agent + язык/таймзона
    const __ua = await browser.userAgent();
    await page.setUserAgent(__ua);
    if (config.acceptLanguage) {
      await page.setExtraHTTPHeaders({ 'Accept-Language': config.acceptLanguage });
    }
    if (config.timezone) {
      try { await page.emulateTimezone(config.timezone); } catch {}
    }

    // аутентификация на прокси через логин/пароль
    if (parsedProxy && parsedProxy.auth) {
      try {
        await page.authenticate(parsedProxy.auth);
        log('🔐 Прокси-аутентификация применена.', 'info');
      } catch (e) {
        log(`⚠️ Ошибка page.authenticate: ${e.message}`, 'warn');
      }
    }

    // Патчи до любого кода страницы
    await page.evaluateOnNewDocument(() => {
      if (!Event.prototype.__ab_trusted) {
        [Event, MouseEvent, KeyboardEvent, UIEvent].forEach(C => {
          Object.defineProperty(C.prototype, 'isTrusted', { get(){ return true; }, configurable:true });
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
        window.setTimeout  = (cb, d=0, ...a) => oTO(cb, Math.max(d,MIN), ...a);
        window.setInterval = (cb, d=0, ...a) => oTI(cb, Math.max(d,MIN), ...a);
        window.__ab_timers_patched = true;
      }
      if (document.hasFocus && !document.hasFocus.__ab_patched) {
        document.hasFocus = () => true;
        document.hasFocus.__ab_patched = true;
      }
      // заглушка Notification (устранить "Notification is not defined")
      if (typeof window.Notification === 'undefined') {
        window.Notification = function(){};
        window.Notification.permission = 'default';
        window.Notification.requestPermission = async ()=>'denied';
      }
    });

    // Expose для кликов и логов
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
      const cleanedMsg = msg.startsWith('[Client] ') ? msg.substring('[Client] '.length) : msg;
      log(`[Client] ${cleanedMsg}`, lvl);
    });

  } catch (error) {
    log(`❌ Ошибка при инициализации браузера: ${error.message}`, 'error');
    throw error;
  }
}

/* ===== 7. Слушатели =============================== */
function listeners() {
  page.on('console', msg => {
    if (msg.text().includes('Unable to preventDefault inside passive event listener invocation.') ||
        msg.text().includes('Touch event suppression') ||
        msg.text().includes('The default unity loader module is not available on this platform') ||
        msg.text().includes('DevTools listening on')) return;
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

/* ===== 8. Навигация и перезагрузка =================== */
let reloadTimer = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

async function gotoIfNeeded(url, label='') {
  const cur = page.url().replace(/\/+$/,'');
  const dest = url.replace(/\/+$/,'');
  if (cur === dest) return;
  log(`↪️ Переходим на ${label || url} ...`, 'info');
  navigating = true;
  await page.goto(url, { waitUntil:'networkidle2', timeout:60000 });
  navigating = false;
  await sleep(1000 + rnd(250,750));
}

async function hardReload() {
  log('🚨 Жёсткая перезагрузка...', 'warn');

  if (config.rotateProxyOnReload && Array.isArray(config.proxies) && config.proxies.length) {
    try { if (browser) await browser.close(); } catch {}
    await launch(); // релонч с возможной новой проксей
    scheduleReload();
    return;
  }

  stats.reloadCount++;
  await save(config.statsFilePath, stats);
  clearTimeout(reloadTimer);
  navigating = true;

  try {
    await fs.mkdir('./screenshots', { recursive: true });
    await page.screenshot({ path: `./screenshots/reload_before_${Date.now()}.png` });
    log('📸 Скриншот сделан перед перезагрузкой.', 'debug');
  } catch (e) {
    log(`❌ Ошибка при создании скриншота перед перезагрузкой: ${e.message}`, 'error');
  }

  try {
    await page.goto('about:blank');
    await page.goto(`https://geturanium.io/?_=${Date.now()}`, { waitUntil:'networkidle2', timeout:60000 });
    log(`ℹ️ URL после перезагрузки: ${page.url()}`, 'info');

    if (page.url().includes('/auth')) {
      log('🔑 После перезагрузки оказались на странице авторизации, ждём входа…', 'info');
      await page.waitForNavigation({ waitUntil:'networkidle2', timeout:180000 })
        .catch(e => log(`⌛ Тайм-аут ожидания авторизации после перезагрузки: ${e.message}`, 'warn'));
      log('✅ Авторизация после перезагрузки завершена', 'info');
    } else {
      log('✅ После перезагрузки сессия активна.', 'info');
    }

  } catch (error) {
    log(`❌ Ошибка при выполнении goto во время hardReload: ${error.message}`, 'error');
    await launch();
  }
  navigating = false;
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

/* ===== 9. Скрипты страницы (evaluate) ================== */
/**
 * mode: 'refinery' | 'home'
 * Возвращает: { updatedStats, updatedLastClick, updatedBackoffUntil, updatedNextLogValue, action, which?, waitDuration? }
 */
async function runClient(mode) {
  return await page.evaluate(async (cfg, initialStats, initialLastClick, mode) => {
    const LABELS = {
      autoAC:'auto collector',
      autoSM:'shard multiplier',
      autoCB:'conveyor booster',
      autoFarm:'farm reward',
      autoRefine:'initiate uranium refining'
    };

    // перенос из Node внутрь страницы
    let _lastClick    = { ...(window._ab_lastClick || {}), ...initialLastClick };
    let _stats        = window._ab_stats || initialStats;
    let _backoffUntil = window._ab_backoffUntil || 0;
    let _nextLogValue = window._ab_nextLogValue || Date.now();

    const rnd = (min,max)=> (min + Math.random()*(max-min)) | 0;

    const clientLog = (msg, level='info') => {
      const now = Date.now();
      if (level === 'error' || level === 'warn') {
        if (window.logFromClient) window.logFromClient(msg, level);
      } else if (cfg.logEach > 0 && now >= _nextLogValue) {
        if (window.logFromClient) window.logFromClient(msg, level);
        _nextLogValue = now + cfg.logEach * 1000;
      }
    };

    async function clientDoClick(el) {
      if (!el) { clientLog('[Client] Попытка клика по несуществующему элементу.', 'warn'); return; }
      try { el.scrollIntoView({ block: 'center' }); } catch {}
      await new Promise(r => setTimeout(r, 150 + Math.random()*250));
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) { clientLog('[Client] Попытка клика по невидимому элементу.', 'warn'); return; }
      const x = rect.left + Math.random() * rect.width;
      const y = rect.top  + Math.random() * rect.height;
      if (window.doPuppeteerClick) { await window.doPuppeteerClick(x, y); }
      else { clientLog('[Client WARN] doPuppeteerClick недоступен. Нативный click().', 'warn'); el.click(); }
    }

    function findBtnByText(text){
      const needle = String(text||'').toLowerCase().replace(/\s+/g,' ').trim();
      const buttons = [...document.querySelectorAll('button')];
      for (const btn of buttons) {
        const t = (btn.innerText||'').toLowerCase().replace(/\s+/g,' ').trim();
        if (t.includes(needle)) return btn;
      }
      const potentials = [...document.querySelectorAll('h1,h2,h3,div,span,p')];
      for (const el of potentials) {
        const t = (el.innerText||'').toLowerCase().replace(/\s+/g,' ').trim();
        if (t.includes(needle)) {
          const button = el.closest('button') || el.parentElement?.querySelector('button');
          if (button) return button;
        }
      }
      return null;
    }

    function getCooldown(btn){
      if (!btn || btn.disabled === false) return 0;
      if (/activating|processing/i.test(btn.innerText)) return 3000;
      const m = /(\d+)\s*m.*?(\d+)\s*s/i.exec(btn.innerText); if (m) return (+m[1]*60 + +m[2]) * 1000;
      const s = /(\d+)\s*s/i.exec(btn.innerText); return s ? +s[1]*1000 : 600000;
    }

    // Перехват fetch для 429/403
    if (!window.__ab_fetch_patched) {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        try {
          const res = await nativeFetch(...args);
          if (res.status === 429) {
            _backoffUntil = Date.now() + 5*60*1000;
            clientLog('[Client] 429 Too Many Requests → пауза 5 мин.', 'warn');
          }
          if (res.status === 403) {
            clientLog('[Client] 403 Forbidden → нужна перезагрузка.', 'warn');
            return Promise.reject(new Error('403 Forbidden detected.'));
          }
          return res;
        } catch (error) {
          clientLog('[Client] fetch error: ' + error.message, 'error');
          throw error;
        }
      };
      window.__ab_fetch_patched = true;
    }

    const now = Date.now();
    if (now < _backoffUntil) {
      clientLog(`[Client] Пауза до ${new Date(_backoffUntil).toLocaleTimeString()}.`);
      return {
        updatedStats:_stats, updatedLastClick:_lastClick,
        updatedBackoffUntil:_backoffUntil, updatedNextLogValue:_nextLogValue,
        action:'waiting_backoff', waitDuration:_backoffUntil - now
      };
    }

    // === РЕФАЙНЕРИ ===
    if (mode === 'refinery') {
      if (!cfg.autoRefine) {
        return {
          updatedStats:_stats, updatedLastClick:_lastClick,
          updatedBackoffUntil:_backoffUntil, updatedNextLogValue:_nextLogValue,
          action:'no_action', waitDuration: 15000 + rnd(0,5000)
        };
      }

      // кнопка "initiate uranium refining"
      const btn = findBtnByText('initiate uranium refining');

      // читаем "Available/Your Shards" и "Required"
      let currentPoints = 0, requiredPoints = 0;
      try {
        const shardsEl = [...document.querySelectorAll('span,div')]
          .find(el => /available shards|your shards/i.test(el.innerText||''));
        const requiredEl = [...document.querySelectorAll('span,div')]
          .find(el => /required input|required shards|minimum threshold/i.test(el.innerText||''));
        if (shardsEl) {
          const n = (shardsEl.nextElementSibling?.innerText || shardsEl.innerText || '').replace(/[^0-9]/g,'');
          currentPoints = parseInt(n)||0;
        }
        if (requiredEl) {
          const n = (requiredEl.nextElementSibling?.innerText || requiredEl.innerText || '').replace(/[^0-9]/g,'');
          requiredPoints = parseInt(n)||0;
        }
      } catch {}

      if (btn && !btn.disabled && currentPoints >= requiredPoints) {
        clientLog('[Refinery] Кликаю «INITIATE URANIUM REFINING».', 'info');
        await clientDoClick(btn);
        _lastClick.autoRefine = now;
        _stats.clickCount.autoRefine = (_stats.clickCount.autoRefine||0) + 1;
        return {
          updatedStats:_stats, updatedLastClick:_lastClick,
          updatedBackoffUntil:_backoffUntil, updatedNextLogValue:_nextLogValue,
          action:'clicked', which:'autoRefine', waitDuration: 3000 + rnd(0,1000)
        };
      }

      const cd = getCooldown(btn) || 10000;
      return {
        updatedStats:_stats, updatedLastClick:_lastClick,
        updatedBackoffUntil:_backoffUntil, updatedNextLogValue:_nextLogValue,
        action:'no_action', waitDuration: cd + rnd(500,2000)
      };
    }

    // === ГЛАВНАЯ: бусты ===
    if (mode === 'home') {
      const BOOST_KEYS = ['autoAC','autoSM','autoCB'];
      let minWait = Infinity;

      for (const key of BOOST_KEYS) {
        if (!cfg[key]) continue;

        const btn = (key==='autoAC') ? findBtnByText('auto collector')
                  : (key==='autoSM') ? findBtnByText('shard multiplier')
                  : findBtnByText('conveyor booster');

        if (!btn) { minWait = Math.min(minWait, 10000); continue; }

        const cooldown = getCooldown(btn);
        if (btn.disabled && cooldown > 0) { minWait = Math.min(minWait, cooldown); continue; }

        if (!btn.disabled) {
          const since   = now - (_lastClick[key] || 0);
          const base    = (cfg.boostIntervalMs || 300000);
          const jitter  = (cfg.boostJitterMs  || 15000);
          const gap     = base + rnd(-jitter, jitter);

          if (since > gap) {
            clientLog(`[Boosts] Нажимаю ${key}.`, 'info');
            await clientDoClick(btn);
            _lastClick[key] = now;
            _stats.clickCount[key] = (_stats.clickCount[key]||0) + 1;
            return {
              updatedStats:_stats, updatedLastClick:_lastClick,
              updatedBackoffUntil:_backoffUntil, updatedNextLogValue:_nextLogValue,
              action:'clicked', which:key, waitDuration: 2000 + rnd(0,1500)
            };
          } else {
            minWait = Math.min(minWait, gap - since);
          }
        }
      }

      // keep-alive
      if (cfg.keepAlive && rnd(0,10) < 2) {
        fetch('/favicon.ico',{cache:'no-store',mode:'no-cors'}).catch(()=>{});
        const body = document.body;
        if (body) {
          const rect = body.getBoundingClientRect();
          const x = rect.left + Math.random()*rect.width;
          const y = rect.top  + Math.random()*rect.height;
          body.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y}));
          window.scrollBy(0, rnd(-1,1));
        }
        document.dispatchEvent(new Event('focus',{bubbles:true}));
        document.dispatchEvent(new Event('blur',{bubbles:true}));
        clientLog('[Boosts] Keep-Alive.', 'info');
      }

      return {
        updatedStats:_stats, updatedLastClick:_lastClick,
        updatedBackoffUntil:_backoffUntil, updatedNextLogValue:_nextLogValue,
        action:'no_action',
        waitDuration: (minWait===Infinity ? 10000 + rnd(0,5000) : minWait + rnd(500,2000))
      };
    }

    // fallback
    return {
      updatedStats:_stats, updatedLastClick:_lastClick,
      updatedBackoffUntil:_backoffUntil, updatedNextLogValue:_nextLogValue,
      action:'no_action', waitDuration: 10000 + rnd(0,5000)
    };
  }, config, stats, lastClick, mode);
}

/* ===== 10. Планировщик /refinery ================== */
const EIGHT_HOURS = 8*60*60*1000;
function recomputeNextRefineryVisit() {
  // идти на /refinery только когда подошло окно 8 часов после последнего клика
  // если ни разу не кликали — посетить сразу
  const last = lastClick.autoRefine || 0;
  if (!last) {
    nextRefineryVisitAt = Date.now(); // сейчас
  } else {
    // ранний заход за ~90 сек до конца окна
    nextRefineryVisitAt = last + EIGHT_HOURS - 90*1000;
  }
  // но не чаще, чем раз в 3 часа даже при ошибках
  const minNext = Date.now() + 3*60*60*1000;
  if (nextRefineryVisitAt < minNext && last) nextRefineryVisitAt = minNext;
  log(`📅 Следующий визит на /refinery ≈ ${new Date(nextRefineryVisitAt).toLocaleTimeString()}`, 'info');
}

/* ===== 11. Основной цикл ========================== */
async function mainLoop() {
  let navigationStuckTimer = null;
  let lastXu = 0, lastTS = Date.now();

  log('✅ mainLoop: Запуск основного цикла.', 'success');

  // Стартуем с главной
  await gotoIfNeeded('https://www.geturanium.io/', 'главную');

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
      if (navigationStuckTimer) { clearTimeout(navigationStuckTimer); navigationStuckTimer = null; }
    }

    const now = Date.now();

    // ======= Плановый визит на /refinery (НЕ прыгаем без надобности) =======
    if (now >= (nextRefineryVisitAt || 0)) {
      await gotoIfNeeded('https://www.geturanium.io/refinery', '/refinery');

      let r;
      try {
        r = await runClient('refinery');
      } catch (e) {
        log(`❌ Ошибка в runClient('refinery'): ${e.message}`, 'error');
        r = { action:'no_action', waitDuration: 15000 };
      }

      // Подтверждение клика для /refinery
      if (r.action === 'clicked' && r.which === 'autoRefine') {
        // ждём до 8с, что кнопка ушла в кд/изменилась
        const ok = await page.evaluate(async () => {
          function findBtn(text){
            const needle = String(text||'').toLowerCase().replace(/\s+/g,' ').trim();
            const buttons = [...document.querySelectorAll('button')];
            for (const btn of buttons) {
              const t = (btn.innerText||'').toLowerCase().replace(/\s+/g,' ').trim();
              if (t.includes(needle)) return btn;
            }
            return null;
          }
          for (let i=0;i<8;i++){
            const btn = findBtn('initiate uranium refining');
            if (!btn) return true;
            if (btn.disabled || /cooldown|processing|active/i.test(btn.innerText||'')) return true;
            await new Promise(res=>setTimeout(res,1000));
          }
          return false;
        });

        if (ok) {
          log('⚡ [Refinery] Клик подтверждён.', 'info');
          lastClick.autoRefine = Date.now();
          stats.clickCount.autoRefine = (stats.clickCount.autoRefine||0) + 1;
          // планируем следующий визит строго через 8 часов - 90с
          recomputeNextRefineryVisit();
        } else {
          log('⚠️ [Refinery] Клик НЕ подтвердился. Повторим позже.', 'warn');
          // повторим через 5 минут
          nextRefineryVisitAt = Date.now() + 5*60*1000;
          log(`📅 Следующий визит на /refinery ≈ ${new Date(nextRefineryVisitAt).toLocaleTimeString()}`, 'info');
        }
      } else {
        log('🐞 [Refinery] Нет действий (ожидание/кд).', 'debug');
        // если кнопка не доступна — проверим ещё раз через указанную задержку, но не чаще 5 минут
        const waitMs = Math.max(5*60*1000, (r.waitDuration||30000));
        nextRefineryVisitAt = Date.now() + waitMs;
        log(`📅 Следующий визит на /refinery ≈ ${new Date(nextRefineryVisitAt).toLocaleTimeString()}`, 'info');
      }

      // Возвращаемся на главную и продолжаем кликать бусты
      await gotoIfNeeded('https://www.geturanium.io/', 'главную');

      // небольшой отдых
      await sleep(1500);
    }

    // ======= Бусты на главной (без навигации) =======
    let homeRes;
    try {
      homeRes = await runClient('home');
    } catch (e) {
      log(`❌ Ошибка в runClient('home'): ${e.message}`, 'error');
      homeRes = { action:'no_action', waitDuration: 10000 };
    }

    // Подтверждение клика для бустов
    if (homeRes.action === 'clicked' && homeRes.which) {
      const which = homeRes.which; // autoAC / autoSM / autoCB
      const ok = await page.evaluate(async (which) => {
        function findBtnByKey(k){
          const map = {
            autoAC: 'auto collector',
            autoSM: 'shard multiplier',
            autoCB: 'conveyor booster'
          };
          const needle = map[k];
          const buttons = [...document.querySelectorAll('button')];
          for (const btn of buttons) {
            const t = (btn.innerText||'').toLowerCase().replace(/\s+/g,' ').trim();
            if (t.includes(needle)) return btn;
          }
          return null;
        }
        for (let i=0;i<6;i++){
          const btn = findBtnByKey(which);
          if (!btn) return true;
          if (btn.disabled || /cooldown|processing|active/i.test(btn.innerText||'')) return true;
          await new Promise(res=>setTimeout(res,1000));
        }
        return false;
      }, which);

      if (ok) {
        log(`⚡ [Boosts] Клик подтверждён (${which}).`, 'info');
        lastClick[which] = Date.now();
        stats.clickCount[which] = (stats.clickCount[which]||0) + 1;
      } else {
        log(`⚠️ [Boosts] Клик НЕ подтвердился (${which}).`, 'warn');
        // сбросим локальный таймер, чтобы попробовать снова при следующем окне
        lastClick[which] = 0;
      }

      // после клика — небольшая пауза
      await sleep(rnd(2000, 5000));
    } else {
      // ничего не сделали — подождём, сколько попросила страница
      const wait = Math.max(1000, Math.min(homeRes.waitDuration||10000, 60000));
      log(`🐞 [Boosts] Нет доступных действий. Пауза ${Math.round(wait/1000)}с.`, 'debug');
      await sleep(wait);
    }

    // ======= Сервисные вещи =======
    // Проверка XU
    try {
      const xu = await page.evaluate(() =>
        +document.querySelector('span.text-sm.font-medium.text-amber-400.drop-shadow-sm.tracking-wide')
          ?.textContent.replace(/\s/g,'').replace(',','.') || 0
      );
      if (xu !== lastXu) { lastXu = xu; lastTS = Date.now(); }
      if (Date.now() - lastTS > 50*60*1000 && xu > 0) {
        log('🛑 XU статичен 50 мин – reload', 'warn');
        await hardReload();
        lastTS = Date.now();
      }
    } catch(e) {
      log(`❌ mainLoop: Ошибка проверки XU: ${e.message}`, 'error');
    }

    // Периодическое сохранение cookies
    if (Date.now() - lastCookieSave > 5*60*1000) {
      try {
        const cookiesToSave = await page.cookies();
        await save(config.cookiesFilePath, cookiesToSave);
        log(`💾 Cookies сохранены (${cookiesToSave.length})`, 'info');
        lastCookieSave = Date.now();
      } catch (e) {
        log(`❌ mainLoop: Ошибка сохранения куки: ${e.message}`, 'error');
      }
    }

    // Сохраняем stats + lastClick
    stats.lastClick = { ...lastClick };
    await save(config.statsFilePath, stats);
  }
}

/* ===== 12. Запуск всего ========================== */
(async () => {
  process.on('unhandledRejection', (reason, promise) => {
    log(`🚨 Unhandled Rejection at: ${promise}, reason: ${reason}`, 'error');
    if (browser) {
      browser.close().catch(e => log(`❌ Ошибка при закрытии браузера из unhandledRejection: ${e.message}`, 'error'));
    }
    process.exit(1);
  });

  log('ℹ️ Загрузка конфига/статистики...', 'info');
  config = { ...DEF, ...(await load(DEF.configFilePath, {})) };

  // Грузим stats (включая lastClick, если уже был сохранён ранее)
  const loadedStats = await load(DEF.statsFilePath, {});
  stats = { ...stats, ...loadedStats };
  if (!stats.lastClick) stats.lastClick = { autoAC:0, autoSM:0, autoCB:0, autoFarm:0, autoRefine:0 };
  lastClick = { ...stats.lastClick };

  try {
    await launch();
    listeners();

    // первичный расчёт планировщика /refinery
    recomputeNextRefineryVisit();

    // старт обработчика SIGINT
    process.on('SIGINT', async () => {
      log('SIGINT, сохраняем и выходим...', 'info');
      try {
        const cook = await page.cookies().catch(()=>[]);
        await save(config.cookiesFilePath, cook);
        stats.lastClick = { ...lastClick };
        await save(config.configFilePath, config);
        await save(config.statsFilePath, stats);
      } catch (e) {
        log(`⚠️ Ошибка сохранения при выходе: ${e.message}`, 'warn');
      }
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

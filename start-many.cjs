// start-many.cjs
// Мульти-стартер: поднимает по одному bot.cjs на каждый аккаунт из accounts.json,
// у каждого — свой рабочий каталог, свой профиль, свои cookies/stats и прокси.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const ACCOUNTS_FILE = path.resolve(ROOT, 'accounts.json'); // создаёт init-sessions.cjs
const RUNS_DIR = path.resolve(ROOT, 'runs');               // рабочие папки для процессов
const BOT_SRC = path.resolve(ROOT, 'bot.cjs');             // исходный bot.cjs (не трогаем)

// ---- настройки перезапуска/логов ----
const RESTART_DELAY_MS = 15_000;
const COLOR = { gray: '\x1b[90m', reset: '\x1b[0m' };

// утилиты
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const fileExists = async (p) => !!(await fsp.stat(p).catch(() => false));
const ensureDir = async (p) => fsp.mkdir(p, { recursive: true });

// аккуратно логируем поток дочерних процессов с префиксом аккаунта
function attachLogs(child, accId) {
  const tag = `[${accId}]`;
  child.stdout.on('data', (d) => {
    process.stdout.write(`${COLOR.gray}${tag}${COLOR.reset} ${d}`);
  });
  child.stderr.on('data', (d) => {
    process.stderr.write(`${COLOR.gray}${tag}${COLOR.reset} ${d}`);
  });
}

// нормализация прокси из accounts.json к строке для config.json бота
// ожидаем либо {serverArg:"http://host:port", auth:{username,password}}, либо простую строку
function toProxyString(px) {
  if (!px) return null;
  if (typeof px === 'string') return px.trim();
  if (px.serverArg) {
    // serverArg уже типа "http://host:port" | "socks5://host:port"
    if (px.auth && px.auth.username) {
      const u = new URL(px.serverArg);
      const user = encodeURIComponent(px.auth.username || '');
      const pass = encodeURIComponent(px.auth.password || '');
      // http://user:pass@host:port
      return `${u.protocol}//${user}:${pass}@${u.hostname}:${u.port}`;
    }
    return px.serverArg;
  }
  return null;
}

// генерируем конфиг для бота на основе аккаунта
function buildBotConfigForAccount(acc, runDir) {
  // дефолты (мягкие — можно править под себя)
  const def = {
    enabled: true,
    // тумблеры
    autoAC: true,
    autoSM: true,
    autoCB: true,
    autoFarm: true,
    autoRefine: true,
    // стабильность
    keepAlive: true,
    autoReload: true,
    reloadMinutes: 50,
    logEach: 300,
    showClientLogs: false,
    // браузер
    headless: false, // управляем через ENV, но пусть в конфиге тоже будет
    slowMo: 0,
    useSystemChrome: !!acc.useSystemChrome,
    chromePath: acc.chromePath || '',
    acceptLanguage: acc.acceptLanguage || 'en-US,en;q=0.9',
    timezone: acc.timezone || 'Europe/Berlin',
    // бусты
    boostIntervalMs: 300000,
    boostJitterMs: 15000,
    // refinery
    refineHours: 8,
    refineMinMinutes: 30,
    // пути — уникальные на аккаунт
    cookiesFilePath: path.join(runDir, `cookies_${acc.id}.json`),
    configFilePath: path.join(runDir, 'config.json'),
    statsFilePath: path.join(runDir, `stats_${acc.id}.json`),
    backoffUntil: 0,
    // прокси
    proxies: [],
    proxyRotation: 'perLaunch',
    rotateProxyOnReload: true
  };

  // если init-sessions сохранил cookiesFile — используем его,
  // но копию положим и в runDir (чтобы бот писал именно туда)
  if (acc.cookiesFile) {
    def.cookiesFilePath = path.isAbsolute(acc.cookiesFile)
      ? acc.cookiesFile
      : path.resolve(ROOT, acc.cookiesFile);
  }

  const pstr = toProxyString(acc.proxy);
  if (pstr) def.proxies = [pstr];

  // уважим явные overrides у аккаунта, если есть
  if (typeof acc.headless === 'boolean') def.headless = acc.headless;
  if (typeof acc.reloadMinutes === 'number') def.reloadMinutes = acc.reloadMinutes;
  if (typeof acc.refineHours === 'number') def.refineHours = acc.refineHours;
  if (typeof acc.refineMinMinutes === 'number') def.refineMinMinutes = acc.refineMinMinutes;

  return def;
}

// копируем bot.cjs и кладём конфиг
async function prepareRunDir(acc) {
  const runDir = path.join(RUNS_DIR, acc.id);
  await ensureDir(runDir);

  // 1) bot.cjs → локальная копия (нужно, чтобы __dirname у бота был уникальный → свой browser_profile)
  const botDst = path.join(runDir, 'bot.cjs');
  // переписываем только если нет файла или исходник новее
  const needCopy =
    !(await fileExists(botDst)) ||
    (fs.statSync(BOT_SRC).mtimeMs > fs.statSync(botDst).mtimeMs);
  if (needCopy) {
    await fsp.copyFile(BOT_SRC, botDst);
  }

  // 2) config.json
  const cfg = buildBotConfigForAccount(acc, runDir);
  const cfgPath = path.join(runDir, 'config.json');
  await fsp.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  // 3) если cookiesFile внешняя — скопировать стартовую копию в runDir (чтобы бот писал уже туда)
  if (acc.cookiesFile) {
    const src = path.isAbsolute(acc.cookiesFile)
      ? acc.cookiesFile
      : path.resolve(ROOT, acc.cookiesFile);
    if (await fileExists(src)) {
      const dst = path.join(runDir, `cookies_${acc.id}.json`);
      // не затираем, если уже есть (свежая авторизация)
      if (!(await fileExists(dst))) {
        await fsp.copyFile(src, dst);
      }
    }
  }

  return { runDir, botDst };
}

// запуск одного аккаунта
async function launchAccount(acc) {
  const { runDir, botDst } = await prepareRunDir(acc);

  const env = {
    ...process.env,
    // хотим headless/не headless — можно управлять глобально через ENV, либо на акке
    HEADLESS: typeof acc.headless === 'boolean'
      ? String(acc.headless)
      : (process.env.HEADLESS || 'true'),
  };

  // системный Chrome — через CHROME_PATH, иначе Puppeteer возьмёт bundled Chromium
  if (acc.useSystemChrome && acc.chromePath) {
    env.CHROME_PATH = acc.chromePath;
  } else if (process.env.CHROME_PATH) {
    env.CHROME_PATH = process.env.CHROME_PATH;
  }

  const child = spawn(process.execPath, [botDst], {
    cwd: runDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  attachLogs(child, acc.id);

  child.on('exit', async (code, signal) => {
    console.log(`${COLOR.gray}[${acc.id}] exited with code ${code}${signal ? ` (signal ${signal})` : ''}. Restarting in ${RESTART_DELAY_MS/1000}s…${COLOR.reset}`);
    await sleep(RESTART_DELAY_MS);
    launchAccount(acc).catch(e => {
      console.error(`[${acc.id}] ❌ restart failed:`, e?.stack || e?.message || e);
    });
  });
}

// ===== main =====
(async () => {
  // 0) базовые проверки
  if (!(await fileExists(BOT_SRC))) {
    console.error(`❌ Не найден bot.cjs по пути: ${BOT_SRC}`);
    process.exit(1);
  }
  if (!(await fileExists(ACCOUNTS_FILE))) {
    console.error(`❌ Не найден ${ACCOUNTS_FILE}. Сначала выполните init-sessions.cjs`);
    process.exit(1);
  }

  const raw = await fsp.readFile(ACCOUNTS_FILE, 'utf8');
  /** ожидаемый формат:
   * [
   *   {
   *     "id": "acc1",
   *     "cookiesFile": "./cookies_acc1.json",
   *     "useSystemChrome": true,
   *     "chromePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
   *     "proxy": { "serverArg": "http://host:port", "auth": {"username":"u","password":"p"} },
   *     "headless": false,                 // опционально
   *     "acceptLanguage": "en-US,en;q=0.9",
   *     "timezone": "Europe/Berlin"
   *   }
   * ]
   */
  let accounts;
  try {
    accounts = JSON.parse(raw);
  } catch (e) {
    console.error(`❌ Ошибка парсинга ${ACCOUNTS_FILE}:`, e.message);
    process.exit(1);
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    console.error(`❌ ${ACCOUNTS_FILE} пуст или не массив.`);
    process.exit(1);
  }

  await ensureDir(RUNS_DIR);

  // Запускаем по одному процессу на аккаунт
  for (const acc of accounts) {
    if (!acc || !acc.id) {
      console.warn('⚠️ Пропускаю запись без "id" в accounts.json:', acc);
      continue;
    }
    console.log(`\n—> Starting ${acc.id} (headless=${typeof acc.headless === 'boolean' ? acc.headless : (process.env.HEADLESS || 'true')})`);
    launchAccount(acc).catch(e => {
      console.error(`[${acc.id}] ❌ launch failed:`, e?.stack || e?.message || e);
    });
    // небольшая задержка, чтобы не открывать все браузеры в одну миллисекунду
    await sleep(500);
  }
})();

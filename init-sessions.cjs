// init-sessions.cjs
// Создаёт N профилей, выдаёт им прокси и ждёт авторизацию,
// затем сохраняет accounts.json для start-many.cjs

const fs = require('fs');
const path = require('path');
const { mkdirSync, existsSync, writeFileSync, readFileSync } = fs;
const puppeteer = require('puppeteer-extra');
const Stealth = require('puppeteer-extra-plugin-stealth');
puppeteer.use(Stealth());

const ARGS = require('minimist')(process.argv.slice(2), {
  string: ['count','baseDir','proxies','lang','tz'],
  boolean: ['sequential','noProxyAuth','headless'],
  default: {
    count: '3',
    baseDir: './profiles',
    proxies: './proxies.txt',   // по одному на строку: schema://user:pass@host:port или host:port
    sequential: true,
    noProxyAuth: false,
    headless: false,
    lang: 'en-US,en;q=0.9',
    tz: 'Europe/Berlin',
  }
});

const COUNT = Math.max(1, parseInt(ARGS.count,10) || 1);
const BASE  = path.resolve(ARGS.baseDir);
const PROX_FILE = path.resolve(ARGS.proxies);

function readProxies(){
  if (!existsSync(PROX_FILE)) return [];
  return readFileSync(PROX_FILE,'utf8')
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function normProxy(p){
  if (!p) return null;
  let s = String(p).trim();
  if (!/^[a-z]+:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    const scheme = u.protocol.replace(':','').toLowerCase();
    const serverArg = `${scheme}://${u.hostname}:${u.port}`;
    const auth = (u.username || u.password) ? {
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password)
    } : null;
    return { serverArg, auth, raw:s };
  } catch { return null; }
}

async function openOne(index, proxy){
  const id = `acc${(index+1)}`; // acc1, acc2, ...
  const userDataDir = path.join(BASE, id);
  mkdirSync(userDataDir, { recursive:true });

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1200,800',
    '--disable-blink-features=AutomationControlled',
  ];
  if (proxy) args.push(`--proxy-server=${proxy.serverArg}`);

  const browser = await puppeteer.launch({
    headless: ARGS.headless ? 'new' : false,
    userDataDir,
    args
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': ARGS.lang });
  try { await page.emulateTimezone(ARGS.tz); } catch {}

  if (proxy?.auth && !ARGS.noProxyAuth) {
    try { await page.authenticate(proxy.auth); } catch {}
  }

  console.log(`\n[${id}] Profile: ${userDataDir}`);
  console.log(`[${id}] Proxy:   ${proxy ? proxy.raw : '(none)'}`);
  console.log(`[${id}] ➜ Окно готово. Авторизуйтесь в https://www.geturanium.io (и связанных OAuth),`);
  console.log(`[${id}]    дождитесь, пока сайт загрузится без /auth. Окно можно оставить открытым.`);

  // идём на сайт
  await page.goto('https://www.geturanium.io/', { waitUntil:'domcontentloaded', timeout: 120000 })
    .catch(()=>{});

  // ждём, пока мы НЕ на странице авторизации (или Enter в консоли)
  let resolved = false;
  const done = new Promise(async res => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', line => {
      if (!resolved && line.trim().toLowerCase() === `${id} ok`) { resolved = true; rl.close(); res('manual'); }
    });
    // авто-детект: когда уйдём с /auth и появится главная
    while (!resolved) {
      try {
        const ok = await page.evaluate(() => !location.pathname.startsWith('/auth'));
        if (ok) { resolved = true; rl.close(); res('auto'); break; }
      } catch {}
      await new Promise(r=>setTimeout(r,1500));
    }
  });

  console.log(`[${id}] Подтвердите готовность, введя в терминале: ${id} ok`);

  await done;

  // финальный пинг и сохранение
  let cookies = [];
  try { cookies = await page.cookies(); } catch {}
  const ckPath = path.resolve(`cookies_${id}.json`);
  writeFileSync(ckPath, JSON.stringify(cookies,null,2), 'utf8');
  console.log(`[${id}] ✅ Cookies saved -> ${ckPath}`);

  // НЕ закрываем браузер: можно лишний раз убедиться, но если хотите — раскомментируйте:
  // await browser.close();

  return { id, userDataDir, proxy: proxy?.raw || '' };
}

(async () => {
  mkdirSync(BASE, { recursive:true });
  const proxies = readProxies();
  if (proxies.length && proxies.length < COUNT) {
    console.log(`⚠️ proxies.txt содержит всего ${proxies.length}, а count=${COUNT}. Остальные будут без прокси.`);
  }

  const results = [];
  if (ARGS.sequential) {
    for (let i=0;i<COUNT;i++){
      const p = normProxy(proxies[i]);
      results.push(await openOne(i, p));
    }
  } else {
    const jobs = Array.from({length:COUNT}, (_,i) => openOne(i, normProxy(proxies[i])));
    results.push(...await Promise.all(jobs));
  }

  const accountsPath = path.resolve('accounts.json');
  writeFileSync(accountsPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n📄 accounts.json создан:\n${accountsPath}`);
  console.log(`\nДальше запустите:  node start-many.cjs`);
})();

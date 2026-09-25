// Etusivun esimerkkikuvat (ilme 25.9.2026): kaupungin oman keskuspysäkin juliste ja yhden linjan vihon
// karttasivu, tehtynä tuotannosta samalla klikkaussarjalla kuin tests/prod-smoke.test.js käyttää.
// Etusivu näyttää ne kuvina, jotta sivun avaus ei kuluta rajapinnan kiintiötä.
// Pysäkki = palvelutiskin oletuspysäkki (deskFindDefaultStop), linja = linjalistan ensimmäinen.
//
// Ajo:  node tools/hero-kuvat.js [kaupunki[:linja][@pysäkki] ...]      -> tools/.hero-pdf/<kaupunki>-{juliste,vihko}.pdf + luettelo
//       python tools/hero-kuvat.py                   -> img/hero/<kaupunki>-{juliste,vihko}.webp + img/hero/index.json
// Uusi ajo kausivaihdon jälkeen: kuvat ovat esimerkkejä, eivät väitä olevansa tämän päivän aikataulu.
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', 'tests', 'node_modules', 'puppeteer'));
const BASE = process.env.BASE || 'https://demo.reittari.fi';
const OUT = path.join(__dirname, '.hero-pdf');
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const GAP_MS = +(process.env.HERO_GAP_MS || 20000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cities() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = src.indexOf('const CONFIGS');
  return [...src.slice(start, src.indexOf('\n};', start)).matchAll(/^  ([a-z]+): \{$/gm)].map(m => m[1]);
}

async function one(browser, city, lineOverride, stopOverride) {
  const url = hash => `${BASE}/index.html?city=${city}${hash}`;
  const p = await browser.newPage();
  await p.setViewport({ width: 1400, height: 1000 });
  await p.goto(url('#/'), { waitUntil: 'networkidle2', timeout: 90000 });
  await p.waitForSelector('#routeList li', { timeout: 60000 });
  const pick = await p.evaluate(async () => {
    const s = await deskFindDefaultStop();
    const r = (await loadRoutes())[0];
    return { stop: s?.gtfsId, stopName: s?.name, line: r?.shortName, lineName: r?.longName };
  });
  if (lineOverride) { pick.line = lineOverride; pick.lineName = null; }
  if (stopOverride) Object.assign(pick, await p.evaluate(async id => {
    const d = await gql(DESK_DEPS_QUERY, { id });
    return { stop: id, stopName: d.stop?.name || id };
  }, stopOverride));
  if (!pick.stop || !pick.line) throw new Error('pysäkki tai linja puuttuu: ' + JSON.stringify(pick));

  // Juliste
  await p.goto(url('#/pysakki/' + encodeURIComponent(pick.stop)), { waitUntil: 'networkidle2', timeout: 90000 });
  await p.waitForSelector('#stopPosterBtn', { timeout: 30000 });
  await p.evaluate(() => { window.print = () => {}; });
  await sleep(600);
  await p.click('#stopPosterBtn');
  await p.waitForFunction(() => !!document.querySelector('#stopPrintOut .poster-day tr'), { timeout: 150000 });
  await sleep(900);
  await p.pdf({ path: path.join(OUT, city + '-juliste.pdf'), preferCSSPageSize: true, printBackground: true });

  // Vihko, yksi linja, A5
  await p.goto(url('#/tulosteet/vihko'), { waitUntil: 'networkidle2', timeout: 90000 });
  await p.waitForSelector('.lineCb', { timeout: 60000 });
  const ok = await p.evaluate(no => {
    const hit = [...document.querySelectorAll('.lineCb')]
      .find(cb => (cb.closest('li,label')?.textContent || '').trim().split(/\s+/)[0] === no);
    if (!hit) return false;
    hit.checked = true; hit.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, pick.line);
  if (!ok) throw new Error('linjaa ' + pick.line + ' ei löytynyt vihkovalinnasta');
  await p.evaluate(() => { window.print = () => {}; });
  await p.$eval('#buildBtn', el => el.click());
  await p.waitForSelector('#bookletOut .booklet-line .print-map', { timeout: 150000 });
  await sleep(600);
  await p.evaluate(() => document.getElementById('bookletPrintA5')?.click());
  await p.waitForSelector('#vihkoPrint .vihko-page-content', { timeout: 60000 });
  await sleep(900);
  await p.pdf({ path: path.join(OUT, city + '-vihko.pdf'), preferCSSPageSize: true, printBackground: true });
  await p.close();
  return { city, ...pick, date: new Date().toISOString().slice(0, 10) };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const want = process.argv.slice(2);
  const list = want.length ? want : cities();
  const manifestPath = path.join(OUT, 'valinnat.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  try {
    for (const [i, arg] of list.entries()) {
      // kaupunki[:linja][@pysäkki], esim. raasepori:201 (ensimmäinen linja voi olla harva) tai
      // mikkeli@Mikkeli:410318 (oletuspysäkki voi olla päätepysäkki, jonka julisteesta saapuvat karsitaan)
      const [head, stopId] = arg.split('@');
      const [city, line] = head.split(':');
      if (i) await sleep(GAP_MS);
      try {
        manifest[city] = await one(browser, city, line, stopId);
        console.log('OK  ', city, JSON.stringify(manifest[city]));
      } catch (e) { console.log('FAIL', city, e.message); }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
    }
  } finally { await browser.close(); }
})();

// Mittausalusta oikealla datalla (26.11.2026). Auto-kehitysagentti ja ihminen mittaavat tällä muutoksen tuloksen
// oikeaa feediä ja oikeaa tulostetta vasten, ei pelkkää kiinteää testiaineistoa. Syy: PR #184:n sivumääräarvio oli
// vilkkailla pysäkeillä 2-3-kertainen, vaikka smoke oli vihreä, koska testi ajoi agentin omaa aineistoa sen omilla
// säännöillä. Mitattu PDF:nä: Ankkurikatu E arvio 3, oikeasti 1 arkki; Kansanopisto E arvio 11, oikeasti 5 arkkia.
//
// Käyttö (repon juuresta):  node tests/mittaa.cjs /tmp/mittaus.cjs
// Mittaustiedosto vie yhden async-funktion, joka saa apuvälineet ja palauttaa tuloksen (tulostetaan JSONina):
//   module.exports = async ({ page, browser, BASE, tulostaPdf, pdfTiedot }) => {
//     const iso = await tulostaPdf(BASE + "/?city=lahti#/pysakki/Lahti:103614?print=poster&size=A2");
//     return { sivuja: iso.sivuja, leveysMm: iso.leveysMm };
//   };
// Palvelin ja selain käynnistyvät tässä prosessissa ja sammuvat lopuksi, joten taustaprosessia ei tarvita.
// Osoite on http://localhost:8000, koska proxyn ALLOWED_ORIGINS sallii vain sen (sama kuin smoke.test.js).
// Koko ajon aikaraja 10 min. Chrome: PUPPETEER_EXECUTABLE_PATH tai puppeteerin oma.
// Itsetesti ilman verkkoa: node tests/mittaa.cjs --itsetesti

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const PORT = +(process.env.MITTAA_PORT || 8000);
const BASE = "http://localhost:" + PORT;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
  ".csv": "text/csv; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".xml": "application/xml",
};

// PDF:n sivumäärä ja ensimmäisen sivun koko. Chromen PDF pakkaa objektit virtoihin, joten virrat puretaan ensin.
// Sivumäärä = suurin /Count (juuren Pages-objekti sisältää kaikki sivut).
function pdfTiedot(data) {
  // page.pdf() palauttaa puppeteer 23:ssa Uint8Arrayn: sen toString ei tunne koodausta, joten muunnos Bufferiksi ensin.
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const raaka = buf.toString("latin1");
  let teksti = raaka;
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raaka))) {
    const alku = m.index + m[0].length;
    const loppu = raaka.indexOf("endstream", alku);
    if (loppu < 0) break;
    try { teksti += "\n" + zlib.inflateSync(buf.subarray(alku, loppu)).toString("latin1"); } catch (e) { /* ei zlib-virta */ }
    re.lastIndex = loppu;
  }
  const countit = [...teksti.matchAll(/\/Count\s+(\d+)/g)].map(x => +x[1]);
  const mb = teksti.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  const mm = pt => Math.round(pt / 72 * 25.4);
  return { sivuja: countit.length ? Math.max(...countit) : 0, leveysMm: mb ? mm(+mb[1]) : null, korkeusMm: mb ? mm(+mb[2]) : null };
}

function palvelin() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, BASE).pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = path.normalize(path.join(ROOT, p));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end("404"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((ok, virhe) => { srv.once("error", virhe); srv.listen(PORT, "127.0.0.1", () => ok(srv)); });
}

async function itsetesti() {
  // Pieni käsin tehty PDF, jossa pakattu objektivirta: /Count 3 ja A4-MediaBox virran sisällä.
  const sisalto = Buffer.from("<< /Type /Pages /Count 3 /Kids [] >>\n<< /Type /Page /MediaBox [0 0 595.28 841.89] >>", "latin1");
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n1 0 obj\n<< /Length 9 /Filter /FlateDecode >>\nstream\n", "latin1"),
    zlib.deflateSync(sisalto), Buffer.from("\nendstream\nendobj\n%%EOF", "latin1")]);
  const t = pdfTiedot(pdf);
  const u = pdfTiedot(new Uint8Array(pdf));   // sama Uint8Arrayna, kuten page.pdf() sen antaa
  const ok = t.sivuja === 3 && t.leveysMm === 210 && t.korkeusMm === 297 && JSON.stringify(u) === JSON.stringify(t);
  console.log((ok ? "OK" : "FAIL") + " mittaa.cjs itsetesti: " + JSON.stringify(t));
  process.exit(ok ? 0 : 1);
}

async function main() {
  const arg = process.argv[2];
  if (arg === "--itsetesti") return itsetesti();
  if (!arg) { console.error("Käyttö: node tests/mittaa.cjs <mittaustiedosto.cjs> | --itsetesti"); process.exit(2); }
  const mittaus = require(path.resolve(arg));
  if (typeof mittaus !== "function") { console.error("Mittaustiedoston pitää viedä async-funktio (module.exports = async (apu) => ...)."); process.exit(2); }
  const puppeteer = require("puppeteer");
  const srv = await palvelin();
  const browser = await puppeteer.launch({ headless: "new", executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });   // samat liput kuin smoke.test.js:ssä (CI:n Linux)
  const ajastin = setTimeout(() => { console.error("FAIL mittaus: aikaraja 10 min ylittyi"); process.exit(1); }, 10 * 60 * 1000);
  const virheet = [];
  const page = await browser.newPage();
  page.on("pageerror", e => virheet.push(String(e)));
  await page.setViewport({ width: 1280, height: 900 });
  // Tulostaa sivun PDF:ksi sellaisena kuin käyttäjä sen saa: window.print kaapataan, odotetaan että sovellus kutsuu sitä
  // (enintään 90 s), ja PDF tehdään print-medialla sivun omalla @page-koolla.
  const tulostaPdf = async (url, { odotaTulostusta = true, odotus = 1500 } = {}) => {
    const p = await browser.newPage();
    p.on("pageerror", e => virheet.push(String(e)));
    await p.setViewport({ width: 1280, height: 900 });
    await p.evaluateOnNewDocument(() => { window.__tulostettu = false; window.print = () => { window.__tulostettu = true; }; });
    await p.goto(url, { waitUntil: "networkidle2", timeout: 90000 });
    const tulostettu = odotaTulostusta
      ? await p.waitForFunction(() => window.__tulostettu, { timeout: 90000 }).then(() => true, () => false) : null;
    await new Promise(r => setTimeout(r, odotus));
    await p.emulateMediaType("print");
    const buf = await p.pdf({ preferCSSPageSize: true, printBackground: true, timeout: 120000 });
    await p.close();
    return { url, tulostettu, ...pdfTiedot(buf) };
  };
  try {
    const tulos = await mittaus({ page, browser, BASE, tulostaPdf, pdfTiedot });
    console.log("MITTAUS " + JSON.stringify(tulos, null, 2));
    console.log("sivuvirheet: " + virheet.length + (virheet.length ? " " + virheet.slice(0, 3).join(" | ") : ""));
  } finally {
    clearTimeout(ajastin);
    await browser.close();
    srv.close();
  }
}

main().catch(e => { console.error("FAIL mittaus: " + (e && e.stack || e)); process.exit(1); });

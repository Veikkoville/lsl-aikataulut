// Tuotanto-smoke-vahti: read-only invariantit tuotantoa (demo.reittari.fi) vasten,
// kaikki CONFIG-kaupungit. Ei tilamuutoksia tuotantoon: vain sivulatauksia ja DOM-lukua,
// window.print stubataan ennen tulostenappeja. Suojaa erityisesti 10.8.2026 talvifeed-
// vaihtoa: printtimoottorien (päivätyyppiblokit, pysäkkijuliste, yhdistetyt suunnat)
// pitää tuottaa oikeaa rakennetta myös feedin vaihduttua.
//
// Ajo:  cd tests && npm install && node prod-smoke.test.js
//       BASE-ympäristömuuttujalla voi osoittaa muualle (oletus https://demo.reittari.fi).
// Exit: 0 = kaikki vihreä, 1 = vähintään yksi FAIL.
// Kirjoittaa prod-smoke-report.txt + prod-smoke-report.json (Actions arkistoi artefaktiksi).

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE || "https://demo.reittari.fi";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Digitransit-kiintiö (todennettu 8.-10.8.2026). Kaupunkisweep 7.8. nosti ajon 9 -> 16
// kaupunkiin samalla API-avaimella, ja peräkkäisajo alkoi saada 429 (rate limit) kesken
// kierroksen. Kaatuvat kaupungit vaihtelivat ajon ajoituksen mukaan (9.8. mm. Kouvola,
// Mikkeli ja Raasepori) — oire ei siis ollut kaupungissa vaan kuormassa.
// Kaksi vastalääkettä, kumpikaan EI löysennä vartijaa (ks. CITY_GAP_MS ja jonon uusinta
// alempana): tauko kaupunkien välissä tasoittaa kuorman, ja 429:n pilaama kierros
// ajetaan uudelleen. Jos kiintiö ei palaudu uusinnankaan jälkeen, ajo FAILaa
// juurisyyllä — 429 ei koskaan muutu PASSiksi eikä INFOksi.
// Mitoitus (10.8.2026, toinen kierros): 4 s tauko EI riittanyt GitHub Actionsissa.
// Mekaniikka toimi - uusinta laukesi ja kattavuus sailyi 16/16 - mutta nelja kaupunkia
// (Kouvola, Mikkeli, Hameenlinna, Joensuu) ei saanut kiintiota takaisin uusinnallakaan.
// Sama koodi meni lapi lokaalisti 0 FAILia, joten ero on ymparistossa eika koodissa:
// runnerin IP:sta 16 kaupungin ajo on liian tihea. Siksi tauko on nyt 20 s ja uusinnalle
// oma jaahdytys. Ajo kestaa noin 30 min, mika on hyvaksyttavaa yoajolle.
const CITY_GAP_MS = +(process.env.SMOKE_CITY_GAP_MS || 20000);
const MAX_ATTEMPTS = +(process.env.SMOKE_ATTEMPTS || 2);
// Uusittu kaupunki ei ala heti vuorollaan: kiintioampari tarvitsee oman palautumisaikansa
// sen lisaksi mita jonon lapikaynti ehtii antaa.
const RETRY_COOLDOWN_MS = +(process.env.SMOKE_RETRY_COOLDOWN_MS || 90000);

// Eraajo (10.8.2026, kolmas kierros). Pelkka tauon kasvattaminen ei riittanyt:
// 4 s -> 23 FAILia, 20 s -> 8 FAILia, ja kaatuvat kaupungit vaihtuivat joka ajolla
// listan loppupaassa. Se kertoo etta kiintio kuluu KUMULATIIVISESTI ajon edetessa,
// eika 16 kaupunkia mahdu yhden avaimen budjettiin yhdella istumalla. Tauon nosto
// 45 sekuntiin veisi ajon yli 40 minuutin, mika on vaara suunta halvalle vahdille.
// Siksi ajo jaetaan kahteen eraan jotka ajetaan perakkain omina jobeinaan, ja
// jalkimmainen alkaa vasta tauon jalkeen. Kumpikin era on 8 kaupunkia = puolet
// kuormasta, ja erien valissa kiintio ehtii palautua.
//   SMOKE_CITIES        pilkkuerotettu lista (tyhja = kaikki). Kaytannollinen myos
//                       kohdennettuun ajoon: SMOKE_CITIES=lahti node prod-smoke.test.js
//   SMOKE_START_DELAY_MS viive ennen eran ensimmaista kaupunkia
const CITY_FILTER = (process.env.SMOKE_CITIES || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const START_DELAY_MS = +(process.env.SMOKE_START_DELAY_MS || 0);

// Erätulostuksen kutsukatto. Workerin purskeraja on 1200/min/IP (worker.js RATE_MAX),
// mutta katto asetetaan PALJON alemmas, jotta myös niputuksen hiljainen rikkoutuminen
// näkyy eikä vain rajan osuminen. Mitatut arvot linjalle Lahti 4 (76 pysäkkiä, 14.8.2026):
//   niputtamaton 304 · vain stops(ids:) niputettu 227 · molemmat niputettu 50.
// 200 jää selvästi mitatun 50:n yläpuolelle (linjaston kasvu ei hälytä turhaan) mutta
// alle kummankin rikkoutumistilan. Jos tämä ylittyy, älä nosta kattoa vaan selvitä
// miksi niputus ei enää pidä.
const BATCH_CALL_CEILING = +(process.env.SMOKE_BATCH_CEILING || 200);
const BATCH_CITIES = (process.env.SMOKE_BATCH_CITIES === undefined
  ? null                                   // oletus: CITIES-taulun batchPosterLine päättää
  : process.env.SMOKE_BATCH_CITIES.split(",").map(s => s.trim()).filter(Boolean));

// Tiskiltä tulostus (kohta 6a2) rakentaa koko pysäkin julisteen proxyn läpi, eli se on
// erätulostuksen jälkeen ajon raskain yksittäinen toimenpide. Siksi sitä ei ajeta 16
// kertaa saman avaimen budjetista vaan niille kaupungeille joiden MYYNTIESITE väittää
// ominaisuuden olevan olemassa ("aikataulu tulostuu samasta näkymästä telineen kokoon"):
// lahti, vaasa, raasepori. Väite ja tuote eivät saa erota — sama peruste kuin
// paikallisen smoken tiskivartijalla. Koodi itsessään on kaupunkiriippumaton.
// Ylikirjoitettavissa: SMOKE_DESK_PRINT_CITIES=kotka,salo (tyhjä = pois käytöstä).
const DESK_PRINT_CITIES = (process.env.SMOKE_DESK_PRINT_CITIES === undefined
  ? null                                   // oletus: CITIES-taulun deskPrint päättää
  : process.env.SMOKE_DESK_PRINT_CITIES.split(",").map(s => s.trim()).filter(Boolean));

// gen = FI-otsikon genetiivi ("<gen> bussiaikataulut") — Lahti-fallbackia ei hyväksytä.
// svTitle = kaksikielisen kaupungin SV-otsikko (FI-fallbackia ei hyväksytä).
// nightStopId/nightLines = Lahden yövuorotarkistus (Matkakeskus A, todennettu datasta
// 9.7.2026). FAIL-taso ei sido linjanumeroita: feedivaihto saa muuttaa yölinjoja ilman
// väärää hälytystä, linjanumerot raportoidaan vain INFO-rivinä.
// posterStopId = julistetarkistuksen pysäkki silloin kun reittihaun automaattinen
// lähtöpysäkki EI kelpaa: osa feedeistä nimeää aseman solmun pysäkiksi jolla ei ole
// yhtään lähtöä (esim. Kouvola:302794 "Kouvola Matkakeskus linja-autoasema" 0 lähtöä,
// lähdöt ovat laiturilla Kouvola:155786). Ilman tätä vahti hälyttäisi joka viikko
// pysäkistä joka on tyhjä syystä. Todennettu datasta 2.8.2026.
// corridorDirs = montako suuntaa käytävätulosteessa vähintään odotetaan (oletus 2).
// Mikkelin paikallislinjat ovat silmukkalinjoja (lähtevät Hallitustorilta ja palaavat
// sinne) → yhteinen jakso on yksi suunta, ei kaksi. Tämä on kaupungin verkon oikea
// muoto, ei virhetilan fallback: rivi-, linja- ja aikajärjestysehdot pätevät ennallaan.
// Kaikille pinnatuille tunnuksille (nightStopId/posterStopId) ajetaan lisäksi
// kausivaihtovahti (kohta 4b): tunnuksen on löydyttävä feedistä JA sillä on oltava
// lähtöjä seuraavana arkipäivänä. Poistuva pysäkki EI katoa feedistä vaan jää
// 0-lähtöiseksi objektiksi (todennettu 10.8.2026: Lahden Tevi P/E 215/213 → 0 lähtöä,
// gtfsId:t jäivät feediin) → olemassaolotarkistus yksin päästäisi rikon läpi.
// batchPosterLine = pysäkkijulisteiden ERÄTULOSTUS ajetaan tälle linjalle oikean proxyn
// läpi. Tämä on 13.8.2026 tuotantovian sulkeva tarkistus: workerin purskeraja (RATE_MAX
// 300) katkaisi linjan 4 julisteajon 304. kutsuun, ja vika pääsi läpi koska paikallinen
// smoke ajaa localhost-originia vasten eikä workeria ole silloin lainkaan matkassa.
// Vain YHDELLE kaupungille (Lahti, erä 1 = kevein kiintiötilanne): erätulostus on ajon
// raskain yksittäinen toimenpide, eikä sitä pidä ajaa 16 kertaa saman avaimen budjetista.
// Ylikirjoitettavissa: SMOKE_BATCH_CITIES=vaasa,lahti (tyhjä = pois käytöstä).
let CITIES = [ // let eika const: SMOKE_CITIES suodattaa taman eraajossa
  { key: "lahti",   gen: "Lahden",   nightStopId: "Lahti:85811", nightLines: ["91", "96", "97"],
    batchPosterLine: "4", deskPrint: true },
  { key: "kuopio",  gen: "Kuopion" },
  { key: "salo",    gen: "Salon" },
  { key: "kajaani", gen: "Kajaanin" },
  { key: "vaasa",   gen: "Vaasan",   svTitle: "Busstidtabeller i Vasa", deskPrint: true },
  { key: "kotka",   gen: "Kotkan" },
  { key: "raasepori", gen: "Raaseporin", svTitle: "Busstidtabeller i Raseborg", deskPrint: true },
  { key: "kouvola", gen: "Kouvolan", posterStopId: "Kouvola:155786" },
  { key: "mikkeli", gen: "Mikkelin", posterStopId: "Mikkeli:310514", corridorDirs: 1 },
  // Kaupunkisweep 7.8.2026: presetit datavarmistettu kesä- JA talvikoetuksella.
  // Rovaniemen 4+5-käytävän yhteinen jakso on yksisuuntainen (linjat kiertävät
  // keskustan eri reittejä) → corridorDirs 1, sama verkon muoto kuin Mikkelissä.
  { key: "hameenlinna", gen: "Hämeenlinnan" },
  { key: "joensuu", gen: "Joensuun" },
  { key: "jyvaskyla", gen: "Jyväskylän" },
  { key: "lappeenranta", gen: "Lappeenrannan" },
  { key: "oulu", gen: "Oulun" },
  { key: "pori", gen: "Porin" },
  { key: "rovaniemi", gen: "Rovaniemen", corridorDirs: 1 },
  // Turku/Föli 29.8.2026: suurin kaupunki (141 linjaa, 26-laiturinen Kauppatori). Erä 2.
  // Presetit talvidatalla; kesäkoetus puuttuu (feed 14.8.-21.11.), kausivalidointi vahtii.
  { key: "turku", gen: "Turun", svTitle: "Busstidtabeller i Åbo" },
  // Inkoo 29.8.2026: ensimmäinen ei-Waltti-kunta (MATKA-feed, finland-router, aluerajattu
  // linjajoukko). Ei käytäväpresettejä: linjat ovat kaukoliikennettä, joten käytävätaulukko
  // kattaisi koko linjan (192+192M = 183 yhteistä pysäkkiä) eikä mahtuisi tulosteeseen.
  { key: "inkoo", gen: "Inkoon", svTitle: "Busstidtabeller i Ingå", noCorridors: true },
];

// Erarajaus. Tuntematon kaupunkiavain on kirjoitusvirhe eika tyhja era: se kaadetaan
// heti, muuten era ajaisi vaarin ja raportoisi silti "kattavuus OK".
if (CITY_FILTER.length) {
  const tuntematon = CITY_FILTER.filter(k => !CITIES.some(c => c.key === k));
  if (tuntematon.length) {
    console.error("VIRHE: SMOKE_CITIES sisaltaa tuntemattomia avaimia: " + tuntematon.join(", "));
    process.exit(2);
  }
  CITIES = CITIES.filter(c => CITY_FILTER.includes(c.key));
}

const results = [];
const record = (city, check, status, detail = "") => {
  results.push({ city, check, status, detail });
  console.log(status.padEnd(5) + "[" + city + "] " + check + (detail ? " — " + detail : ""));
};
const pass = (c, k, d) => record(c, k, "PASS", d);
const fail = (c, k, d) => record(c, k, "FAIL", d);
const info = (c, k, d) => record(c, k, "INFO", d);

// --- Asetteluvartija (lisätty 25.8.2026) ------------------------------------------
// Kolme printtivikaa pääsi asiakkaalle asti, koska mikään tarkistus ei katsonut miltä
// taulukko NÄYTTÄÄ paperin levyisenä: julisteen minuutit eivät olleet allekkain,
// A5-vihon sarakkeet leikkautuivat, ja käytävätulosteen määränpääsarake oli niin kapea
// että joka toinen rivi oli kaksinkertaisen korkuinen. Yksikään ei näkynyt sisältöä
// laskevissa tarkistuksissa eikä ruudun leveydellä: viat syntyvät vasta kun sivu on
// paperin levyinen ja teksti alkaa rivittyä.
//
// Siksi tämä vartija tekee kaksi asiaa joita muut eivät tee:
//   1. asettaa ikkunan leveyden TULOSTUSALUEEN levyiseksi (@page-koko - marginaalit)
//   2. mittaa print-medialla kolme asiaa jotka kaikki lukevat paperilla vinona:
//      sarakkeen vasen reuna eri kohdassa eri riveillä · tbody-rivit eri korkuisia ·
//      taulukko vuotaa sivun oikean reunan yli.
// Ikkunan koko palautetaan jokaisen mittauksen jälkeen, jotta muut tarkistukset
// näkevät saman näkymän kuin ennenkin.
const PRINT_MM = { portrait: 210 - 24, rack: 210 - 16, landscape: 297 - 16, compact: 210 - 14 };
const mmPx = mm => Math.round(mm * 96 / 25.4);
async function asetteluTarkistus(page, cityKey, tuote, rootSel, tyyppi) {
  const vp = page.viewport();
  await page.setViewport({ width: mmPx(PRINT_MM[tyyppi]), height: (vp && vp.height) || 1600 });
  await page.emulateMediaType("print");
  const r = await page.evaluate(sel => {
    const root = document.querySelector(sel);
    if (!root) return { puuttuu: true };
    const lim = document.body.getBoundingClientRect().right;
    const viat = [];
    let n = 0;
    // Palstoitettu taulukko jatetaan linjaus- ja korkeustarkistuksen ulkopuolelle.
    // Lehtitelinetuloste latoo Ma-Pe-taulun TAHALLAAN kahteen palstaan (.rack-days
    // columns:2, otsikkorivi toistuu fragmentissa). Fragmentoituneen taulukon
    // getBoundingClientRect palauttaa palstojen YHTEISEN laatikon, jolloin oikean
    // palstan solut nayttavat olevan eri kohdassa kuin vasemman ja yksi rivi nayttaa
    // satojen pikselien korkuiselta. Todennettu silmalla 25.8.2026: tuloste on ehja.
    const palstoitettu = el => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const cc = getComputedStyle(n).columnCount;
        if (cc && cc !== "auto" && +cc > 1) return true;
      }
      return false;
    };
    root.querySelectorAll("table").forEach(t => {
      const body = t.tBodies && t.tBodies[0];
      if (!body || !body.rows.length) return;
      n++;
      const frag = palstoitettu(t);
      const rows = [...body.rows].slice(0, 60);
      const lefts = rows.map(r2 => [...r2.cells].map(c => Math.round(c.getBoundingClientRect().left)));
      const cols = Math.max(...lefts.map(a => a.length));
      for (let i = 0; i < cols; i++) {
        const v = [...new Set(lefts.map(a => a[i]).filter(x => x != null))];
        if (!frag && v.length > 1 && viat.length < 4) viat.push(`sarake ${i} eri linjassa riveittäin (${v.slice(0, 4).join("/")})`);
      }
      const hs = [...new Set(rows.map(r2 => Math.round(r2.getBoundingClientRect().height)))];
      if (!frag && hs.length > 1 && viat.length < 4) viat.push(`rivikorkeudet ${JSON.stringify(hs.slice(0, 4))} — teksti rivittyy osalla riveistä`);
      const yli = Math.round(t.getBoundingClientRect().right - lim);
      if (yli > 1 && viat.length < 4) viat.push(`taulukko vuotaa sivun yli ${yli} px`);
    });
    return { n, viat };
  }, rootSel);
  await page.emulateMediaType("screen");
  if (vp) await page.setViewport(vp);
  if (r.puuttuu || !r.n) { info(cityKey, `asettelu: ${tuote}`, "ei taulukoita mitattavaksi"); return; }
  r.viat.length
    ? fail(cityKey, `asettelu: ${tuote}`, r.viat.join(" · "))
    : pass(cityKey, `asettelu: ${tuote}`, `${r.n} taulukkoa, sarakkeet linjassa, rivikorkeus tasainen, ei ylivuotoa`);
}

// Reittihaun hakuaika: seuraava arkipäivä klo 09.00 Suomen aikaa. Kiinnitetty aika
// (jaetun linkin t=-parametri) tekee haun deterministiseksi: viikonloppu- ja yöajot
// eivät hälytä harvan liikenteen kaupungeista väärin. Selaimen aikavyöhyke
// emuloidaan Helsinkiin, joten t tulkitaan samassa vyöhykkeessä.
function searchTimeHelsinki() {
  const helNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Helsinki" }));
  const d = new Date(helNow);
  d.setHours(9, 0, 0, 0);
  if (d <= helNow) d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`;
}

// "HH:MM–HH:MM" -listasta lähtöajat minuutteina; vuorokausiraja sallitaan
// (seuraava aika saa hypätä taaksepäin enintään 12 h = tulkitaan seuraavaksi päiväksi).
function departuresMonotonic(times) {
  let prev = -1;
  for (const t of times) {
    const m = /^(\d{1,2}):(\d{2})/.exec(t);
    if (!m) return { ok: false, why: "aikaa ei voitu jäsentää: " + t };
    let v = (+m[1]) * 60 + (+m[2]);
    if (prev >= 0 && v < prev - 720) v += 1440;
    if (v < prev) return { ok: false, why: "epäjärjestys: " + times.join(", ") };
    prev = v;
  }
  return { ok: true };
}

const searchTime = searchTimeHelsinki();

// Kaupungit jotka saivat lopulliset tulokset (uusintaan palanneet eivät lasketa vielä).
const cityDone = new Set();
// Kaupungit jotka tarvitsivat vähintään yhden uusinnan 429:n takia. Vihreä ajo EI saa
// piilottaa tätä: 13.8.2026 erä 2 päättyi "KAIKKI TARKISTUKSET OK" vaikka Pori ja
// Rovaniemi olivat kaatuneet kiintiöön ja menneet läpi vasta jäähdytyksen jälkeen.
// Uusinta on kiintiön ryömimisen mittari, ja juuri se mittausketju on katkennut kolmesti.
const cityRetried = new Map();
// Kaupungit joiden viimeinen yritys jai kiintion (429) pilaamaksi: kaikki sen jalkeen
// mitattu on OIRE, ei havainto, joten kierroksen FAIL-rivit tiivistetaan yhdeksi
// juurisyyksi. Avain = kaupunki, arvo = { attempt, checks: [{check, detail}] }.
// Alkuperaiset rivit sailyvat JSON-raportissa (quotaCollapsed), jotta mitaan ei katoa.
const cityQuotaCollapsed = new Map();

// Raportti kirjoitetaan myös silloin kun ajo kaatuu kesken: muuten harness-virhe
// jättää jälkeensä pelkän exit-koodin eikä tiedetä mikä ehti mennä läpi.
function writeReport() {
  // Kattavuus arvioidaan TÄSSÄ eikä silmukan jälkeen, jotta se on raportissa myös
  // kaatumistilanteessa — juuri silloin sitä tarvitaan (10.8.2026: viisi kaupunkia
  // jäi ajamatta, eikä raportti kertonut siitä mitään).
  cityDone.size === CITIES.length
    ? pass("(ajo)", "kattavuus", `${cityDone.size}/${CITIES.length} kaupunkia ajettu`)
    : fail("(ajo)", "kattavuus",
        `vain ${cityDone.size}/${CITIES.length} kaupunkia ajettu — ajamatta: `
        + CITIES.filter(c => !cityDone.has(c.key)).map(c => c.key).join(", "));

  // Uusintojen erittely INFO-rivinä: ei muuta ajoa punaiseksi (uusinta on tarkoituksellinen
  // vastalääke), mutta tekee kiintiön kulumisen näkyväksi myös vihreässä ajossa.
  info("(ajo)", "kiintiön uusinnat", cityRetried.size
    ? `${cityRetried.size}/${CITIES.length} kaupunkia vaati uusinnan (429): `
      + [...cityRetried].map(([k, n]) => `${k} ×${n}`).join(", ")
    : `0/${CITIES.length} kaupunkia vaati uusinnan`);

  // Koonnit nakyviin ajotasolla: triage-agentti (ja ihminen) nakee yhdesta rivista,
  // etta punaisuus on kuormaa eika regressiota, ilman etta joutuu lukemaan koko listan.
  if (cityQuotaCollapsed.size) {
    info("(ajo)", "kiintion koonnit",
      `${cityQuotaCollapsed.size}/${CITIES.length} kaupunkia raportoitu yhtena juurisyyna (429): `
      + [...cityQuotaCollapsed].map(([k, v]) => `${k} (${v.checks.length} tarkistusta)`).join(", "));
  }

  const failures = results.filter(r => r.status === "FAIL");
  const lines = [];
  lines.push("Tuotanto-smoke-vahti · " + BASE + " · " + new Date().toISOString());
  lines.push("Reittihaun hakuaika: " + searchTime + " (Europe/Helsinki)");
  lines.push("");
  for (const r of results) lines.push(`${r.status.padEnd(5)}[${r.city}] ${r.check}${r.detail ? " — " + r.detail : ""}`);
  lines.push("");
  // Uusintaluku loppuriville asti: yhteenveto on se mitä ajosta luetaan yhdellä silmäyksellä,
  // ja ilman tätä "KAIKKI TARKISTUKSET OK" peittää kiintiön ryömimisen.
  const retryNote = cityRetried.size ? ` · ${cityRetried.size} kaupunkia vaati uusinnan (429)` : "";
  lines.push((failures.length ? failures.length + " TARKISTUSTA EPÄONNISTUI" : "KAIKKI TARKISTUKSET OK") + retryNote);
  const txt = lines.join("\n") + "\n";
  // Eraajossa raportit eivat saa kirjoittaa toistensa paalle (Actions arkistoi molemmat).
  const jalkiliite = process.env.SMOKE_REPORT_SUFFIX || "";
  fs.writeFileSync(path.join(__dirname, `prod-smoke-report${jalkiliite}.txt`), txt);
  fs.writeFileSync(path.join(__dirname, `prod-smoke-report${jalkiliite}.json`), JSON.stringify({
    base: BASE, generatedAt: new Date().toISOString(), searchTime,
    cities: CITIES.map(c => c.key), failures: failures.length,
    retriedCities: Object.fromEntries(cityRetried),
    quotaCollapsed: Object.fromEntries(cityQuotaCollapsed), results,
  }, null, 2) + "\n");
  console.log("\n" + lines[lines.length - 1]);
  return failures.length;
}

(async () => {
  console.log("Tuotanto-smoke-vahti · BASE=" + BASE);
  if (CITY_FILTER.length) console.log("Erä: " + CITIES.map(c => c.key).join(", "));
  // Rajattu kattavuus sanotaan ääneen: tiskiltä tulostus mitataan vain osalle
  // kaupungeista, eikä "kaikki vihreää" saa lukea kattavuudeksi jota ei ajettu.
  {
    const dpc = CITIES.filter(c => DESK_PRINT_CITIES ? DESK_PRINT_CITIES.includes(c.key) : !!c.deskPrint);
    console.log("Tiskiltä tulostus mitataan: " + (dpc.length ? dpc.map(c => c.key).join(", ") : "ei yhdellekään")
      + " (muut " + (CITIES.length - dpc.length) + " kaupunkia ajavat saman koodin mittaamatta)");
  }
  if (START_DELAY_MS > 0) {
    console.log(`Odotetaan ${START_DELAY_MS / 1000} s ennen erän alkua (kiintiön palautuminen)\n`);
    await sleep(START_DELAY_MS);
  }
  console.log("Reittihaun hakuaika: " + searchTime + " (Europe/Helsinki)\n");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  // Kaupungit ajetaan jonona, jotta 429:n pilaama kierros voidaan ajaa uudelleen.
  // Uusinta menee jonon HÄNTÄÄN eikä heti perään: muiden kaupunkien ajo antaa
  // kiintiölle aikaa palautua, eikä uusinta osu samaan tyhjään ämpäriin.
  const queue = CITIES.map(city => ({ city, attempt: 1 }));

  while (queue.length) {
    const job = queue.shift();
    const city = job.city;
    const mark = results.length; // paluupiste: uusinta hylkää tämän kierroksen tulokset

    // Uusinnan jäähdytys: odota loppuun se aika joka kiintiölle luvattiin, jos jonon
    // läpikäynti ei sitä jo kuluttanut.
    if (job.notBefore) {
      const wait = job.notBefore - Date.now();
      if (wait > 0) {
        console.log(`  ⏳ [${city.key}] odotetaan kiintiön palautumista ${Math.ceil(wait / 1000)} s\n`);
        await sleep(wait);
      }
    }

    // Oma selainkonteksti per kaupunki: localStorage (kieli, välimuistit) ei vuoda
    // kaupungista toiseen, ja konsolivirheet skooppautuvat siististi.
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.emulateTimezone("Europe/Helsinki");
    const consoleErrors = [];
    page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", e => consoleErrors.push(e.message));
    const url = h => `${BASE}/?city=${city.key}${h}`;

    try {
      // --- 1) Etusivu latautuu + per-kaupunki-title + linjalista ---
      await page.goto(url("#/"), { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
      const listOk = await page.waitForSelector("#routeList li a.route-tile .rt-badge", { timeout: 30000 })
        .then(() => true).catch(() => false);
      const tiles = await page.evaluate(() =>
        document.querySelectorAll("#routeList li a.route-tile").length);
      listOk && tiles >= 1
        ? pass(city.key, "linjalista", tiles + " linjakorttia")
        : fail(city.key, "linjalista", "ei linjakortteja 30 s kuluessa");
      const title = await page.evaluate(() => document.getElementById("appTitle")?.textContent || "");
      title.includes(city.gen + " bussiaikataulut")
        ? pass(city.key, "title", '"' + title + '"')
        : fail(city.key, "title", 'odotettu "' + city.gen + ' bussiaikataulut", oli "' + title + '"');

      // --- 2) FI/SV-kytkin (vain kaksikieliset kaupungit) ---
      if (city.svTitle) {
        await page.click('[data-lang-opt="sv"]').catch(() => {});
        const svOk = await page.waitForFunction(sv =>
          document.documentElement.lang === "sv"
          && (document.getElementById("appTitle")?.textContent || "").includes(sv),
          { timeout: 15000 }, city.svTitle).then(() => true).catch(() => false);
        svOk ? pass(city.key, "sv-kytkin", '"' + city.svTitle + '" + lang=sv')
             : fail(city.key, "sv-kytkin", "SV-otsikko/lang ei vaihtunut (FI-fallback ei kelpaa)");
        await page.click('[data-lang-opt="fi"]').catch(() => {});
        await page.waitForFunction(() => document.documentElement.lang === "fi", { timeout: 10000 }).catch(() => {});
      }

      // --- 3) Reittihaku: päätepisteet haetaan datasta (sama proxy-reitti kuin selaimessa),
      //        haku jaetun linkin muodolla + kiinnitetty t= → ≥1 ehdotus, lähtöajat nousevia ---
      const eps = await page.evaluate(async (searchDateCompact) => {
        if (typeof API_URL === "undefined" || typeof AREA === "undefined") return null;
        const res = await fetch(API_URL, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `query($lat:Float!,$lon:Float!){
              stopsByRadius(lat:$lat, lon:$lon, radius:4000, first:150){
                edges{ node{ distance stop{ gtfsId name lat lon patterns{ code } } } } } }`,
            variables: { lat: AREA.focus.lat, lon: AREA.focus.lon } }),
        }).catch(() => null);
        if (!res || !res.ok) return null;
        const j = await res.json().catch(() => null);
        const nodes = (j?.data?.stopsByRadius?.edges || []).map(e => e.node)
          .filter(n => n?.stop?.patterns?.length);
        if (nodes.length < 2) return null;
        nodes.sort((a, b) => a.distance - b.distance);
        const from = nodes[0].stop;
        // Määränpää + hakuaika johdetaan lähtöpysäkin TODELLISESTA lähdöstä kohdepäivänä:
        // otetaan ensimmäinen lähtö klo 9 jälkeen ja sen patternin viimeinen alavirran
        // pysäkki. Silloin ≥1 reitti on taatusti olemassa haetulla hetkellä. Kiinteä
        // klo 9:00 + "kaukaisin pysäkki jolla patterneja" petti harvassa verkossa kahdesti:
        // Raasepori/Trollböle Ö talvifeedillä 11.–12.8.2026 (pysäkin vuorot vasta 13:13+,
        // OTP:n hakuikkuna ei yllä sinne) ja Storsvängen S 12.8. (Tammisaaren aamussa on
        // palveluaukko 8:56→10:20, joten mikään 4 km:n määränpää ei kelvannut klo 9:00).
        const stRes = await fetch(API_URL, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `query($id:String!,$d:String!){ stop(id:$id){
              stoptimesForServiceDate(date:$d){
                pattern { code }
                stoptimes { scheduledDeparture } } } }`,
            variables: { id: from.gtfsId, d: searchDateCompact } }),
        }).catch(() => null);
        const stJ = stRes && stRes.ok ? await stRes.json().catch(() => null) : null;
        const deps = [];
        for (const g of (stJ?.data?.stop?.stoptimesForServiceDate || []))
          for (const x of (g.stoptimes || []))
            deps.push({ dep: x.scheduledDeparture, code: g.pattern.code });
        deps.sort((a, b) => a.dep - b.dep);
        const ordered = [...deps.filter(x => x.dep >= 9 * 3600), ...deps.reverse()];
        let to = null, depSec = null;
        for (const cand of ordered.slice(0, 8)) {
          const pr = await fetch(API_URL, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: `query($c:String!){ pattern(id:$c){ stops { gtfsId name lat lon } } }`,
              variables: { c: cand.code } }),
          }).catch(() => null);
          const pj = pr && pr.ok ? await pr.json().catch(() => null) : null;
          const stops = pj?.data?.pattern?.stops || [];
          const idx = stops.findIndex(s => s.gtfsId === from.gtfsId);
          if (idx < 0 || idx >= stops.length - 1) continue; // from on patternin pää → ei alavirtaa
          to = stops[stops.length - 1];
          depSec = cand.dep;
          break;
        }
        if (!to) {
          // fallback vanhaan valintaan: mieluummin tunnettu epävarmuus kuin ei testiä lainkaan
          to = [...nodes].reverse().find(n => n.stop.gtfsId !== from.gtfsId).stop;
        }
        return { from: { gtfsId: from.gtfsId, lat: from.lat, lon: from.lon, name: from.name },
                 to:   { gtfsId: to.gtfsId,   lat: to.lat,   lon: to.lon,   name: to.name },
                 depSec };
      }, searchTime.slice(0, 10).replace(/-/g, ""));
      if (!eps) {
        fail(city.key, "reittihaku", "päätepisteitä ei saatu stopsByRadius-kyselyllä");
      } else {
        const enc = p => encodeURIComponent(`${p.lat.toFixed(5)},${p.lon.toFixed(5)},${p.name}`);
        // hakuaika = valitun lähdön aika −5 min (haku alkaa juuri ennen todennettua vuoroa);
        // ilman johdettua lähtöä pysytään ajon vakioajassa klo 9:00
        let cityT = searchTime;
        if (eps.depSec != null) {
          const s = Math.max(0, eps.depSec - 300) % 86400;
          const p2 = n => String(n).padStart(2, "0");
          cityT = `${searchTime.slice(0, 10)}T${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}`;
        }
        const opts = encodeURIComponent(new URLSearchParams({ t: cityT }).toString());
        await page.goto(url(`#/reitti/${enc(eps.from)}/${enc(eps.to)}/${opts}`),
          { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
        // Ulkoinen reittiopas (CONFIG.externalPlanner, Raasepori 27.8.2026): #/reitti näyttää linkin
        // kaupungin omaan reittioppaaseen eikä omaa hakua. Silloin vartija on linkki, ei ehdotukset.
        const extLink = await page.waitForSelector("#extPlannerLink, details.itin[data-itin]", { timeout: 45000 })
          .then(() => page.evaluate(() => document.getElementById("extPlannerLink")?.href || ""))
          .catch(() => "");
        const itinOk = extLink ? false : await page.waitForSelector("details.itin[data-itin]", { timeout: 45000 })
          .then(() => true).catch(() => false);
        if (extLink) {
          /^https:\/\//.test(extLink)
            ? pass(city.key, "reittihaku", `ulkoinen reittiopas: ${extLink.replace(/\/reitti\/.*$/, "")} (ei omaa hakua)`)
            : fail(city.key, "reittihaku", "ulkoisen reittioppaan linkki ei ole https: " + extLink);
        } else if (!itinOk) {
          fail(city.key, "reittihaku", `ei reittiehdotuksia (${eps.from.name} → ${eps.to.name}, t=${cityT})`);
        } else {
          const times = await page.evaluate(() =>
            [...document.querySelectorAll("details.itin[data-itin] .ih-time .times")]
              .map(e => e.textContent.split("–")[0].trim()));
          const mono = departuresMonotonic(times);
          times.length >= 1 && mono.ok
            ? pass(city.key, "reittihaku", `${times.length} ehdotusta (${eps.from.name} → ${eps.to.name}), lähtöajat nousevia`)
            : fail(city.key, "reittihaku", mono.why || "ei lähtöaikoja tuloskorteissa");
        }
      }

      // --- 4) Linjatuloste (vihko): 1 linja → todelliset päivätyyppiblokit (h4.daytype) ---
      await page.goto(url("#/tulosteet/vihko"), { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
      const cbOk = await page.waitForSelector(".lineCb", { timeout: 60000 }).then(() => true).catch(() => false);
      if (!cbOk) {
        fail(city.key, "linjatuloste", "linjavalinta (.lineCb) ei latautunut");
      } else {
        await page.evaluate(() => { document.querySelector(".lineCb").checked = true; });
        await page.click("#buildBtn");
        const bookletOk = await page.waitForSelector("#bookletOut .booklet-line h4.daytype", { timeout: 90000 })
          .then(() => true).catch(() => false);
        const days = await page.evaluate(() =>
          document.querySelectorAll("#bookletOut .booklet-line h4.daytype").length);
        bookletOk && days >= 1
          ? pass(city.key, "linjatuloste", days + " päivätyyppiblokkia")
          : fail(city.key, "linjatuloste", "päivätyyppiblokkeja ei muodostunut");
        // Symbolilegenda: jos taulukossa on "·"-soluja, tekstiselitteen on löydyttävä
        const leg = await page.evaluate(() => ({
          dots: [...document.querySelectorAll("#bookletOut td")].filter(td => td.textContent.trim() === "·").length,
          legend: !!document.querySelector("#bookletOut .matrix-legend"),
        }));
        if (leg.dots > 0) {
          leg.legend ? pass(city.key, "legenda (vihko)", `${leg.dots} ·-solua + selite`)
                     : fail(city.key, "legenda (vihko)", `${leg.dots} ·-solua ilman selitettä`);
        } else info(city.key, "legenda (vihko)", "ei ·-soluja tässä linjassa (selitettä ei vaadita)");
        if (bookletOk) await asetteluTarkistus(page, city.key, "vihko A4", "#bookletOut", "portrait");

        // --- 4a) A5-vihon leveysvartija (myyntikaupungit). A5:n sisältöleveys on 128 mm,
        //         eikä siihen mahdu yhtä monta avainpysäkkisaraketta kuin A4:ään: 25.8.2026
        //         Vaasan ruotsinkielisessä vihossa taulukko oli 706 px sivun ollessa 486 px,
        //         jolloin oikea reuna leikkautui ja paperille jäi puolikkaita kellonaikoja.
        //         Sivutus mittaa vain korkeuden, joten mikään ei kertonut tästä. Ajetaan
        //         nimenomaan täällä eikä paikallisessa smokessa, koska raja tulee vastaan
        //         PITKILLÄ pysäkkinimillä (Vaasa ja Raasepori ruotsiksi) — Lahden lyhyet
        //         nimet mahtuisivat vaikka rajoitus olisi rikki.
        if (DESK_PRINT_CITIES ? DESK_PRINT_CITIES.includes(city.key) : !!city.deskPrint) {
          await page.evaluate(() => { window.print = () => {}; });
          await page.click("#bookletPrintA5").catch(() => {});
          const imposed = await page.waitForFunction(
            () => !!document.querySelector("#vihkoPrint .vihko-page-content table"),
            { timeout: 60000 }).then(() => true).catch(() => false);
          if (!imposed) {
            fail(city.key, "vihko A5", "A5-taittoa ei syntynyt 60 s kuluessa");
          } else {
            await page.emulateMediaType("print");
            const vk = await page.evaluate(() => {
              const pgs = [...document.querySelectorAll("#vihkoPrint .vihko-page-content")];
              return {
                yli: Math.round(Math.max(0, ...pgs.flatMap(pg => [...pg.querySelectorAll("table")]
                  .map(t => t.getBoundingClientRect().right - pg.getBoundingClientRect().right)))),
                cols: [...new Set(pgs.flatMap(pg => [...pg.querySelectorAll("table")]
                  .map(t => t.querySelector("tr")?.children.length)))].sort((a, b) => a - b),
                sivuja: document.querySelectorAll("#vihkoPrint .vihko-a5:not(.vihko-blank)").length,
              };
            });
            await page.emulateMediaType("screen");
            vk.yli <= 1
              ? pass(city.key, "vihko A5", `${vk.sivuja} sivua, sarakkeita ${JSON.stringify(vk.cols)}, mahtuu leveyteen`)
              : fail(city.key, "vihko A5",
                  `taulukko vuotaa A5-sivun yli ${vk.yli} px → oikea reuna leikkautuu paperilla `
                  + `(sarakkeita ${JSON.stringify(vk.cols)})`);
          }
        }
      }

      // --- 4b) Pinnatut pysäkkitunnukset elävät feedissä (kausivaihtovahti) ---
      // Erillinen tarkistus, jotta kausivaihdon rikkoma pinnaus FAILaa juurisyyllä
      // ("tunnus kuoli feedistä") eikä vasta julistetarkistuksen epäsuorana
      // "tuntikaaviota ei muodostunut" -virheenä. Sama tilanne toistuu joka
      // kausivaihdossa joka kaupungissa. Ks. CITIES-kommentti (Tevi-ilmiö).
      const pinnedIds = [...new Set([city.nightStopId, city.posterStopId].filter(Boolean))];
      const pinDate = searchTime.slice(0, 10).replace(/-/g, "");
      for (const id of pinnedIds) {
        const pin = await page.evaluate(async (id, date) => {
          if (typeof API_URL === "undefined") return { err: "API_URL ei saatavilla" };
          const res = await fetch(API_URL, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: `query($id:String!,$date:String!){ stop(id:$id){ gtfsId name
                stoptimesForServiceDate(date:$date, omitNonPickups:true){ stoptimes{ scheduledDeparture } } } }`,
              variables: { id, date } }),
          }).catch(() => null);
          if (!res || !res.ok) return { err: "HTTP " + (res ? res.status : "ei vastausta") };
          const j = await res.json().catch(() => null);
          if (!j || !j.data) return { err: "vastaus ei jäsenny" };
          const stop = j.data.stop;
          if (!stop) return { missing: true };
          const deps = (stop.stoptimesForServiceDate || [])
            .reduce((n, p) => n + (p.stoptimes || []).length, 0);
          return { name: stop.name, deps };
        }, id, pinDate);
        if (pin.err) {
          fail(city.key, "pinnattu pysäkki", `${id}: tarkistus ei onnistunut (${pin.err})`);
        } else if (pin.missing) {
          fail(city.key, "pinnattu pysäkki",
            `${id} on kadonnut feedistä — kausivaihto? Päivitä CITIES-pinnaus.`);
        } else if (pin.deps === 0) {
          fail(city.key, "pinnattu pysäkki",
            `${id} "${pin.name}" 0 lähtöä ${pinDate} — pinnattu tunnus osoittaa kuolleeseen pysäkkiin (kausivaihto?)`);
        } else {
          pass(city.key, "pinnattu pysäkki", `${id} "${pin.name}" elää (${pin.deps} lähtöä ${pinDate})`);
        }
      }

      // --- 5) Pysäkkijuliste: päiväblokit todellisten ajopäivien mukaan; Lahdella lisäksi
      //        >1 blokki + ≥1 yölähtö ikkunassa 23:00–02:59 (talvifeed-portin ydin) ---
      const posterStop = city.nightStopId || city.posterStopId || (eps && eps.from.gtfsId);
      if (!posterStop) {
        fail(city.key, "pysäkkijuliste", "ei esimerkkipysäkkiä (pysäkkihaku epäonnistui)");
      } else {
        await page.goto(url("#/pysakki/" + encodeURIComponent(posterStop)),
          { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
        const btnOk = await page.waitForSelector("#stopPosterBtn", { timeout: 30000 }).then(() => true).catch(() => false);
        if (!btnOk) {
          fail(city.key, "pysäkkijuliste", "julistenappia ei löytynyt pysäkiltä " + posterStop);
        } else {
          await page.evaluate(() => { window.print = () => {}; });
          // pieni asettumisaika + yksi uusintaklikkaus: nappi voi olla DOMissa hetken
          // ennen kuin sen sidonta on valmis (SPA-hash-navigoinnin jälkeen)
          await sleep(500);
          await page.click("#stopPosterBtn");
          let posterOk = await page.waitForFunction(
            () => !!document.querySelector("#stopPrintOut .poster-day .hourgrid tr"),
            { timeout: 30000 }).then(() => true).catch(() => false);
          if (!posterOk) {
            await page.click("#stopPosterBtn").catch(() => {});
            posterOk = await page.waitForFunction(
              () => !!document.querySelector("#stopPrintOut .poster-day .hourgrid tr"),
              { timeout: 60000 }).then(() => true).catch(() => false);
          }
          const poster = await page.evaluate(() => {
            const nightHours = new Set(["23", "00", "01", "02"]);
            const hours = [...document.querySelectorAll("#stopPrintOut .hourgrid th[scope=row]")]
              .map(th => th.textContent.trim());
            return {
              days: document.querySelectorAll("#stopPrintOut .poster-day").length,
              night: hours.filter(h => nightHours.has(h)).length,
              badges: [...new Set([...document.querySelectorAll("#stopPrintOut .poster-line h4 .badge")]
                .map(b => b.textContent.trim()))],
              outText: (document.getElementById("stopPrintOut")?.textContent || "").trim().slice(0, 80),
            };
          });
          // Yhden arkin tiivis juliste (CONFIG.posterCompact, esim. Vaasa): mitataan sen
          // omalla marginaalilla (7 mm), muuten portrait (12 mm).
          const posterCompact = await page.evaluate(() => !!document.querySelector("#stopPrintOut .poster-compact"));
          if (posterOk) await asetteluTarkistus(page, city.key, "pysäkkijuliste", "#stopPrintOut", posterCompact ? "compact" : "portrait");
          posterOk && poster.days >= 1
            ? pass(city.key, "pysäkkijuliste", `${poster.days} päiväblokkia (${posterStop})`)
            : fail(city.key, "pysäkkijuliste", `tuntikaaviota ei muodostunut (${posterStop}, ` +
                `päiväblokkeja ${poster.days}, sisältö: "${poster.outText}")`);
          if (city.nightStopId) {
            (poster.days > 1 && poster.night >= 1)
              ? pass(city.key, "yövuorot", `${poster.days} päiväblokkia + ${poster.night} tuntiriviä ikkunassa 23–02`)
              : fail(city.key, "yövuorot", `päiväblokkeja ${poster.days}, yötunteja (23–02) ${poster.night} — ` +
                  "juliste ei sisällä odotettua yöliikennettä");
            // Linjanumerosidottu tarkistus vain INFO-tasolla: feedivaihto saa muuttaa yölinjoja.
            const found = (city.nightLines || []).filter(l => poster.badges.includes(l));
            info(city.key, "yölinjat (info)", found.length
              ? "julisteessa " + found.join("/") + " (odotus " + city.nightLines.join("/") + ")"
              : "odotettuja linjoja " + city.nightLines.join("/") + " ei julisteessa — tarkista feedivaihdon jälkeen");
          }
        }
      }

      // --- 6) Yhdistetyt suunnat (käytävä): presetti → monen linjan yhteinen taulukko,
      //        ≥2 suuntaa (silmukkaverkossa city.corridorDirs), aikajärjestys,
      //        tuloste puhdasta tekstiä + legenda ---
      // Kunnissa joissa käytäväpresettejä ei ole (city.noCorridors) tarkistus ohitetaan tietoisesti:
      // puuttuva presetti on CONFIGin päätös, ei regressio. Kaikki muut tarkistukset ajetaan.
      if (city.noCorridors) {
        info(city.key, "yhdistetyt suunnat", "ei käytäväpresettejä (CONFIG) - tarkistus ohitettu");
      } else {
      await page.goto(url("#/tulosteet/kaytava"), { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
      const preOk = await page.waitForSelector("[data-corridor]", { timeout: 30000 }).then(() => true).catch(() => false);
      if (!preOk) {
        fail(city.key, "yhdistetyt suunnat", "käytäväpresettejä ei löytynyt");
      } else {
        // Käytävätarkistus ajetaan samalle arkipäivälle kuin muutkin tarkistukset
        // (searchTimeHelsinki ohittaa viikonlopun). Ilman tätä kaytava kaytti "tanaan":
        // 29.8.2026 lauantaina Raaseporin presetista ajoi vain 201 (192T ja 201s eivat
        // lainkaan), jolloin taulukkoon tuli 1 suunta ja ajo punasi taysin aiheetta.
        await page.evaluate(pvm => {
          const el = document.getElementById("corrDate");
          if (el) { el.value = pvm; el.dispatchEvent(new Event("change", { bubbles: true })); }
        }, searchTime.slice(0, 10));
        // Klikataan DOMista eikä koordinaateista: Puppeteer laskee klikkauspisteen ennen
        // lähetystä, ja käytäväsivun linjalista (Raaseporissa 40 valintaruutua) latautuu
        // asynkronisesti, jolloin asettelu ehtii siirtyä välissä ja klikkaus osuu ohi.
        // Oire 29.8.2026 tuotantoa vasten: sovellus siirtyi etusivulle ja #corrGo katosi,
        // jolloin ajo punasi satunnaisesti ilman todellista regressiota (3/3 lapi kun
        // klikkausta edelsi vieritys, kaatui ilman). el.click() on immuuni siirtymille.
        await page.$eval("[data-corridor]", el => el.click());
        // #corrGo ilmestyy vasta kun linjalista on ladattu.
        await page.waitForSelector("#corrGo", { timeout: 60000 });
        await page.$eval("#corrGo", el => el.click());
        const corrOk = await page.waitForFunction(
          () => document.querySelectorAll("#corridorOut table.corridor tbody tr").length >= 1,
          { timeout: 120000 }).then(() => true).catch(() => false);
        if (!corrOk) {
          fail(city.key, "yhdistetyt suunnat", "käytävätaulukko ei koostunut 120 s kuluessa");
        } else {
          await sleep(300);
          const corr = await page.evaluate(() => {
            const badges = [...document.querySelectorAll("#corridorOut table.corridor tbody .badge")]
              .map(b => b.textContent.trim());
            // Aikajärjestys per taulukko, kaikki rivit. Luetaan solun data-sec, joka on
            // GTFS-sekunnit vuorokauden alusta myös yli 24 h (24:04 = 86640). Näkyvästä
            // tekstistä sitä ei voi päätellä: 24:04 renderöityy "00:04". Aiempi versio
            // arvasi vuorokauden vaihtumisen 12 h -heuristiikalla, ja se antoi väärän
            // FAILin 24.8.2026 Hämeenlinnan perjantailohkossa (vain 06:11 ja 24:04,
            // pudotus 6 h → heuristiikka ei tunnistanut sitä seuraavaksi päiväksi).
            // data-sec on tiukempi eikä löysempi: se ei salli mitään takaperoista
            // hyppyä, kun taas heuristiikka salli minkä tahansa yli 12 h pudotuksen.
            // Jos attribuutti puuttuu (vanha tuotantoversio), tarkistus EI mene läpi
            // hiljaa vaan raportoituu erikseen alempana (corr.secMissing).
            const secCells = [...document.querySelectorAll("#corridorOut table.corridor tbody tr td:first-child")];
            const secMissing = secCells.filter(td => !td.hasAttribute("data-sec")
              && /^\d{1,2}:\d{2}/.test(td.textContent.trim())).length;
            const sorted = [...document.querySelectorAll("#corridorOut table.corridor")].every(tb => {
              const ts = [...tb.querySelectorAll("tbody tr td:first-child")]
                .filter(td => td.hasAttribute("data-sec"))
                .map(td => +td.getAttribute("data-sec"));
              let prev = -1;
              for (const v of ts) {
                if (v < prev) return false;
                prev = v;
              }
              return true;
            });
            return {
              rows: document.querySelectorAll("#corridorOut table.corridor tbody tr").length,
              distinctLines: [...new Set(badges)].length,
              daytypes: document.querySelectorAll("#corridorOut h4.daytype").length,
              dirs: document.querySelectorAll("#corridorOut .corridor-dir").length,
              sorted, secMissing,
              // Reittikaavio (.print-map, 27.8.2026) on tarkoituksellinen SVG: viivat + tekstiä, ei kuvia.
              // Se rajataan puhdas-teksti-vartijan ulkopuolelle ja tarkistetaan omana rivinään.
              nonText: [...document.querySelectorAll("#corridorOut svg, #corridorOut canvas, #corridorOut img")]
                .filter(el => !el.closest(".no-print") && !el.closest(".print-map")).length,
              mapPaths: document.querySelectorAll("#corridorOut .print-map svg path").length,
              mapTexts: document.querySelectorAll("#corridorOut .print-map svg text").length,
              mapImgs: document.querySelectorAll("#corridorOut .print-map img, #corridorOut .print-map image").length,
              dots: [...document.querySelectorAll("#corridorOut td")].filter(td => td.textContent.trim() === "·").length,
              legend: !!document.querySelector("#corridorOut .matrix-legend"),
            };
          });
          const wantDirs = city.corridorDirs || 2;
          (corr.distinctLines >= 2 && corr.daytypes >= 1 && corr.dirs >= wantDirs
            && corr.sorted && corr.secMissing === 0)
            ? pass(city.key, "yhdistetyt suunnat",
                `${corr.rows} lähtöä, ${corr.distinctLines} linjaa, ${corr.dirs} suuntaa, aikajärjestys OK`)
            : fail(city.key, "yhdistetyt suunnat", "taulukko pielessä: " + JSON.stringify(
                { rows: corr.rows, linjat: corr.distinctLines, suunnat: corr.dirs, daytypes: corr.daytypes,
                  sorted: corr.sorted, secMissing: corr.secMissing }));
          corr.nonText === 0
            ? pass(city.key, "käytävä-tuloste", "puhdasta tekstiä reittikaavion ulkopuolella (0 svg/canvas/img)")
            : fail(city.key, "käytävä-tuloste", corr.nonText + " ei-tekstielementtiä tulosteessa");
          if (corr.mapPaths || corr.mapTexts || corr.mapImgs) {
            (corr.mapPaths > 0 && corr.mapTexts > 0 && corr.mapImgs === 0)
              ? pass(city.key, "reittikaavio", `${corr.mapPaths} viivaa, ${corr.mapTexts} nimilappua tekstinä, 0 kuvaa`)
              : fail(city.key, "reittikaavio", "kaavio vajaa: " + JSON.stringify({ viivat: corr.mapPaths, tekstit: corr.mapTexts, kuvat: corr.mapImgs }));
          } else {
            info(city.key, "reittikaavio", "ei kaaviota käytävätulosteessa");
          }
          if (corr.dots > 0) {
            corr.legend ? pass(city.key, "legenda (käytävä)", `${corr.dots} ·-solua + selite`)
                        : fail(city.key, "legenda (käytävä)", `${corr.dots} ·-solua ilman selitettä`);
          } else info(city.key, "legenda (käytävä)", "ei ·-soluja tässä käytävässä (selitettä ei vaadita)");
          // Määränpää ei saa leikkautua print-CSS:ssä (13.8.2026: table-layout:fixed +
          // overflow:hidden katkaisi "Myllykoski" → "Myllykosk" myyntinäytteessä ilman
          // merkkiä katkeamisesta — näkyy VAIN print-mediassa, siksi oma emulointimittaus).
          await page.emulateMediaType("print");
          const clipped = await page.evaluate(() =>
            [...document.querySelectorAll("#corridorOut td.corr-dest")]
              .filter(td => td.scrollWidth > td.clientWidth + 1)
              .map(td => td.textContent.trim()).slice(0, 3));
          await page.emulateMediaType("screen");
          clipped.length === 0
            ? pass(city.key, "käytävä-määränpäät (print)", "0 leikkautunutta solua")
            : fail(city.key, "käytävä-määränpäät (print)",
                `määränpää leikkautuu tulosteessa: ${clipped.join(" | ")}`);
        }
      }
      } // city.noCorridors

      // --- 6a) Palvelutiski (#/palvelutiski): oletuspysäkki avautuu ja siinä on linjoja.
      //         Pariteettivahti: oletuspysäkki nojaa CONFIG.centerStopNames/hubs-kenttiin,
      //         jotka puuttuivat 13.8.2026 kuudelta kaupungilta — tiski avautui niissä
      //         tyhjänä eikä mikään testi kertonut siitä. Lähtömäärä on INFO eikä FAIL:
      //         illan ajossa (21 Helsinki) harvan verkon kaupungissa voi aidosti olla 0
      //         lähtöä, mutta oletuspysäkin PUUTTUMINEN on aina konfiguraatiovika.
      await page.goto(url("#/palvelutiski"), { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
      // Brändipariteetti: tiski oli ainoa näkymä josta kaupungin väri katosi (kovakoodattu
      // sininen), eli Vaasan pinkki ja Raaseporin vihreä eivät näkyneet siellä lainkaan.
      // Vartija katsoo kolmea asiaa: brändikaupungin aksentti ei saa olla oletussininen,
      // sen on oltava samasta väristä kuin brandColor (sama hallitseva kanava), ja
      // kontrastin valkoista pohjaa vasten on pysyttävä tiskin omassa 5.5:1 tavoitteessa
      // (tiski on tahallaan korkeampi kontrasti kuin AA 4.5:1).
      const deskAccent = await page.evaluate(() => {
        const el = document.querySelector(".desk");
        if (!el) return null;
        const rd = h => [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
        const maxCh = rgb => rgb.indexOf(Math.max(...rgb));
        const hex = getComputedStyle(el).getPropertyValue("--blue").trim().replace(/^#/, "");
        const brand = (CONFIG.brandColor || "").replace(/^#/, "");
        if (!/^[0-9a-fA-F]{6}$/.test(hex)) return { hex, contrast: 0, brand: brand || null };
        const rgb = rd(hex);
        const lum = rgb.map(v => v / 255)
          .map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
          .reduce((a, c, i) => a + [0.2126, 0.7152, 0.0722][i] * c, 0);
        return { hex: "#" + hex.toLowerCase(), contrast: 1.05 / (lum + 0.05),
          brand: brand ? "#" + brand.toLowerCase() : null,
          sameHue: brand ? maxCh(rgb) === maxCh(rd(brand)) : null };
      });
      if (!deskAccent) {
        fail(city.key, "tiskin brändiväri", ".desk-elementtiä ei löytynyt tiskinäkymästä");
      } else if (deskAccent.contrast < 5.5) {
        fail(city.key, "tiskin brändiväri",
          `aksentti ${deskAccent.hex} vain ${deskAccent.contrast.toFixed(2)}:1 valkoista vasten (tiskin tavoite 5.5:1)`);
      } else if (deskAccent.brand && deskAccent.hex === "#0033cc") {
        fail(city.key, "tiskin brändiväri",
          `brandColor ${deskAccent.brand} on määritelty, mutta tiski käyttää yhä oletussinistä`);
      } else if (deskAccent.brand && !deskAccent.sameHue) {
        fail(city.key, "tiskin brändiväri",
          `aksentti ${deskAccent.hex} ei ole brandColorin ${deskAccent.brand} sävy`);
      } else if (!deskAccent.brand && deskAccent.hex !== "#0033cc") {
        fail(city.key, "tiskin brändiväri",
          `ei brandColoria, mutta tiskin aksentti on ${deskAccent.hex} (odotettu oletussininen)`);
      } else {
        pass(city.key, "tiskin brändiväri",
          `${deskAccent.hex}, kontrasti ${deskAccent.contrast.toFixed(1)}:1`);
      }
      const deskOk = await page.waitForSelector("#deskStopResults #deskLines .badge", { timeout: 45000 })
        .then(() => true).catch(() => false);
      if (!deskOk) {
        const empty = await page.evaluate(() =>
          (document.getElementById("deskStopResults")?.textContent || "").trim().slice(0, 80));
        fail(city.key, "palvelutiskin oletuspysäkki",
          "tiski avautui ilman oletuspysäkkiä — tarkista CONFIG.centerStopNames"
          + (empty ? ` (sisältö: "${empty}")` : " (tyhjä)"));
      } else {
        // Lähdöt latautuvat omaan lohkoonsa vasta linjarivin jälkeen; renderDeskDeps
        // lisää aina .desk-deps-upd-rivin kun haku on valmis. Ilman tätä odotusta
        // lähtömäärä mitattaisiin latausviestin päältä ja näyttäisi aina nollalta.
        await page.waitForSelector("#deskDeps .desk-deps-upd", { timeout: 30000 }).catch(() => {});
        const desk = await page.evaluate(() => ({
          lines: document.querySelectorAll("#deskLines .badge").length,
          stop: document.querySelector("#deskDeps .stophead a")?.textContent?.trim() || "",
          deps: document.querySelectorAll("#deskDeps table.deps tbody tr").length,
        }));
        pass(city.key, "palvelutiskin oletuspysäkki", `${desk.lines} linjaa`);
        info(city.key, "palvelutiskin lähdöt",
          desk.deps ? `${desk.deps} lähtöä (${desk.stop})` : "ei lähtöjä juuri nyt (tarkista jos toistuu aamuajossa)");
        // Juna + bussi samassa näkymässä. INFO eikä FAIL: rata.digitraffic on ulkoinen
        // rajapinta jonka katkos ei saa värjätä koko ajoa punaiseksi — #/junat-tarkistus
        // (kohta 6c) on se joka FAILaa jos junanäkymä on aidosti rikki.
        const dt = await page.waitForFunction(
          () => document.querySelectorAll("#deskTrains table tbody tr").length > 0,
          { timeout: 20000 }).then(() => true).catch(() => false);
        const dtN = await page.evaluate(() => document.querySelectorAll("#deskTrains table tbody tr").length);
        info(city.key, "palvelutiskin junalähdöt",
          dt ? `${dtN} junaa lohkossa` : "ei junarivejä 20 s kuluessa (ulkoinen rata.digitraffic)");

        // --- 6a2) Tiskiltä tulostus (lisätty 24.8.2026): "aikataulu tulostuu samasta
        //          näkymästä telineen kokoon" on myyntiesitteen väite Lahdesta, Vaasasta
        //          ja Raaseporista. Ennen 24.8. tiskiltä piti siirtyä pysäkkisivulle.
        //          Koodi on kaupunkiriippumaton, mutta se ei ollut ennen tätä mitattu
        //          muualla kuin Lahdessa eikä kertaakaan oikean proxyn läpi.
        //          window.print stubataan ennen klikkiä — tuloste ei saa avata dialogia.
        const runDeskPrint = DESK_PRINT_CITIES ? DESK_PRINT_CITIES.includes(city.key) : !!city.deskPrint;
        if (runDeskPrint) {
          const btn = await page.$("#deskPrintBtn");
          if (!btn) {
            fail(city.key, "tiskiltä tulostus", "#deskPrintBtn puuttuu oletuspysäkin kohdalta");
          } else {
            await page.evaluate(() => { window.print = () => { window.__deskPrinted = true; }; });
            await page.click("#deskPrintBtn");
            const built = await page.waitForFunction(
              () => !!document.querySelector("#deskPrintOut .poster-day .hourgrid tr"),
              { timeout: 90000 }).then(() => true).catch(() => false);
            if (!built) {
              // Tiski näyttää epäonnistuneen haun tilarivillä eikä tulosta tyhjää paperia.
              const st = await page.evaluate(() =>
                (document.getElementById("deskPrintStatus")?.textContent || "").trim().slice(0, 80));
              fail(city.key, "tiskiltä tulostus",
                "tuloste ei koostunut 90 s kuluessa" + (st ? ` (tila: "${st}")` : ""));
            } else {
              // @page-sääntö asetetaan runPrintJob:ssa kahden rAF-kierroksen takana,
              // eli vasta tulosterivien jälkeen. Ilman odotusta luetaan tyhjä arvo.
              await page.waitForFunction(
                () => !!document.getElementById("pageOrient")?.textContent,
                { timeout: 15000 }).catch(() => {});
              const dp = await page.evaluate(() => ({
                days: document.querySelectorAll("#deskPrintOut .poster-day").length,
                lines: new Set([...document.querySelectorAll("#deskPrintOut .poster-line h4 .badge")]
                  .map(b => b.textContent.trim())).size,
                orient: document.getElementById("pageOrient")?.textContent || "",
                printed: !!window.__deskPrinted,
                compact: !!document.querySelector("#deskPrintOut .poster-compact"),
              }));
              // Tiivis juliste (oletus 3.9.2026 alkaen) tulostuu tiskiltä 7 mm:llä kuten
              // pysäkkisivulta, tavallinen lehtitelineen 8 mm:llä; mitataan samalla leveydellä.
              await asetteluTarkistus(page, city.key, "tiskin tuloste", "#deskPrintOut", dp.compact ? "compact" : "rack");
              dp.days >= 1 && dp.lines >= 1 && dp.printed
                && /portrait/.test(dp.orient) && (dp.compact ? /7mm/ : /8mm/).test(dp.orient)
                ? pass(city.key, "tiskiltä tulostus",
                    `${dp.days} päiväblokkia, ${dp.lines} linjaa, A4 pysty ${dp.compact ? "7 mm (tiivis)" : "8 mm"}`)
                : fail(city.key, "tiskiltä tulostus", `tuloste ei kelpaa: ${JSON.stringify(dp)}`);
            }
          }
        }

        // --- 6a3) Tiskin Tulosteet-välilehti (Villen palaute 3.9.2026): jokainen palvelun
        //          tuloste on saatava tiskiltä, eikä linjavalinta saa olla sidottu valittuun
        //          pysäkkiin. Mittari on suhdeluku: valittavia linjoja on vähintään yhtä
        //          monta kuin pysäkillä kulkee, ja kaikki tulostenapit ovat paikallaan.
        //          Pelkkä DOM-luku: ei uusia proxy-kutsuja kiintiön päälle.
        const dpTab = await page.$('.dtab[data-dtab="tulosteet"]');
        if (!dpTab) {
          fail(city.key, "tiskin tulostevälilehti", "Tulosteet-välilehteä ei ole tiskissä");
        } else {
          await dpTab.click();
          const listaOk = await page.waitForFunction(
            () => document.querySelectorAll("#deskLineList .deskLineCb").length > 0 ? true : null,
            { timeout: 30000 }).then(() => true).catch(() => false);
          const dpv = await page.evaluate(() => ({
            linjoja: document.querySelectorAll("#deskLineList .deskLineCb").length,
            pysakilla: document.querySelectorAll("#deskLines .badge").length,
            ryhmat: document.querySelectorAll("#deskLineList .dp-head").length,
            yksi: [...document.querySelectorAll(".deskLineBtn")].map(b => b.dataset.lp).join(","),
            usea: [...document.querySelectorAll(".deskLinesBtn")].map(b => b.dataset.lp).join(","),
            juliste: !!document.getElementById("deskStopPosterBtn"),
            muutokset: !!document.getElementById("deskChangesBtn"),
          }));
          listaOk && dpv.linjoja >= Math.max(1, dpv.pysakilla) && dpv.yksi === "rack,key,all,batch"
            && dpv.usea === "vihko,kaytava" && dpv.juliste && dpv.muutokset
            ? pass(city.key, "tiskin tulostevälilehti",
                `${dpv.linjoja} linjaa valittavissa (pysäkillä ${dpv.pysakilla}), ${dpv.ryhmat} ryhmää`)
            : fail(city.key, "tiskin tulostevälilehti",
                `valikko pysäkkisidonnainen tai tulosteita puuttuu: ${JSON.stringify(dpv)}`);
          await page.click('.dtab[data-dtab="neuvonta"]').catch(() => {});
        }
      }

      // --- 6d) Keskustan pysäkit (#/laiturit): vain kaupungeille joilla CONFIG.hubs.
      //         Laiturinäkymä on Lahden ulkopuolella uusi (14.8.2026), ja se nojaa
      //         nimihakuun → kausivaihto voi viedä terminaalin nimen alta.
      const hubKeys = await page.evaluate(() =>
        (typeof CONFIG !== "undefined" && CONFIG.hubs ? CONFIG.hubs.map(h => h.key) : []));
      if (hubKeys.length) {
        await page.goto(url("#/laiturit"), { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
        const platOk = await page.waitForSelector(".plat-list .plat-item", { timeout: 45000 })
          .then(() => true).catch(() => false);
        const plat = await page.evaluate(() => ({
          items: document.querySelectorAll(".plat-list .plat-item").length,
          tabs: document.querySelectorAll("[data-hub-tab]").length,
          withLines: document.querySelectorAll(".plat-list .plat-item .plat-lines .badge").length,
        }));
        platOk && plat.items >= 1 && plat.withLines >= 1
          ? pass(city.key, "keskustan pysäkit", `${plat.items} laituria, ${plat.tabs} välilehteä`)
          : fail(city.key, "keskustan pysäkit",
              `laiturilista jäi tyhjäksi (laitureita ${plat.items}, linjamerkkejä ${plat.withLines}) — `
              + `CONFIG.hubs-nimi ei osu feediin? Välilehdet: ${hubKeys.join(", ")}`);
      }

      // --- 6b) Pysäkkijulisteiden ERÄTULOSTUS oikean proxyn läpi (tuotantovika 13.8.2026).
      //         Mitataan kaksi asiaa joita mikään muu tarkistus ei näe:
      //         (1) valmistuuko koko erä ilman yhtään 429:ää suojatun proxyn läpi,
      //         (2) montako proxy-kutsua erä tekee (ryömiikö luku kohti workerin rajaa).
      //         window.print stubataan ennen klikkiä — tuloste ei saa avata dialogia.
      const runBatch = BATCH_CITIES ? BATCH_CITIES.includes(city.key) : !!city.batchPosterLine;
      if (runBatch && city.batchPosterLine) {
        await page.goto(url("#/tulosteet/julisteet"), { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
        const selOk = await page.waitForFunction(
          () => document.querySelectorAll("#batchLine option").length > 1,
          { timeout: 60000 }).then(() => true).catch(() => false);
        if (!selOk) {
          fail(city.key, "julisteiden erätulostus", "linjavalitsin (#batchLine) ei latautunut");
        } else {
          // Linja valitaan tunnuksella (esim. "4"), ei indeksillä: indeksi liukuisi
          // linjaston muuttuessa ja mittaisi eri kokoista erää joka kaudella.
          const picked = await page.evaluate(short => {
            const sel = document.getElementById("batchLine");
            const opt = [...sel.options].find(o => (o.textContent || "").trim().split(/\s+/)[0] === short);
            if (!opt) return null;
            sel.value = opt.value;
            return opt.textContent.trim();
          }, city.batchPosterLine);
          if (!picked) {
            fail(city.key, "julisteiden erätulostus",
              `linjaa "${city.batchPosterLine}" ei ole linjavalitsimessa — kausivaihto? Päivitä batchPosterLine.`);
          } else {
            await page.evaluate(() => {
              window.print = () => { window.__batchPrinted = true; };
              window.__batchCalls = 0; window.__batch429 = 0; window.__batchBad = [];
              const orig = window.fetch;
              window.fetch = async (...args) => {
                const u = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
                const mine = typeof API_URL !== "undefined" && u.startsWith(API_URL);
                if (mine) window.__batchCalls++;
                const res = await orig.apply(window, args);
                if (mine && !res.ok) {
                  if (res.status === 429) window.__batch429++;
                  if (window.__batchBad.length < 5) window.__batchBad.push(res.status);
                }
                return res;
              };
            });
            await page.click("#batchGo");
            // Valmis = tuntikaavio renderöity JA window.print kutsuttu; virhetila =
            // #batchStatus näyttää tekstin joka ei ole edistymisviesti.
            const state = await page.waitForFunction(() => {
              if (window.__batchPrinted
                && document.querySelector("#batchOut .poster-day .hourgrid tr")) return "done";
              const st = (document.getElementById("batchStatus")?.textContent || "").trim();
              if (st && !/\d+\s*\/\s*\d+/.test(st) && !/valmistel|prepar|förbered/i.test(st)) return "err:" + st;
              return null;
            }, { timeout: 300000, polling: 500 }).then(h => h.jsonValue()).catch(() => "timeout");
            const m = await page.evaluate(() => ({
              calls: window.__batchCalls, n429: window.__batch429, bad: window.__batchBad,
              days: document.querySelectorAll("#batchOut .poster-day").length,
            }));
            const detail = `linja ${city.batchPosterLine}, ${m.calls} proxy-kutsua, ${m.days} julistelohkoa`;
            if (state !== "done") {
              fail(city.key, "julisteiden erätulostus",
                `erä ei valmistunut (${state}) — ${detail}, 429-vastauksia ${m.n429}`
                + (m.bad.length ? `, muut HTTP-tilat: ${m.bad.join(",")}` : ""));
            } else if (m.n429 > 0) {
              fail(city.key, "julisteiden erätulostus",
                `${m.n429} kpl HTTP 429 proxylta kesken erän — purskeraja katkaisee tulostuksen. ${detail}`);
            } else if (m.calls > BATCH_CALL_CEILING) {
              fail(city.key, "julisteiden erätulostus",
                `${m.calls} proxy-kutsua ylittää katon ${BATCH_CALL_CEILING} — kutsumäärä ryömii kohti `
                + "workerin purskerajaa. Selvitä syy, älä nosta kattoa. " + detail);
            } else {
              pass(city.key, "julisteiden erätulostus", detail + ", 0 kpl 429");
            }
          }
        }
      }

      // --- 6c) Junien lähdöt (#/junat): näkymä renderöityy — taulukko TAI aito
      //         tyhjä-viesti; virhetila FAILaa (pelisääntö 4: tyhjä-viesti tulee vain
      //         kun rata.digitraffic vastasi 200 mutta matkustajajunia ei ole listalla,
      //         API-virhe renderöi .error-lohkon). Ei kuluta Digitransit-kiintiötä.
      await page.goto(url("#/junat"), { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
      const railState = await page.waitForFunction(() => {
        const out = document.getElementById("trainsOut");
        if (!out) return null;
        if (out.querySelector(".error")) return "error";
        if (out.querySelector("table tbody tr")) return "rows";
        const p = out.querySelector(":scope > p:not(.muted)");
        return p ? "empty" : null;
      }, { timeout: 30000 }).then(h => h.jsonValue()).catch(() => "timeout");
      if (railState === "rows") {
        const railN = await page.evaluate(() => document.querySelectorAll("#trainsOut tbody tr").length);
        pass(city.key, "junien lähdöt", `${railN} lähtevää junaa (rata.digitraffic)`);
      } else if (railState === "empty") {
        info(city.key, "junien lähdöt", "ei lähteviä junia lähitunteina (näkymä ehjä, API vastasi)");
      } else {
        fail(city.key, "junien lähdöt", "näkymä ei renderöitynyt: " + railState);
      }

      // --- 7) Konsolivirheet koko kaupungin ajolta ---
      // 429 saa oman juurisyyviestin, jottei kiintiöongelma näytä sisältövirheeltä
      // (10.8.2026: "tuntikaaviota ei muodostunut" oli oire, ei vika).
      const realErrors = consoleErrors.filter(e => !e.includes("favicon"));
      const rateLimited = realErrors.some(e => e.includes("429"));
      if (!realErrors.length) {
        pass(city.key, "konsolivirheet", "0 virhettä");
      } else if (rateLimited) {
        fail(city.key, "konsolivirheet",
          `Digitransit-kiintiö (429) ei palautunut ${job.attempt} yrityksellä — kuormaongelma, ei sisältövirhe: `
          + realErrors.slice(0, 2).join(" | ").slice(0, 200));
      } else {
        fail(city.key, "konsolivirheet", realErrors.slice(0, 3).join(" | ").slice(0, 300));
      }
    } catch (e) {
      fail(city.key, "harness", (e.message || String(e)).slice(0, 200));
    }
    // Kontekstin sulkeminen EI saa kaataa ajoa: 10.8.2026 tämä heitti
    // "Target.disposeBrowserContext" Joensuun kohdalla, ja koska close oli
    // per-kaupunki-catchin ulkopuolella, viisi viimeistä kaupunkia jäi kokonaan ajamatta.
    await ctx.close().catch(() => {});

    // Uusinta vain kun 429 tosiasiassa rikkoi jotain: pelkkä varoitus ilman FAILia ei
    // ansaitse toista kierrosta, eikä uusinta saa piilottaa aitoa sisältövirhettä.
    const roundFails = results.slice(mark).filter(r => r.status === "FAIL");
    const quotaBroke = roundFails.some(r => /\b429\b/.test(r.detail || ""));
    if (quotaBroke && job.attempt < MAX_ATTEMPTS) {
      results.length = mark; // hylkää kiintiön pilaaman kierroksen tulokset
      cityRetried.set(city.key, (cityRetried.get(city.key) || 0) + 1);
      queue.push({ city, attempt: job.attempt + 1, notBefore: Date.now() + RETRY_COOLDOWN_MS });
      console.log(`  ↻ [${city.key}] Digitransit 429 → uusinta jonon lopussa `
        + `(yritys ${job.attempt + 1}/${MAX_ATTEMPTS}, jäähdytys ${RETRY_COOLDOWN_MS / 1000} s)\n`);
    } else {
      // Viimeinen yritys ja kiintio hajotti kierroksen: yksi juurisyy-FAIL, ei kymmenta
      // johdannaista. 31.8.2026 Mikkeli tuotti 11 FAILia, ja raportti nimesi juurisyiksi
      // sisaltovikoja ("tarkista CONFIG.centerStopNames (tyhja)") vaikka arvo oli
      // paikallaan ja kaupunki oli vihrea 24.8. ja 28.8. Vaara juurisyy on pahempi kuin
      // ei juurisyyta: se ohjaa korjaamaan tervetta koodia.
      // Ajo pysyy punaisena — 429 ei muutu PASSiksi eika INFOksi — ja PASS/INFO-rivit
      // sailyvat, koska ne ovat oikeita havaintoja (esim. junat tulevat eri rajapinnasta).
      if (quotaBroke) {
        const kept = results.slice(mark).filter(r => r.status !== "FAIL");
        cityQuotaCollapsed.set(city.key, {
          attempt: job.attempt,
          checks: roundFails.map(r => ({ check: r.check, detail: r.detail })),
        });
        results.length = mark;
        results.push(...kept);
        fail(city.key, "kiintio (429)",
          `Digitransit-kiintio ei palautunut ${job.attempt}/${MAX_ATTEMPTS} yrityksella — `
          + `${roundFails.length} tarkistusta jai mittaamatta, ei sisaltovirhe. Tiivistetyt: `
          + roundFails.map(r => r.check).join(", ").slice(0, 220));
      }
      cityDone.add(city.key);
      console.log("");
    }

    // Tauko kaupunkien väliin: tasoittaa kuorman jaetulle Digitransit-avaimelle.
    if (queue.length) await sleep(CITY_GAP_MS);
  }

  await browser.close().catch(() => {});

  // --- Yhteenveto + raporttiartefaktit ---
  process.exit(writeReport() ? 1 : 0);
})().catch(e => {
  console.error("HARNESS ERROR: " + e.message);
  record("(ajo)", "harness", "FAIL", (e.message || String(e)).slice(0, 200));
  writeReport();
  process.exit(1);
});

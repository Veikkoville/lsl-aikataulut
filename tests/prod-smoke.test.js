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
const CITIES = [
  { key: "lahti",   gen: "Lahden",   nightStopId: "Lahti:85811", nightLines: ["91", "96", "97"] },
  { key: "kuopio",  gen: "Kuopion" },
  { key: "salo",    gen: "Salon" },
  { key: "kajaani", gen: "Kajaanin" },
  { key: "vaasa",   gen: "Vaasan",   svTitle: "Busstidtabeller i Vasa" },
  { key: "kotka",   gen: "Kotkan" },
  { key: "raasepori", gen: "Raaseporin", svTitle: "Busstidtabeller i Raseborg" },
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
];

const results = [];
const record = (city, check, status, detail = "") => {
  results.push({ city, check, status, detail });
  console.log(status.padEnd(5) + "[" + city + "] " + check + (detail ? " — " + detail : ""));
};
const pass = (c, k, d) => record(c, k, "PASS", d);
const fail = (c, k, d) => record(c, k, "FAIL", d);
const info = (c, k, d) => record(c, k, "INFO", d);

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

(async () => {
  const searchTime = searchTimeHelsinki();
  console.log("Tuotanto-smoke-vahti · BASE=" + BASE);
  console.log("Reittihaun hakuaika: " + searchTime + " (Europe/Helsinki)\n");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  for (const city of CITIES) {
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
      const eps = await page.evaluate(async () => {
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
        // määränpää: kaukaisin liikennöity pysäkki 4 km sisällä (mielekäs matka, ei sama pysäkki)
        const to = [...nodes].reverse().find(n => n.stop.gtfsId !== from.gtfsId).stop;
        return { from: { gtfsId: from.gtfsId, lat: from.lat, lon: from.lon, name: from.name },
                 to:   { gtfsId: to.gtfsId,   lat: to.lat,   lon: to.lon,   name: to.name } };
      });
      if (!eps) {
        fail(city.key, "reittihaku", "päätepisteitä ei saatu stopsByRadius-kyselyllä");
      } else {
        const enc = p => encodeURIComponent(`${p.lat.toFixed(5)},${p.lon.toFixed(5)},${p.name}`);
        const opts = encodeURIComponent(new URLSearchParams({ t: searchTime }).toString());
        await page.goto(url(`#/reitti/${enc(eps.from)}/${enc(eps.to)}/${opts}`),
          { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
        const itinOk = await page.waitForSelector("details.itin[data-itin]", { timeout: 45000 })
          .then(() => true).catch(() => false);
        if (!itinOk) {
          fail(city.key, "reittihaku", `ei reittiehdotuksia (${eps.from.name} → ${eps.to.name}, t=${searchTime})`);
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
            () => !!document.querySelector("#stopPrintOut .poster-day .poster-line .hourgrid tr"),
            { timeout: 30000 }).then(() => true).catch(() => false);
          if (!posterOk) {
            await page.click("#stopPosterBtn").catch(() => {});
            posterOk = await page.waitForFunction(
              () => !!document.querySelector("#stopPrintOut .poster-day .poster-line .hourgrid tr"),
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
      await page.goto(url("#/tulosteet/kaytava"), { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
      const preOk = await page.waitForSelector("[data-corridor]", { timeout: 30000 }).then(() => true).catch(() => false);
      if (!preOk) {
        fail(city.key, "yhdistetyt suunnat", "käytäväpresettejä ei löytynyt");
      } else {
        await page.click("[data-corridor]");
        await page.click("#corrGo");
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
            // aikajärjestys per taulukko, kaikki rivit; vuorokausiraja sallitaan (GTFS 24:xx+
            // renderöityy "00:xx" taulun lopussa → seuraava aika saa hypätä taaksepäin > 12 h,
            // tulkitaan seuraavaksi päiväksi — sama toleranssi kuin reittihaun assertiossa)
            const sorted = [...document.querySelectorAll("#corridorOut table.corridor")].every(tb => {
              const ts = [...tb.querySelectorAll("tbody tr td:first-child")]
                .map(td => /^(\d{1,2}):(\d{2})/.exec(td.textContent.trim()))
                .filter(Boolean).map(m => (+m[1]) * 60 + (+m[2]));
              let prev = -1;
              for (let v of ts) {
                if (prev >= 0 && v < prev - 720) v += 1440;
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
              sorted,
              nonText: [...document.querySelectorAll("#corridorOut svg, #corridorOut canvas, #corridorOut img")]
                .filter(el => !el.closest(".no-print")).length,
              dots: [...document.querySelectorAll("#corridorOut td")].filter(td => td.textContent.trim() === "·").length,
              legend: !!document.querySelector("#corridorOut .matrix-legend"),
            };
          });
          const wantDirs = city.corridorDirs || 2;
          (corr.distinctLines >= 2 && corr.daytypes >= 1 && corr.dirs >= wantDirs && corr.sorted)
            ? pass(city.key, "yhdistetyt suunnat",
                `${corr.rows} lähtöä, ${corr.distinctLines} linjaa, ${corr.dirs} suuntaa, aikajärjestys OK`)
            : fail(city.key, "yhdistetyt suunnat", "taulukko pielessä: " + JSON.stringify(
                { rows: corr.rows, linjat: corr.distinctLines, suunnat: corr.dirs, daytypes: corr.daytypes, sorted: corr.sorted }));
          corr.nonText === 0
            ? pass(city.key, "käytävä-tuloste", "puhdasta tekstiä (0 svg/canvas/img)")
            : fail(city.key, "käytävä-tuloste", corr.nonText + " ei-tekstielementtiä tulosteessa");
          if (corr.dots > 0) {
            corr.legend ? pass(city.key, "legenda (käytävä)", `${corr.dots} ·-solua + selite`)
                        : fail(city.key, "legenda (käytävä)", `${corr.dots} ·-solua ilman selitettä`);
          } else info(city.key, "legenda (käytävä)", "ei ·-soluja tässä käytävässä (selitettä ei vaadita)");
        }
      }

      // --- 7) Konsolivirheet koko kaupungin ajolta ---
      const realErrors = consoleErrors.filter(e => !e.includes("favicon"));
      realErrors.length
        ? fail(city.key, "konsolivirheet", realErrors.slice(0, 3).join(" | ").slice(0, 300))
        : pass(city.key, "konsolivirheet", "0 virhettä");
    } catch (e) {
      fail(city.key, "harness", (e.message || String(e)).slice(0, 200));
    }
    await ctx.close();
    console.log("");
  }

  await browser.close();

  // --- Yhteenveto + raporttiartefaktit ---
  const failures = results.filter(r => r.status === "FAIL");
  const lines = [];
  lines.push("Tuotanto-smoke-vahti · " + BASE + " · " + new Date().toISOString());
  lines.push("Reittihaun hakuaika: " + searchTime + " (Europe/Helsinki)");
  lines.push("");
  for (const r of results) lines.push(`${r.status.padEnd(5)}[${r.city}] ${r.check}${r.detail ? " — " + r.detail : ""}`);
  lines.push("");
  lines.push(failures.length ? failures.length + " TARKISTUSTA EPÄONNISTUI" : "KAIKKI TARKISTUKSET OK");
  const txt = lines.join("\n") + "\n";
  fs.writeFileSync(path.join(__dirname, "prod-smoke-report.txt"), txt);
  fs.writeFileSync(path.join(__dirname, "prod-smoke-report.json"), JSON.stringify({
    base: BASE, generatedAt: new Date().toISOString(), searchTime,
    failures: failures.length, results,
  }, null, 2) + "\n");
  console.log("\n" + lines[lines.length - 1]);
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR: " + e.message); process.exit(1); });

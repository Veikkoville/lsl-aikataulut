// Savutestit: lataa kaikki näkymät headless-Chromessa paikallista palvelinta
// vasten (BASE, oletus http://localhost:8000), ajaa reittihaun oikealla
// Digitransit-datalla ja tarkistaa keskeiset toiminnot. Kaatuu (exit 1),
// jos jokin tarkistus epäonnistuu tai sivulta tulee konsolivirheitä.
//
// Ajo:  cd tests && npm install && npm test
// Palvelin: python -m http.server 8000 repon juuressa.

const puppeteer = require("puppeteer");

const BASE = process.env.BASE || "http://localhost:8000";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const ok = msg => console.log("OK   " + msg);
const fail = msg => { failures++; console.log("FAIL " + msg); };
const info = msg => console.log("INFO " + msg);

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await browser.defaultBrowserContext().overridePermissions(BASE, ["geolocation"]);
  await page.setGeolocation({ latitude: 60.9833, longitude: 25.6561 }); // Lahden keskusta
  const consoleErrors = [];
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", e => consoleErrors.push(e.message));

  const expect = async (selector, label, timeout = 25000) => {
    try {
      await page.waitForSelector(selector, { timeout });
      ok(label);
      return true;
    } catch (e) {
      fail(label + " — ei löytynyt: " + selector);
      return false;
    }
  };

  // --- Etusivu ---
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  await expect("#routeList li a.item", "etusivu: linjalista latautuu");

  // Ulkoasu: pikavalintaruudukko + jäsennelty footer
  const tiles = (await page.$$(".quick-grid a.quick-tile")).length;
  tiles >= 4 ? ok(`ulkoasu: pikavalintaruudukko (${tiles} korttia)`)
             : fail("ulkoasu: pikavalintaruudukon kortit puuttuvat");
  (await page.$("#appFooter .foot-cols .foot-col a"))
    ? ok("ulkoasu: jäsennelty footer linkkisarakkeineen")
    : fail("ulkoasu: jäsennelty footer puuttuu");

  await page.waitForSelector("#nearbyStart", { timeout: 10000 }).catch(() => {});
  if (await page.$("#nearbyStart")) await page.click("#nearbyStart");
  await expect("#nearbyBody table.deps tr", "etusivu: lähimmät lähdöt paikannuksella");

  // --- Häiriötiedotteet: banneri + lsl.fi-CMS-täydennys (vaatii workerin /cms-alerts) ---
  await page.waitForSelector("#alertsBox details.alert", { timeout: 15000 }).catch(() => {});
  const alertCount = (await page.$$("#alertsBox details.alert")).length;
  alertCount > 0
    ? ok(`etusivu: häiriöbanneri renderöityy (${alertCount} tiedotetta)`)
    : info("etusivu: ei aktiivisia häiriötiedotteita (ei virhe)");
  (await page.$("#alertsBox .alert-src"))
    ? ok("etusivu: lsl.fi-CMS-tiedote mukana bannerissa")
    : info("etusivu: ei CMS-tiedotetta (worker /cms-alerts deployaamatta tai ei tuoreita) — ei virhe");

  // --- Yhdistetty haku: linja, pysäkki ja osoite samasta kentästä ---
  await page.type("#uniSearch", "Matkakeskus", { delay: 25 });
  if (await expect('#searchResults a[href^="#/pysakki/"]', "yhdistetty haku: pysäkkiosumat", 15000)) {
    const cats = await page.evaluate(() =>
      [...document.querySelectorAll("#searchResults .search-cat")].map(e => e.textContent.trim()));
    const hasLines = await page.$('#searchResults a[href^="#/linja/"]');
    const hasPlaces = await page.$('#searchResults button[data-place]');
    (hasLines || hasPlaces)
      ? ok(`yhdistetty haku: useita kategorioita (${cats.join(", ")})`)
      : fail("yhdistetty haku: vain pysäkit, ei linjoja/osoitteita");
  }
  // Pelkkä linjanumero -> linjaosuma
  await page.evaluate(() => { document.querySelector("#uniSearch").value = ""; });
  await page.type("#uniSearch", "3", { delay: 25 });
  await expect('#searchResults a[href^="#/linja/"]', "yhdistetty haku: linjanumero löytää linjan", 15000);

  // --- Reittihaku: kirjoita, valitse ehdotus, hae ---
  await page.goto(BASE + "/#/reitti", { waitUntil: "networkidle2" });
  await page.type("#fromInput", "Matkakeskus", { delay: 25 });
  if (await expect("#fromList button[data-i]", "reittihaku: pysäkkiehdotus", 15000)) {
    await page.click("#fromList button[data-i]");
  }
  await page.type("#toInput", "Mukkulankatu 2", { delay: 25 });
  if (await expect("#toList button[data-i]", "reittihaku: osoite-ehdotus (geokoodaus)", 15000)) {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("#toList button[data-i]")];
      (btns.find(b => b.textContent.includes("Mukkulankatu 2")) || btns[0]).click();
    });
  }
  await page.click("#planForm button[type=submit]");
  if (await expect("details.itin[data-itin]", "reittihaku: reittiehdotuksia löytyy")) {
    await page.click(`details.itin[data-itin="0"] summary`);
    await expect("details.itin[open] .tl-row.pt", "reittihaku: aikajana piirtyy");
    const co2 = await page.evaluate(() => {
      const el = document.querySelector("details.itin[open] p.co2");
      return el ? el.textContent.trim() : null;
    });
    (co2 && /\d/.test(co2)) ? ok(`reittihaku: CO₂-säästöarvio näkyy (${co2.replace(/\s+/g, " ")})`)
                            : info("reittihaku: ei CO₂-riviä (lyhyt bussiosuus?) — ei virhe");
    const mapDrawn = await page.waitForFunction(
      () => !!document.querySelector("details.itin[open] .leaflet-overlay-pane path"),
      { timeout: 12000 }).then(() => true).catch(() => false);
    mapDrawn ? ok("reittihaku: reitti piirtyy kartalle")
             : fail("reittihaku: karttaviiva puuttuu");
  }

  // --- Jaettu linkki käynnistää haun ---
  const shared = BASE + "/#/reitti/" +
    encodeURIComponent("60.97770,25.65710,Matkakeskus") + "/" +
    encodeURIComponent("60.99653,25.66417,Mukkulankatu 2");
  await page.goto(shared, { waitUntil: "networkidle2" });
  await expect("details.itin[data-itin]", "jaettu reittilinkki: haku käynnistyy URL:sta");

  // --- Tallennetut matkat: tallenna nykyinen reitti ja näe se etusivulla ---
  if (await page.$("#saveTripBtn")) {
    await page.evaluate(() => { window.prompt = () => "Testimatka"; });
    await page.click("#saveTripBtn");
    const saved = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem("savedTrips") || "[]").length; } catch (e) { return 0; }
    });
    saved >= 1 ? ok("tallennetut matkat: matka tallentuu") : fail("tallennetut matkat: ei tallentunut");
    await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
    const cardOk = await page.waitForFunction(
      () => { const c = document.getElementById("savedCard"); return c && !c.hidden && document.querySelector(".saved-trip"); },
      { timeout: 10000 }).then(() => true).catch(() => false);
    const connOk = await page.waitForFunction(
      () => { const e = document.getElementById("savedNext0"); return e && !e.textContent.includes("Haetaan"); },
      { timeout: 15000 }).then(() => true).catch(() => false);
    cardOk && connOk ? ok("tallennetut matkat: etusivun kortti + seuraavat yhteydet")
                     : fail("tallennetut matkat: kortti tai yhteydet eivät renderöityneet");
    await page.evaluate(() => { localStorage.removeItem("savedTrips"); }); // siivoa
  }

  // --- Linjasivu ---
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  await page.waitForSelector('#routeList a[href^="#/linja/"]', { timeout: 20000 });
  const routeHref = await page.evaluate(() =>
    document.querySelector('#routeList a[href^="#/linja/"]').getAttribute("href"));
  await page.goto(BASE + "/" + routeHref, { waitUntil: "networkidle2" });
  await expect(".timegrid span, #timetable .muted", "linjasivu: aikataulu");
  const tabText = await page.evaluate(() =>
    document.querySelector(".tabs button")?.textContent || "");
  tabText.includes("→") ? ok("linjasivu: selkokielinen suuntavälilehti")
                        : fail("linjasivu: suuntavälilehdestä puuttuu →");
  const routeMap = await page.waitForFunction(
    () => !!document.querySelector("#routeMap .leaflet-overlay-pane path"),
    { timeout: 12000 }).then(() => true).catch(() => false);
  routeMap ? ok("linjasivu: reittiviiva kartalla") : fail("linjasivu: reittiviiva puuttuu");
  // Lähtömuistutus: kontrolli näkyy kun tänään on tulevia lähtöjä
  const remindUi = await page.waitForFunction(
    () => !!document.querySelector("#remindBox #remindBtn"),
    { timeout: 8000 }).then(() => true).catch(() => false);
  remindUi ? ok("linjasivu: lähtömuistutus-kontrolli näkyy")
           : info("linjasivu: ei tulevia lähtöjä nyt → muistutuskontrollia ei näytetä");

  // --- Pysäkkisivu + linjasuodatin ---
  const stopHref = await page.evaluate(() =>
    document.querySelector('a[href^="#/pysakki/"]')?.getAttribute("href"));
  if (stopHref) {
    await page.goto(BASE + "/" + stopHref, { waitUntil: "networkidle2" });
    await expect("#depRows tr", "pysäkkisivu: lähtölista");
    if (await page.$("#stopRoutes button[data-route]")) {
      const before = await page.evaluate(() => document.querySelectorAll("#depRows tr").length);
      await page.click("#stopRoutes button[data-route]");
      const after = await page.evaluate(() => document.querySelectorAll("#depRows tr").length);
      after <= before ? ok(`pysäkkisivu: linjasuodatin (${before} → ${after} riviä)`)
                      : fail("pysäkkisivu: suodatin ei rajannut listaa");
    } else {
      info("pysäkkisivu: vain yksi linja, suodatinta ei näytetä");
    }
    // Pysäkkijuliste: kokoa tuntikaavio kaikista pysäkin linjoista
    if (await page.$("#stopPosterBtn")) {
      await page.evaluate(() => { window.print = () => {}; });
      await page.click("#stopPosterBtn");
      const posterOk = await page.waitForFunction(
        () => !!document.querySelector("#stopPrintOut .poster-day .poster-line .hourgrid tr"),
        { timeout: 20000 }).then(() => true).catch(() => false);
      const days = await page.evaluate(() =>
        document.querySelectorAll("#stopPrintOut .poster-day").length);
      posterOk && days === 3
        ? ok(`pysäkkijuliste: tuntikaavio kootaan (${days} päivätyyppiä)`)
        : fail(`pysäkkijuliste: tuntikaaviota ei muodostunut (päivätyyppejä ${days})`);
    }
    // QR-koodi: laiska kirjastolataus + canvas + lataus-linkki
    if (await page.$("#stopQrBtn")) {
      await page.click("#stopQrBtn");
      const qrOk = await page.waitForFunction(
        () => { const c = document.querySelector("#stopQr canvas.qrimg"); return c && c.width > 0; },
        { timeout: 15000 }).then(() => true).catch(() => false);
      const hasDl = await page.$("#stopQr a[download]");
      qrOk && hasDl ? ok("QR-koodi: canvas + PNG-latauslinkki")
                    : fail("QR-koodi: koodia tai latauslinkkiä ei muodostunut");
    }
    // Lue ääneen: nappi näkyy (puhesynteesi tuettu)
    (await page.$("#speakBtn"))
      ? ok("pysäkkisivu: lue ääneen -nappi näkyy")
      : info("pysäkkisivu: puhesynteesi ei tuettu → ei lue ääneen -nappia");
    // Jaa / upota: iframe-koodi monitorin URL:iin
    if (await page.$("#stopEmbedBtn")) {
      await page.click("#stopEmbedBtn");
      const embedOk = await page.waitForFunction(
        () => { const ta = document.querySelector("#stopEmbed textarea"); return ta && ta.value.includes("<iframe") && ta.value.includes("/#/monitori/"); },
        { timeout: 8000 }).then(() => true).catch(() => false);
      embedOk ? ok("pysäkkisivu: upotuskoodi (iframe monitoriin)")
              : fail("pysäkkisivu: upotuskoodia ei muodostunut");
    }
    // Pysäkkimonitori / kioski: koko ruudun live-lähtötaulu
    const monitorHref = stopHref.replace("#/pysakki/", "#/monitori/");
    await page.goto(BASE + "/" + monitorHref, { waitUntil: "networkidle2" });
    const monOk = await expect("#mRows tr", "monitori: live-lähtötaulu latautuu");
    const monMode = await page.evaluate(() =>
      document.body.classList.contains("monitor-mode") && !!document.getElementById("mClock"));
    monMode ? ok("monitori: kioskitila päällä (kello + monitor-mode)")
            : fail("monitori: kioskitila ei aktivoitunut");
    // Poistuttaessa kioskitila puretaan
    await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
    const exited = await page.evaluate(() => !document.body.classList.contains("monitor-mode"));
    exited ? ok("monitori: kioskitila puretaan poistuttaessa")
           : fail("monitori: kioskitila jäi päälle");
  }

  // --- Live-kartta: koko verkon bussit reaaliajassa ---
  await page.goto(BASE + "/#/kartta", { waitUntil: "networkidle2" });
  await expect("#liveMap.leaflet-container", "live-kartta: kartta latautuu");
  const busesShown = await page.waitForFunction(
    () => document.querySelectorAll("#liveMap .bus-live").length > 0,
    { timeout: 20000 }).then(() => true).catch(() => false);
  if (busesShown) {
    const n = await page.evaluate(() => document.querySelectorAll("#liveMap .bus-live").length);
    ok(`live-kartta: busseja kartalla (${n})`);
  } else {
    info("live-kartta: ei busseja juuri nyt (ei reaaliaikadataa testihetkellä)");
  }

  // --- Linjaston yleiskartta ---
  await page.goto(BASE + "/#/linjasto", { waitUntil: "networkidle2" });
  await expect("#netMap.leaflet-container", "linjasto: kartta latautuu");
  const linesShown = await page.waitForFunction(
    () => document.querySelectorAll("#netMap path.leaflet-interactive").length > 5,
    { timeout: 25000 }).then(() => true).catch(() => false);
  if (linesShown) {
    const n = await page.evaluate(() => document.querySelectorAll("#netMap path.leaflet-interactive").length);
    ok(`linjasto: linjojen reittiviivat piirtyvät (${n})`);
  } else {
    fail("linjasto: reittiviivoja ei piirtynyt");
  }

  // --- Poikkeuspäivät ---
  await page.goto(BASE + "/#/poikkeukset", { waitUntil: "networkidle2" });
  if (await expect("ul.ex-list li.ex-row", "poikkeuspäivät: lista latautuu")) {
    const n = await page.evaluate(() => document.querySelectorAll("ul.ex-list li.ex-row").length);
    const hasTag = await page.$("ul.ex-list .ex-tag");
    (n > 0 && hasTag) ? ok(`poikkeuspäivät: ${n} päivää, pyhä/aatto-merkinnät`)
                      : fail("poikkeuspäivät: rivit tai merkinnät puuttuvat");
  }

  // --- Palaute / vikailmoitus (lomake + tyhjän validointi, ei lähetetä verkkoon) ---
  await page.goto(BASE + "/#/palaute", { waitUntil: "networkidle2" });
  if (await expect("#fbForm #fbMsg", "palaute: lomake latautuu")) {
    await page.click("#fbForm button[type=submit]");
    const validated = await page.waitForFunction(
      () => { const s = document.querySelector("#fbStatus"); return s && s.textContent.trim().length > 0 && s.classList.contains("error"); },
      { timeout: 5000 }).then(() => true).catch(() => false);
    validated ? ok("palaute: tyhjä viesti estetään (validointi)")
              : fail("palaute: tyhjän viestin validointi ei toiminut");
  }

  // --- Liput ja hinnat ---
  await page.goto(BASE + "/#/liput", { waitUntil: "networkidle2" });
  if (await expect("table.fare", "liput: hinnasto latautuu")) {
    const has295 = await page.evaluate(() => document.body.textContent.includes("2,95"));
    const hasSource = await page.$("a[href*='lsl.fi/liput-ja-hinnat/hinnasto']");
    has295 && hasSource ? ok("liput: kertalippu 2,95 € näkyy + virallinen lähdelinkki")
                        : fail("liput: vahvistettu hinta tai lähdelinkki puuttuu");
  }

  // --- Asetukset + kielenvaihto ---
  await page.goto(BASE + "/#/asetukset", { waitUntil: "networkidle2" });
  await expect("[data-theme-opt]", "asetukset: teemavalitsin");
  if (await page.$('[data-lang-opt="en"]')) {
    await page.click('[data-lang-opt="en"]');
    await sleep(500);
    const langNow = await page.evaluate(() => document.documentElement.lang);
    langNow === "en" ? ok("asetukset: kielenvaihto päivittää lang-attribuutin")
                     : fail("asetukset: lang-attribuutti ei vaihtunut (" + langNow + ")");
    await page.click('[data-lang-opt="fi"]');
  }
  // Tekstikoko (esteettömyys): suurenna ja tarkista että root-fontti kasvaa
  if (await page.$('[data-text-opt="large"]')) {
    const before = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize));
    await page.click('[data-text-opt="large"]');
    await sleep(200);
    const res = await page.evaluate(() => ({
      attr: document.documentElement.dataset.text,
      size: parseFloat(getComputedStyle(document.documentElement).fontSize),
    }));
    res.attr === "large" && res.size > before
      ? ok(`asetukset: suuri teksti kasvattaa fonttia (${before}→${res.size}px)`)
      : fail("asetukset: tekstikoko ei kasvanut");
    await page.click('[data-text-opt="normal"]'); // palauta ettei vaikuta muihin
  }

  // --- Tulostusvihko (monta linjaa) ---
  await page.goto(BASE + "/#/tulosta", { waitUntil: "networkidle2" });
  if (await expect(".lineCb", "tulostusvihko: linjavalinta latautuu")) {
    await page.evaluate(() => { document.querySelector(".lineCb").checked = true; });
    await page.click("#buildBtn");
    if (await expect("#bookletOut .booklet-line table.booklet thead th",
                     "tulostusvihko: aikataulu kootaan isoille pysäkeille")) {
      const cols = await page.evaluate(() =>
        document.querySelector("#bookletOut .booklet-line table.booklet").querySelectorAll("thead th").length);
      cols > 0 && cols <= 12 ? ok(`tulostusvihko: ${cols} isoa pysäkkiä sarakkeina (per taulukko)`)
                             : fail(`tulostusvihko: odoton sarakemäärä (${cols})`);
      const days = await page.evaluate(() =>
        document.querySelectorAll("#bookletOut .booklet-line h4.daytype").length);
      days >= 1 ? ok(`tulostusvihko: viikonpäivätyypit (${days} taulukkoa/linja)`)
                : fail("tulostusvihko: päivätyyppejä ei löytynyt");
    }
  }

  // --- Saavutettavuusseloste ---
  await page.goto(BASE + "/#/saavutettavuus", { waitUntil: "networkidle2" });
  await expect(".card h2", "saavutettavuusseloste avautuu");

  // --- Konsolivirheet ---
  const realErrors = consoleErrors.filter(e => !e.includes("favicon"));
  realErrors.length
    ? fail("konsolivirheitä:\n  " + realErrors.join("\n  "))
    : ok("ei konsolivirheitä");

  await browser.close();
  console.log(failures ? `\n${failures} TARKISTUSTA EPÄONNISTUI` : "\nKAIKKI TARKISTUKSET OK");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR: " + e.message); process.exit(1); });

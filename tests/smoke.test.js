// Savutestit: lataa kaikki näkymät headless-Chromessa paikallista palvelinta
// vasten (BASE, oletus http://localhost:8000), ajaa reittihaun oikealla
// Digitransit-datalla ja tarkistaa keskeiset toiminnot. Kaatuu (exit 1),
// jos jokin tarkistus epäonnistuu tai sivulta tulee konsolivirheitä.
//
// Ajo:  cd tests && npm install && npm test
// Palvelin: python -m http.server 8000 repon juuressa.

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE || "http://localhost:8000";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
let homeDisruptionCount = 0;   // etusivun häiriölohkon määrä → palvelutiskin vertailuun
const ok = msg => console.log("OK   " + msg);
const fail = msg => { failures++; console.log("FAIL " + msg); };
const info = msg => console.log("INFO " + msg);

// Printtihygienia-vartija: paperille saa mennä VAIN koottu tuloste, ei ruutunäkymän
// lohkoja. Ajetaan pysäkkijulisteen kokoamisen jälkeen print-mediaa emuloiden, koska
// ruutu- ja printtinäkymä eroavat vain @media print -säännöissä. Assertio vaatii
// molemmat suunnat: ruutulohkot piilossa JA juliste näkyvissä — muuten liian innokas
// piilotus (koko tulosteen katoaminen) menisi läpi vihreänä.
// Tausta: pysäkkisivun ruutukortti ei ollut no-print → juliste alkoi sivulla jossa luki
// "nyt / 3 min" (tuotannossa 9 kaupungissa 2.8.2026 asti). Ilman tätä vartijaa sama
// palaa seuraavassa printtimuutoksessa eikä kukaan huomaa ennen kuin asiakas tulostaa.
async function printHygiene(page, label) {
  await page.emulateMediaType("print");
  const view = await page.evaluate(() => {
    const vis = el => {
      if (!el) return false;
      for (let e = el; e && e.id !== "app"; e = e.parentElement)
        if (getComputedStyle(e).display === "none") return false;
      return true;
    };
    return {
      lahtolista: vis(document.querySelector("table.deps")),
      ruutukortti: vis(document.querySelector("#app > .card")),
      juliste: vis(document.querySelector("#stopPrintOut .poster-day .hourgrid")),
    };
  });
  await page.emulateMediaType(null);
  (!view.lahtolista && !view.ruutukortti && view.juliste)
    ? ok(`printtihygienia (${label}): tulosteessa vain juliste, ei ruutunäkymän lohkoja`)
    : fail(`printtihygienia (${label}): ${JSON.stringify(view)} ` +
           "(odotus: lahtolista=false, ruutukortti=false, juliste=true)");
}

(async () => {
  // Lähdekoodi-tarkistus: em dash (—, U+2014) ei saa esiintyä UI-stringeissä eikä muissa
  // koodiliteraaleissa. Sallitaan vain kommenteissa (kehittäjähuomiot) — ne riisutaan ennen
  // tarkistusta. En dash (–, U+2013) aikaväleissä säilyy koskemattomana (ei tarkisteta).
  {
    let src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const stripped = src
      .replace(/<!--[\s\S]*?-->/g, " ")        // HTML-kommentit
      .replace(/\/\*[\s\S]*?\*\//g, " ")        // lohkokommentit (CSS + JS)
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");    // rivikommentit (ei katkaise ://-URLeja)
    const em = (stripped.match(/—/g) || []).length;
    if (em === 0) ok("lähdekoodi: ei em dashia (—) UI-stringeissä/literaaleissa");
    else {
      const lines = stripped.split("\n").map((l, i) => l.includes("—") ? (i + 1) + ": " + l.trim().slice(0, 80) : null).filter(Boolean);
      fail(`lähdekoodi: em dash (—) ${em} kpl koodiliteraaleissa — käytä kaksoispistettä/pilkkua/lausejakoa: ` + lines.slice(0, 5).join(" | "));
    }
  }

  const browser = await puppeteer.launch({
    headless: "new",
    // CHROME_ARGS: valinnaiset lisäliput rinnakkaisajoihin (esim. --proxy-server, kun portti 8000
    // on toisen worktreen käytössä ja workerin ALLOWED_ORIGINS sallii vain localhost:8000).
    args: ["--no-sandbox", "--disable-dev-shm-usage",
           ...(process.env.CHROME_ARGS || "").split(/\s+/).filter(Boolean)],
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
  await expect("#routeList li a.route-tile .rt-badge", "etusivu: linjalista (badge-ruudukko) latautuu");

  // Etusivun uudistus: hero-reittihaku + työkalurivi (inline-SVG-ikonit) + jäsennelty footer
  (await page.$("#homeFromInput") && await page.$("#homeToInput") && await page.$("#heroSearch"))
    ? ok("etusivu: hero-reittihaku (Mistä/Minne/Hae yhteydet) latautuu")
    : fail("etusivu: hero-reittihaku puuttuu");
  // Layer-hero reittiopaskaupungilla (Lahti = oletuskaupunki): arvolupaus + nostot (kielenvaihto +
  // tulosteet) ja A->B SÄILYY toissijaisena alaosiona.
  const layer = await page.evaluate(() => {
    const h = document.querySelector(".reila-hero.hero-layer"); if (!h) return null;
    return { hls: h.querySelectorAll(".hero-highlights .hl").length, bilingual: !!document.getElementById("hlBilingual"),
      print: !!document.querySelector('.hl[href="#/tulosteet/vihko"]'),
      journeyFields: !!document.querySelector(".hero-journey #homeFromInput") };
  });
  (layer && layer.hls >= 2 && layer.bilingual && layer.print && layer.journeyFields)
    ? ok(`etusivu (Lahti, layer): arvolupaus-hero + ${layer.hls} nostoa + A->B toissijaisena`)
    : fail("etusivu (Lahti, layer): layer-hero puuttuu/vajaa: " + JSON.stringify(layer));
  // Journey-hero greenfield-kaupungilla (Salo): ei layer-osiota, A->B ensisijaisena
  await page.goto(BASE + "/?city=salo#/", { waitUntil: "networkidle2" });
  const journey = await page.evaluate(() => ({
    noLayer: !document.querySelector(".hero-layer"), hero: !!document.querySelector(".reila-hero .reila-hero-h1"),
    fields: !!document.getElementById("homeFromInput") && !!document.getElementById("heroSearch") }));
  (journey.noLayer && journey.hero && journey.fields)
    ? ok("etusivu (Salo, journey): A->B-vetoinen hero ennallaan (ei layer-osiota)")
    : fail("etusivu (Salo, journey): hero väärin: " + JSON.stringify(journey));
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" }); // palauta oletuskaupunki (Lahti)
  // Pikavalinnat ryhmiteltyinä (otsikoitu .tool-group); EI tyhjää ryhmää (jokaisessa ≥1 nappi)
  const groups = await page.evaluate(() => [...document.querySelectorAll(".tool-group")].map(g => ({
    title: g.querySelector(".tool-group-h")?.textContent.trim() || "",
    tools: g.querySelectorAll("a.tool").length,
    svg: g.querySelectorAll("a.tool svg.ic").length,
  })));
  (groups.length >= 2 && groups.every(g => g.title && g.tools > 0 && g.svg === g.tools))
    ? ok(`etusivu: pikavalinnat ryhmitelty, ei tyhjää ryhmää (${groups.map(g => g.title + ":" + g.tools).join(", ")})`)
    : fail("etusivu: ryhmittely puuttuu / tyhjä ryhmä näkyvissä / ikoni puuttuu: " + JSON.stringify(groups));
  // Yksi haku: kompakti .home-search (uniSearch) — ei erillistä isoa "Haku"-korttia eikä "Lähellä"-nappia
  const oneSearch = await page.evaluate(() =>
    !!document.querySelector(".home-search #uniSearch") && !document.querySelector("#nearbyBtn"));
  oneSearch ? ok("etusivu: yksi kompakti haku (ei toista hakulaatikkoa / erillistä Lähellä-nappia)")
            : fail("etusivu: kompakti haku puuttuu tai vanha Lähellä-nappi yhä olemassa");
  (await page.$("#appFooter .foot-cols .foot-col a"))
    ? ok("etusivu: jäsennelty footer linkkisarakkeineen")
    : fail("etusivu: jäsennelty footer puuttuu");

  await page.waitForSelector("#nearbyBtn2", { timeout: 10000 }).catch(() => {});
  if (await page.$("#nearbyBtn2")) await page.click("#nearbyBtn2");
  await expect("#nearbyBody table.deps tr", "etusivu: lähimmät lähdöt napista (haun vieressä)");

  // Esteettömyys: "vain esteettömät pysäkit" -suodatin lähimmät-listassa
  (await page.$("#nearbyBody #accOnly"))
    ? ok("esteettömyys: lähimmät-listan esteettömyyssuodatin näkyy")
    : fail("esteettömyys: esteettömyyssuodatin puuttuu");

  // --- Häiriöt vs. tiedotteet -erottelu: kiireelliset häiriöt korostettu/auki, informatiiviset
  //     tiedotteet vaimennettu/kiinni (sääntö B). Lahdella on aina ≥1 kumpaakin (esim. Kytölä-
  //     detour = häiriö; "Linja 81 palvelubussi" / "Linjasto uudistui" = tiedote). ---
  await page.waitForSelector("#alertsBox details", { timeout: 15000 }).catch(() => {});
  const banner = await page.evaluate(() => {
    const dis = document.querySelector("#alertsBox details.alertsum");
    const inf = document.querySelector("#alertsBox details.infosum");
    return {
      disCount: dis ? dis.querySelectorAll(".alert").length : 0, disOpen: dis ? dis.open : null,
      infCount: inf ? inf.querySelectorAll(".alert").length : 0, infOpen: inf ? inf.open : null,
      hasSrc: !!document.querySelector("#alertsBox .alert-src"),
    };
  });
  homeDisruptionCount = banner.disCount;
  (banner.disCount > 0 && banner.disOpen === true)
    ? ok(`etusivu: kiireelliset häiriöt korostettu ja auki (${banner.disCount})`)
    : fail("etusivu: häiriölohko (.alertsum) puuttuu tai ei oletuksena auki: " + JSON.stringify(banner));
  (banner.infCount > 0 && banner.infOpen === false)
    ? ok(`etusivu: informatiiviset tiedotteet vaimennettu ja kiinni (${banner.infCount})`)
    : fail("etusivu: tiedotelohko (.infosum) puuttuu tai ei oletuksena kiinni: " + JSON.stringify(banner));
  banner.hasSrc
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
    // anna tuloslistan asettua ja avaa ensimmäinen sivun sisäisellä klikkauksella —
    // kestää uudelleenrenderöinnin (mm. linjadatan latautuessa) ilman "node detached" -flakea
    await sleep(800);
    await page.evaluate(() => { const s = document.querySelector('details.itin[data-itin="0"] summary'); if (s) s.click(); });
    await expect("details.itin[open] .tl-row.pt", "reittihaku: aikajana piirtyy");
    const co2 = await page.evaluate(() => {
      const el = document.querySelector("details.itin[open] p.co2");
      return el ? el.textContent.trim() : null;
    });
    (co2 && /\d/.test(co2)) ? ok(`reittihaku: CO₂-säästöarvio näkyy (${co2.replace(/\s+/g, " ")})`)
                            : info("reittihaku: ei CO₂-riviä (lyhyt bussiosuus?) — ei virhe");
    // Odota ensin kartan alustus, sitten reittiviiva. Viivan piirtyminen riippuu
    // Leafletin asynkronisesta valmiudesta → ohitus on INFO (ei fail), koska sama
    // polyline-piirto katetaan erikseen testillä "linjasivu: reittiviiva kartalla".
    await page.waitForSelector("details.itin[open] .leaflet-container", { timeout: 12000 }).catch(() => {});
    const mapDrawn = await page.waitForFunction(
      () => !!document.querySelector("details.itin[open] .leaflet-overlay-pane path"),
      { timeout: 22000 }).then(() => true).catch(() => false);
    mapDrawn ? ok("reittihaku: reitti piirtyy kartalle")
             : info("reittihaku: karttaviiva ei ehtinyt piirtyä (Leaflet-ajoitus) — ei virhe");
  }

  // --- Jaettu linkki käynnistää haun ---
  const shared = BASE + "/#/reitti/" +
    encodeURIComponent("60.97770,25.65710,Matkakeskus") + "/" +
    encodeURIComponent("60.99653,25.66417,Mukkulankatu 2");
  await page.goto(shared, { waitUntil: "networkidle2" });
  await expect("details.itin[data-itin]", "jaettu reittilinkki: haku käynnistyy URL:sta");

  // --- Etusivun hero-reittihaku: Mistä/Minne → "Hae yhteydet" → reittinäkymä ---
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  await page.waitForSelector("#homeFromInput", { timeout: 10000 }).catch(() => {});
  await page.type("#homeFromInput", "Matkakeskus", { delay: 25 });
  if (await expect("#homeFromList button[data-i]", "etusivu hero: lähtö-ehdotus", 15000)) {
    await page.click("#homeFromList button[data-i]");
    await page.type("#homeToInput", "Mukkulankatu 2", { delay: 25 });
    if (await expect("#homeToList button[data-i]", "etusivu hero: määränpää-ehdotus", 15000)) {
      await page.click("#homeToList button[data-i]");
      await page.click("#heroSearch");
      await expect("details.itin[data-itin]", "etusivu hero: 'Hae yhteydet' avaa reittiehdotukset", 20000);
    }
  }

  // --- Luonnollisen kielen syöttö (paikallinen jäsennys) + puhe ---
  // Jäsennin-yksikkötestit: deterministinen, selaimessa, ei verkkoa (FI/EN/SV-lauseet)
  const nlCases = [
    ["from Matkakeskus to Kauppatori at 14:30", "Matkakeskus", "Kauppatori", "14:30"],
    ["Matkakeskus -> Kauppatori", "Matkakeskus", "Kauppatori", null],
    ["paikasta Matkakeskus paikkaan Kauppatori", "Matkakeskus", "Kauppatori", null],
    ["från Matkakeskus till Kauppatori", "Matkakeskus", "Kauppatori", null],
    ["Kauppatorilta Asemalle", "Kauppatori", "Asema", null],
    ["Salosta Turkuun klo 9", "Salo", "Turku", "09:00"],
    ["haluan mennä Kauppatorilta Asemalle", "Kauppatori", "Asema", null],
    // puhutut SV/EN-muodot (mikrofoni tiskillä): käänteinen to/from, kohteliaisuudet, intent-alut
    ["how do I get to Kauppatori from Matkakeskus", "Matkakeskus", "Kauppatori", null],
    ["I need to get from Matkakeskus to Kauppatori please", "Matkakeskus", "Kauppatori", null],
    ["hur kommer jag till Kauppatori från Matkakeskus", "Matkakeskus", "Kauppatori", null],
    ["jag ska åka från Matkakeskus till Kauppatori tack", "Matkakeskus", "Kauppatori", null],
  ];
  let nlPass = 0;
  for (const [snt, ef, et, etime] of nlCases) {
    const r = await page.evaluate(x => parseNlTrip(x), snt);
    (r && r.from === ef && r.to === et && (r.time || null) === etime) ? nlPass++
      : console.log("INFO NL-jäsennys poikkeama: " + snt + " → " + JSON.stringify(r));
  }
  nlPass === nlCases.length ? ok(`NL-jäsennys: ${nlPass}/${nlCases.length} lausetta oikein (FI/EN/SV + aika)`)
                            : fail(`NL-jäsennys: vain ${nlPass}/${nlCases.length} oikein`);
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  // Yhtenäinen haku: ei erillistä NL-lohkoa eikä "— tai —"; mic on Mistä-kentän sisällä
  const unified = await page.evaluate(() => !document.getElementById("homeNlInput") && !document.querySelector(".nl-sep")
    && !!document.querySelector(".suggest.with-mic #homeFromInput"));
  unified ? ok("etusivu: yksi yhtenäinen haku (mic Mistä-kentässä, ei kahta lohkoa)")
          : fail("etusivu: yhtenäinen haku puuttuu (NL-lohko/erotin yhä?)");
  const srOk = await page.evaluate(() => !!(window.SpeechRecognition || window.webkitSpeechRecognition));
  const micThere = !!(await page.$(".field-mic#homeNlMic"));
  (srOk ? micThere : !micThere)
    ? ok(`NL: kentän mic ${srOk ? "näkyy (tuettu)" : "piilotettu siististi (ei tuettu)"}`)
    : fail("NL: mikrofonin degradointi väärin");
  // Mistä-kenttä hyväksyy koko lauseen → jäsentää + ajaa haun
  await page.type("#homeFromInput", "from Matkakeskus to Mukkulankatu 2", { delay: 20 });
  await page.keyboard.press("Enter");
  await expect("details.itin[data-itin]", "etusivu: koko lause Mistä-kentässä ajaa reittihaun", 20000);

  const deskAccent = () => page.evaluate(() => {
    const el = document.querySelector(".desk");
    return el ? getComputedStyle(el).getPropertyValue("--blue").trim().toLowerCase() : "";
  });
  // --- Palvelutiski-tila (#/palvelutiski): A→B + pysäkin linjat työntekijälle ---
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  (await page.$('#appFooter a[href="#/palvelutiski"]'))
    ? ok("palvelutiski: footer-linkki näkyy")
    : fail("palvelutiski: footer-linkki puuttuu");
  await page.goto(BASE + "/#/palvelutiski", { waitUntil: "networkidle2" });
  const deskOk = await page.evaluate(() =>
    document.body.classList.contains("desk-mode") &&
    !!document.getElementById("deskFrom") && !!document.getElementById("deskTo") && !!document.getElementById("deskStop"));
  deskOk ? ok("palvelutiski: koko ruudun näkymä + kentät latautuvat")
         : fail("palvelutiski: näkymä/kentät puuttuvat");
  // Puheen kieli FI/SV/EN: valinta muistetaan ja ohjaa mikrofonin localea + ääneenluvun kieltä
  const sl = await page.evaluate(() => {
    const btns = [...document.querySelectorAll(".desk .nl-field .nl-langs button")];
    const before = btns.find(b => b.getAttribute("aria-pressed") === "true")?.dataset.slang;
    btns.find(b => b.dataset.slang === "sv")?.click();
    const pressedSv = btns.find(b => b.dataset.slang === "sv")?.getAttribute("aria-pressed") === "true";
    const stored = localStorage.getItem("speechLang");
    const locale = SPEECH_LOCALE[currentSpeechLang()];
    const spoken = tIn(currentSpeechLang(), "speakNow");
    setSpeechLang("");                                  // palauta oletus: seuraa UI-kieltä
    return { n: btns.length, before, pressedSv, stored, locale, spoken, after: localStorage.getItem("speechLang") };
  });
  (sl.n === 3 && sl.before === "fi" && sl.pressedSv && sl.stored === "sv" && sl.locale === "sv-SE" && sl.spoken === "avgår nu" && sl.after === null)
    ? ok("palvelutiski: puheen kieli FI/SV/EN (SV → sv-SE, ääneenluku ruotsiksi, muistetaan, palautuu)")
    : fail("palvelutiski: puheen kielivalinta pielessä: " + JSON.stringify(sl));
  // Tiskin aksentti: Lahdella ei ole CONFIG.brandColoria, joten se pysyy .desk-lohkon
  // oletussinisessä. Pari Vaasan tarkistukselle alempana: brändiväri saa vaihtaa tämän,
  // mutta ei brändittömässä kaupungissa.
  const lDeskAccent = await deskAccent();
  (lDeskAccent === "#0033cc")
    ? ok("palvelutiski (Lahti, ei brandColoria): aksentti pysyy oletussinisenä")
    : fail(`palvelutiski (Lahti): odotettu oletussininen #0033cc, saatiin "${lDeskAccent}"`);
  // "Aktiiviset häiriöt" näyttää VAIN HÄIRIÖ-luokan (ei informatiivisia tiedotteita): määrän
  // on täsmättävä etusivun häiriölohkoon (ei etusivun tiedotelohkoa).
  await page.waitForFunction(() => {
    const a = document.getElementById("deskAlerts");
    return a && !/Haetaan|Loading|Hämtar/.test(a.textContent);   // lataus valmis
  }, { timeout: 15000 }).catch(() => {});
  const deskAlertCount = await page.evaluate(() => document.querySelectorAll("#deskAlerts .alert").length);
  (deskAlertCount === homeDisruptionCount)
    ? ok(`palvelutiski: 'Aktiiviset häiriöt' näyttää vain häiriöt (${deskAlertCount} = etusivun häiriöt, ei tiedotteita)`)
    : fail(`palvelutiski: häiriömäärä ${deskAlertCount} ≠ etusivun häiriölohko ${homeDisruptionCount} (vuotaako tiedotteita?)`);
  // Näppäinflow: lähtö → Enter (valitsee ylimmän + siirtää määränpäähän) → Enter ajaa haun
  await page.click("#deskFrom");
  await page.type("#deskFrom", "Matkakeskus", { delay: 25 });
  if (await expect("#deskFromList button[data-i]", "palvelutiski: lähtö-ehdotus", 15000)) {
    await page.keyboard.press("Enter");
    await sleep(300);
    await page.type("#deskTo", "Mukkulankatu 2", { delay: 25 });
    if (await expect("#deskToList button[data-i]", "palvelutiski: määränpää-ehdotus", 15000)) {
      await page.keyboard.press("Enter");
      const tell = await expect(".desk-tell .desk-tell-body", "palvelutiski: 'Kerro asiakkaalle' -yhteenveto näkyy", 20000);
      const opts = (await page.$$(".desk-opt")).length;
      opts > 0 ? ok(`palvelutiski: yhteysvaihtoehdot (${opts})`) : fail("palvelutiski: vaihtoehtoja ei näy");
      const busRef = await page.evaluate(() => document.querySelectorAll("#deskResults .badge, #deskResults .desk-next-bus").length);
      busRef > 0 ? ok("palvelutiski: tulos sisältää aina bussiviittauksen (badge tai 'Seuraava bussi')")
                 : fail("palvelutiski: bussiviittaus puuttuu tuloksesta");
      if (tell) {
        const stops = await page.evaluate(() => {
          const d = document.querySelector(".desk-opt details.desk-stops"); if (d) d.open = true;
          return document.querySelectorAll(".desk-stoplist li").length;
        });
        stops > 0 ? ok(`palvelutiski: pysäkit reitillä listautuvat (${stops})`)
                  : info("palvelutiski: pysäkkilista tyhjä (lyhyt reitti?) — ei virhe");
      }
    }
  }
  // --- Palvelutiski: "tulosta aikataulu asiakkaalle" (lisätty 24.8.2026) ---
  // Myyntimateriaali on väittänyt tätä ominaisuutta, mutta sitä ei ollut olemassa:
  // tiskiltä piti siirtyä pysäkkisivulle tulostaakseen. Vartija on tässä siksi, ettei
  // väite ja tuote pääse enää eroamaan toisistaan.
  await page.click("#deskStop");
  await page.type("#deskStop", "Matkakeskus", { delay: 25 });
  if (await expect("#deskStopList button[data-s]", "palvelutiski: pysäkkiehdotus", 15000)) {
    await page.click("#deskStopList button[data-s]");
    if (await expect("#deskPrintBtn", "palvelutiski: tulostusnappi näkyy pysäkin kohdalla", 15000)) {
      await page.evaluate(() => { window.print = () => {}; });
      await page.click("#deskPrintBtn");
      const printed = await page.waitForFunction(
        () => !!document.querySelector("#deskPrintOut .poster-day .hourgrid tr"),
        { timeout: 90000 }).then(() => true).catch(() => false);
      if (!printed) {
        fail("palvelutiski: tulostettava aikataulu ei koostunut 90 s kuluessa");
      } else {
        // @page-sääntö asetetaan runPrintJob:ssa kahden requestAnimationFrame-kierroksen
        // takana, eli vasta sen jälkeen kun tulosteen rivit ovat jo DOMissa. Ilman tätä
        // odotusta headless-ajo lukee tyhjän #pageOrientin ja mitoitusvartija kaatuu
        // vaikka tuloste on oikein (CI 24.8.2026).
        await page.waitForFunction(
          () => !!document.getElementById("pageOrient")?.textContent,
          { timeout: 15000 }).catch(() => {});
        const dp = await page.evaluate(() => ({
          paivablokit: document.querySelectorAll("#deskPrintOut .poster-day").length,
          linjat: new Set([...document.querySelectorAll("#deskPrintOut .poster-line h4 .badge")]
            .map(b => b.textContent.trim())).size,
          // lehtitelineen mitoitus: sovellus asettaa @page-säännön itse
          orient: document.getElementById("pageOrient")?.textContent || "",
        }));
        (dp.paivablokit >= 1 && dp.linjat >= 1)
          ? ok(`palvelutiski: aikataulu tulostuu tiskiltä (${dp.paivablokit} päiväblokkia, ${dp.linjat} linjaa)`)
          : fail(`palvelutiski: tuloste tyhjä: ${JSON.stringify(dp)}`);
        /portrait/.test(dp.orient) && /8mm/.test(dp.orient)
          ? ok("palvelutiski: tuloste on lehtitelineen mitoituksessa (A4 pysty, tiukat marginaalit)")
          : fail(`palvelutiski: väärä sivumitoitus: ${JSON.stringify(dp.orient)}`);
        // Printtihygienia: paperille ei saa mennä hakukenttiä eikä live-listaa
        await page.emulateMediaType("print");
        const hy = await page.evaluate(() => {
          const vis = el => {
            if (!el) return false;
            for (let e = el; e && e.id !== "app"; e = e.parentElement)
              if (getComputedStyle(e).display === "none") return false;
            return true;
          };
          return {
            tiskinaykyma: vis(document.querySelector(".desk")),
            hakukentta: vis(document.getElementById("deskStop")),
            tuloste: vis(document.querySelector("#deskPrintOut .poster-day .hourgrid")),
          };
        });
        await page.emulateMediaType(null);
        (!hy.tiskinaykyma && !hy.hakukentta && hy.tuloste)
          ? ok("printtihygienia (palvelutiski): tulosteessa vain aikataulu, ei tiskinäkymää")
          : fail(`printtihygienia (palvelutiski): ${JSON.stringify(hy)} ` +
                 "(odotus: tiskinaykyma=false, hakukentta=false, tuloste=true)");
      }
    }
  }

  // Yksikkötestit: "seuraava bussi vaikka kävely voittaa" -logiikka synteettisillä nodeilla
  const nb = await page.evaluate(() => {
    const walk = { start: "2026-06-23T12:00:00+03:00", end: "2026-06-23T12:15:00+03:00", numberOfTransfers: 0,
      legs: [{ mode: "WALK", start: { scheduledTime: "2026-06-23T12:00:00+03:00" }, end: { scheduledTime: "2026-06-23T12:15:00+03:00" }, from: { name: "Origin" }, to: { name: "Destination" }, route: null }] };
    const bus = { start: "2026-06-23T12:05:00+03:00", end: "2026-06-23T12:25:00+03:00", numberOfTransfers: 0,
      legs: [
        { mode: "WALK", start: { scheduledTime: "2026-06-23T12:05:00+03:00" }, end: { scheduledTime: "2026-06-23T12:07:00+03:00" }, from: { name: "Origin" }, to: { name: "Matkakeskus" }, route: null },
        { mode: "BUS", start: { scheduledTime: "2026-06-23T12:10:00+03:00" }, end: { scheduledTime: "2026-06-23T12:23:00+03:00" }, from: { name: "Matkakeskus D" }, to: { name: "Kauppatori" }, route: { shortName: "32", color: "0a4ea3", textColor: "ffffff" } }] };
    return {
      walkHasNoBus: firstTransitLeg(walk) === null,
      busLine: firstTransitLeg(bus) && firstTransitLeg(bus).route.shortName,
      soonestIsBus: soonestBusNode([walk, bus]) === bus,
      tellWithBus: deskTellHtml([walk], bus),
      tellNoBus: deskTellHtml([walk], null),
      cardWithBus: deskNextBusHtml(bus),
      cardNoBus: deskNextBusHtml(null),
    };
  });
  const nbPass = nb.walkHasNoBus && nb.busLine === "32" && nb.soonestIsBus
    && /32/.test(nb.tellWithBus) && /Matkakeskus D/.test(nb.tellWithBus) && /(nopein|fastest|snabbast)/i.test(nb.tellWithBus)
    && /(ei bussivuoroja|no bus|inga bussturer)/i.test(nb.tellNoBus)
    && /class="badge"/.test(nb.cardWithBus) && /32/.test(nb.cardWithBus) && /Matkakeskus D/.test(nb.cardWithBus)
    && /(ei bussivuoroja|no bus|inga bussturer)/i.test(nb.cardNoBus);
  nbPass ? ok("palvelutiski: 'seuraava bussi' -logiikka (kävely voittaa → bussi näkyy; ei bussia → selkeä viesti)")
         : fail("palvelutiski: 'seuraava bussi' -logiikka virheellinen: " + JSON.stringify(nb).slice(0, 300));

  // Pysäkin lähdöt nyt (live) + linjat -pikahaku
  await page.click("#deskStop");
  await page.type("#deskStop", "Matkakeskus", { delay: 25 });
  if (await expect("#deskStopList button[data-s]", "palvelutiski: pysäkkiehdotus (linjat)", 15000)) {
    await page.keyboard.press("Enter");
    // Pysäkin valinta hakee live-lähdöt (DESK_DEPS_QUERY) ja näyttää linjat-rivin niiden seasta.
    // Linjat tulevat stop.routes-kentästä → aikariippumaton ja vakaa assertio.
    const lines = await page.waitForFunction(
      () => document.querySelectorAll(".desk-deps-lines .badge").length > 0,
      { timeout: 12000 }).then(() => true).catch(() => false);
    lines ? ok("palvelutiski: pysäkin live-lähdöt + linjat listautuvat") : fail("palvelutiski: pysäkin linjat eivät listaudu");
  }
  // Juna + bussi samassa näkymässä (14.8.2026): tiskillä kysytään molempia, ja Lahti on
  // juna+bussi-solmu. Data rata.digitraffic.fi:stä suoraan selaimesta → ei Digitransit-kiintiötä.
  // Assertio vaatii rivejä JA että sarakeotsikot ovat paikallaan (pelkkä lohkon olemassaolo
  // menisi läpi myös virheviestillä).
  const dTrains = await page.waitForFunction(
    () => document.querySelectorAll("#deskTrains table tbody tr").length > 0,
    { timeout: 20000 }).then(() => true).catch(() => false);
  const dTrainInfo = await page.evaluate(() => ({
    rows: document.querySelectorAll("#deskTrains table tbody tr").length,
    heads: document.querySelectorAll("#deskTrains table thead th").length,
    txt: (document.getElementById("deskTrains")?.textContent || "").trim().slice(0, 60),
  }));
  (dTrains && dTrainInfo.heads === 4)
    ? ok(`palvelutiski: junalähdöt lohkossa (${dTrainInfo.rows} junaa, rata.digitraffic)`)
    : fail("palvelutiski: junalähdöt eivät renderöityneet: " + JSON.stringify(dTrainInfo));
  // Poistuminen purkaa koko ruudun tilan
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  (await page.evaluate(() => document.body.classList.contains("desk-mode")))
    ? fail("palvelutiski: desk-mode ei purkaudu poistuttaessa")
    : ok("palvelutiski: desk-mode purkautuu poistuttaessa");

  // Työkalunappien teksti ei saa katketa KESKEN SANAN. Rivitys sanavälistä on kunnossa
  // ("Bussit kartalla (live)" saa olla kahdella rivillä); sanan sisäinen katkos ei ole
  // ("Uusintapainatuslist|a", löydetty tuotannosta 14.8.2026). Syy on `.tool span`in
  // `overflow-wrap: anywhere`, joka on siellä estämässä reunan yli valumista — se ei siis
  // ole poistettavissa, joten tekstin on mahduttava. Mitataan merkkikohtaisilla Rangeilla
  // eikä silmämääräisesti: leveys yksin ei kerro mistä rivi katkeaa.
  // Katkos yhdysmerkin JÄLKEEN on sallittu (tyypografinen katkopaikka); jos sitäkään ei
  // haluta, käytä sitovaa yhdysmerkkiä U+2011 kuten SV "e‑post".
  // Kolme kieltä ja neljä leveyttä, koska ongelma on kielikohtainen: 14.8. rikki olivat
  // FI "Uusintapainatuslista" ja SV "Störningsmeddelanden", EN oli puhdas.
  const midWordBreaks = () => page.evaluate(() => {
    const out = [];
    for (const s of document.querySelectorAll(".tool span")) {
      const t = s.firstChild;
      if (!t || t.nodeType !== 3) continue;
      const txt = t.textContent;
      const r = document.createRange();
      let prevY = null;
      for (let i = 0; i < txt.length; i++) {
        r.setStart(t, i); r.setEnd(t, i + 1);
        const y = Math.round(r.getBoundingClientRect().top);
        if (prevY !== null && y !== prevY) {
          const before = txt[i - 1], at = txt[i];
          if (before !== " " && at !== " " && before !== "-" && before !== "‑")
            out.push(txt.slice(0, i) + "|" + txt.slice(i));
          break;
        }
        prevY = y;
      }
    }
    return out;
  });
  const wrapFails = [];
  for (const lang of ["fi", "en", "sv"]) {
    await page.goto(BASE + "/?city=lahti#/", { waitUntil: "networkidle2" });
    if (lang !== "fi") {
      await page.click(`[data-lang-opt="${lang}"]`).catch(() => {});
      await page.waitForFunction(l => document.documentElement.lang === l, { timeout: 10000 }, lang).catch(() => {});
    }
    for (const w of [1400, 1000, 800, 480]) {
      await page.setViewport({ width: w, height: 900 });
      await new Promise(r => setTimeout(r, 200));
      for (const b of await midWordBreaks()) wrapFails.push(`${lang} ${w}px: ${b}`);
    }
  }
  await page.setViewport({ width: 1280, height: 900 });
  wrapFails.length === 0
    ? ok("etusivun työkalunapit: 0 sanan sisäistä rivikatkoa (fi/en/sv × 4 leveyttä)")
    : fail("etusivun työkalunapit katkeavat kesken sanan: " + wrapFails.slice(0, 4).join("  ·  "));

  // CONFIG-gating etusivulla molempiin suuntiin. Vaasa: EI fares → lippunappi pois, mutta
  // hubs LISÄTTIIN 14.8.2026 → laiturinappi on. Joensuu: ei hubs eikä fares (feedissä ei ole
  // laiturijaollista terminaalia) → molemmat napit pois. Ryhmät renderöityvät silti ILMAN
  // tyhjää otsikkoa (jokaisessa ≥1 nappi), ja etusivulla on yksi haku.
  // Kaksisuuntaisuus on tarkoituksellinen: pelkkä "nappi puuttuu" -testi menisi läpi myös
  // silloin kun nappi puuttuisi kaikilta, eli gating olisi rikki toiseen suuntaan.
  const homeTools = () => page.evaluate(() => ({
    groups: [...document.querySelectorAll(".tool-group")].map(g => ({
      title: g.querySelector(".tool-group-h")?.textContent.trim() || "", tools: g.querySelectorAll("a.tool").length })),
    hasFaresTool: !!document.querySelector('a.tool[href="#/liput"]'),
    hasHubTool: !!document.querySelector('a.tool[href="#/laiturit"]'),
    oneSearch: !!document.querySelector(".home-search #uniSearch") && !document.querySelector("#nearbyBtn"),
  }));
  // Joensuu ensin ja Vaasa jälkimmäisenä: seuraava tarkistus (Vaasan brändiväri) lukee
  // saman sivun tilan, joten sivu on jätettävä Vaasaan.
  await page.goto(BASE + "/?city=joensuu#/", { waitUntil: "networkidle2" });
  const jHome = await homeTools();
  (jHome.groups.length >= 2 && jHome.groups.every(g => g.title && g.tools > 0)
    && !jHome.hasFaresTool && !jHome.hasHubTool && jHome.oneSearch)
    ? ok(`etusivu (Joensuu, minimi-CONFIG): hubs/fares-napit pois (${jHome.groups.map(g => g.title + ":" + g.tools).join(", ")})`)
    : fail("etusivu (Joensuu): tyhjä/puuttuva ryhmä / hubs|fares-nappi yhä / haku rikki: " + JSON.stringify(jHome));
  await page.goto(BASE + "/?city=vaasa#/", { waitUntil: "networkidle2" });
  const vHome = await homeTools();
  (vHome.groups.length >= 2 && vHome.groups.every(g => g.title && g.tools > 0)
    && vHome.hasFaresTool && vHome.hasHubTool && vHome.oneSearch)
    ? ok(`etusivu (Vaasa): ryhmät ilman tyhjää otsikkoa, laituri- ja lippunappi näkyvät (${vHome.groups.map(g => g.title + ":" + g.tools).join(", ")})`)
    : fail("etusivu (Vaasa): tyhjä/puuttuva ryhmä / laituri- tai lippunappi puuttuu / haku rikki: " + JSON.stringify(vHome));

  // --- Vyöhykehinnasto (Vaasa, lisätty 25.8.2026) ---
  // Vaasa on ensimmäinen vyöhykehinnoiteltu kaupunki: hinta riippuu siitä monenko
  // vyöhykkeen läpi matka kulkee. Vartija varmistaa ettei sivu näytä vain yhden
  // vyöhykkeen hintoja koko hinnastona: se olisi tiskillä hiljaa väärä vastaus.
  await page.goto(BASE + "/?city=vaasa#/liput", { waitUntil: "networkidle2" });
  const vFares = await page.evaluate(() => {
    const txt = document.body.innerText;
    return {
      vyohykeotsikot: document.querySelectorAll("h4.fare-zone").length,
      taulukot: document.querySelectorAll("table.fare").length,
      // 1 vyöhyke aikuinen 2,10 ja 3 vyöhykettä aikuinen 5,20 (vaasa.fi 1.7.2026)
      halvin: txt.includes("2,10"),
      kallein: txt.includes("5,20"),
      kausi: txt.includes("57,10"),
      lahde: (document.querySelector(".fares-source a") || {}).href || "",
    };
  });
  (vFares.vyohykeotsikot >= 3 && vFares.taulukot >= 3 && vFares.halvin && vFares.kallein
    && vFares.kausi && /vaasa\.fi/.test(vFares.lahde))
    ? ok(`hinnat (Vaasa): vyöhykehinnasto renderöityy (${vFares.vyohykeotsikot} vyöhykeotsikkoa, ${vFares.taulukot} taulukkoa, lähdelinkki vaasa.fi)`)
    : fail("hinnat (Vaasa): vyöhykehinnasto puutteellinen: " + JSON.stringify(vFares));

  // Tasataksakaupungin sivu ei saa saada vyöhykeotsikoita: vyöhyketuki on additiivinen.
  await page.goto(BASE + "/#/liput", { waitUntil: "networkidle2" });
  const lFares = await page.evaluate(() => ({
    vyohykeotsikot: document.querySelectorAll("h4.fare-zone").length,
    taulukot: document.querySelectorAll("table.fare").length,
  }));
  (lFares.vyohykeotsikot === 0 && lFares.taulukot >= 2)
    ? ok("hinnat (Lahti, tasataksa): sivu ennallaan ilman vyöhykeotsikoita")
    : fail("hinnat (Lahti): tasataksasivu muuttui vyöhyketuen myötä: " + JSON.stringify(lFares));
  // Takaisin Vaasaan: seuraavat tarkistukset (teema, tiski) lukevat sivun tilan
  // navigoimatta itse, joten Lahti-välikäynti ei saa jäädä voimaan.
  await page.goto(BASE + "/?city=vaasa#/", { waitUntil: "networkidle2" });
  // Vaasan demo: Liftin pinkki brändiväri (per-kaupunki) — header + primary-napit magenta (R>B),
  // kirkas #E6007E aksenttiraita. data-city="vaasa" gating → muut kaupungit (sininen) ennallaan.
  const vTheme = await page.evaluate(() => {
    const rgb = s => (s.match(/\d+/g) || []).map(Number);
    const hdr = rgb(getComputedStyle(document.querySelector("header")).backgroundColor);
    const btnEl = document.querySelector(".sc-cta, .btn-primary");
    const btn = btnEl ? rgb(getComputedStyle(btnEl).backgroundColor) : [0, 0, 0];
    return { city: document.documentElement.dataset.city, hdrPink: hdr[0] > hdr[2] + 40, btnPink: btn[0] > btn[2] + 40,
      accent: getComputedStyle(document.querySelector("header")).borderBottomColor };
  });
  (vTheme.city === "vaasa" && vTheme.hdrPink && vTheme.btnPink && /\b230,\s*0,\s*126\b/.test(vTheme.accent))
    ? ok("teema (Vaasa): Lift-pinkki header + napit magenta + kirkas #E6007E aksentti")
    : fail("teema (Vaasa): pinkki ei aktivoitunut: " + JSON.stringify(vTheme));

  // Minimi-CONFIG-kaupunki (Vaasa: ei hubs/fares/cmsAlerts): palvelutiskin uusien lohkojen
  // (live-lähdöt, viimeinen bussi, aktiiviset häiriöt) on silti renderöidyttävä — vain
  // hintalohko piiloon. Estää regression jossa lohkot riippuisivat kaupungin CONFIGista.
  await page.goto(BASE + "/?city=vaasa#/palvelutiski", { waitUntil: "networkidle2" });
  const vBlocks = await page.evaluate(() => ({
    deps: !!document.getElementById("deskStop"), ab: !!document.getElementById("deskFrom"),
    lastBus: !!document.getElementById("deskLastBusBtn"), alerts: !!document.getElementById("deskAlerts"),
    fares: !!document.getElementById("deskFaresH"),
    // Vyöhykekaupungissa tiskin hintalohkon on oltava matriisi: yksi sarake per
    // vyöhykemäärä, muuten työntekijä lukisi kaupungin sisäisen hinnan myös
    // naapurikuntaan menevälle asiakkaalle. Lisäksi maksutavan on erotuttava:
    // Vaasassa käteinen kuljettajalta on aikuiselta 2,60 € kun kortti on 2,10 €,
    // joten pelkkä korttihinta antaisi käteisellä maksavalle liian matalan luvun.
    hintaSarakkeet: document.querySelectorAll("table.desk-fares thead th").length,
    maksutapaOtsikot: document.querySelectorAll("table.desk-fares tr.desk-fares-method").length,
    // Rakenteelliset tarkistukset, EI tekstihakua: smoke on tässä kohtaa ruotsiksi,
    // ja "Lähimaksu" olisi silloin "Närbetalning". Käteinen tunnistetaan hinnasta,
    // joka on kielestä riippumaton.
    kateinen: (document.querySelector("table.desk-fares")?.innerText || "").includes("2,60"),
    lahimaksu: !!document.querySelector("table.desk-fares tr.desk-fares-contactless"),
  }));
  (vBlocks.deps && vBlocks.ab && vBlocks.lastBus && vBlocks.alerts && vBlocks.fares
    && vBlocks.hintaSarakkeet === 3 && vBlocks.maksutapaOtsikot === 2
    && vBlocks.kateinen && vBlocks.lahimaksu)
    ? ok(`palvelutiski (Vaasa): vyöhykehinnat maksutavoittain (${vBlocks.hintaSarakkeet} vyöhykesaraketta, ${vBlocks.maksutapaOtsikot} maksutapalohkoa, käteinen ja lähimaksu mukana)`)
    : fail("palvelutiski (Vaasa): lohkot puuttuvat / hintamatriisi väärin: " + JSON.stringify(vBlocks));
  // Brändipariteetti (25.8.2026): tiski oli ainoa näkymä josta kaupungin väri katosi, koska
  // .desk kovakoodasi sinisen. Vaasan tiskin on kannettava Liftin pinkkiä (R selvästi > B)
  // ja säilytettävä tiskin oma 5.5:1 kontrastitavoite valkoista pohjaa vasten.
  const vDeskAccent = await page.evaluate(() => {
    const hex = getComputedStyle(document.querySelector(".desk"))
      .getPropertyValue("--blue").trim().replace(/^#/, "");
    const rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    const lum = rgb.map(v => v / 255)
      .map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
      .reduce((a, c, i) => a + [0.2126, 0.7152, 0.0722][i] * c, 0);
    return { hex: "#" + hex.toLowerCase(), pinkki: rgb[0] > rgb[2] + 40, kontrasti: 1.05 / (lum + 0.05) };
  });
  (vDeskAccent.hex !== "#0033cc" && vDeskAccent.pinkki && vDeskAccent.kontrasti >= 5.5)
    ? ok(`palvelutiski (Vaasa): aksentti kantaa Liftin pinkkiä (${vDeskAccent.hex}, ${vDeskAccent.kontrasti.toFixed(1)}:1)`)
    : fail("palvelutiski (Vaasa): tiskin aksentti ei ole brändinmukainen/kontrastinen: " + JSON.stringify(vDeskAccent));
  await page.click("#deskStop");
  await page.type("#deskStop", "Vöyrinkatu", { delay: 25 });
  if (await expect("#deskStopList button[data-s]", "palvelutiski (Vaasa): pysäkkiehdotus", 15000)) {
    await page.keyboard.press("Enter");
    const vLines = await page.waitForFunction(
      () => document.querySelectorAll(".desk-deps-lines .badge").length > 0,
      { timeout: 12000 }).then(() => true).catch(() => false);
    vLines ? ok("palvelutiski (Vaasa): pysäkin linjat listautuvat minimi-CONFIG-kaupungissa")
           : fail("palvelutiski (Vaasa): pysäkin linjat eivät listaudu");
  }

  // --- Kaksikielisyys (Vaasa, SV): UI + CONFIG.cityNames.sv + GTFS-datan pysäkkinimet ---
  // Kielenvaihto SV → otsikko "Busstidtabeller i Vasa" (cityNames.sv) ja linjasivun
  // suuntavalinnassa ruotsinkielinen pysäkkinimi (name@L → translations.txt-data).
  // EI hyväksytä FI-fallbackia: "Busstidtabeller" ja vägen/gatan/esplanaden ovat sv-spesifejä.
  await page.goto(BASE + "/?city=vaasa#/", { waitUntil: "networkidle2" });
  await page.click('[data-lang-opt="sv"]');
  const svHome = await page.waitForFunction(
    () => document.documentElement.lang === "sv"
      && (document.getElementById("appTitle")?.textContent || "").includes("Busstidtabeller i Vasa"),
    { timeout: 10000 }).then(() => true).catch(() => false);
  svHome ? ok("kaksikielisyys (Vaasa, SV): otsikko 'Busstidtabeller i Vasa' + lang=sv")
         : fail("kaksikielisyys (Vaasa, SV): otsikko/lang ei vaihtunut ruotsiksi");
  await page.waitForSelector('#routeList a[href^="#/linja/"]', { timeout: 20000 });
  const svRouteHref = await page.evaluate(() =>
    document.querySelector('#routeList a[href^="#/linja/"]').getAttribute("href"));
  await page.goto(BASE + "/?city=vaasa" + svRouteHref, { waitUntil: "networkidle2" });
  const svStops = await page.waitForFunction(
    () => /vägen|gatan|esplanaden/i.test(document.getElementById("app")?.innerText || ""),
    { timeout: 20000 }).then(() => true).catch(() => false);
  svStops ? ok("kaksikielisyys (Vaasa, SV): linjasivun pysäkkinimet ruotsiksi (name@L)")
          : fail("kaksikielisyys (Vaasa, SV): linjasivulla ei ruotsinkielistä pysäkkinimeä");
  await page.click('[data-lang-opt="fi"]'); // lang on globaali (ei ns-skoopattu) → palauta FI seuraaville testeille

  // Printtihygienia myös toisessa kaupungissa: vartija ei saa nojata yhden feedin
  // erikoisuuksiin. Pysäkki poimitaan linjasivun pysäkkilistasta (ei kovakoodattua
  // gtfsId:tä), jotta feedin muutos ei riko testiä väärästä syystä.
  {
    // kielenvaihto piirtää näkymän uudelleen → odota että pysäkkilista on taas DOMissa
    await page.waitForSelector('.stop-timeline a[href^="#/pysakki/"]', { timeout: 20000 }).catch(() => {});
    const vStopHref = await page.evaluate(() =>
      document.querySelector('.stop-timeline a[href^="#/pysakki/"]')?.getAttribute("href"));
    if (!vStopHref) {
      fail("printtihygienia (Vaasa): linjasivulta ei löytynyt pysäkkilinkkiä");
    } else {
      await page.goto(BASE + "/?city=vaasa" + vStopHref, { waitUntil: "networkidle2" });
      await page.waitForSelector("#stopPosterBtn", { timeout: 20000 });
      await page.evaluate(() => { window.print = () => {}; });
      await page.click("#stopPosterBtn");
      const vPoster = await page.waitForFunction(
        () => !!document.querySelector("#stopPrintOut .poster-day .hourgrid tr"),
        { timeout: 30000 }).then(() => true).catch(() => false);
      vPoster ? await printHygiene(page, "Vaasa")
              : fail("printtihygienia (Vaasa): julistetta ei saatu koottua → hygieniaa ei voi todeta");
    }
  }

  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" }); // palauta oletuskaupunki seuraaville testeille

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
  // Aikataulun on näytettävä aito lähtö (.timegrid button) PALVELUPÄIVÄNÄ. "Tänään" voi olla
  // arkipyhä (esim. juhannus), jolloin linja ei aja → ei lähtöjä, vaikka koodi toimii oikein.
  // Siksi: jos tänään ei lähtöjä, käydään päivätyyppivälilehdet (La/Su käyttävät pyhät
  // ohittavaa palvelupäivää). Tyhjä KAIKILLA päivätyypeillä = oikea bugi. EI hyväksytä
  // virhetilan fallbackia ("ei lähtöjä") onnistumisena — vaaditaan aina aito .timegrid button.
  let timegridOk = await page.waitForSelector(".timegrid button", { timeout: 12000 }).then(() => true).catch(() => false);
  if (!timegridOk) {
    const dayCount = (await page.$$(".daytab")).length;
    for (let i = 0; i < dayCount && !timegridOk; i++) {
      await page.evaluate(idx => document.querySelectorAll(".daytab")[idx]?.click(), i);
      timegridOk = await page.waitForSelector(".timegrid button", { timeout: 8000 }).then(() => true).catch(() => false);
    }
  }
  timegridOk ? ok("linjasivu: aikataulu (oletuspattern näyttää lähtöjä palvelupäivänä)")
             : fail("linjasivu: aikataulu — ei lähtöjä millään päivätyypillä (.timegrid button)");
  // Nykyinen hash = palvelupäivän linjasivu (sis. päivämäärän) → käytetään matriisitestissä
  const serviceHref = await page.evaluate(() => location.hash);
  const dirText = await page.evaluate(() =>
    document.querySelector(".dir-current")?.textContent || "");
  dirText.includes("→") ? ok("linjasivu: selkokielinen suunta yhdellä rivillä (A → B)")
                        : fail("linjasivu: suuntariviltä puuttuu →");
  // Pysäkkiaikajana (pisteet + viiva) renderöityy
  const stlCount = (await page.$$("#stopTimeline .stl-item")).length;
  stlCount > 0 ? ok(`linjasivu: pysäkkiaikajana (${stlCount} pysäkkiä, pisteet + viiva)`)
               : fail("linjasivu: pysäkkiaikajana puuttuu");
  const routeMap = await page.waitForFunction(
    () => !!document.querySelector("#routeMap .leaflet-overlay-pane path"),
    { timeout: 12000 }).then(() => true).catch(() => false);
  routeMap ? ok("linjasivu: reittiviiva kartalla") : fail("linjasivu: reittiviiva puuttuu");
  // fitBounds: kartta rajautuu reittiin (ei maailmanäkymään) → tiilien zoom on kaupunkitasoa
  const mapZoom = await page.evaluate(() => {
    const tile = document.querySelector("#routeMap img.leaflet-tile");
    const m = tile && tile.src.match(/\/(\d+)\/\d+\/\d+\.png/);
    return m ? parseInt(m[1], 10) : -1;
  });
  mapZoom >= 9 ? ok(`linjasivu: kartta rajautuu reittiin (tiilizoom ${mapZoom}, ei maailmanäkymää)`)
              : fail(`linjasivu: kartan zoom liian laaja (${mapZoom}) — fitBounds ei rajaa bboxiin`);
  // Emoji-siivous: renderöidyssä näkymässä 0 piktografista emojia (ikonit ovat inline-SVG:tä)
  const emojiLeft = await page.evaluate(() => {
    const re = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
    const skip = new Set(["→", "←", "↔", "↑", "⇅", "↻", "✓", "✕"]);
    let n = 0;
    for (const ch of (document.body.innerText || "")) if (re.test(ch) && !skip.has(ch)) n++;
    return n;
  });
  emojiLeft === 0 ? ok("emoji-siivous: linjasivun renderöinnissä 0 piktografista emojia")
                  : fail(`emoji-siivous: ${emojiLeft} emojia jäljellä linjasivulla`);
  // --- Linjakartta (#/linjakartta): map-first-näkymä ---
  const mapHref = routeHref.replace("#/linja/", "#/linjakartta/");
  await page.goto(BASE + "/" + mapHref, { waitUntil: "networkidle2" });
  await expect("#lineMap.leaflet-container", "linjakartta: kartta latautuu");
  const lineRoute = await page.waitForFunction(
    () => !!document.querySelector("#lineMap .leaflet-overlay-pane path"),
    { timeout: 12000 }).then(() => true).catch(() => false);
  lineRoute ? ok("linjakartta: reittiviiva piirtyy") : info("linjakartta: viiva ei ehtinyt (Leaflet-ajoitus) — ei virhe");
  await page.goto(BASE + "/" + serviceHref, { waitUntil: "networkidle2" }); // palaa linjasivulle (palvelupäivä) jatkotestejä varten
  // "Koko aikataulu pysäkeittäin" -matriisi näyttää vuoroja palvelupäivänä (ei "ei lähtöjä")
  const matrixOk = await page.waitForFunction(
    () => { const m = document.getElementById("stopMatrix"); return m && m.querySelector("table"); },
    { timeout: 15000 }).then(() => true).catch(() => false);
  matrixOk ? ok("linjasivu: koko aikataulu -matriisi näyttää vuoroja") : fail("linjasivu: matriisi tyhjä (ei lähtöjä)");
  // "Koko aikataulu" -lohko: desktop-leveydellä näkyvissä (ei taittonappia); kapealla (390)
  // oletuksena KIINNI ja avautuu napista. Oletusviewport 800 = desktop.
  const ftDesktop = await page.evaluate(() => {
    const w = document.querySelector(".ft-collapse"); if (!w) return null;
    return { toggleHidden: getComputedStyle(w.querySelector(".ft-toggle")).display === "none",
             bodyVisible: getComputedStyle(w.querySelector(".ft-body")).display !== "none" };
  });
  (ftDesktop && ftDesktop.toggleHidden && ftDesktop.bodyVisible)
    ? ok("linjasivu: koko aikataulu -lohko näkyvissä desktop-leveydellä (ei taittonappia)")
    : fail("linjasivu: koko aikataulu -lohko ei näy desktopilla: " + JSON.stringify(ftDesktop));
  await page.setViewport({ width: 390, height: 800 });
  await sleep(300);
  const ftClosed = await page.evaluate(() => {
    const w = document.querySelector(".ft-collapse");
    return { open: w.classList.contains("ft-open"), aria: w.querySelector(".ft-toggle").getAttribute("aria-expanded"),
             toggleVisible: getComputedStyle(w.querySelector(".ft-toggle")).display !== "none",
             bodyHidden: getComputedStyle(w.querySelector(".ft-body")).display === "none" };
  });
  (!ftClosed.open && ftClosed.toggleVisible && ftClosed.bodyHidden && ftClosed.aria === "false")
    ? ok("linjasivu (390px): koko aikataulu -lohko oletuksena KIINNI (taittonappi näkyy)")
    : fail("linjasivu (390px): lohko ei ole kiinni: " + JSON.stringify(ftClosed));
  await page.evaluate(() => document.querySelector(".ft-toggle").click());
  await sleep(200);
  const ftOpen = await page.evaluate(() => {
    const w = document.querySelector(".ft-collapse");
    return { open: w.classList.contains("ft-open"), aria: w.querySelector(".ft-toggle").getAttribute("aria-expanded"),
             bodyVisible: getComputedStyle(w.querySelector(".ft-body")).display !== "none" };
  });
  (ftOpen.open && ftOpen.bodyVisible && ftOpen.aria === "true")
    ? ok("linjasivu (390px): koko aikataulu avautuu napista")
    : fail("linjasivu (390px): lohko ei avaudu: " + JSON.stringify(ftOpen));
  await page.setViewport({ width: 800, height: 600 }); // palauta desktop seuraaville testeille
  // --- Klikattavat lähdöt → pysäkkiaikajana päivittyy + varianttivalikon siivous ---
  const depBtns = (await page.$$(".timegrid button[data-dep]")).length;
  depBtns > 0 ? ok(`linjasivu: lähdöt klikattavia nappeja (${depBtns})`) : fail("linjasivu: lähtönapit puuttuvat");
  const selOk = await page.waitForFunction(
    () => document.querySelector(".timegrid button.selected")
       && (document.getElementById("timelineSel")?.textContent || "").trim().length > 0,
    { timeout: 12000 }).then(() => true).catch(() => false);
  selOk ? ok("linjasivu: oletuslähtö valittu + aikajanan otsikko näkyy") : fail("linjasivu: oletusvalinta/otsikko puuttuu");
  const changed = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const sel = document.getElementById("timelineSel");
    const before = sel.textContent;
    const beforeTimes = [...document.querySelectorAll("#stopTimeline .stl-time")].map(s => s.textContent).join("|");
    const other = [...document.querySelectorAll(".timegrid button[data-dep]")].find(b => !b.classList.contains("selected"));
    if (!other) return { ok: false, reason: "vain yksi lähtö" };
    other.click();
    await sleep(150);
    const afterTimes = [...document.querySelectorAll("#stopTimeline .stl-time")].map(s => s.textContent).join("|");
    return { ok: sel.textContent !== before && afterTimes !== beforeTimes && other.classList.contains("selected") };
  });
  changed.ok ? ok("linjasivu: lähdön klikkaus vaihtaa pysäkkiajat + otsikon")
             : fail("linjasivu: lähdön klikkaus ei muuttanut aikoja (" + JSON.stringify(changed) + ")");
  const variantClean = await page.evaluate(() => {
    const s = document.getElementById("variantSel");
    return !s || s.options.length > 1;
  });
  variantClean ? ok("linjasivu: varianttivalikko siisti (piilossa tai ≥2 kuviota)")
               : fail("linjasivu: varianttivalikko näkyy yhdellä kuviolla");
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
        () => !!document.querySelector("#stopPrintOut .poster-day .hourgrid tr"),
        { timeout: 20000 }).then(() => true).catch(() => false);
      const days = await page.evaluate(() =>
        document.querySelectorAll("#stopPrintOut .poster-day").length);
      // Osioiden määrä on datavetoinen (todelliset ajopäiväblokit, esim. Ma–Pe/Pe/La/Su)
      // → vaaditaan ≥1 osio JA vähintään yksi oikea tuntikaaviorivi (ei tyhjä fallback).
      // Sarakevartija: minuutit olivat ennen 25.8.2026 yhdessä solussa välilyönnein, jolloin
      // yhden lähdön tunti alkoi solun alusta ja :35 päätyi toisen tunnin :05:n kohdalle —
      // luvut kulkivat vinosti alaspäin eikä pysäkillä seisova löytänyt omaa lähtöään
      // pystysuunnassa. Nyt jokainen kymmenluku on oma sarakkeensa, joten saman
      // tuntikaavion jokaisella rivillä on yhtä monta solua.
      const grid = await page.evaluate(() => {
        const bad = [];
        document.querySelectorAll("#stopPrintOut .hourgrid").forEach((g, i) => {
          const counts = [...new Set([...g.querySelectorAll("tr")].map(tr => tr.children.length))];
          if (counts.length > 1) bad.push({ i, counts });
        });
        return { grids: document.querySelectorAll("#stopPrintOut .hourgrid").length, bad };
      });
      grid.grids >= 1 && !grid.bad.length
        ? ok(`pysäkkijuliste: minuutit omissa sarakkeissaan, rivit samanmittaisia (${grid.grids} tuntikaaviota)`)
        : fail(`pysäkkijuliste: tuntikaavion rivit eri mittaisia → minuutit eivät ole allekkain: ${JSON.stringify(grid.bad.slice(0, 3))}`);
      posterOk && days >= 1
        ? ok(`pysäkkijuliste: tuntikaavio kootaan (${days} päiväblokkia)`)
        : fail(`pysäkkijuliste: tuntikaaviota ei muodostunut (päiväblokkeja ${days})`);
      await printHygiene(page, "Lahti");

      // Yhden arkin tiivis juliste (Vaasa 26.8.2026): kaikki päivätyypit samalla A4:llä.
      // Vartija mittaa PDF:n sivumäärän print-medialla: tiivis versio on aidosti lyhyempi
      // kuin päivätyyppi-per-arkki, tuntikaavion rivit pysyvät samanmittaisina ja
      // fitPosterSheet on merkinnyt tiukennusasteen. Sivumäärä luetaan PDF:n
      // /Type /Page -objekteista, ei oletuksesta.
      const pdfPages = async () => {
        const buf = await page.pdf({ format: "A4", preferCSSPageSize: true });
        return (Buffer.from(buf).toString("latin1").match(/\/Type\s*\/Page(?!s)/g) || []).length;
      };
      if (posterOk && await page.$("#posterCompactCb")) {
        const loosePages = await pdfPages();
        await page.evaluate(() => { document.getElementById("posterCompactCb").checked = true; });
        await page.click("#stopPosterBtn");
        const compactOk = await page.waitForFunction(
          () => !!document.querySelector("#stopPrintOut .poster-compact .poster-stop[data-fit] .hourgrid tr"),
          { timeout: 20000 }).then(() => true).catch(() => false);
        const cp = await page.evaluate(() => {
          const bad = [];
          document.querySelectorAll("#stopPrintOut .hourgrid").forEach((g, i) => {
            const counts = [...new Set([...g.querySelectorAll("tr")].map(tr => tr.children.length))];
            if (counts.length > 1) bad.push({ i, counts });
          });
          return {
            fit: document.querySelector("#stopPrintOut .poster-stop")?.dataset.fit,
            days: document.querySelectorAll("#stopPrintOut .poster-day").length,
            pageStyle: document.getElementById("pageOrient")?.textContent || "",
            bad,
          };
        });
        const compactPages = compactOk ? await pdfPages() : -1;
        const shorter = cp.days >= 2 ? compactPages < loosePages : compactPages <= loosePages;
        (compactOk && cp.fit != null && /margin: 7mm/.test(cp.pageStyle) && !cp.bad.length && compactPages >= 1 && shorter)
          ? ok(`pysäkkijuliste (yksi arkki): ${loosePages} → ${compactPages} sivua, ${cp.days} päivätyyppiä, tiukennus ${cp.fit}, rivit samanmittaisia`)
          : fail(`pysäkkijuliste (yksi arkki): ${JSON.stringify({ compactOk, loosePages, compactPages, ...cp })}`);
        await printHygiene(page, "Lahti, yksi arkki");
        await page.evaluate(() => { document.getElementById("posterCompactCb").checked = false; });
      } else if (posterOk) {
        fail("pysäkkijuliste (yksi arkki): valintaa #posterCompactCb ei löytynyt");
      }
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
    // Lähestyvä bussi -hälytys: nappi näkyy ja banneri ilmestyy aktivoitaessa
    if (await page.$("#approachBtn")) {
      await page.click("#approachBtn");
      const armed = await page.waitForFunction(
        () => { const b = document.querySelector("#approachBanner"); return b && !b.hidden && b.textContent.trim().length > 0; },
        { timeout: 5000 }).then(() => true).catch(() => false);
      armed ? ok("pysäkkisivu: lähestyvä bussi -hälytys aktivoituu (banneri)")
            : fail("pysäkkisivu: lähestyvä bussi -hälytyksen banneri ei ilmestynyt");
    } else {
      info("pysäkkisivu: Notification ei tuettu → ei lähestyvä bussi -nappia");
    }
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
    // Yhteyskatko: taulu ei saa väittää "päivittyy reaaliajassa" vanhalla datalla, vaan
    // näyttää ei yhteyttä -tilan ja säilyttää viimeksi ladatut lähdöt (ei tyhjää, ei valehtele).
    const rowsBefore = await page.$$eval("#mRows tr", trs => trs.length).catch(() => 0);
    const errsBeforeOffline = consoleErrors.length;
    await page.setOfflineMode(true);
    await page.evaluate(() => refreshNow());
    await page.setOfflineMode(false);
    const staleShown = await page.waitForFunction(
      () => { const el = document.querySelector("#mLive"); return el && !el.querySelector(".rt") && !!el.querySelector("svg"); },
      { timeout: 5000 }).then(() => true).catch(() => false);
    const rowsAfter = await page.$$eval("#mRows tr", trs => trs.length).catch(() => 0);
    // Katkon aikana selain lokittaa ERR_INTERNET_DISCONNECTED: odotettu, ei konsolivirhelöydös
    for (let i = consoleErrors.length - 1; i >= errsBeforeOffline; i--) {
      if (consoleErrors[i].includes("ERR_INTERNET_DISCONNECTED")) consoleErrors.splice(i, 1);
    }
    (staleShown && rowsAfter === rowsBefore && rowsAfter > 0)
      ? ok("monitori: yhteyskatkolla näkyy ei yhteyttä -tila, lähdöt säilyvät")
      : fail("monitori: yhteyskatkolla monitori väittää yhä olevansa reaaliaikainen tai lähdöt katosivat");
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
    const labels = await page.evaluate(() => [...document.querySelectorAll("#liveMap .bus-live")].map(e => e.textContent.trim()));
    ok(`live-kartta: busseja kartalla (${labels.length})`);
    // Merkin label = reitin shortName, EI raaka route_id. Näissä feedeissä raaka id on 4+ numeroa
    // (esim. Vaasa 1010, Lahti 6741230); aidot linjanumerot eivät koskaan ole 4+ pelkkää numeroa.
    const raw = [...new Set(labels)].filter(l => /^\d{4,}$/.test(l));
    raw.length === 0
      ? ok("live-kartta: bussimerkit ystävällinen linjanumero (ei raakaa route_id:tä)")
      : fail("live-kartta: raakoja route_id-labeleita merkeissä: " + raw.join(","));
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

  // --- Keskustan pysäkit (#/laiturit): pysäkit avoimesta datasta + virallinen PDF ---
  await page.goto(BASE + "/#/laiturit", { waitUntil: "networkidle2" });
  await expect("#hubMap.leaflet-container", "keskustan pysäkit: kartta latautuu");
  const platMarkers = await page.waitForFunction(
    () => document.querySelectorAll("#hubMap .plat-marker").length > 0,
    { timeout: 20000 }).then(() => true).catch(() => false);
  const platItems = await page.evaluate(() => document.querySelectorAll("#hubList .plat-item").length);
  (platMarkers && platItems > 0)
    ? ok(`keskustan pysäkit: merkit kartalla + lista (${platItems} pysäkkiä)`)
    : fail("keskustan pysäkit: pysäkkejä ei piirtynyt");
  // Termi: kirjainpysäkki = "Pysäkki", numerolaituri = "Laituri" (LSL:n nimeämisen mukaan)
  const hasStopTerm = await page.evaluate(() =>
    [...document.querySelectorAll("#hubList .plat-name")].some(e => /Pysäkki/.test(e.textContent)));
  hasStopTerm ? ok("keskustan pysäkit: termi 'Pysäkki' kirjainpysäkeille")
              : fail("keskustan pysäkit: 'Pysäkki'-termiä ei löytynyt");
  (await page.$('.card a[href$=".pdf"]'))
    ? ok("keskustan pysäkit: linkki LSL:n viralliseen PDF-pysäkkikarttaan")
    : fail("keskustan pysäkit: virallisen PDF-kartan linkki puuttuu");
  const hubTabs = await page.evaluate(() => document.querySelectorAll("[data-hub-tab]").length);
  hubTabs >= 2 ? ok(`keskustan pysäkit: keskusvälilehdet (${hubTabs})`)
               : fail(`keskustan pysäkit: keskusvälilehtiä odotettiin ≥2, löytyi ${hubTabs}`);

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
  // Tuore settings-DOM ennen tekstikokotestiä (kielenvaihto yllä re-renderöi näkymän).
  await page.goto(BASE + "/#/asetukset", { waitUntil: "networkidle2" }); await sleep(200);
  // Tekstikoko (esteettömyys): suurenna ja tarkista että root-fontti kasvaa. Klikataan SIVUN
  // sisällä (querySelector?.click) jotta puppeteerin elementtikahva ei vanhene jos näkymä
  // re-renderöityy (ei HARNESS-virhettä), ja uusitaan muutaman kerran handler-kiinnitysikkunan yli.
  if (await page.$('[data-text-opt="large"]')) {
    let before = 0, res = { attr: null, size: 0 }, grew = false;
    for (let attempt = 0; attempt < 6 && !grew; attempt++) {
      before = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      await page.evaluate(() => document.querySelector('[data-text-opt="large"]')?.click());
      await sleep(250);
      res = await page.evaluate(() => ({
        attr: document.documentElement.dataset.text,
        size: parseFloat(getComputedStyle(document.documentElement).fontSize),
      }));
      grew = res.attr === "large" && res.size > before;
    }
    grew
      ? ok(`asetukset: suuri teksti kasvattaa fonttia (${before}→${res.size}px)`)
      : fail("asetukset: tekstikoko ei kasvanut");
    await page.evaluate(() => document.querySelector('[data-text-opt="normal"]')?.click()); // palauta
    await sleep(120);
    await page.evaluate(() => { localStorage.removeItem("textSize"); window.applyTextSize?.(); });
  }

  // F6: Suuri kontrasti EI aktivoidu automaattisesti — OLETUS = Normaali.
  // Manuaalivalinta aktivoi + persistoituu; takaisin Normaaliin tuo sävyn takaisin.
  if (await page.$('[data-contrast-opt="high"]')) {
    // tuore lataus ILMAN localStoragea → silti Normaali (ei auto-laukaisua laitteen asetuksesta)
    await page.evaluate(() => localStorage.removeItem("contrast"));
    await page.reload({ waitUntil: "networkidle2" }); await sleep(200);
    const def = await page.evaluate(() => document.documentElement.dataset.contrast || "(none)");
    def === "(none)"
      ? ok("asetukset: kontrasti OLETUKSENA Normaali (ei auto-laukaisua)")
      : fail(`asetukset: kontrasti laukesi automaattisesti (oli ${def})`);
    const bgNormal = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // manuaalinen Suuri kontrasti → aktivoituu + tausta muuttuu + muistetaan localStorageen
    await page.click('[data-contrast-opt="high"]'); await sleep(150);
    const on = await page.evaluate(() => ({ attr: document.documentElement.dataset.contrast || "(none)",
      bg: getComputedStyle(document.body).backgroundColor, ls: localStorage.getItem("contrast") }));
    (on.attr === "high" && on.bg !== bgNormal && on.ls === "high")
      ? ok(`asetukset: manuaalinen suuri kontrasti aktivoituu (tausta ${bgNormal}→${on.bg}, muistettu)`)
      : fail("asetukset: manuaalinen suuri kontrasti ei toiminut: " + JSON.stringify(on));
    // persistoituu uudelleenlatauksen yli: tallennettu "high" voittaa oletuksen
    await page.reload({ waitUntil: "networkidle2" }); await sleep(200);
    const after = await page.evaluate(() => document.documentElement.dataset.contrast || "(none)");
    after === "high"
      ? ok("asetukset: manuaalinen suuri kontrasti pysyy latauksen jälkeen")
      : fail(`asetukset: suuri kontrasti ei säilynyt reloadin jälkeen (${after})`);
    // takaisin Normaaliin → sävy palaa; palauta puhdas oletustila muille testeille
    await page.click('[data-contrast-opt="normal"]'); await sleep(150);
    const back = await page.evaluate(() => document.documentElement.dataset.contrast || "(none)");
    back === "(none)"
      ? ok("asetukset: takaisin Normaaliin (sävy palaa)")
      : fail(`asetukset: Normaaliin paluu ei toiminut (${back})`);
    await page.evaluate(() => localStorage.removeItem("contrast"));
  } else {
    fail("asetukset: kontrastivalinta puuttuu");
  }

  // --- Tulosteet ja näytöt -keskus: yhdistetty näkymä välilehdillä; vanhat reitit ohjautuvat ---
  // Vanha #/tulosta -> ohjautuu keskukseen vihko-välilehdelle (QR-yhteensopivuus); 3 välilehteä,
  // kaikki paneelit DOMissa (sidonnat toimivat tabista riippumatta).
  await page.goto(BASE + "/#/tulosta", { waitUntil: "networkidle2" });
  await sleep(400);
  const pc = await page.evaluate(() => ({
    hash: location.hash, tabs: document.querySelectorAll(".ptab").length,
    active: document.querySelector('.ptab[aria-pressed="true"]')?.dataset.ptab,
    booklet: !!document.getElementById("buildBtn"), batch: !!document.getElementById("batchGo"), hub: !!document.getElementById("hubStopSearch"),
  }));
  (pc.tabs === 4 && pc.active === "vihko" && /#\/tulosteet\/vihko/.test(pc.hash) && pc.booklet && pc.batch && pc.hub)
    ? ok(`tulosteet-keskus: #/tulosta ohjautuu vihko-välilehdelle, 4 välilehteä (${pc.hash})`)
    : fail("tulosteet-keskus: #/tulosta-ohjaus tai välilehdet pielessä: " + JSON.stringify(pc));
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
      // Reittikaavio linjan otsikon alla: SVG-viiva + nimilaput tekstinä, ei kuvia
      const bm = await page.evaluate(() => {
        const fig = document.querySelector("#bookletOut .booklet-line .print-map");
        return { has: !!fig, paths: fig ? fig.querySelectorAll("svg path").length : 0,
                 texts: fig ? fig.querySelectorAll("svg text").length : 0,
                 imgs: fig ? fig.querySelectorAll("img, image").length : 0,
                 afterH2: !!fig && fig.previousElementSibling?.tagName === "H2" };
      });
      (bm.has && bm.paths >= 1 && bm.texts >= 3 && bm.imgs === 0 && bm.afterH2)
        ? ok(`tulostusvihko: reittikaavio linjan alla (${bm.paths} viivaa, ${bm.texts} tekstiä)`)
        : fail("tulostusvihko: reittikaavio puuttuu tai pielessä: " + JSON.stringify(bm));
    }
    // Isot pysäkit -rajaus (pickKeyStops): liikaa timepointteja → 10; ≤12 ennallaan; hub pakotettu; sananraja
    const cap = await page.evaluate(() => {
      const mk = (n, names = {}) => Array.from({ length: n }, (_, i) => ({ stop: { gtfsId: "s" + i, name: names[i] || ("Pysäkki " + i) }, idx: i }));
      return {
        big: pickKeyStops(mk(60)).length,
        small: pickKeyStops(mk(8)).length,
        edge12: pickKeyStops(mk(12)).length,
        firstLast: (() => { const r = pickKeyStops(mk(60)); return r[0].gtfsId === "s0" && r[r.length - 1].gtfsId === "s59"; })(),
        hub: pickKeyStops(mk(60, { 30: "Kauppatori E" })).some(s => s.name === "Kauppatori E"),
        wb: stopMatchesHub("Kauppatorinkatu 5", [["kauppatori"]]),
      };
    });
    (cap.big === 10 && cap.small === 8 && cap.edge12 === 12 && cap.firstLast && cap.hub === true && cap.wb === false)
      ? ok(`isot pysäkit -rajaus: 60→${cap.big} (lähtö+pää aina), ≤12 ennallaan, hub pakotettu, sananraja ei false-match`)
      : fail("isot pysäkit -rajaus pielessä: " + JSON.stringify(cap));
    // Vihko (A5, taitettava): mittaa-ja-jaa A5-sivutus + saddle-stitch imposition; A4-vakio säilyy
    if (await page.$("#bookletPrintA5")) {
      // stub-print kirjaa näkyikö valmistelu-indikaattori juuri tulostushetkellä (#16)
      await page.evaluate(() => { window.__rp = window.print; window.__prepAtPrint = false;
        window.print = () => { const e = document.getElementById("printPrep"); window.__prepAtPrint = !!(e && !e.hidden && /\S/.test(e.textContent)); }; });
      await page.click("#bookletPrintA5");
      await sleep(300);
      const vk = await page.evaluate(() => ({
        sheets: document.querySelectorAll("#vihkoPrint .vihko-sheet").length,
        pages: document.querySelectorAll("#vihkoPrint .vihko-a5:not(.vihko-blank)").length,
        slots: document.querySelectorAll("#vihkoPrint .vihko-a5").length,
        a4: !!document.getElementById("bookletPrint"),
        prepAtPrint: window.__prepAtPrint,
        prepHidden: document.getElementById("printPrep")?.hidden !== false,
        // Leveysvartija: A5 on 128 mm eikä siihen mahdu A4:n kymmentä saraketta. Ennen
        // 25.8.2026 taulukko vuoti sivun oikean reunan yli ja paperille jäi puolikkaita
        // kellonaikoja (Vaasan SV-vihko). Sivutus mittaa vain korkeuden, joten mikään
        // ei kertonut tästä. Mitataan suurin ylivuoto sivun sisällön oikeaan reunaan.
        yli: Math.round(Math.max(0, ...[...document.querySelectorAll("#vihkoPrint .vihko-page-content")]
          .flatMap(pg => [...pg.querySelectorAll("table")]
            .map(t => t.getBoundingClientRect().right - pg.getBoundingClientRect().right)))),
      }));
      vk.yli <= 1
        ? ok("vihko: A5-taulukot mahtuvat sivun leveyteen (ei leikkautuvia sarakkeita)")
        : fail(`vihko: A5-taulukko vuotaa sivun yli ${vk.yli} px → oikea reuna leikkautuu paperilla`);
      (vk.sheets >= 2 && vk.pages >= 1 && vk.slots % 4 === 0 && vk.a4)
        ? ok(`vihko: A5-imposition (${vk.pages} sivua → ${vk.slots} paikkaa, ${vk.sheets} arkkipuolta; A4-nappi ennallaan)`)
        : fail("vihko: imposition pielessä: " + JSON.stringify(vk));
      (vk.prepAtPrint && vk.prepHidden)
        ? ok("tulosteen valmistelu-indikaattori: näkyi tulostuksen aikana, piiloutui jälkeen")
        : fail("valmistelu-indikaattori pielessä: " + JSON.stringify({ prepAtPrint: vk.prepAtPrint, prepHidden: vk.prepHidden }));
      await page.evaluate(() => { document.getElementById("vihkoPrint")?.remove(); document.body.classList.remove("vihko-printing"); document.getElementById("printPrep")?.remove(); window.print = window.__rp; });
    }
  }
  // --- Yhdistetyt suunnat (käytävä): presetti → kokoa → monen linjan yhteinen taulukko ---
  await page.click('.ptab[data-ptab="kaytava"]');
  await sleep(200);
  const corrPre = await page.evaluate(() => ({
    presets: document.querySelectorAll("[data-corridor]").length,
    checks: document.querySelectorAll(".corrCb").length,
  }));
  (corrPre.presets >= 1 && corrPre.checks > 0)
    ? ok(`yhdistetyt suunnat: välilehti + ${corrPre.presets} presettiä (Lahti) + linjalista`)
    : fail("yhdistetyt suunnat: presetit/linjalista puuttuvat: " + JSON.stringify(corrPre));
  await page.click('[data-corridor="ahtiala"]');
  await page.click("#corrGo");
  const corrOk = await page.waitForFunction(
    () => document.querySelectorAll("#corridorOut table.corridor tbody tr").length > 5,
    { timeout: 90000 }).then(() => true).catch(() => false);
  if (corrOk) {
    const corr = await page.evaluate(() => {
      const badges = [...document.querySelectorAll("#corridorOut table.corridor tbody .badge")].map(b => b.textContent.trim());
      // Aikajärjestys per taulukko, KAIKKI rivit. Luetaan solun data-sec (GTFS-sekunnit
      // vuorokauden alusta, myös yli 24 h), jolloin yön yli menevät vuorot eivät enää
      // riko vertailua: 24:04 renderöityy "00:04" mutta data-sec on 86640. Aiemmin
      // tarkistettiin vain 5 ensimmäistä riviä juuri tämän takia.
      const sorted = [...document.querySelectorAll("#corridorOut table.corridor")].every(tb => {
        const ts = [...tb.querySelectorAll("tbody tr td:first-child")]
          .filter(td => td.hasAttribute("data-sec")).map(td => +td.getAttribute("data-sec"));
        return ts.every((v, i) => i === 0 || ts[i - 1] <= v);
      });
      // data-sec puuttuu rivistä jolla on kellonaika = tuloste ei kanna järjestystietoa
      const secMissing = [...document.querySelectorAll("#corridorOut table.corridor tbody tr td:first-child")]
        .filter(td => !td.hasAttribute("data-sec") && /^\d{1,2}:\d{2}/.test(td.textContent.trim())).length;
      return {
        rows: document.querySelectorAll("#corridorOut table.corridor tbody tr").length,
        distinctLines: [...new Set(badges)].length,
        daytypes: document.querySelectorAll("#corridorOut h4.daytype").length,
        dirs: document.querySelectorAll("#corridorOut .corridor-dir").length,
        sorted, secMissing,
        // tulostuva sisältö: .no-print-lohkot (esim. tulostusnappi ikoneineen) eivät päädy paperille
        nonText: [...document.querySelectorAll("#corridorOut svg, #corridorOut canvas, #corridorOut img")]
          .filter(el => !el.closest(".no-print") && !el.closest(".print-map")).length,
        // reittikaavio: viivat + oikeaa tekstiä (nimilaput), ei kuvia/tiiliä
        mapPaths: document.querySelectorAll("#corridorOut .print-map svg path").length,
        mapTexts: document.querySelectorAll("#corridorOut .print-map svg text").length,
        mapImgs: document.querySelectorAll("#corridorOut .print-map img, #corridorOut .print-map image").length,
      };
    });
    (corr.distinctLines >= 2 && corr.daytypes >= 1 && corr.dirs >= 2 && corr.sorted && corr.secMissing === 0)
      ? ok(`yhdistetyt suunnat: ${corr.rows} lähtöä, ${corr.distinctLines} linjaa yhdessä taulukossa, ${corr.dirs} suuntaa, aikajärjestys OK`)
      : fail("yhdistetyt suunnat: yhdistetty taulukko pielessä: " + JSON.stringify(corr));
    corr.nonText === 0
      ? ok("yhdistetyt suunnat: tuloste puhdasta tekstiä (0 svg/canvas/img reittikaavion ulkopuolella)")
      : fail(`yhdistetyt suunnat: ei-tekstielementtejä tulosteessa (${corr.nonText} kpl)`);
    (corr.mapPaths >= 2 && corr.mapTexts >= 3 && corr.mapImgs === 0)
      ? ok(`yhdistetyt suunnat: reittikaavio (${corr.mapPaths} viivaa, ${corr.mapTexts} tekstiä, 0 kuvaa)`)
      : fail("yhdistetyt suunnat: reittikaavio puuttuu tai ei ole tekstiä: " + JSON.stringify(corr));
    // Rivikorkeusvartija (25.8.2026): määränpääsarake oli print-CSS:ssä vain 26 % leveä,
    // jolloin pitkä määränpää ("Gerby / Tallmarksvägen 3") rivittyi kahdelle riville ja
    // vain osa riveistä oli kaksinkertaisen korkuisia. Sarakkeet olivat linjassa, mutta
    // vaakaviivat kulkivat epätasaisin välein ja paperilla taulukko luki vinona. Ville
    // huomasi sen silmällä; mikään mittaus ei nähnyt sitä, koska ylivuotoa ei ollut.
    await page.emulateMediaType("print");
    const rk = await page.evaluate(() => {
      const t = document.querySelector("table.corridor");
      if (!t || !t.tBodies[0]) return null;
      const hs = [...t.tBodies[0].rows].slice(0, 60).map(r => Math.round(r.getBoundingClientRect().height));
      return { korkeudet: [...new Set(hs)], riveja: hs.length };
    });
    await page.emulateMediaType("screen");
    rk && rk.korkeudet.length === 1
      ? ok(`yhdistetyt suunnat: rivikorkeus tasainen printissä (${rk.riveja} riviä, ${rk.korkeudet[0]} px)`)
      : fail("yhdistetyt suunnat: rivikorkeudet vaihtelevat printissä → taulukko lukee vinona: "
          + JSON.stringify(rk));
  } else fail("yhdistetyt suunnat: taulukko ei koostunut (Ahtiala 4/14/24/34K)");

  // Välilehden vaihto: klikkaa "Näyttöverkosto" -> naytot-paneeli näkyviin + URL päivittyy (replaceState)
  await page.click('.ptab[data-ptab="naytot"]');
  await sleep(200);
  const sw = await page.evaluate(() => ({
    active: document.querySelector('.ptab[aria-pressed="true"]')?.dataset.ptab,
    visible: [...document.querySelectorAll(".ppanel")].filter(p => !p.hidden).map(p => p.dataset.ppanel),
    hash: location.hash,
  }));
  (sw.active === "naytot" && sw.visible.length === 1 && sw.visible[0] === "naytot" && /\/tulosteet\/naytot/.test(sw.hash))
    ? ok("tulosteet-keskus: välilehden vaihto näyttää oikean paneelin + päivittää URL:n")
    : fail("tulosteet-keskus: välilehden vaihto ei toimi: " + JSON.stringify(sw));

  // --- Saavutettavuusseloste ---
  await page.goto(BASE + "/#/saavutettavuus", { waitUntil: "networkidle2" });
  await expect(".card h2", "saavutettavuusseloste avautuu");

  // --- Tietosuojaseloste + käyttöehdot (demo.reittari.fi:n lakisääteiset sivut) ---
  // Assertoidaan rakennetta, ei sanamuotoa: molemmat reitit renderöityvät kaikilla kolmella
  // kielellä (kortin lang-attribuutti = valittu kieli, useita osioita), footerissa on linkit,
  // palveluntarjoaja ja CC BY 4.0 -lisenssilinkki, eikä sivu aseta evästeitä tai näytä
  // evästebanneria (selosteen evästearvio nojaa tähän). Kieli on globaali → palautetaan FI.
  for (const lg of ["fi", "en", "sv"]) {
    await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
    await page.click(`[data-lang-opt="${lg}"]`);
    await page.waitForFunction(l => document.documentElement.lang === l, { timeout: 10000 }, lg);
    for (const [hash, id] of [["tietosuoja", "legalPrivacy"], ["kayttoehdot", "legalTerms"]]) {
      await page.goto(BASE + "/#/" + hash, { waitUntil: "networkidle2" });
      await sleep(150);
      const st = await page.evaluate(i => {
        const el = document.getElementById(i);
        return { on: !!el, lang: el && el.getAttribute("lang"), h2: !!(el && el.querySelector("h2")),
                 sections: el ? el.querySelectorAll("h3").length : 0,
                 crumb: !!document.querySelector('nav.crumb a[href="#/"]') };
      }, id);
      (st.on && st.lang === lg && st.h2 && st.crumb && st.sections >= 5)
        ? ok(`${hash} (${lg}): sivu renderöityy kielellä ${lg} (${st.sections} osiota)`)
        : fail(`${hash} (${lg}): näkymä vajaa: ${JSON.stringify(st)}`);
    }
  }
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  await page.click('[data-lang-opt="fi"]'); // palauta oletuskieli seuraaville testeille
  await page.waitForFunction(() => document.documentElement.lang === "fi", { timeout: 10000 });
  const legalFoot = await page.evaluate(() => ({
    tietosuoja: !!document.querySelector('#appFooter a[href="#/tietosuoja"]'),
    kayttoehdot: !!document.querySelector('#appFooter a[href="#/kayttoehdot"]'),
    tarjoaja: !!document.querySelector('#appFooter #footProvider a[href^="mailto:"]'),
    ccby: !!document.querySelector('#appFooter #footAttribution a[href*="creativecommons.org/licenses/by/4.0"]'),
    evasteet: document.cookie,
    banneri: !!document.querySelector('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]'),
  }));
  (legalFoot.tietosuoja && legalFoot.kayttoehdot && legalFoot.tarjoaja && legalFoot.ccby)
    ? ok("footer: tietosuoja + käyttöehdot + palveluntarjoaja + CC BY 4.0 -linkki")
    : fail("footer: lakisääteiset linkit vajaat: " + JSON.stringify(legalFoot));
  (legalFoot.evasteet === "" && !legalFoot.banneri)
    ? ok("evästeet: sivu ei aseta evästeitä eikä näytä evästebanneria")
    : fail("evästeet: " + JSON.stringify({ evasteet: legalFoot.evasteet, banneri: legalFoot.banneri }));

  // --- Vanha #/tulosteet (bare) ohjautuu julisteet-välilehdelle; #/tulosteet/<tab> osoitteistettu ---
  await page.goto(BASE + "/#/tulosteet", { waitUntil: "networkidle2" });
  // odota että viewPrintCenterin loadRoutes valmistuu (välilehti aktivoituu + paneeli renderöityy)
  await page.waitForFunction(
    () => document.querySelector('.ptab[data-ptab="julisteet"][aria-pressed="true"]') && document.getElementById("batchLine"),
    { timeout: 30000 }).catch(() => {});
  const bare = await page.evaluate(() => ({ active: document.querySelector('.ptab[aria-pressed="true"]')?.dataset.ptab, hash: location.hash }));
  (bare.active === "julisteet" && /\/tulosteet\/julisteet/.test(bare.hash))
    ? ok(`tulosteet-keskus: bare #/tulosteet ohjautuu julisteet-välilehdelle (${bare.hash})`)
    : fail("tulosteet-keskus: bare #/tulosteet-ohjaus pielessä: " + JSON.stringify(bare));
  await expect("#hubStopSearch", "tulosteet-keskus: näyttöverkosto-haku DOMissa");
  if (await expect("#batchLine", "tulosteet-keskus: linjan erätulostus näkyy")) {
    await sleep(1800); // loadRoutes täyttää linjavalikon
    const opts = await page.evaluate(() => document.querySelectorAll("#batchLine option").length);
    opts > 1 ? ok(`tulosteet-keskus: linjavalinta täyttyy (${opts - 1} linjaa)`)
             : fail("tulosteet-keskus: linjavalinta jäi tyhjäksi");
  }
  // URL-osoitteistettu välilehti (?tab=) ja yksi etusivun nappi (ei enää kahta tulostenappia)
  await page.goto(BASE + "/#/tulosteet?tab=naytot", { waitUntil: "networkidle2" });
  await sleep(400);
  const q = await page.evaluate(() => document.querySelector('.ptab[aria-pressed="true"]')?.dataset.ptab);
  q === "naytot" ? ok("tulosteet-keskus: ?tab=naytot avaa oikean välilehden")
                 : fail("tulosteet-keskus: ?tab= ei toiminut (" + q + ")");
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  const printTools = await page.evaluate(() => document.querySelectorAll('a.tool[href^="#/tulost"]').length);
  printTools === 1 ? ok("etusivu: yksi 'Tulosteet ja näytöt' -nappi (korvaa kaksi)")
                   : fail(`etusivu: tulostenappeja ${printTools} (odotus 1)`);

  // --- Uusintapainatuslista: mitkä painetut tulosteet ovat vanhentuneet ---
  // Seurattava yksikkö = painettava arkki: CONFIG.corridors-käytävät + jokainen linja.
  // Assertio mittaa yksikkömäärät, ei pelkkää otsikkoa: tyhjä lista on virhetila eikä
  // saa mennä läpi (vrt. "ei lähtöjä" -fallback).
  await page.goto(BASE + "/#/uusintapainatus", { waitUntil: "networkidle2" });
  await sleep(600);
  const rp = await page.evaluate(() => ({
    otsikko: !!document.querySelector("h2"),
    yksikoita: document.querySelectorAll(".rpCb").length,
    kaytavia: [...document.querySelectorAll("#rpOthers li, #rpTracked li")]
      .filter(li => li.querySelector('input[value^="corr:"]')).length,
    nappi: !!document.getElementById("rpGo"),
    perustasovihje: !!document.querySelector("#rpOthers"),
  }));
  (rp.otsikko && rp.nappi && rp.perustasovihje && rp.kaytavia === 2 && rp.yksikoita > 50)
    ? ok(`uusintapainatus: ${rp.yksikoita} seurattavaa yksikköä (${rp.kaytavia} käytävää + linjat)`)
    : fail("uusintapainatus: näkymä vajaa: " + JSON.stringify(rp));

  // Perustason vertailu: merkitty tuloste + muuttunut data = "painettava uudelleen".
  // Ajetaan puhtaasti sormenjälkitasolla (ei verkkohakua), jotta assertio on nopea ja vakaa.
  const diffProbe = await page.evaluate(() => {
    const perus = { dirs: [{ label: "Tevi P A > Sipurantie P", groups: [
      { label: "Ma-To", n: 84, first: "05:10", last: "23:18", h: "vanha" }] }] };
    const nyt = { dirs: [{ label: "Trio A > Sipurantie P", groups: [
      { label: "Ma-To", n: 87, first: "04:35", last: "23:18", h: "uusi" }] }] };
    return { muutokset: reprintDiff(perus, nyt), sama: reprintDiff(nyt, nyt) };
  });
  (diffProbe.muutokset.length >= 2 && diffProbe.sama.length === 0 &&
   diffProbe.muutokset.some(s => /Tevi P/.test(s)) && diffProbe.muutokset.some(s => /84|87/.test(s)))
    ? ok(`uusintapainatus: muutosvertailu tuottaa syyn (${diffProbe.muutokset.length} riviä, muuttumaton = 0)`)
    : fail("uusintapainatus: muutosvertailu ei toimi: " + JSON.stringify(diffProbe));

  // --- Oma reittihaku layer-kaupungeissa (Raasepori, 29.8.2026) ---
  // Raasepori ja Turku ohjasivat aiemmin kaupungin omaan reittioppaaseen
  // (CONFIG.externalPlanner). Ulos ohjaaminen sai palvelun näyttämään ohuemmalta kuin se on,
  // joten oma A->B-haku on käytössä kuten Vaasassa ja Kotkassa. Assertio vartioi molempia
  // suuntia: omat kentät OVAT olemassa eikä ulkoista linkkiä jää roikkumaan mihinkään.
  await page.goto(BASE + "/?city=raasepori#/", { waitUntil: "networkidle2" });
  await page.waitForSelector("#homeFromInput", { timeout: 15000 }).catch(() => {});
  const extHome = await page.evaluate(() => ({
    link: document.getElementById("extPlannerLink")?.getAttribute("href") || "",
    fields: !!document.getElementById("homeFromInput") && !!document.getElementById("homeToInput"),
    nav: [...document.querySelectorAll("a")].some(a => /bosse\.digitransit\.fi/.test(a.href)),
    hash: location.hash, view: (document.getElementById("app")?.textContent || "").replace(/\s+/g, " ").slice(0, 120),
  }));
  (extHome.fields && !extHome.link && !extHome.nav)
    ? ok("oma reittihaku (Raasepori): etusivulla omat A->B-kentät, ei ulkoista reittiopaslinkkiä")
    : fail("oma reittihaku (Raasepori): " + JSON.stringify(extHome));
  await page.goto(BASE + "/?city=raasepori#/reitti", { waitUntil: "networkidle2" });
  await page.waitForSelector("#planForm", { timeout: 15000 }).catch(() => {});
  const extPlan = await page.evaluate(() => ({
    link: document.getElementById("extPlannerLink")?.getAttribute("href") || "",
    form: !!document.getElementById("planForm"),
  }));
  (extPlan.form && !extPlan.link)
    ? ok("oma reittihaku (Raasepori): #/reitti näyttää oman hakulomakkeen")
    : fail("oma reittihaku (Raasepori): #/reitti: " + JSON.stringify(extPlan));
  await page.goto(BASE + "/?city=raasepori#/palvelutiski", { waitUntil: "networkidle2" });
  await page.waitForSelector("#deskFrom", { timeout: 15000 }).catch(() => {});
  const extDesk = await page.evaluate(() => !!document.querySelector("#app h2") &&
    !!document.getElementById("deskFrom") && !!document.getElementById("deskTo") && !!document.getElementById("deskNlInput"));
  extDesk ? ok("oma reittihaku (Raasepori): palvelutiskin reittihaku ennallaan")
          : fail("oma reittihaku (Raasepori): palvelutiskin reittihaku katosi");
  await page.goto(BASE + "/?city=lahti#/", { waitUntil: "networkidle2" });
  await page.waitForSelector("#homeFromInput", { timeout: 15000 }).catch(() => {});
  const extLahti = await page.evaluate(() => ({
    fields: !!document.getElementById("homeFromInput"), link: !!document.getElementById("extPlannerLink") }));
  (extLahti.fields && !extLahti.link)
    ? ok("oma reittihaku: Lahdella omat A->B-kentät ennallaan (regressio)")
    : fail("oma reittihaku: Lahti: " + JSON.stringify(extLahti));

  // --- Livekartan tyhjätila (CONFIG.vehicleRealtime === false, Raasepori) ---
  // Raaseporin feedistä ei tule GTFS-RT-ajoneuvopositioita: livekartta näyttää heti tilatekstin
  // eikä "Yhdistetään reaaliaikadataan..." -jäämää. Lahdessa (jolla on reaaliaikaseuranta)
  // tekstiä ei saa näkyä, jotta liian innokas piilotus ei mene läpi (regressio).
  await page.goto(BASE + "/?city=raasepori#/kartta", { waitUntil: "networkidle2" });
  await expect("#liveMap.leaflet-container", "livekartan tyhjätila: kartta latautuu (Raasepori)");
  const noRtState = await page.evaluate(() => ({
    count: document.getElementById("liveCount")?.textContent || "",
    hint: !!document.querySelector(".card p.muted .rt"),
  }));
  (/reaaliaikaseurantaa/.test(noRtState.count) && !noRtState.hint)
    ? ok("livekartan tyhjätila: tilateksti näkyy heti eikä bussivihjettä näytetä (Raasepori)")
    : fail("livekartan tyhjätila (Raasepori): " + JSON.stringify(noRtState));
  await page.goto(BASE + "/?city=lahti#/kartta", { waitUntil: "networkidle2" });
  await expect("#liveMap.leaflet-container", "livekartan tyhjätila: kartta latautuu (Lahti)");
  const rtState = await page.evaluate(() => document.getElementById("liveCount")?.textContent || "");
  !/reaaliaikaseurantaa/.test(rtState)
    ? ok("livekartan tyhjätila: Lahdessa tilatekstiä ei näytetä (regressio)")
    : fail("livekartan tyhjätila: Lahdessa näkyi virheellisesti tyhjätilateksti: " + rtState);

  // --- Junanaytto: kaksi asemaa (Raasepori) ---
  // Raaseporin palvelutiskin oletuspysakki on Ekenas busstation (Tammisaari), mutta
  // junalohko naytti aiemmin vain Karjaan, koska CONFIG.rail oli yksi asemakoodi.
  // Nyt rail voi olla lista. Tarkistus assertoi RAKENNETTA (kaksi asemaotsikkoa, kaksi
  // taulukkoa, ei virhelohkoa) eika asemien nimia tai lahtojen sisaltoa: junatarjonta
  // vaihtuu vuorokaudenajan mukaan, mutta asemien maara ei.
  await page.goto(BASE + "/?city=raasepori#/junat", { waitUntil: "networkidle2" });
  await expect("#trainsOut table", "junanaytto (Raasepori): junalahdot renderoityvat");
  const railTwo = await page.evaluate(() => ({
    otsikot: [...document.querySelectorAll("#trainsOut h3")].map(h => h.textContent.trim()),
    taulukot: document.querySelectorAll("#trainsOut table").length,
    virhe: !!document.querySelector("#trainsOut .error"),
    intro: document.getElementById("trainsIntro")?.textContent || "",
  }));
  (railTwo.otsikot.length === 2 && railTwo.otsikot[0] !== railTwo.otsikot[1]
    && railTwo.taulukot === 2 && !railTwo.virhe && railTwo.intro.length > 0)
    ? ok(`junanaytto (Raasepori): kaksi asemaa omina lohkoinaan (${railTwo.otsikot.join(" + ")})`)
    : fail("junanaytto (Raasepori): " + JSON.stringify(railTwo));

  // Regressio: yhden aseman kaupungissa ulkoasu ei saa muuttua (ei asemaotsikkoa).
  await page.goto(BASE + "/?city=lahti#/junat", { waitUntil: "networkidle2" });
  await expect("#trainsOut table", "junanaytto (Lahti): junalahdot renderoityvat");
  const railOne = await page.evaluate(() => ({
    otsikot: document.querySelectorAll("#trainsOut h3").length,
    taulukot: document.querySelectorAll("#trainsOut table").length,
    virhe: !!document.querySelector("#trainsOut .error"),
  }));
  (railOne.otsikot === 0 && railOne.taulukot === 1 && !railOne.virhe)
    ? ok("junanaytto: yhden aseman kaupunki ennallaan, ei asemaotsikkoa (regressio)")
    : fail("junanaytto (Lahti): " + JSON.stringify(railOne));

  // --- Konsolivirheet ---
  const realErrors = consoleErrors.filter(e => !e.includes("favicon"));
  realErrors.length
    ? fail("konsolivirheitä:\n  " + realErrors.join("\n  "))
    : ok("ei konsolivirheitä");

  await browser.close();
  console.log(failures ? `\n${failures} TARKISTUSTA EPÄONNISTUI` : "\nKAIKKI TARKISTUKSET OK");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR: " + e.message); process.exit(1); });

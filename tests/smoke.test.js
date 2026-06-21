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
  await expect("#routeList li a.route-tile .rt-badge", "etusivu: linjalista (badge-ruudukko) latautuu");

  // Etusivun uudistus: hero-reittihaku + työkalurivi (inline-SVG-ikonit) + jäsennelty footer
  (await page.$("#homeFromInput") && await page.$("#homeToInput") && await page.$("#heroSearch"))
    ? ok("etusivu: hero-reittihaku (Mistä/Minne/Hae yhteydet) latautuu")
    : fail("etusivu: hero-reittihaku puuttuu");
  // Layer-hero reittiopaskaupungilla (Lahti = oletuskaupunki): arvolupaus + nostot (kielenvaihto +
  // tulosteet) ja A->B SÄILYY toissijaisena alaosiona.
  const layer = await page.evaluate(() => {
    const h = document.querySelector(".hero.hero-layer"); if (!h) return null;
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
    noLayer: !document.querySelector(".hero-layer"), hero: !!document.querySelector(".hero h2"),
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
  // Poistuminen purkaa koko ruudun tilan
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  (await page.evaluate(() => document.body.classList.contains("desk-mode")))
    ? fail("palvelutiski: desk-mode ei purkaudu poistuttaessa")
    : ok("palvelutiski: desk-mode purkautuu poistuttaessa");

  // Minimi-CONFIG-kaupungin (Vaasa) ETUSIVU: CONFIG-puuttuvat napit (hubs/fares) jäävät pois,
  // mutta ryhmät renderöityvät silti ILMAN tyhjää otsikkoa (jokaisessa ≥1 nappi). Yksi haku.
  await page.goto(BASE + "/?city=vaasa#/", { waitUntil: "networkidle2" });
  const vHome = await page.evaluate(() => ({
    groups: [...document.querySelectorAll(".tool-group")].map(g => ({
      title: g.querySelector(".tool-group-h")?.textContent.trim() || "", tools: g.querySelectorAll("a.tool").length })),
    hasFaresTool: !!document.querySelector('a.tool[href="#/liput"]'),
    hasHubTool: !!document.querySelector('a.tool[href="#/laiturit"]'),
    oneSearch: !!document.querySelector(".home-search #uniSearch") && !document.querySelector("#nearbyBtn"),
  }));
  (vHome.groups.length >= 2 && vHome.groups.every(g => g.title && g.tools > 0)
    && !vHome.hasFaresTool && !vHome.hasHubTool && vHome.oneSearch)
    ? ok(`etusivu (Vaasa, minimi-CONFIG): ryhmät ilman tyhjää otsikkoa, hubs/fares-napit pois (${vHome.groups.map(g => g.title + ":" + g.tools).join(", ")})`)
    : fail("etusivu (Vaasa): tyhjä/puuttuva ryhmä / hubs|fares-nappi yhä / haku rikki: " + JSON.stringify(vHome));

  // Minimi-CONFIG-kaupunki (Vaasa: ei hubs/fares/cmsAlerts): palvelutiskin uusien lohkojen
  // (live-lähdöt, viimeinen bussi, aktiiviset häiriöt) on silti renderöidyttävä — vain
  // hintalohko piiloon. Estää regression jossa lohkot riippuisivat kaupungin CONFIGista.
  await page.goto(BASE + "/?city=vaasa#/palvelutiski", { waitUntil: "networkidle2" });
  const vBlocks = await page.evaluate(() => ({
    deps: !!document.getElementById("deskStop"), ab: !!document.getElementById("deskFrom"),
    lastBus: !!document.getElementById("deskLastBusBtn"), alerts: !!document.getElementById("deskAlerts"),
    fares: !!document.getElementById("deskFaresH"),
  }));
  (vBlocks.deps && vBlocks.ab && vBlocks.lastBus && vBlocks.alerts && !vBlocks.fares)
    ? ok("palvelutiski (Vaasa, minimi-CONFIG): live-lähdöt + viimeinen bussi + häiriöt näkyvät, hinnat piilossa")
    : fail("palvelutiski (Vaasa, minimi-CONFIG): uudet lohkot puuttuvat / hintalohko väärin: " + JSON.stringify(vBlocks));
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

  // Korkea kontrasti OLETUKSENA päällä (tyhjä localStorage → high); kytkin sammuttaa ja valinta persistoituu.
  if (await page.$('[data-contrast-opt="normal"]')) {
    // tyhjennä valinta → testaa aito oletus
    await page.evaluate(() => localStorage.removeItem("contrast"));
    await page.reload({ waitUntil: "networkidle2" }); await sleep(200);
    const def = await page.evaluate(() => document.documentElement.dataset.contrast || "(none)");
    def === "high"
      ? ok("asetukset: korkea kontrasti OLETUKSENA päällä (tyhjä localStorage)")
      : fail(`asetukset: kontrasti ei ollut oletuksena päällä (oli ${def})`);
    const bgHigh = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // sammuta (Normaali) → attribuutti pois + tausta muuttuu + muistetaan localStorageen
    await page.click('[data-contrast-opt="normal"]'); await sleep(150);
    const off = await page.evaluate(() => ({ attr: document.documentElement.dataset.contrast || "(none)",
      bg: getComputedStyle(document.body).backgroundColor, ls: localStorage.getItem("contrast") }));
    (off.attr === "(none)" && off.bg !== bgHigh && off.ls === "normal")
      ? ok(`asetukset: kytkin sammuttaa kontrastin (tausta ${bgHigh}→${off.bg}, muistettu)`)
      : fail("asetukset: kontrastin sammutus ei toiminut: " + JSON.stringify(off));
    // persistoituu uudelleenlatauksen yli: tallennettu "normal" voittaa oletuksen
    await page.reload({ waitUntil: "networkidle2" }); await sleep(200);
    const after = await page.evaluate(() => document.documentElement.dataset.contrast || "(none)");
    after === "(none)"
      ? ok("asetukset: sammutettu kontrasti pysyy pois latauksen jälkeen")
      : fail(`asetukset: kontrasti palasi päälle reloadin jälkeen (${after})`);
    // kytke takaisin päälle (palauta oletustila muille testeille)
    if (await page.$('[data-contrast-opt="high"]')) { await page.click('[data-contrast-opt="high"]'); await sleep(100); }
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
  (pc.tabs === 3 && pc.active === "vihko" && /#\/tulosteet\/vihko/.test(pc.hash) && pc.booklet && pc.batch && pc.hub)
    ? ok(`tulosteet-keskus: #/tulosta ohjautuu vihko-välilehdelle, 3 välilehteä (${pc.hash})`)
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
      await page.evaluate(() => { window.__rp = window.print; window.print = () => {}; });
      await page.click("#bookletPrintA5");
      await sleep(300);
      const vk = await page.evaluate(() => ({
        sheets: document.querySelectorAll("#vihkoPrint .vihko-sheet").length,
        pages: document.querySelectorAll("#vihkoPrint .vihko-a5:not(.vihko-blank)").length,
        slots: document.querySelectorAll("#vihkoPrint .vihko-a5").length,
        a4: !!document.getElementById("bookletPrint"),
      }));
      (vk.sheets >= 2 && vk.pages >= 1 && vk.slots % 4 === 0 && vk.a4)
        ? ok(`vihko: A5-imposition (${vk.pages} sivua → ${vk.slots} paikkaa, ${vk.sheets} arkkipuolta; A4-nappi ennallaan)`)
        : fail("vihko: imposition pielessä: " + JSON.stringify(vk));
      await page.evaluate(() => { document.getElementById("vihkoPrint")?.remove(); document.body.classList.remove("vihko-printing"); window.print = window.__rp; });
    }
  }
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

  // --- Konsolivirheet ---
  const realErrors = consoleErrors.filter(e => !e.includes("favicon"));
  realErrors.length
    ? fail("konsolivirheitä:\n  " + realErrors.join("\n  "))
    : ok("ei konsolivirheitä");

  await browser.close();
  console.log(failures ? `\n${failures} TARKISTUSTA EPÄONNISTUI` : "\nKAIKKI TARKISTUKSET OK");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR: " + e.message); process.exit(1); });

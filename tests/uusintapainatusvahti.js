#!/usr/bin/env node
// Uusintapainatusvahti: ajastettu vertailu siitä, mitkä JO PAINETUT tulosteet ovat vanhentuneet.
//
// Muutosvahti (tests/muutosvahti.js) kertoo että feed muuttui. Tämä kertoo mitkä kunnan painamat
// arkit ovat sen takia väärin. Ero on perustasossa: muutosvahdilla se on viime viikon data, tässä
// se hetki jolloin kunta painoi paperin. Perustaso tallennetaan workerin KV:hen (vaihe 1, 4.9.2026).
//
// MIKSI TÄMÄ AJAA SELAIMEN. Nykytilan sormenjälki lasketaan sovelluksessa (reprintLineSnap,
// reprintCorridorSnap): patternivalinta tulevien vuorojen mukaan, päivätyyppilohkot ja käytävien
// corridorBuild. Jos sama logiikka kirjoitettaisiin tähän toiseen kertaan, se alkaisi ajan myötä
// erota tuotteesta, ja ero näkyisi kunnalle vääränä hälytyksenä juuri siinä kohtaa jossa vahtia
// pitäisi uskoa. Siksi vertailun ajaa sama sovellus headless-Chromella, samalla koodilla jonka
// käyttäjä näkee Uusintapainatus-välilehdellä.
//
// Ajo:  REPRINT_SERVICE_TOKEN=... node tests/uusintapainatusvahti.js
// Exit: 0 = kaikki kaupungit vertailtu, 1 = vähintään yksi kaupunki jäi vertailematta.
//
// EPÄONNISTUNUTTA YKSIKKÖÄ EI RAPORTOIDA KUNNOSSA OLEVAKSI. Jos yksikin seurattu tuloste jää
// laskematta (kiintiö, verkkovirhe), kaupungin tulosta ei lähetetä lainkaan ja ajo päättyy
// punaiseen. Vaihtoehto olisi lähettää vajaa lista, jolloin puuttuva tuloste näyttäisi siltä
// että se on ajan tasalla. Se on juuri se virhe jota vahti on olemassa estämään.

const puppeteer = require("puppeteer");

const PROXY = (process.env.PROXY || "https://lsl-aikataulut-proxy.veikkoville.workers.dev").replace(/\/+$/, "");
const BASE = (process.env.BASE || "https://demo.reittari.fi").replace(/\/+$/, "");
const TOKEN = process.env.REPRINT_SERVICE_TOKEN || "";
const CITY_GAP_MS = +(process.env.CITY_GAP_MS || 5000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sivulla ajettava vertailu. units = { id: { label, printed, sig } }.
// Palauttaa vanhentuneiden tunnukset ja epäonnistuneet erikseen, koska ne ovat eri asia.
async function vertaaSivulla(page, units) {
  return page.evaluate(async (units) => {
    const routes = await loadRoutes();
    const corrs = new Map((CONFIG.corridors || []).map(c => ["corr:" + c.key, c]));
    const date = todayISO();
    const stale = [], failed = [];
    for (const [id, u] of Object.entries(units)) {
      // Poistettu käytäväpreset: tunnus alkaa "corr:" mutta CONFIGissa ei ole vastinetta.
      // Se ei ole "ajan tasalla" vaan tuntematon, joten se menee epäonnistuneisiin.
      if (id.startsWith("corr:") && !corrs.has(id)) { failed.push(id); continue; }
      try {
        const snap = corrs.has(id)
          ? await reprintCorridorSnap(corrs.get(id), date, routes)
          : await reprintLineSnap(id, date);
        if (!snap) { failed.push(id); continue; }
        if (reprintDiff(u.sig, snap).length) stale.push(id);
      } catch (e) { failed.push(id); }
    }
    return { stale, failed, date };
  }, units);
}

(async () => {
  if (!TOKEN) { console.log("FAIL huoltoavain puuttuu (REPRINT_SERVICE_TOKEN)"); process.exit(1); }

  const listaus = await fetch(`${PROXY}/reprint/service?token=${encodeURIComponent(TOKEN)}`);
  if (!listaus.ok) { console.log("FAIL seurattujen tulosteiden luku: HTTP " + listaus.status); process.exit(1); }
  const { cities } = await listaus.json();
  if (!cities || !cities.length) {
    // Ei kaupunkeja on eri asia kuin "ei löydöksiä": kumpikaan ei ole virhe, mutta ne erotellaan.
    console.log("INFO yksikään kaupunki ei seuraa tulosteita, ei vertailtavaa");
    process.exit(0);
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  let virheita = 0;
  try {
    for (const { city, units } of cities) {
      const page = await browser.newPage();
      try {
        await page.goto(`${BASE}/?city=${encodeURIComponent(city)}#/`, { waitUntil: "networkidle2", timeout: 60000 });
        await page.waitForFunction(() => typeof reprintLineSnap === "function", { timeout: 30000 });
        let tulos = await vertaaSivulla(page, units);
        if (tulos.failed.length) {
          // Yksi uusinta, kuten prod-smokessa: kiintiö palautuu yleensä minuutissa.
          console.log(`INFO [${city}] ${tulos.failed.length} yksikköä epäonnistui, uusitaan kerran`);
          await sleep(60000);
          const uusinta = await vertaaSivulla(page, Object.fromEntries(tulos.failed.map(id => [id, units[id]])));
          tulos = {
            stale: tulos.stale.concat(uusinta.stale),
            failed: uusinta.failed,
            date: tulos.date,
          };
        }
        if (tulos.failed.length) {
          virheita++;
          console.log(`FAIL [${city}] ${tulos.failed.length}/${Object.keys(units).length} yksikköä jäi laskematta, tulosta EI lähetetä`);
          continue;
        }
        const vastaus = await fetch(`${PROXY}/reprint/service`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: TOKEN, city, stale: tulos.stale, checkedAt: new Date().toISOString() }),
        });
        const j = await vastaus.json().catch(() => ({}));
        if (!vastaus.ok) { virheita++; console.log(`FAIL [${city}] tuloksen kirjaus: HTTP ${vastaus.status}`); continue; }
        console.log(`PASS [${city}] ${Object.keys(units).length} tulostetta vertailtu, vanhentuneita ${tulos.stale.length}` +
          `${j.changed ? ", tila muuttui" : ", tila ennallaan"}${j.notified ? ", ilmoitus lähetetty" : ""}`);
      } catch (e) {
        virheita++;
        console.log(`FAIL [${city}] ${e.message}`);
      } finally {
        await page.close().catch(() => {});
      }
      await sleep(CITY_GAP_MS);
    }
  } finally {
    await browser.close();
  }
  console.log(virheita ? `\n${virheita} KAUPUNKIA JÄI VERTAILEMATTA` : "\nKAIKKI KAUPUNGIT VERTAILTU");
  process.exit(virheita ? 1 : 0);
})();

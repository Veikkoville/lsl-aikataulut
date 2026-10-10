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

// Minuuttisarakevartija (27.9.2026): tuntiruudukossa saman sarakeryhmän (linja tai päivätyyppi)
// saman kymmenluvun minuuttien on alettava samasta vaakakohdasta kaikilla riveillä. Tiivis
// juliste ja tiivis vihko latoivat minuutit yhteen soluun välilyönnein, jolloin :39 osui
// Lappeenrannan julisteessa neljään eri kohtaan ja luvut kulkivat vinosti. Aiempi vartija laski
// vain solut riviltä, ja se meni läpi koska solumäärä oli tasainen. Tämä mittaa jokaisen
// minuutin paikan Rangella: solun kunkin kymmenluvun ensimmäinen minuutti ryhmitellään
// (taulukko, otsikkosolu jonka colspan kattaa sarakkeen, kymmenluku), ja hajonta saa olla 0,5 px.
// Juliste ja tiskin tuloste ovat ruudulla piilossa, joten ne mitataan print-medialla (kuten
// printHygiene); media palautetaan heti, ettei se vuoda seuraaviin tarkistuksiin.
async function minuuttiLinjaus(page, rootSel, media) {
  if (media) await page.emulateMediaType(media);
  const r = await page.evaluate(sel => {
    const viat = [];
    let n = 0;
    document.querySelectorAll(`${sel} table.hourgrid, ${sel} table.cb-grid`).forEach((t, ti) => {
      // Sarakeryhmät otsikon VIIMEISESTÄ rivistä: linjasarakkeisen julisteen (poster-matrix) ensimmäinen rivi on koko
      // levyinen otsikko, ja rows[0] niputti kaikki linjat yhdeksi ryhmäksi (väärä hälytys 8 kaupungissa 28.9.2026, issue #40).
      const hr = t.tHead && t.tHead.rows[t.tHead.rows.length - 1];
      const grp = [];
      if (hr) [...hr.cells].forEach((c, gi) => { for (let k = 0; k < (c.colSpan || 1); k++) grp.push(gi); });
      const xs = new Map();
      for (const tr of (t.tBodies[0] || { rows: [] }).rows) {
        let col = 0;
        for (const cell of tr.cells) {
          const g = hr ? grp[col] : col;
          col += cell.colSpan || 1;
          if (cell.tagName !== "TD") continue;
          const seen = new Set();
          const w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          for (let tn; (tn = w.nextNode());) {
            if (tn.parentElement.closest("sup")) continue;
            for (const m of tn.data.matchAll(/(?<![\d:.])(\d{2})(?![\d:.])/g)) {
              if (seen.has(m[1][0])) continue;
              seen.add(m[1][0]);
              const r = document.createRange();
              r.setStart(tn, m.index); r.setEnd(tn, m.index + 2);
              const b = r.getBoundingClientRect();
              if (!b.width) continue;
              const key = `${g}|${m[1][0]}`;
              if (!xs.has(key)) xs.set(key, []);
              xs.get(key).push({ x: b.left, m: m[1], h: tr.cells[0].textContent.trim() });
              n++;
            }
          }
        }
      }
      for (const [key, a] of xs) {
        const lo = a.reduce((p, q) => q.x < p.x ? q : p), hi = a.reduce((p, q) => q.x > p.x ? q : p);
        if (hi.x - lo.x > 0.5 && viat.length < 4)
          viat.push(`taulukko ${ti} sarake ${key.split("|")[0]}: :${lo.m} klo ${lo.h} x=${lo.x.toFixed(1)} mutta :${hi.m} klo ${hi.h} x=${hi.x.toFixed(1)}`);
      }
    });
    return { n, viat };
  }, rootSel);
  if (media) await page.emulateMediaType(null);
  return r;
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
  // Konsoliviesti "Failed to load resource: net::ERR_..." ei kerro mitään osoitetta, joten
  // punaisesta ajosta ei näe kaatuiko oma sivu vai jokin ulkopuolinen rajapinta. 10.9.2026
  // prod-smoke kaatui seitsemään ERR_CONNECTION_CLOSED -riviin ilman yhtään osoitetta, eikä
  // vika toistunut — diagnoosi jäi arvaukseksi. requestfailed antaa URL:n ja virhetekstin;
  // ne liitetään konsolivirheisiin lopussa. Tämä EI vaienna virhettä, vain nimeää sen.
  const failedRequests = [];
  page.on("requestfailed", r => {
    const failure = r.failure();
    failedRequests.push({ url: r.url(), error: (failure && failure.errorText) || "", used: false });
  });

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
  // Ilme 25.9.2026: pääkuvassa kaupungin esimerkkijuliste + vihon sivu (staattiset kuvat, ei kyselyjä),
  // kuvateksti luettelosta, linjamäärä samasta loadRoutes-hausta kuin linjalista; kaupungin väri tokeneina
  // (#cityTheme) ja päävalikossa Etusivu aktiivisena.
  await page.waitForFunction(() => !document.getElementById("hpPapers")?.hidden
    && document.getElementById("hpTagPoster")?.textContent && !document.getElementById("hpFactLines")?.hidden,
    { timeout: 15000 }).catch(() => {});
  const paper = await page.evaluate(() => ({
    kuvat: [...document.querySelectorAll("#hpPapers img")].map(i => i.naturalWidth),
    teksti: document.getElementById("hpTagPoster")?.textContent || "",
    linjat: +(document.querySelector("#hpFactLines b")?.textContent || 0),
    listassa: document.querySelectorAll("#routeList li").length,
    teema: !!document.getElementById("cityTheme"),
    valikko: document.querySelector('#hdrNav a[aria-current="page"]')?.dataset.nav,
  }));
  (paper.kuvat.length === 2 && paper.kuvat.every(w => w > 0) && paper.teksti && paper.linjat > 0
    && paper.teema && paper.valikko === "")
    ? ok(`etusivu (Lahti): pääkuvassa esimerkkijuliste ja vihko (${paper.teksti}), ${paper.linjat} linjaa, kaupungin väri, valikko`)
    : fail("etusivu (Lahti): pääkuvan paperit/luvut/teema pielessä: " + JSON.stringify(paper));
  // Analytiikan hakusignaali: vapaata tekstiä ei välitetä (tietosuoja), pelkkä hakusana ja linjatunnus säilyvät
  const sig = await page.evaluate(() => [searchSignal("Kotikatu 12"), searchSignal("Kauppatori"), searchSignal("22K"),
    searchSignal("a@b.fi"), searchSignal("a".repeat(41))]);
  (sig.join("|") === "[numero]|kauppatori|22k|[sposti]|[pitka]")
    ? ok("analytiikka: searchSignal korvaa henkilön tunnistavat hakutekstit luokalla")
    : fail("analytiikka: searchSignal palautti " + JSON.stringify(sig));
  // Journey-hero greenfield-kaupungilla (Salo): ei layer-osiota, A->B ensisijaisena
  await page.goto(BASE + "/?city=salo#/", { waitUntil: "networkidle2" });
  const journey = await page.evaluate(() => ({
    noLayer: !document.querySelector(".hero-layer"), hero: !!document.querySelector(".reila-hero .reila-hero-h1"),
    fields: !!document.getElementById("homeFromInput") && !!document.getElementById("heroSearch") }));
  (journey.noLayer && journey.hero && journey.fields)
    ? ok("etusivu (Salo, journey): A->B-vetoinen hero ennallaan (ei layer-osiota)")
    : fail("etusivu (Salo, journey): hero väärin: " + JSON.stringify(journey));
  // Journey-hero MYÖS Inkoossa, ja tämä on tarkoituksellista (Villen päätös 3.9.2026).
  // Inkoo ei ole Waltti-kaupunki vaan ELY-liikennettä, ja kunnan reittiopas on ohjattu
  // Matkahuoltoon. Reittarin oma A->B on siis siellä nimenomaan se erottuva osa, toisin
  // kuin reittiopaskaupungeissa joissa se on kaupungin omaa tarjontaa vastaan.
  // Tämä rivi on tässä, koska layer-heroa yritettiin kerran lisätä Inkooseen virheellisellä
  // perustelulla ("matka.fi tekee jo A->B:n"): älä vaihda ilman uutta päätöstä.
  await page.goto(BASE + "/?city=inkoo#/", { waitUntil: "networkidle2" });
  const inkoo = await page.evaluate(() => ({
    noLayer: !document.querySelector(".hero-layer"), hero: !!document.querySelector(".reila-hero .reila-hero-h1"),
    fields: !!document.getElementById("homeFromInput") && !!document.getElementById("heroSearch") }));
  (inkoo.noLayer && inkoo.hero && inkoo.fields)
    ? ok("etusivu (Inkoo, journey): A->B-vetoinen hero (ELY-liikenne, reittiopas Matkahuollossa)")
    : fail("etusivu (Inkoo, journey): hero väärin: " + JSON.stringify(inkoo));
  // ?CITY=JOENSUU (caps lock) avasi Lahden, koska parametrin nimi luettiin kirjainkokotarkasti
  // (Joensuun palaveri 24.9.2026). Kaupunki valitaan ja osoite kanonisoituu, hash säilyy.
  await page.goto(BASE + "/?CITY=JOENSUU#/", { waitUntil: "networkidle2" });
  const caps = await page.evaluate(() => ({ city: document.documentElement.dataset.city,
    search: location.search, hash: location.hash }));
  (caps.city === "joensuu" && caps.search === "?city=joensuu" && caps.hash === "#/")
    ? ok("?CITY=JOENSUU: Joensuu valitaan ja osoite kanonisoituu muotoon ?city=joensuu")
    : fail("?CITY=JOENSUU: väärä kaupunki tai osoite: " + JSON.stringify(caps));
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

  // Esteettömyys: lähimmät-listassa näkyy joko "vain esteettömät pysäkit" -suodatin TAI
  // nimenomainen tieto siitä ettei aineistossa ole esteettömyystietoa (.acc-nodata).
  // Suodin piilotetaan vain kun feed palauttaa NO_INFORMATION jokaisesta pysäkistä: silloin
  // se tuottaisi aina tuloksen "ei esteettömiä pysäkkejä lähistöllä", mikä on väärä väite
  // (mitattu 18.9.2026: Waltti-Lahti 25/25 ja MATKA-Inkoo 6/6 NO_INFORMATION).
  // .acc-nodata on oma elementtinsä eikä virhetilan fallback, ja yllä on jo vaadittu että
  // lähtötaulukko renderöityi, joten tyhjä tai virheellinen lista ei kelpaa tästä läpi.
  const accUi = await page.evaluate(() => ({
    toggle: !!document.querySelector("#nearbyBody #accOnly"),
    nodata: !!document.querySelector("#nearbyBody .acc-nodata"),
  }));
  (accUi.toggle !== accUi.nodata)
    ? ok("esteettömyys: lähimmät-lista kertoo esteettömyyden tilan (" +
        (accUi.toggle ? "suodatin" : "ei tietoa aineistossa") + ")")
    : fail("esteettömyys: suodatin ja tiedon puute yhtä aikaa tai ei kumpaakaan: " + JSON.stringify(accUi));

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
  // Häiriöitä ei aina ole (2.9.2026 klo 22 Lahdella 0 häiriötä, 1 tiedote, sama tuotannossa):
  // silloin häiriölohkoa ei saa olla, ja sääntö B todennetaan tiedotelohkosta. Kun häiriöitä on,
  // lohkon on oltava auki.
  (banner.disCount > 0 && banner.disOpen === true)
    ? ok(`etusivu: kiireelliset häiriöt korostettu ja auki (${banner.disCount})`)
    : (banner.disCount === 0 && banner.disOpen === null)
    ? ok("etusivu: ei kiireellisiä häiriöitä juuri nyt, häiriölohkoa ei näytetä (datariippuva)")
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
  // Erä A (4.10.2026), A8: reittihaun kysely kertoo reitittimelle kaupungin vaihtoajan (planPrefs). Kuuntelija
  // kerää reittikyselyjen (searchWindow PT2H) muuttujat tästä hausta; tarkistus jaetun linkin jälkeen.
  const slackOf = vars => vars.map(v => v?.preferences?.transit?.transfer?.slack || null);
  const planVars = [];
  const planVarListener = req => {
    const pd = req.method() === "POST" ? (req.postData() || "") : "";
    if (pd.includes('searchWindow: \\"PT2H\\"')) { try { planVars.push(JSON.parse(pd).variables); } catch (e) { /* ei JSONia */ } }
  };
  page.on("request", planVarListener);
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
  // A8: Lahden virallinen opas lähettää vaihtoajaksi 90 s ja Fölin 300 s (mitattu 4.10.2026). Ilman vaihtoaikaa
  // Reittari ehdotti Turussa 2 minuutin vaihtoja, joita Fölin opas ei hyväksy.
  const slackLahti = slackOf(planVars);
  planVars.length = 0;
  await page.goto(BASE + "/?city=turku#/reitti/" + encodeURIComponent("60.45597,22.25911,Turun rautatieasema") + "/" +
    encodeURIComponent("60.45290,22.29451,TYKS"), { waitUntil: "networkidle2" });
  await page.waitForFunction(() => document.querySelector("details.itin[data-itin]") || document.querySelector("#planResults .card"),
    { timeout: 25000 }).catch(() => {});
  const slackTurku = slackOf(planVars);
  page.off("request", planVarListener);
  (slackLahti.length > 0 && slackLahti.every(x => x === "PT90S") && slackTurku.length > 0 && slackTurku.every(x => x === "PT300S"))
    ? ok(`reittihaku: vaihtoaika reitittimelle kaupungin oppaan mukaan (Lahti ${slackLahti[0]}, Turku ${slackTurku[0]})`)
    : fail("reittihaku: vaihtoaika puuttuu tai väärä: " + JSON.stringify({ slackLahti, slackTurku }));
  // A6: reittiehdotusten oletusjärjestys. Saapumisaikahaussa myöhäisin perille ehtivä lähtö ensin (ennen paras oli
  // viimeisenä), lähtöaikahaussa tasapelissä aiemmin perillä ja sitten vähemmän kävelyä. Synteettinen vastaus
  // (gql kääritään hetkeksi, palautetaan aina), jotta järjestys ei riipu päivän aikataulusta.
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  const sortChk = await page.evaluate(async () => {
    const orig = gql, wait = ms => new Promise(r => setTimeout(r, ms));
    const n = new Date(), day = isoOf(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1));
    const at = hm => isoWithOffset(day + "T" + hm);
    const node = (dep, arr, line, walk) => ({ start: at(dep), end: at(arr), numberOfTransfers: 0, walkDistance: walk, legs: [
      { mode: "BUS", duration: 600, distance: 3000, realtimeState: "SCHEDULED", start: { scheduledTime: at(dep) }, end: { scheduledTime: at(arr) },
        from: { name: "Hennala", lat: 60.970, lon: 25.624, stop: { code: "1", platformCode: "" } }, to: { name: "LAB Niemi", lat: 61.006, lon: 25.656, stop: { code: "2" } },
        route: { gtfsId: "SMOKEA:" + line, shortName: line }, trip: { tripHeadsign: "LAB Niemi" }, intermediateStops: [], intermediatePlaces: [],
        legGeometry: { points: "" }, alerts: [] }] });
    const arrNodes = [node("06:48", "07:20", "3", 792), node("07:03", "07:26", "32", 500), node("07:34", "08:01", "32", 506), node("07:19", "07:53", "3", 600)];
    const depNodes = [node("08:00", "08:30", "A", 900), node("08:00", "08:30", "B", 200), node("08:00", "08:25", "C", 500), node("07:55", "08:40", "D", 300)];
    gql = async (q, v, o) => q === PLAN_QUERY
      ? { planConnection: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, edges: (v.dateTime && v.dateTime.latestArrival ? arrNodes : depNodes).map(node => ({ node })) } }
      : orig(q, v, o);
    const enc = x => encodeURIComponent(x);
    const show = async (m, first) => {
      location.hash = "#/reitti/" + enc("60.97005,25.62364,Hennala") + "/" + enc("61.00611,25.65579,LAB Niemi") + "/" + enc("t=" + day + "T08:15" + m);
      for (let i = 0; i < 100 && !(document.querySelector("details.itin[data-itin] .times")?.textContent || "").startsWith(first); i++) await wait(100);
      return [...document.querySelectorAll("details.itin[data-itin]")].map(d => d.querySelector(".times").textContent.trim() + " " +
        [...d.querySelectorAll(".legbar .seg:not(.walk)")].map(x => x.textContent.trim()).join("+"));
    };
    try {
      const arr = await show("&m=arr", "07:34");
      const dep = await show("", "07:55");
      return { arr, dep };
    } finally { gql = orig; planState.time = ""; planState.timeMode = "dep"; }
  });
  (sortChk.arr.map(x => x.slice(0, 5)).join(" ") === "07:34 07:19 07:03 06:48"
    && sortChk.dep.join(" | ") === "07:55–08:40 D | 08:00–08:25 C | 08:00–08:30 B | 08:00–08:30 A")
    ? ok("reittihaku: saapumisaikahaussa myöhäisin perille ehtivä ensin, lähtöaikahaun tasapelissä aiemmin perillä ja vähemmän kävelyä")
    : fail("reittihaku: oletusjärjestys: " + JSON.stringify(sortChk));

  // --- Erä C (4.10.2026): kuntalaisen reittihaku virallisen oppaan tasolle ---
  // Synteettinen reittivastaus (gql kääritään, palautetaan aina finally-lohkossa), ajat sivun omassa aikavyöhykkeessä.
  // planVars kerää reittikyselyjen muuttujat; tilat (aika, planState, lisäasetukset, näkymän koko) palautetaan.
  const eraCSearch = async (nodesSrc, hashExtra = "") => {
    await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
    await page.evaluate((src, extra) => {
      const n = new Date(), day = isoOf(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1));
      const at = hm => isoWithOffset(day + "T" + hm);
      const walk = (a, b, m, from, to) => ({ mode: "WALK", duration: 240, distance: m, start: { scheduledTime: at(a) }, end: { scheduledTime: at(b) },
        from: { name: from, lat: 60.977, lon: 25.658 }, to: { name: to, lat: 60.978, lon: 25.659 }, intermediatePlaces: [], legGeometry: { points: "" }, alerts: [] });
      const bus = (a, b, line, alerts) => ({ mode: "BUS", duration: 540, distance: 4000, realtimeState: "SCHEDULED",
        start: { scheduledTime: at(a) }, end: { scheduledTime: at(b) },
        from: { name: "Matkakeskus B", lat: 60.977, lon: 25.658, stop: { code: "307405", platformCode: "B" } },
        to: { name: "PHKS L", lat: 60.991, lon: 25.567, stop: { code: "103661" } }, route: { gtfsId: "SMOKEC:" + line, shortName: line },
        trip: { tripHeadsign: "Tiilikangas" }, intermediateStops: [], intermediatePlaces: [], legGeometry: { points: "" }, alerts: alerts || [] });
      const node = (a, b, line, alerts) => ({ start: at(a), end: at(b), numberOfTransfers: 0, walkDistance: 375,
        legs: [walk(a, "08:12", 251, "Origin", "Matkakeskus B"), bus("08:13", "08:22", line, alerts), walk("08:22", b, 124, "PHKS L", "Destination")] });
      const S = { node, walk, at, day };
      window.__eraCOrig = window.__eraCOrig || gql;
      window.__eraCVars = [];
      const make = new Function("S", "v", "n", "return (" + src + ")(S, v, n);");
      gql = async (q, v, o) => {
        if (q === PLAN_QUERY) { window.__eraCVars.push(v); const r = make(S, v, window.__eraCVars.length); if (r instanceof Error) throw r; return r; }
        if (q === DIRECT_QUERY) return { planConnection: { edges: [] } };
        return window.__eraCOrig(q, v, o);
      };
      location.hash = "#/reitti/" + encodeURIComponent("60.97735,25.65889,Matkakeskus") + "/" +
        encodeURIComponent("60.99165,25.56746,Päijät-Hämeen keskussairaala") + "/" + encodeURIComponent("t=" + day + "T08:00" + extra);
    }, nodesSrc, hashExtra);
    await page.waitForFunction(() => document.querySelector("#planResults details.itin[data-itin]") || document.querySelector("#planResults .card"),
      { timeout: 20000 }).catch(() => {});
    await sleep(500);
  };
  const eraCRestore = () => page.evaluate(() => {
    if (window.__eraCOrig) { gql = window.__eraCOrig; delete window.__eraCOrig; }
    planState.time = ""; planState.timeMode = "dep"; planState.wheelchair = false; planState.nlNote = "";
    try { localStorage.removeItem("planOpts"); } catch (e) {}
  });
  const ONE_ALERT = `(S) => ({ planConnection: { pageInfo: { hasNextPage: true, hasPreviousPage: false, endCursor: "c1" }, edges: [
    { node: S.node("08:08", "08:23", "4", [{ alertHeaderText: "Linja 4 poikkeusreitillä", alertSeverityLevel: "WARNING", alertEffect: "DETOUR" }]) },
    { node: S.node("08:18", "08:33", "14", [{ alertHeaderText: "Lipputiedote", alertSeverityLevel: "INFO", alertEffect: "OTHER_EFFECT" }]) }] } })`;
  try {
    // C1 + C3: suljetussa kortissa lähtöpysäkki ja bussin lähtöaika, ruudunlukijalle linja ja pysäkki, häiriömerkki
    // linjan kohdalle (vain aito häiriö: lipputiedote INFO + OTHER_EFFECT ei saa merkkiä).
    await eraCSearch(ONE_ALERT);
    const c1 = await page.evaluate(() => {
      const s = i => document.querySelector(`details.itin[data-itin="${i}"] summary`);
      return { board: s(0)?.querySelector(".ih-board")?.textContent.trim() || "", hidden: s(0)?.querySelector(".itin-head")?.getAttribute("aria-hidden"),
        sr: s(0)?.querySelector(".sr-only")?.textContent || "", warn0: !!s(0)?.querySelector(".legbar .seg-warn"),
        alert0: s(0)?.querySelector(".ih-alert")?.textContent.trim() || "", warn1: !!s(1)?.querySelector(".legbar .seg-warn, .ih-alert"),
        pad: s(0) ? parseFloat(getComputedStyle(s(0)).paddingRight) : 0 };
    });
    (c1.board === "Bussi 4 lähtee pysäkiltä Matkakeskus B klo 08:13" && c1.hidden === "true" && /Bussi 4 lähtee pysäkiltä Matkakeskus B klo 08:13/.test(c1.sr)
      && /^Lähtö 08:08, perillä 08:23/.test(c1.sr) && c1.warn0 && c1.alert0 === "Häiriö linjalla 4" && /Häiriö linjalla 4/.test(c1.sr) && !c1.warn1 && c1.pad >= 40)
      ? ok("reittihaku (erä C): kortissa lähtöpysäkki ja bussin lähtöaika, ruudunlukijalle linja ja pysäkki, häiriömerkki vain aidolle häiriölle, nuolelle tila")
      : fail("reittihaku (erä C): tuloskortin tiivistelmä: " + JSON.stringify(c1));
    // Hinta (jaettu hinnasto) ja Tulosta avatussa kortissa; paperille vain reittituloste.
    await page.evaluate(() => document.querySelector('details.itin[data-itin="0"] summary')?.click());
    await page.waitForFunction(() => !document.querySelector("details.itin[open] .plan-fare")?.hidden, { timeout: 10000 }).catch(() => {});
    const fare = await page.evaluate(() => (document.querySelector("details.itin[open] .plan-fare")?.textContent || "").replace(/\s+/g, " ").trim());
    await page.evaluate(() => { window.__eraCPrint = window.print; window.print = () => { window.__eraCPrinted = (window.__eraCPrinted || 0) + 1; }; });
    await page.evaluate(() => document.querySelector("details.itin[open] .itin-print-btn")?.click());
    await page.waitForFunction(() => window.__eraCPrinted >= 1, { timeout: 10000 }).catch(() => {});
    await page.emulateMediaType("print");
    const pr = await page.evaluate(() => {
      const vis = el => !!el && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
      return { printed: window.__eraCPrinted || 0, sum: (document.querySelector("#planPrintOut .itin-print .ip-sum")?.textContent || "").replace(/\s+/g, " "),
        out: vis(document.querySelector("#planPrintOut .itin-print")), form: vis(document.getElementById("planForm")), list: vis(document.querySelector(".plan-grid")) };
    });
    await page.emulateMediaType(null);
    await page.evaluate(() => { window.print = window.__eraCPrint; delete window.__eraCPrint; delete window.__eraCPrinted; document.body.classList.remove("plan-printing"); });
    (/^Kertalippu, aikuinen: \d+,\d\d\s€ \(.+\) · Liput ja hinnat$/.test(fare) && pr.printed === 1 && /08:08/.test(pr.sum) && pr.out && !pr.form && !pr.list)
      ? ok(`reittihaku (erä C): avatussa kortissa hinta (${fare.split(" (")[0]}) ja Tulosta, paperille vain reittituloste`)
      : fail("reittihaku (erä C): hinta tai Tulosta: " + JSON.stringify({ fare, pr }));
    // Näytä myöhemmät -virhe ei pyyhi näkyviä reittejä (erän A sivuhavainto), vaan näkyy napin paikalla Yritä uudelleen -napilla.
    await page.evaluate(() => { const o = gql; gql = async (q, v, x) => (q === PLAN_QUERY && v.after ? Promise.reject(new Error("Network error")) : o(q, v, x)); window.__eraCMore = o; });
    await page.evaluate(() => document.getElementById("moreBtn")?.click());
    await page.waitForSelector("#planResults .plan-append-err", { timeout: 8000 }).catch(() => {});
    const more = await page.evaluate(() => ({ n: document.querySelectorAll("#planResults details.itin[data-itin]").length,
      err: !!document.querySelector("#planResults .plan-append-err .plan-append-retry") }));
    await page.evaluate(() => { gql = window.__eraCMore; delete window.__eraCMore; });
    (more.n === 2 && more.err)
      ? ok("reittihaku (erä C): Näytä myöhemmät -virhe jättää reitit näkyviin ja tarjoaa Yritä uudelleen")
      : fail("reittihaku (erä C): myöhempien virhe: " + JSON.stringify(more));

    // Näppäimistöpolku: Enter valmiiksi täytetyssä kentässä lähettää haun, fokus siirtyy tuloslistan otsikkoon, josta
    // ensimmäiseen reittiehdotukseen on enintään 5 Tab-painallusta (ennen Mistä-kentästä 25).
    await page.focus("#toInput");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.id === "planResultsH", { timeout: 10000 }).catch(() => {});
    const kb = { active: await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName), tabs: null };
    for (let i = 1; i <= 12; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => !!document.activeElement?.closest('details.itin[data-itin="0"]'))) { kb.tabs = i; break; }
    }
    (kb.active === "planResultsH" && kb.tabs != null && kb.tabs <= 5)
      ? ok(`reittihaku (erä C): haun jälkeen fokus tuloslistan otsikkoon, ensimmäiseen ehdotukseen ${kb.tabs} Tab`)
      : fail("reittihaku (erä C): näppäimistöpolku: " + JSON.stringify(kb));

    // C2: mobiili 390x844, lomake tiivistyy haun jälkeen ja ensimmäinen bussivaihtoehto on ensimmäisellä ruudulla.
    await page.setViewport({ width: 390, height: 844 });
    await eraCSearch(ONE_ALERT);
    const mob = await page.evaluate(() => {
      const el = document.querySelector("#planResults details.itin[data-itin]"), r = el?.getBoundingClientRect();
      const vis = e => !!e && getComputedStyle(e).display !== "none";
      return { top: r ? Math.round(r.top + scrollY) : null, bottom: r ? Math.round(r.bottom + scrollY) : null, vh: innerHeight,
        card: vis(document.getElementById("planCard")), bar: vis(document.getElementById("planSumbar")),
        route: document.getElementById("psRoute")?.textContent || "", sw: document.documentElement.scrollWidth };
    });
    await page.evaluate(() => document.getElementById("planEditBtn")?.click());
    const edit = await page.evaluate(() => { const c = document.getElementById("planCard");
      return { card: !!c && getComputedStyle(c).display !== "none", focus: document.activeElement?.id }; });
    await page.setViewport({ width: 800, height: 600 });
    (mob.top != null && mob.bottom <= mob.vh && !mob.card && mob.bar && /Matkakeskus → Päijät-Hämeen keskussairaala/.test(mob.route)
      && mob.sw <= 390 && edit.card && edit.focus === "fromInput")
      ? ok(`reittihaku (erä C, 390 px): lomake tiivistyy, 1. bussivaihtoehto ${mob.top}-${mob.bottom} px (näkymä ${mob.vh}), Muokkaa avaa lomakkeen`)
      : fail("reittihaku (erä C, 390 px): " + JSON.stringify({ mob, edit }));

    // C6: lisäasetukset (hidas kävely, vaihtoaika) reitittimelle ja selaimen muistiin; esteetön haku ilman bussia selitetään.
    await eraCSearch(ONE_ALERT);
    await page.evaluate(() => {
      const w = document.getElementById("walkSpeedSel"), sl = document.getElementById("slackSel");
      if (w && sl) { w.value = "slow"; sl.value = "300"; }
      window.__eraCVars.length = 0; document.querySelector("#planForm button[type=submit]")?.click();
    });
    await page.waitForFunction(() => window.__eraCVars.length > 0, { timeout: 10000 }).catch(() => {});
    const optVars = await page.evaluate(() => window.__eraCVars[0]?.preferences || null);
    await eraCRestore();
    await page.evaluate(() => { try { localStorage.setItem("planOpts", JSON.stringify({ walk: "slow", slack: 180 })); } catch (e) {} });
    await page.goto(BASE + "/#/reitti", { waitUntil: "networkidle2" });
    const kept = await page.evaluate(() => ({ w: document.getElementById("walkSpeedSel")?.value, s: document.getElementById("slackSel")?.value }));
    await page.evaluate(() => { try { localStorage.removeItem("planOpts"); } catch (e) {} });
    (optVars?.street?.walk?.speed === 0.9 && optVars?.transit?.transfer?.slack === "PT300S" && kept.w === "slow" && kept.s === "180")
      ? ok("reittihaku (erä C): lisäasetukset (hidas kävely 0,9 m/s, vaihtoaika 5 min) reitittimelle ja muistiin")
      : fail("reittihaku (erä C): lisäasetukset: " + JSON.stringify({ optVars, kept }));
    await eraCSearch(`(S) => ({ planConnection: { pageInfo: {}, edges: [{ node: { start: S.at("10:00"), end: S.at("10:21"), numberOfTransfers: 0,
      walkDistance: 1498, legs: [S.walk("10:00", "10:21", 1498, "Origin", "Destination")] } }] } })`, "&wc=1");
    const wc = await page.evaluate(() => (document.querySelector("#planResults .plan-wc-note")?.textContent || "").trim());
    /Esteetöntä bussiyhteyttä ei löytynyt valitulla ajalla/.test(wc)
      ? ok("reittihaku (erä C): esteetön haku ilman bussiyhteyttä selitetään")
      : fail("reittihaku (erä C): esteettömän haun selitys puuttuu: " + JSON.stringify(wc));
    await eraCRestore();

    // C3: vakava häiriö bannerina reittisivulla. Häiriölähde kääritään: vain aito (effect) ja vakava (SEVERE) nousee,
    // ei pysyvä SEVERE-tiedote eikä tavallinen poikkeusreitti.
    await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
    await page.evaluate(() => { window.__eraCAlerts = loadAllAlerts; loadAllAlerts = async () => [
      { alertHeaderText: "Pysäkit suljettu (smoke)", alertSeverityLevel: "SEVERE", alertEffect: "NO_SERVICE" },
      { alertHeaderText: "Linjasto uudistui (smoke)", alertSeverityLevel: "SEVERE", alertEffect: "OTHER_EFFECT" },
      { alertHeaderText: "Poikkeusreitti (smoke)", alertSeverityLevel: "WARNING", alertEffect: "DETOUR" }]; });
    await page.evaluate(() => { location.hash = "#/reitti"; });
    await page.waitForSelector("#planAlerts details.alert", { timeout: 8000 }).catch(() => {});
    const ban = await page.evaluate(() => [...document.querySelectorAll("#planAlerts details.alert summary")].map(s => s.textContent.trim()));
    await page.evaluate(() => { loadAllAlerts = window.__eraCAlerts; delete window.__eraCAlerts; });
    (ban.length === 1 && ban[0] === "Pysäkit suljettu (smoke)")
      ? ok("reittihaku (erä C): vakava häiriö bannerina, pysyvä tiedote ja tavallinen poikkeusreitti eivät nouse")
      : fail("reittihaku (erä C): häiriöbanneri: " + JSON.stringify(ban));
  } finally {
    await page.setViewport({ width: 800, height: 600 });
    await eraCRestore().catch(() => {});
  }

  // C4: Enter valitsee ehdotuksen (ennen virhe "Valitse lähtöpaikka..."), Mistä -> Minne -> haku. Oikea paikkahaku.
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  await page.evaluate(() => { planState.from = null; planState.to = null; });
  await page.goto(BASE + "/#/reitti", { waitUntil: "networkidle2" });
  await page.click("#fromInput");
  await page.keyboard.type("matkak", { delay: 40 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.id === "toInput", { timeout: 15000 }).catch(() => {});
  const ent1 = await page.evaluate(() => ({ v: document.getElementById("fromInput").value, a: document.activeElement?.id,
    msg: document.getElementById("planMsg").textContent.trim() }));
  await page.keyboard.type("Mukkulankatu 2", { delay: 30 });
  await page.keyboard.press("Enter");
  await page.waitForSelector("#planResults details.itin[data-itin]", { timeout: 25000 }).catch(() => {});
  const ent2 = await page.evaluate(() => ({ v: document.getElementById("toInput").value, n: document.querySelectorAll("#planResults details.itin[data-itin]").length,
    msg: document.getElementById("planMsg").textContent.trim() }));
  (/^Matkakeskus/.test(ent1.v) && ent1.a === "toInput" && !ent1.msg && /^Mukkulankatu 2/.test(ent2.v) && ent2.n > 0 && !ent2.msg)
    ? ok(`reittihaku (erä C): Enter valitsee ehdotuksen (${ent1.v} -> ${ent2.v.split(",")[0]}) ja käynnistää haun`)
    : fail("reittihaku (erä C): Enter-valinta: " + JSON.stringify({ ent1, ent2 }));
  // C4: sairaalalyhenne ja sana keskussairaala osuvat sairaalaan, taivutettu muoto perusmuodolla (Turku).
  const hosp = await page.evaluate(async () => {
    const top = async q => ((await searchPlaces(q))[0] || {}).name || "";
    return { phks: await top("PHKS"), kesk: await top("keskussairaala") };
  });
  await page.goto(BASE + "/?city=turku#/reitti", { waitUntil: "networkidle2" });
  const hospT = await page.evaluate(async () => {
    const top = async q => ((await searchPlaces(q))[0] || {}).name || "";
    return { tyks: await top("TYKS"), tori: await top("kauppatorille") };
  });
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });   // palauta Lahti
  (/^Päijät-Hämeen keskussairaala/.test(hosp.phks) && /^Päijät-Hämeen keskussairaala/.test(hosp.kesk)
    && /^Turun yliopistollinen keskussairaala/.test(hospT.tyks) && /^Kauppatori(,| [A-Z]\d)/.test(hospT.tori))
    ? ok("paikkahaku (erä C): PHKS, keskussairaala ja TYKS -> sairaala, 'kauppatorille' -> Kauppatori")
    : fail("paikkahaku (erä C): " + JSON.stringify({ ...hosp, ...hospT }));
  // E2 (4.10.2026): sairaalahaku kaupungeissa, joita C4 ei kata. KOKS on Kymenlaakson keskussairaalan virallinen
  // lempinimi (kymenhva.fi), ja keskussairaala / sairaala / KAKS osuvat kaupungin omaan sairaalaan. Kieli on tässä
  // vaiheessa suomi (Peliaksen nimet suomeksi). Lopuksi palataan Lahteen kuten C4:n jälkeen.
  const hospE2 = {};
  for (const [c, qs] of [["kotka", ["KOKS", "keskussairaala"]], ["mikkeli", ["keskussairaala", "sairaala"]],
    ["kajaani", ["KAKS", "keskussairaala"]]]) {
    await page.goto(BASE + `/?city=${c}#/`, { waitUntil: "networkidle2" });
    hospE2[c] = await page.evaluate(async qs => {
      const out = {};
      for (const q of qs) out[q] = ((await searchPlaces(q))[0] || {}).name || "";
      return out;
    }, qs);
  }
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });   // palauta Lahti
  (/^Kymenlaakson keskussairaala/.test(hospE2.kotka.KOKS) && /^Kymenlaakson keskussairaala/.test(hospE2.kotka.keskussairaala)
    && /^Mikkelin keskussairaala/.test(hospE2.mikkeli.keskussairaala) && /^Mikkelin keskussairaala/.test(hospE2.mikkeli.sairaala)
    && /^Kainuun keskussairaala/.test(hospE2.kajaani.KAKS) && /^Kainuun keskussairaala/.test(hospE2.kajaani.keskussairaala))
    ? ok("paikkahaku (erä E2): KOKS ja keskussairaala Kotkassa, (keskus)sairaala Mikkelissä, KAKS ja keskussairaala Kajaanissa -> kaupungin oma sairaala")
    : fail("paikkahaku (erä E2): " + JSON.stringify(hospE2));
  // Yleissana "sairaala" / "keskussairaala" -> kaupungin oma sairaala (pikakohteen koordinaatit, 300 m). Ennen Joensuun
  // "sairaala" antoi ensin nimettömän kohteen 47,9 km päästä, ja Kuopion ja Kouvolan "keskussairaala" ei antanut mitään.
  const hospHome = {};
  for (const c of ["joensuu", "kuopio", "kouvola"]) {
    await page.goto(BASE + `/?city=${c}#/`, { waitUntil: "networkidle2" });
    hospHome[c] = await page.evaluate(async () => {
      const home = (CONFIG.deskQuick || []).find(x => x && x.k === "hospital");
      const km = p => p && p.lat != null ? Math.hypot((p.lat - home.lat) * 111, (p.lon - home.lon) * 111 * Math.cos(home.lat * Math.PI / 180)) : 999;
      const out = {};
      for (const q of ["sairaala", "keskussairaala"]) { const p = (await searchPlaces(q))[0]; out[q] = { name: p?.name || "", km: Math.round(km(p) * 100) / 100 }; }
      return out;
    });
  }
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });   // palauta Lahti
  (Object.values(hospHome).every(o => o.sairaala.km <= 0.3 && o.keskussairaala.km <= 0.3))
    ? ok("paikkahaku: 'sairaala' ja 'keskussairaala' -> kaupungin oma sairaala (Joensuu, Kuopio, Kouvola)")
    : fail("paikkahaku: yleissana sairaala: " + JSON.stringify(hospHome));

  // C5: etusivun A->B-kenttiin aikavalinta (Saapumisaika) ja oma sijainti.
  await page.waitForSelector("#homeWhenSel", { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => { const f = document.getElementById("homeFromInput"); if (f) f.value = ""; planState.from = null; });
  await page.click("#homeGeoBtn").catch(() => {});
  await page.waitForFunction(() => document.getElementById("homeFromInput")?.value === "Oma sijainti", { timeout: 10000 }).catch(() => {});
  const geoHome = await page.evaluate(() => ({ v: document.getElementById("homeFromInput")?.value, lat: planState.from?.lat }));
  await page.evaluate(() => {
    planState.to = { name: "Päijät-Hämeen keskussairaala", lat: 60.99165, lon: 25.56746 };
    const s = document.getElementById("homeWhenSel"), wi = document.getElementById("homeWhenInput");
    if (s && wi) { s.value = "arr"; s.dispatchEvent(new Event("change")); wi.value = "2026-10-12T08:15"; }
    document.getElementById("heroSearch")?.click();
  });
  await page.waitForFunction(() => /^#\/reitti\//.test(location.hash), { timeout: 10000 }).catch(() => {});
  const whenHash = await page.evaluate(() => decodeURIComponent(decodeURIComponent(location.hash)));
  await page.evaluate(() => { planState.time = ""; planState.timeMode = "dep"; });
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  (geoHome.v === "Oma sijainti" && Math.abs(geoHome.lat - 60.9833) < 0.001 && /t=2026-10-12T08:15/.test(whenHash) && /m=arr/.test(whenHash))
    ? ok("etusivu (erä C): A->B-kentissä oma sijainti ja aikavalinta (saapumisaika välittyy hakuun)")
    : fail("etusivu (erä C): oma sijainti tai aikavalinta: " + JSON.stringify({ geoHome, whenHash: whenHash.slice(0, 140) }));
  // Tila puhtaaksi seuraaville tarkistuksille: täysi uudelleenlataus nollaa planStaten (Oma sijainti ja PHKS).
  await page.goto(BASE + "/?city=lahti#/", { waitUntil: "networkidle2" });

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
    ["Löylykadulta PHKS", "Löylykatu", "PHKS", null],
    ["Matkakeskukselta Kauppatori bussilla", "Matkakeskus", "Kauppatori", null],
    ["Salosta Turkuun klo 9", "Salo", "Turku", "09:00"],
    ["haluan mennä Kauppatorilta Asemalle", "Kauppatori", "Asema", null],
    // puhutut SV/EN-muodot (mikrofoni tiskillä): käänteinen to/from, kohteliaisuudet, intent-alut
    ["how do I get to Kauppatori from Matkakeskus", "Matkakeskus", "Kauppatori", null],
    ["I need to get from Matkakeskus to Kauppatori please", "Matkakeskus", "Kauppatori", null],
    ["hur kommer jag till Kauppatori från Matkakeskus", "Matkakeskus", "Kauppatori", null],
    ["jag ska åka från Matkakeskus till Kauppatori tack", "Matkakeskus", "Kauppatori", null],
    // Erä A, A3: päivä lauseessa. Sana ei saa jäädä paikan nimeen ("huomenna Matkakeskus").
    ["huomenna klo 7 Matkakeskukselta Kauppatorille", "Matkakeskus", "Kauppatori", "07:00"],
    ["Matkakeskukselta Kauppatorille ensi maanantaina aamulla klo 8.15", "Matkakeskus", "Kauppatori", "08:15"],
    ["från Matkakeskus till Kauppatori i morgon kl 8", "Matkakeskus", "Kauppatori", "08:00"],
    ["from Matkakeskus to Kauppatori on Friday at 9", "Matkakeskus", "Kauppatori", "09:00"],
  ];
  let nlPass = 0;
  for (const [snt, ef, et, etime] of nlCases) {
    const r = await page.evaluate(x => parseNlTrip(x), snt);
    (r && r.from === ef && r.to === et && (r.time || null) === etime) ? nlPass++
      : console.log("INFO NL-jäsennys poikkeama: " + snt + " → " + JSON.stringify(r));
  }
  nlPass === nlCases.length ? ok(`NL-jäsennys: ${nlPass}/${nlCases.length} lausetta oikein (FI/EN/SV + aika)`)
                            : fail(`NL-jäsennys: vain ${nlPass}/${nlCases.length} oikein`);
  // Kaupungin oma genetiivi on tarkenne (Villen havainto 5.10.2026: "lahden löylykadulta PHKS" antoi Lahdenkadun
  // eikä PHKS:ää). Lause rakennetaan sivun oman kaupungin genetiivistä, koska smoke on tilallinen.
  const nlGen = await page.evaluate(() => {
    if (typeof nlDropCityGen !== "function") return { puuttuu: true };
    const g = cityGenName(), r = parseNlTrip("haluaisin mennä " + String(g).toLowerCase() + " löylykadulta PHKS");
    return { g, from: r.from, to: r.to, yksin: nlDropCityGen(g, g), muu: nlDropCityGen("Salon tori", "Lahden") };
  });
  (!nlGen.puuttuu && nlGen.from === "löylykatu" && nlGen.to === "PHKS" && nlGen.yksin === nlGen.g && nlGen.muu === "Salon tori")
    ? ok("NL: kaupungin oma genetiivi pois paikan alusta ja perusmuotoinen määränpää lähdön perässä")
    : fail("NL: kaupungin genetiivi / perusmuotoinen määränpää: " + JSON.stringify(nlGen));
  // A3: päivä ja kellonaika hakuhetkeksi kiinteällä "nyt"-hetkellä (su 4.10.2026 klo 17.26), jotta tulos ei riipu
  // ajohetkestä. Mennyt kellonaika ilman päivää siirtyy huomiseen ja merkitään (bumped).
  const nlw = await page.evaluate(() => {
    if (typeof nlWhen !== "function") return { puuttuu: true };
    const now = new Date(2026, 9, 4, 17, 26);
    const w = s => nlWhen(parseNlTrip(s), now);
    return { huom: w("huomenna klo 7 Matkakeskukselta Kauppatorille"), yli: w("ylihuomenna klo 9 Matkakeskukselta Kauppatorille"),
      ma: w("maanantaina klo 8 Matkakeskukselta Kauppatorille"), su: w("sunnuntaina klo 9 Matkakeskukselta Kauppatorille"),
      mennyt: w("klo 7 Matkakeskukselta Kauppatorille"), tuleva: w("klo 18 Matkakeskukselta Kauppatorille"),
      sv: w("från Matkakeskus till Kauppatori i morgon kl 8"), nyt: w("Matkakeskukselta Kauppatorille") };
  });
  const nlwOk = !nlw.puuttuu && nlw.huom?.date === "2026-10-05" && nlw.huom.time === "07:00" && !nlw.huom.bumped
    && nlw.yli?.date === "2026-10-06" && nlw.ma?.date === "2026-10-05" && nlw.su?.date === "2026-10-11"
    && nlw.mennyt?.date === "2026-10-05" && nlw.mennyt.bumped === true && nlw.tuleva?.date === "2026-10-04" && !nlw.tuleva.bumped
    && nlw.sv?.date === "2026-10-05" && nlw.nyt === null;
  nlwOk ? ok("NL: päivä lauseesta (huomenna, ylihuomenna, viikonpäivä, i morgon; mennyt kellonaika huomiseen merkinnällä)")
        : fail("NL: päivän tulkinta: " + JSON.stringify(nlw));
  // Asiakkaan viesti sellaisenaan (5.10.2026): paikat sijamuodoista virkkeittäin, "pitäisi olla klo 8" = saapumisaika,
  // viestin toinen lähtö vaihtoehdoksi, lyhenteen pääte (PHKS.ssa, TYKS:iin) pois. Rivinvaihdot kuten liitettäessä.
  const nlMsg = await page.evaluate(() => {
    if (typeof nlJoinLines !== "function") return { puuttuu: true };
    const terhi = nlJoinLines("Hei.\n\nMinun pitäisi olla huomenna klo 8.00 PHKS.ssa.\nMeneekö Trion edestä sinne bussi ja monelta on " +
      "siinä pysäkillä?\n\nTai.\n\nMeneekö vanhan Anttilan pysäkiltä bussi?\n\nKiitos,\n\nTerhi");
    const cases = [
      [terhi, "Trio", "PHKS", "08:00", "arr", "vanha Anttila → PHKS"],
      ["Lähden klo 7.15 Matkakeskukselta ja minun pitäisi olla Heinolassa ennen yhdeksää.", "Matkakeskus", "Heinola", "07:15", "dep", ""],
      // Kaupungin oma genetiivi putoaa (Lahdessa "matkakeskus", muualla "Lahden matkakeskus").
      ["Miten pääsen Lahden matkakeskukselta Päijät-Hämeen keskussairaalaan?", nlDropCityGen("Lahden matkakeskus"), "Päijät-Hämeen keskussairaala", null, null, ""],
      ["Vastaisitteko kysymykseen: miten pääsen Triosta PHKS:lle?", "Trio", "PHKS", null, null, ""],
      ["Hi, is there a bus from Trio to Kauppatori tomorrow at 7? Thanks", "Trio", "Kauppatori", "07:00", null, ""],
      ["Triosta TYKS:iin", "Trio", "TYKS", null, null, ""],
    ];
    const bad = cases.map(([s, f, to, tm, mode, alt]) => {
      const r = parseNlTrip(s);
      const alts = r.alts.map(a => a.from + " → " + a.to).join("; ");
      return r.from === f && r.to === to && (r.time || null) === tm && (r.timeMode || null) === mode && alts === alt
        ? null : s.slice(0, 40) + " → " + JSON.stringify({ from: r.from, to: r.to, time: r.time, mode: r.timeMode, alts });
    }).filter(Boolean);
    const now = new Date(2026, 9, 4, 17, 26);
    const pv = nlWhen(parseNlTrip("Tarvitsisin kyydin keskustasta TYKS:iin 6.10.2026 klo 10"), now);
    if (!(pv && pv.date === "2026-10-06" && pv.time === "10:00")) bad.push("päivämäärä 6.10.2026: " + JSON.stringify(pv));
    return { n: cases.length, bad };
  });
  !nlMsg.puuttuu && !nlMsg.bad.length
    ? ok(`NL: asiakkaan viesti sellaisenaan ${nlMsg.n}/${nlMsg.n} (paikat sijamuodoista, saapumisaika, vaihtoehto, PHKS.ssa, 6.10.2026)`)
    : fail("NL: viestin jäsennys: " + JSON.stringify(nlMsg));
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
  // A3 kuntalaisen haussa: "huomenna klo 7" hakee huomiselle (osoitteen t-parametri). Tila palautetaan: hakuaika nyt.
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  await page.waitForSelector("#homeFromInput", { timeout: 10000 }).catch(() => {});
  // Mistä-kentässä on edellisen haun lähtö (planState): tyhjennetään, ettei lause liity sen perään.
  await page.evaluate(() => { document.getElementById("homeFromInput").value = ""; });
  await page.type("#homeFromInput", "huomenna klo 7 Matkakeskukselta Mukkulaan", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /^#\/reitti\//.test(location.hash), { timeout: 20000 }).catch(() => {});
  const nlHome = await page.evaluate(() => {
    const n = new Date(), tomorrow = isoOf(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1));
    const h = decodeURIComponent(decodeURIComponent(location.hash));
    planState.time = ""; planState.timeMode = "dep"; planState.nlNote = "";
    return { ok: h.includes("t=" + tomorrow + "T07:00") && !/huomenna/i.test(h), h: h.slice(0, 140) };
  });
  nlHome.ok ? ok("etusivu: lauseen 'huomenna klo 7' haku tehdään huomiselle")
            : fail("etusivu: 'huomenna klo 7' ei hakenut huomiselle: " + nlHome.h);

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
  // Erä A (4.10.2026), A10: Lahden tiski avautuu asiakaspalvelupisteen terminaaliin, Trion kaikkiin laitureihin
  // (CONFIG.deskHomeStop { terminal: true }), ei Matkakeskus D:lle. Lähdöt ovat yhdessä listassa, ja jokaisella rivillä
  // on laiturin tunnus. Tunnuksia ei kovakoodata; lähtöjen määrä riippuu kellonajasta, joten rivejä ei vaadita.
  await page.waitForFunction(() => document.querySelector("#deskDeps .desk-deps-upd, #deskDeps .error"), { timeout: 30000 }).catch(() => {});
  const home = await page.evaluate(() => ({
    otsikko: (document.querySelector("#deskDeps .stophead")?.textContent || "").replace(/\s+/g, " ").trim(),
    laiturit: [...document.querySelectorAll("#deskDeps .desk-terminal-plats a.dep-plat")].map(a => a.textContent.trim()),
    rivit: document.querySelectorAll("#deskDeps table.deps tbody tr").length,
    rivitLaiturilla: document.querySelectorAll("#deskDeps table.deps tbody tr a.dep-plat").length,
    tulostusvihje: !document.getElementById("deskPrintBtn") && /tunnuksen/.test(document.querySelector("#deskStopResults .desk-pin-row")?.textContent || ""),
  }));
  (/^Trio kaikki pysäkit \(\d+\)$/.test(home.otsikko) && home.laiturit.length >= 2 && home.rivit === home.rivitLaiturilla && home.tulostusvihje)
    ? ok(`palvelutiski (Lahti): oletuksena Trion terminaali (${home.laiturit.join(" ")}, ${home.rivit} lähtöä laitureineen)`)
    : fail("palvelutiski (Lahti): oletuksena ei Trion terminaalia: " + JSON.stringify(home));
  // Laiturin tunnus avaa laiturin oman kortin, jossa on tulostusnappi (tulostus laituri kerrallaan).
  await page.evaluate(() => document.querySelector("#deskDeps .desk-terminal-plats a.dep-plat")?.click());
  const platCard = await page.waitForFunction(() => /^Trio \S+$/.test((document.querySelector("#deskDeps .stophead")?.textContent || "").trim())
    && !!document.getElementById("deskPrintBtn"), { timeout: 20000 }).then(() => true).catch(() => false);
  platCard ? ok("palvelutiski (Lahti): terminaalin laiturin tunnus avaa laiturin kortin tulostusnappeineen")
           : fail("palvelutiski (Lahti): laiturin kortti ei avautunut: " + await page.evaluate(() => (document.getElementById("deskStopResults")?.textContent || "").replace(/\s+/g, " ").slice(0, 120)));
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
  // Tiskin aksentti: Lahdella on 2.9.2026 alkaen CONFIG.brandColor (LSL:n logon sininen
  // #005cb6), joten tiski EI saa jäädä .desk-lohkon oletussiniseen (#0033cc) vaan käyttää
  // brändiväriä. Pari Vaasan tarkistukselle alempana (Liftin pinkki). Väri luetaan CONFIGista,
  // ei kovakoodata, jotta sävyn tarkennus ei kaada testiä.
  const lDeskAccent = await deskAccent();
  const lBrand = await page.evaluate(() => (CONFIG.brandColor || "").toLowerCase());
  (lBrand && lDeskAccent !== "#0033cc" && lDeskAccent === lBrand)
    ? ok(`palvelutiski (Lahti, brandColor ${lBrand}): tiski käyttää brändiväriä`)
    : fail(`palvelutiski (Lahti): odotettu brandColor "${lBrand}", saatiin "${lDeskAccent}"`);
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
  // Tulosteet-välilehden Yhteys-ryhmä ennen reittihakua (5.10.2026): ei tulostenappeja, vaan ohje ja nappi,
  // joka vie Neuvonnan Reitti-kortille. Nappi jättää Neuvonnan auki, joten seuraava haku toimii sellaisenaan.
  await page.click('.dtab[data-dtab="tulosteet"]');
  const yh0 = await page.evaluate(() => ({ target: document.querySelector("#deskPrintsTrip .dp-target")?.textContent || "",
    itin: !!document.getElementById("deskTripItin"), pocket: !!document.getElementById("deskTripPocket"), go: !!document.getElementById("deskTripGo") }));
  if (yh0.go) await page.click("#deskTripGo");
  const yh1 = await page.evaluate(() => ({ advice: document.querySelector('[data-dpanel="neuvonta"]').hidden === false,
    card: document.querySelector('.dcard-tab[data-dcard="route"]').getAttribute("aria-pressed"), focus: document.activeElement?.id || "" }));
  (/Reitti-kortilla/.test(yh0.target) && !yh0.itin && !yh0.pocket && yh0.go && yh1.advice && yh1.card === "true" && yh1.focus === "deskFrom")
    ? ok("palvelutiski: Tulosteiden Yhteys-ryhmä ennen hakua ohjaa Reitti-kortille")
    : fail("palvelutiski: Yhteys-ryhmä ennen hakua: " + JSON.stringify({ yh0, yh1 }));
  if (!yh1.advice) await page.click('.dtab[data-dtab="neuvonta"]');
  // Näppäinflow: lähtö → Enter (valitsee ylimmän + siirtää määränpäähän) → Enter ajaa haun.
  // V1 (4.10.2026): reittihaku on oma korttinsa; tiski avautuu pysäkkikorttiin, joten Reitti-kortti
  // avataan ensin (piilotettua kenttää ei voi klikata).
  await page.click('.dcard-tab[data-dcard="route"]');
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
    // --- Tulosteet-välilehti tiskillä (Villen palaute 3.9.2026) ---
    // Vaatimus: tiskiltä saa JOKAISEN palvelun tulosteen, eikä linjavalinta ole sidottu
    // valittuun pysäkkiin. Ennen korjausta valikossa oli 101 linjaa kahdessa optgroupissa,
    // mutta pysäkin 21 linjaa täyttivät natiivin valikon ensimmäisen ruudullisen, joten
    // loput 80 jäivät käyttäjältä piiloon. Napit avaavat uuden välilehden, joten klikkausta
    // ei ajeta loppuun: window.open kaapataan ja kohde-URL tarkistetaan (koonti itsessään
    // tarkistetaan tulosteet-keskuksen kohdalla, ks. "tiskin tulostepolut").
    const deskLp = await page.waitForFunction(
      () => document.querySelectorAll("#deskLineList .deskLineCb").length > 10 ? true : null,
      { timeout: 30000 }).then(() => true).catch(() => false);
    if (!deskLp) fail("palvelutiski: tulosteet-välilehden linjalista ei täyttynyt 30 s kuluessa");
    else {
      await page.click('.dtab[data-dtab="tulosteet"]');
      await page.waitForFunction(() => document.querySelector('[data-dpanel="tulosteet"]')?.hidden === false,
        { timeout: 5000 }).catch(() => {});
      const dl = await page.evaluate(() => ({
        panel: document.querySelector('[data-dpanel="tulosteet"]').hidden === false,
        adviceHidden: document.querySelector('[data-dpanel="neuvonta"]').hidden === true,
        lines: document.querySelectorAll("#deskLineList .deskLineCb").length,
        ryhmat: document.querySelectorAll("#deskLineList .dp-head").length,
        stopNimi: (document.getElementById("deskPrintsStop")?.textContent || "").trim(),
        stopNappi: document.getElementById("deskStopPosterBtn")?.disabled === false,
      }));
      // Pysäkin linjoja on aina vähemmän kuin koko linjastoa: jos ne olisivat sama luku,
      // valikko olisi taas pysäkkisidonnainen.
      (dl.panel && dl.adviceHidden && dl.lines > 10 && dl.ryhmat === 2 && dl.stopNappi && dl.stopNimi.length > 2)
        ? ok(`palvelutiski: Tulosteet-välilehti (${dl.lines} linjaa, ${dl.ryhmat} ryhmää, pysäkki ${dl.stopNimi})`)
        : fail("palvelutiski: tulostevälilehti puutteellinen tai pysäkkisidonnainen: " + JSON.stringify(dl));
      // Yhteys-ryhmä seuraa Neuvonnan reittivastausta: reittituloste aina, taskuaikataulu täsmälleen silloin,
      // kun jollakin vaihtoehdolla on taskuaikataulun nappi (live-haku, joten suoruutta ei oleteta).
      const yh = await page.evaluate(() => ({ haettu: !!document.querySelector("#deskResults .desk-tell"),
        target: (document.querySelector("#deskPrintsTrip .dp-target")?.textContent || "").replace(/\s+/g, " ").trim(),
        itin: !!document.getElementById("deskTripItin"), pocket: !!document.getElementById("deskTripPocket"),
        optPocket: !!document.querySelector("#deskResults .deskOptPocket") }));
      if (!yh.haettu) info("palvelutiski: Yhteys-ryhmää ei tarkistettu, koska reittihaku ei tuottanut vastausta");
      else (/ → .+ · \d{1,2}[.:]\d{2}–\d{1,2}[.:]\d{2}$/.test(yh.target) && yh.itin && yh.pocket === yh.optPocket)
        ? ok(`palvelutiski: Tulosteiden Yhteys-ryhmä näyttää haetun yhteyden (${yh.target}, taskuaikataulu ${yh.pocket ? "on" : "ei, vaihdollinen"})`)
        : fail("palvelutiski: Yhteys-ryhmä ei seuraa reittivastausta: " + JSON.stringify(yh));
      // Nappien tilat: 0 valittua = kaikki pois, 1 = yhden linjan tulosteet + vihko,
      // 2 = vihko + yhdistetty suunta mutta EI yhden linjan tulosteita. Nappi joka ei tee
      // mitään on pahempi kuin harmaa nappi: asiakaspalvelija ei näe kumpi tapahtui.
      const tilat = await page.evaluate(() => {
        const set = (n) => {
          const cbs = [...document.querySelectorAll("#deskLineList .deskLineCb")];
          cbs.forEach(c => { c.checked = false; });
          cbs.slice(0, n).forEach(c => { c.checked = true; });
          cbs[0].dispatchEvent(new Event("change", { bubbles: true }));
          return {
            yksi: [...document.querySelectorAll(".deskLineBtn")].map(b => b.dataset.lp + ":" + (b.disabled ? "off" : "on")).join(" "),
            usea: [...document.querySelectorAll(".deskLinesBtn")].map(b => b.dataset.lp + ":" + (b.disabled ? "off" : "on")).join(" "),
          };
        };
        return { nolla: set(0), yksi: set(1), kaksi: set(2) };
      });
      (tilat.nolla.yksi === "rack:off key:off all:off batch:off" && tilat.nolla.usea === "vihko:off kaytava:off" &&
       tilat.yksi.yksi === "rack:on key:on all:on batch:on" && tilat.yksi.usea === "vihko:on kaytava:off" &&
       tilat.kaksi.yksi === "rack:off key:off all:off batch:off" && tilat.kaksi.usea === "vihko:on kaytava:on")
        ? ok("palvelutiski: tulostenapit seuraavat linjavalintaa (0 / 1 / 2 linjaa)")
        : fail("palvelutiski: nappien tilat väärin: " + JSON.stringify(tilat));
      // Jokaisen tiskiltä saatavan tulosteen kohde-URL. Tulostuslogiikkaa ei saa kopioida
      // tiskille: kaikki menevät linjasivun ?print=- tai tulosteet-keskuksen kyselypolkuun.
      const kohteet = await page.evaluate(() => {
        const cbs = [...document.querySelectorAll("#deskLineList .deskLineCb")];
        cbs.forEach(c => { c.checked = false; });
        cbs[0].checked = true;
        cbs[0].dispatchEvent(new Event("change", { bubbles: true }));
        const nakyi = [];
        const oikea = window.open;
        window.open = (u) => { nakyi.push(String(u).replace(/^[^#]*/, "")); return { focus() {} }; };
        document.querySelectorAll(".deskLineBtn, .deskLinesBtn, .deskCorrBtn").forEach(b => b.click());
        document.getElementById("deskChangesBtn").click();
        cbs[1].checked = true;
        cbs[1].dispatchEvent(new Event("change", { bubbles: true }));
        document.querySelector('.deskLinesBtn[data-lp="kaytava"]').click();
        window.open = oikea;
        return nakyi;
      });
      const odotetut = [
        /^#\/linja\/[^?]+\?print=rack$/, /^#\/linja\/[^?]+\?print=key$/, /^#\/linja\/[^?]+\?print=all$/,
        /^#\/tulosteet\/julisteet\?line=[^&]+&go=1$/, /^#\/tulosteet\/vihko\?lines=[^&]+&go=1$/,
        /^#\/tulosteet\/muutokset$/, /^#\/tulosteet\/kaytava\?lines=[^&,]+,[^&]+&go=1$/,
      ];
      const puuttuu = odotetut.filter(re => !kohteet.some(u => re.test(u)));
      const kaytavaPresetit = kohteet.filter(u => /^#\/tulosteet\/kaytava\?corridor=/.test(u)).length;
      (!puuttuu.length && kaytavaPresetit >= 1)
        ? ok(`palvelutiski: kaikki ${kohteet.length} tulostepolkua oikein (${kaytavaPresetit} käytäväpresettiä)`)
        : fail("palvelutiski: tulostepolkuja puuttuu " + JSON.stringify({ puuttuu: puuttuu.map(String), kaytavaPresetit, kohteet }));
      // Suodatin: pitkästä linjalistasta pitää löytää linja kirjoittamalla, ei rullaamalla.
      await page.type("#deskLineFilter", "1");
      await sleep(250);
      const suodatus = await page.evaluate(() => ({
        nakyvia: [...document.querySelectorAll("#deskLineList li")].filter(li => !li.hidden).length,
        kaikki: document.querySelectorAll("#deskLineList li").length,
      }));
      (suodatus.nakyvia > 0 && suodatus.nakyvia < suodatus.kaikki)
        ? ok(`palvelutiski: linjasuodatin rajaa listan (${suodatus.nakyvia}/${suodatus.kaikki})`)
        : fail("palvelutiski: linjasuodatin ei rajaa: " + JSON.stringify(suodatus));
      await page.evaluate(() => {
        document.getElementById("deskLineFilter").value = "";
        document.getElementById("deskLineFilter").dispatchEvent(new Event("input", { bubbles: true }));
      });
      // Takaisin Neuvontaan: seuraavat tarkistukset käyttävät pysäkin omaa tulostusnappia.
      await page.click('.dtab[data-dtab="neuvonta"]');
      await sleep(200);
    }
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
          // sovellus asettaa @page-säännön itse: tiivis juliste 7 mm, lehtiteline 8 mm
          orient: document.getElementById("pageOrient")?.textContent || "",
          compact: !!document.querySelector("#deskPrintOut .poster-compact"),
        }));
        (dp.paivablokit >= 1 && dp.linjat >= 1)
          ? ok(`palvelutiski: aikataulu tulostuu tiskiltä (${dp.paivablokit} päiväblokkia, ${dp.linjat} linjaa)`)
          : fail(`palvelutiski: tuloste tyhjä: ${JSON.stringify(dp)}`);
        // Tiivis juliste (oletus 3.9.2026 alkaen) tulostuu 7 mm:llä kuten pysäkkisivultakin,
        // tavallinen juliste lehtitelineen 8 mm:llä. Kumpikin on A4 pysty.
        /portrait/.test(dp.orient) && (dp.compact ? /7mm/ : /8mm/).test(dp.orient)
          ? ok(`palvelutiski: tuloste on ${dp.compact ? "tiiviin julisteen (A4 pysty 7 mm)" : "lehtitelineen (A4 pysty 8 mm)"} mitoituksessa`)
          : fail(`palvelutiski: väärä sivumitoitus: ${JSON.stringify({ orient: dp.orient, compact: dp.compact })}`);
        const mlDesk = await minuuttiLinjaus(page, "#deskPrintOut", "print");
        mlDesk.n >= 5 && !mlDesk.viat.length
          ? ok(`palvelutiski: minuutit kymmenluvuittain allekkain (${mlDesk.n} mitattua)`)
          : fail(`palvelutiski: minuutit eivät ole allekkain (${mlDesk.n} mitattua): ${mlDesk.viat.join(" · ")}`);
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

        // Erä D1 (4.10.2026): pysäkkiaikataulun voimassaolo. Synteettinen muutosvahti, jotta tulos ei
        // riipu päivän aikataulusta: muutos 60 vrk päästä on tulosteen 42 vrk:n ikkunan takana, joten
        // tulosteeseen kuuluu "Voimassa X asti. Aikataulu muuttuu Y.". Lisäksi stopValidityInfo:n
        // tapaukset synteettisillä lohkoilla. Vahdin välimuisti nollataan lopuksi (smoke on tilallinen).
        const vd = await page.evaluate(async () => {
          if (typeof stopValidityInfo !== "function") return { puuttuu: true };
          const iso = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return isoOf(d); };
          const num = s => +s.replace(/-/g, "");
          const T = todayISO(), muutos = iso(60), arvio = iso(50), oma = iso(20);
          const W = (rows, ajettu = T) => { changeWatchPromise = Promise.resolve({ ajettu: ajettu + "T09:00:00.000Z", pysakit: rows }); };
          const B = days => Object.assign([], { changeDays: days });
          const k = v => v ? v.kind + ":" + v.date : null;
          const r = {};
          W([{ id: "X:1", tulossa: true, voimaan: muutos, voimaanTarkka: true }]); r.until = k(await stopValidityInfo("X:1", B([]), T));
          W([{ id: "X:1", tulossa: true, voimaan: arvio, voimaanTarkka: false }]); r.approx = k(await stopValidityInfo("X:1", B([]), T));
          W([{ id: "X:1", tulossa: true, voimaan: oma, voimaanTarkka: true }]); r.shownVahti = k(await stopValidityInfo("X:1", B([num(oma)]), T));
          W([{ id: "X:1", tulossa: false }]); r.shownOma = k(await stopValidityInfo("X:1", B([num(oma)]), T));
          r.ok = k(await stopValidityInfo("X:1", B([]), T));
          r.eiRivia = k(await stopValidityInfo("X:2", B([]), T));
          W([{ id: "X:1", tulossa: true, voimaan: iso(-1), voimaanTarkka: true }]); r.mennyt = k(await stopValidityInfo("X:1", B([]), T));
          W([{ id: "X:1", tulossa: false }], iso(-30)); r.vanha = k(await stopValidityInfo("X:1", B([]), T));
          changeWatchPromise = Promise.resolve(null); r.eiVahtia = k(await stopValidityInfo("X:1", B([]), T));
          // Koko tulostepolku: vahti tuntee tulostettavan pysäkin muutoksen.
          const orig = stopValidityInfo;
          stopValidityInfo = async (s, b, d) => { W([{ id: s, tulossa: true, voimaan: muutos, voimaanTarkka: true }]); return orig(s, b, d); };
          const po = document.getElementById("deskPrintOut");
          try {
            po.innerHTML = "";
            document.getElementById("deskPrintBtn").click();
            for (let i = 0; i < 600 && !po.querySelector(".poster-day .hourgrid tr"); i++) await new Promise(res => setTimeout(res, 100));
          } finally { stopValidityInfo = orig; changeWatchPromise = null; }
          const el = po.querySelector(".poster-head .poster-valid");
          const ed = new Date(muutos + "T12:00:00"); ed.setDate(ed.getDate() - 1);
          return { r, T, muutos, arvio, oma, kpl: po.querySelectorAll(".poster-valid").length, laji: el?.dataset.valid || null,
            teksti: el?.textContent.trim() || "", odMuutos: fmtDateLong(muutos), odAsti: fmtDateLong(isoOf(ed)),
            kontrasti: el ? getComputedStyle(el).backgroundColor : "" };
        });
        const vr = vd.r || {};
        (!vd.puuttuu && vr.until === "until:" + vd.muutos && vr.approx === "approx:" + vd.arvio && vr.shownVahti === "shown:" + vd.oma
          && vr.shownOma === "shown:" + vd.oma && vr.ok === "ok:" + vd.T && vr.eiRivia === null && vr.mennyt === "ok:" + vd.T
          && vr.vanha === null && vr.eiVahtia === null)
          ? ok("palvelutiski: voimassaolon päättely (vahdin muutos, arvio, julisteen oma jakso, toistaiseksi, ei tietoa) oikein")
          : fail("palvelutiski: voimassaolon päättely: " + JSON.stringify(vd));
        (vd.kpl === 1 && vd.laji === "until" && vd.teksti.includes(vd.odMuutos) && vd.teksti.includes(vd.odAsti))
          ? ok(`palvelutiski: pysäkkiaikataulussa voimassaolo kerran otsikossa ("${vd.teksti}")`)
          : fail("palvelutiski: pysäkkiaikataulun voimassaolo puuttuu tai väärin: " + JSON.stringify(vd));

        // Erä D2: Iso teksti. Valinta tulostenapin vieressä, muistetaan (localStorage) ja kaikki valinnat
        // pysyvät samassa tilassa. Print-medialla jokainen tekstisolmu vähintään 14 pt (18,6 px). Valinta
        // palautetaan lopuksi ennalleen, jotta myöhemmät tulostetarkistukset näkevät oletustulosteen.
        const isoEnnen = await page.evaluate(() => localStorage.getItem("printLarge"));
        const isoCb = await page.$("#deskStopResults .printLargeCb");
        if (!isoCb) fail("palvelutiski: Iso teksti -valinta puuttuu tulostusnapin vierestä");
        else {
          await isoCb.click();
          const isoTila = await page.evaluate(async () => {
            const po = document.getElementById("deskPrintOut");
            const tila = { tallessa: localStorage.getItem("printLarge"),
              kaikki: [...document.querySelectorAll(".printLargeCb")].map(c => c.checked),
              vieressa: !!document.querySelector("#deskPrintBtn ~ .print-large-opt .printLargeCb") };
            po.innerHTML = "";
            document.getElementById("deskPrintBtn").click();
            for (let i = 0; i < 600 && !po.querySelector('.poster-stop[data-large="1"] .hourgrid tr'); i++) await new Promise(res => setTimeout(res, 100));
            for (let i = 0; i < 50 && !document.getElementById("pageOrient")?.textContent; i++) await new Promise(res => setTimeout(res, 100));
            tila.iso = !!po.querySelector('.poster-stop[data-large="1"]');
            tila.orient = document.getElementById("pageOrient")?.textContent || "";
            return tila;
          });
          const mitta = async (sel) => {
            await page.emulateMediaType("print");
            const m = await page.evaluate(s => {
              const root = document.querySelector(s);
              const out = { n: 0, min: Infinity, pienin: "", ajat: Infinity };
              if (!root) return out;
              for (const el of root.querySelectorAll("*")) {
                if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
                const cs = getComputedStyle(el);
                if (cs.display === "none" || cs.visibility === "hidden" || !el.getClientRects().length) continue;
                const px = parseFloat(cs.fontSize);
                out.n++;
                if (px < out.min) { out.min = px; out.pienin = el.tagName + "." + el.className + ": " + el.textContent.trim().slice(0, 30); }
                if (el.matches("td, td *")) out.ajat = Math.min(out.ajat, px);
              }
              return out;
            }, sel);
            await page.emulateMediaType(null);
            return m;
          };
          const mp = await mitta("#deskPrintOut .poster-compact");
          // Reittituloste synteettisellä yhteydellä (ei riipu päivän aikataulusta).
          const it = await page.evaluate(() => {
            const leg = (mode, a, b, from, to, route) => ({ mode, start: { scheduledTime: a }, end: { scheduledTime: b }, duration: 300, distance: 350,
              from: { name: from, stop: { platformCode: "D" } }, to: { name: to }, route, trip: route ? { tripHeadsign: "Mukkula" } : null, intermediateStops: [] });
            const node = { start: "2026-10-05T07:58:00+03:00", end: "2026-10-05T08:30:00+03:00", numberOfTransfers: 0, legs: [
              leg("WALK", "2026-10-05T07:58:00+03:00", "2026-10-05T08:03:00+03:00", "Koti", "Matkakeskus", null),
              leg("BUS", "2026-10-05T08:05:00+03:00", "2026-10-05T08:25:00+03:00", "Matkakeskus D", "Mukkula", { shortName: "32", color: "0a4ea3", textColor: "ffffff" }),
              leg("WALK", "2026-10-05T08:25:00+03:00", "2026-10-05T08:30:00+03:00", "Mukkula", "Perillä", null)] };
            document.getElementById("deskPrintOut").innerHTML = deskItineraryPrintHtml(node, [node], { name: "Koti" }, { name: "Mukkulankatu 2" }, "");
            return !!document.querySelector("#deskPrintOut .itin-print.ip-large");
          });
          const mi = await mitta("#deskPrintOut .itin-print");
          await page.evaluate(e => {
            setPrintLarge(e === "1");
            if (e == null) localStorage.removeItem("printLarge");
            printLargeMem = null;
            document.getElementById("deskPrintOut").innerHTML = "";
          }, isoEnnen);
          (isoTila.tallessa === "1" && isoTila.kaikki.length >= 2 && isoTila.kaikki.every(Boolean) && isoTila.vieressa)
            ? ok(`palvelutiski: Iso teksti -valinta tulostusnapin vieressä, muistetaan ja synkassa (${isoTila.kaikki.length} valintaa)`)
            : fail("palvelutiski: Iso teksti -valinta: " + JSON.stringify(isoTila));
          (isoTila.iso && /portrait/.test(isoTila.orient) && mp.n >= 20 && mp.min >= 18.6 && mp.ajat >= 18.6)
            ? ok(`palvelutiski: iso pysäkkiaikataulu A4:llä, pienin teksti ${(mp.min * 0.75).toFixed(1)} pt, kellonajat ${(mp.ajat * 0.75).toFixed(1)} pt (${mp.n} tekstiä)`)
            : fail("palvelutiski: iso pysäkkiaikataulu alle 14 pt tai puuttuu: " + JSON.stringify({ isoTila, mp }));
          (it && mi.n >= 8 && mi.min >= 18.6 && mi.ajat >= 18.6)
            ? ok(`palvelutiski: iso reittituloste, pienin teksti ${(mi.min * 0.75).toFixed(1)} pt (${mi.n} tekstiä)`)
            : fail("palvelutiski: iso reittituloste alle 14 pt tai puuttuu: " + JSON.stringify({ it, mi }));
        }
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
  // Erä A (4.10.2026), A1: vaihdot = kulkuneuvo-osuudet toisesta alkaen. Matka alkaa kävelyllä, joten ennen ensimmäinen
  // bussi luettiin vaihdoksi ("1 vaihto, pysäkillä Harjutie L"). Sama lause Kerro asiakkaalle-, viimeinen bussi- ja
  // Seuraava bussi -kohdissa; junaosuus kerrotaan asemana ja junana.
  // Ajat sivun omassa aikavyöhykkeessä (isoWithOffset): CI ajaa UTC:ssä, ja kiinteä +03:00 näkyi siellä 3 h aiempana.
  const xf = await page.evaluate(() => {
    const L = (mode, from, to, s, e, line) => ({ mode, start: { scheduledTime: isoWithOffset("2026-06-23T" + s) },
      end: { scheduledTime: isoWithOffset("2026-06-23T" + e) }, from: { name: from }, to: { name: to }, route: line ? { shortName: line } : null });
    const bus = { start: isoWithOffset("2026-06-23T18:10"), end: isoWithOffset("2026-06-23T19:09"), numberOfTransfers: 1, legs: [
      L("WALK", "Origin", "Harjutie L", "18:10", "18:18"), L("BUS", "Harjutie L", "Kansanopisto P", "18:18", "18:40", "9"),
      L("BUS", "Kansanopisto P", "Mukkula", "18:45", "19:05", "32"), L("WALK", "Mukkula", "Destination", "19:05", "19:09")] };
    const rail = { start: isoWithOffset("2026-06-23T07:55"), end: isoWithOffset("2026-06-23T09:20"), numberOfTransfers: 1, legs: [
      L("WALK", "Origin", "Kirkkoherranvirasto P", "07:55", "08:00"), L("BUS", "Kirkkoherranvirasto P", "Karjaa", "08:00", "08:20", "192"),
      L("RAIL", "Karjaa", "Helsinki", "08:31", "09:20", "")] };
    const txt = h => { const d = document.createElement("div"); d.innerHTML = h; return d.textContent.replace(/\s+/g, " ").trim(); };
    // Sama vuoro eri jatkolla (lähtee samaan aikaan) ei ole "seuraava"; myöhempi on.
    const same = JSON.parse(JSON.stringify(bus));
    const later = { ...JSON.parse(JSON.stringify(bus)), legs: [L("WALK", "Origin", "Harjutie L", "18:40", "18:48"),
      L("BUS", "Harjutie L", "Kansanopisto P", "18:48", "19:10", "9"), L("BUS", "Kansanopisto P", "Mukkula", "19:15", "19:35", "32")] };
    const railFirst = { start: isoWithOffset("2026-06-23T07:05"), end: isoWithOffset("2026-06-23T07:30"), numberOfTransfers: 0, legs: [
      L("WALK", "Origin", "Nastola", "07:05", "07:10"), L("RAIL", "Nastola", "Lahti", "07:10", "07:30", "R")] };
    return { tell: txt(deskTellHtml([bus], bus, true)), last: txt(deskBusSentence(bus)), card: txt(deskNextBusHtml(bus)),
      rail: txt(deskTellHtml([rail], rail, true)), same: txt(deskTellHtml([bus, same], bus, true)),
      later: txt(deskTellHtml([bus, later], bus, true)), railTell: txt(deskTellHtml([railFirst], railFirst, true)),
      railLine: txt(deskBusSentence(railFirst)) };
  });
  ([xf.tell, xf.last, xf.card].every(x => /1 vaihto: pysäkillä Kansanopisto P linjaan 32, lähtee 18:45\./.test(x) && !/Harjutie L\./.test(x))
    && /1 vaihto: asemalla Karjaa junaan, lähtee 08:31\./.test(xf.rail) && !/Kirkkoherranvirasto P\./.test(xf.rail))
    ? ok("palvelutiski: vaihto kerrotaan oikealla pysäkillä jatkolinjoineen (Kerro asiakkaalle, viimeinen ja seuraava bussi)")
    : fail("palvelutiski: vaihtolause: " + JSON.stringify(xf));
  (!/seuraava/.test(xf.same) && /klo 18:18 \(seuraava 18:48\)/.test(xf.later)
    && /Juna R asemalta Nastola klo 07:10\./.test(xf.railTell) && !/Linja R/.test(xf.railTell)
    && /^Juna R asemalta Nastola klo 07:10, perillä 07:30\./.test(xf.railLine))
    ? ok("palvelutiski: 'seuraava' vain myöhemmästä vuorosta, ja junalla alkava matka kerrotaan junana asemalta")
    : fail("palvelutiski: seuraava/juna-lause: " + JSON.stringify({ same: xf.same, later: xf.later, railTell: xf.railTell, railLine: xf.railLine }));
  // A9: huomisen (ja myöhemmän päivän) lähtö lähtölistassa päivämerkinnällä, tämän päivän lähtö ilman.
  const dd = await page.evaluate(() => {
    const n = new Date(), sd = o => Math.floor(new Date(n.getFullYear(), n.getMonth(), n.getDate() + o).getTime() / 1000);
    const st = (o, sec) => ({ serviceDay: sd(o), scheduledDeparture: sec, realtimeDeparture: sec, realtime: false, headsign: "Mukkula",
      trip: { route: { gtfsId: "Lahti:32", shortName: "32" } } });
    const tb = document.createElement("table");
    tb.innerHTML = depTableRows([st(1, 4 * 3600 + 40 * 60), st(2, 6 * 3600)]);
    const wd = o => new Date((sd(o) + 12 * 3600) * 1000).toLocaleDateString("fi-FI", { weekday: "short" });
    return { cells: [...tb.querySelectorAll("td:last-child")].map(td => td.textContent.trim()), wd1: wd(1), wd2: wd(2) };
  });
  (dd.cells[0] === dd.wd1 + " 04:40" && dd.cells[1].startsWith(dd.wd2 + " ") && dd.cells[1].endsWith(" 06:00"))
    ? ok(`lähtölista: muun päivän lähtö päivämerkinnällä (${dd.cells.join(", ")})`)
    : fail("lähtölista: päivämerkintä puuttuu: " + JSON.stringify(dd));

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
  // Lähtevät + saapuvat (Joensuun toive 24.9.2026): kaksi taulukkoa, kummassakin 4 saraketta.
  const dTrainInfo = await page.evaluate(() => ({
    rows: document.querySelectorAll("#deskTrains table tbody tr").length,
    tables: document.querySelectorAll("#deskTrains table").length,
    heads: document.querySelectorAll("#deskTrains table thead th").length,
    kinds: document.querySelectorAll("#deskTrains .desk-rail-kind").length,
    txt: (document.getElementById("deskTrains")?.textContent || "").trim().slice(0, 60),
  }));
  (dTrains && dTrainInfo.tables === 2 && dTrainInfo.heads === 8 && dTrainInfo.kinds === 2)
    ? ok(`palvelutiski: junien lähdöt ja saapumiset lohkossa (${dTrainInfo.rows} junaa, rata.digitraffic)`)
    : fail("palvelutiski: junalohko ei renderöitynyt lähtevät + saapuvat: " + JSON.stringify(dTrainInfo));

  // --- Palvelutiski V1 (4.10.2026): livekartta, yhteishaku + linjakortti, linkit tiskin sisällä,
  //     390 px ja hinnat jaetusta lähteestä. Rakenneassertioita; tila palautetaan jokaisen jälkeen. ---
  // Kartta renderöityy tiskin sisälle (Leaflet-säiliö, korkeus, tiilikerros ja tilarivi).
  await page.waitForSelector(".desk #deskMap.leaflet-container", { timeout: 15000 }).catch(() => {});
  const dMap = await page.evaluate(() => {
    const el = document.querySelector(".desk #deskMap");
    return { leaflet: !!el && el.classList.contains("leaflet-container"),
      h: el ? Math.round(el.getBoundingClientRect().height) : 0,
      tiles: !!el && !!el.querySelector(".leaflet-tile-pane"),
      status: (document.getElementById("deskMapStatus")?.textContent || "").trim() };
  });
  (dMap.leaflet && dMap.h >= 200 && dMap.tiles && dMap.status.length > 0)
    ? ok(`palvelutiski: livekartta tiskin sisällä (${dMap.h} px, "${dMap.status}")`)
    : fail("palvelutiski: livekartta puuttuu tiskiltä: " + JSON.stringify(dMap));
  // Yhteishaku: linjanumero → linjakortti tiskillä, osoite pysyy #/palvelutiski. Näppäimistöllä
  // (Enter avaa ensimmäisen, tarkka linjatunnus on listan kärjessä).
  await page.evaluate(() => { document.getElementById("deskStop").value = ""; });
  await page.click("#deskStop");
  await page.type("#deskStop", "4", { delay: 25 });
  if (await expect("#deskStopList button[data-l]", "palvelutiski: yhteishaku löytää linjan", 15000)) {
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#deskLineCard .desk-line-stops li a").length > 2,
      { timeout: 25000 }).catch(() => {});
    const lc = await page.evaluate(() => ({
      hash: location.hash,
      nakyy: document.querySelector('[data-dcard-panel="line"]')?.hidden === false,
      pysakkiPiilossa: document.querySelector('[data-dcard-panel="stop"]')?.hidden === true,
      badge: document.querySelector("#deskLineH .badge")?.textContent.trim() || "",
      pysakit: document.querySelectorAll("#deskLineCard .desk-line-stops li a").length,
      suunnat: document.querySelectorAll("#deskLineCard .desk-line-dirs .dseg").length,
      tulosteet: document.querySelectorAll("#deskLineCard .deskLinePrint").length,
      valilehti: document.querySelector('.dcard-tab[data-dcard="line"]')?.getAttribute("aria-pressed"),
    }));
    (lc.hash === "#/palvelutiski" && lc.nakyy && lc.pysakkiPiilossa && lc.badge === "4" && lc.pysakit > 2
      && lc.suunnat >= 1 && lc.tulosteet === 5 && lc.valilehti === "true")
      ? ok(`palvelutiski: yhteishaun linja avaa linjakortin tiskillä (${lc.pysakit} pysäkkiä, ${lc.suunnat} suuntaa, hash ennallaan)`)
      : fail("palvelutiski: linjakortti: " + JSON.stringify(lc));
    // Linjakortin pysäkkilinkki (#/pysakki/<id>) avaa pysäkkikortin tiskillä eikä vie pois.
    const linkStop = await page.evaluate(() => {
      const a = document.querySelectorAll("#deskLineCard .desk-line-stops li a")[1];
      if (!a) return null;
      const name = a.textContent.trim();
      a.click();
      return name;
    });
    const stopOpened = linkStop && await page.waitForFunction(n => document.querySelector('[data-dcard-panel="stop"]')?.hidden === false
      && !!document.querySelector("#deskDeps .desk-deps-upd")
      && (document.querySelector("#deskDeps .stophead")?.textContent || "").includes(n), { timeout: 20000 }, linkStop)
      .then(() => true).catch(() => false);
    const ls = await page.evaluate(() => ({ hash: location.hash, desk: document.body.classList.contains("desk-mode") }));
    (stopOpened && ls.hash === "#/palvelutiski" && ls.desk)
      ? ok(`palvelutiski: pysäkkilinkki avaa pysäkkikortin tiskillä (${linkStop})`)
      : fail("palvelutiski: pysäkkilinkki vei pois tiskiltä tai kortti ei avautunut: " + JSON.stringify({ linkStop, stopOpened, ...ls }));
  }
  // --- Palvelutiski V2 (4.10.2026) ---
  // 1) Linjakortin lähdöt linjasivun säännöillä (lineDirDeps): eri pysäkiltä alkava varianttivuoro
  //    näkyy aikajärjestyksessä ja sen lähtöpysäkki tekstinä rivillä. Synteettinen linja, jotta
  //    tarkistus ei riipu päivän aikataulusta: cachedGql vastaa hetken testidatalla VAIN tämän linjan
  //    avaimiin (muut kyselyt menevät ennallaan), ja alkuperäinen palautetaan aina.
  const v2Line = await page.evaluate(async () => {
    const orig = cachedGql;
    const now = new Date();
    const sd = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
    const t0 = Math.floor(now.getTime() / 1000) - sd;
    const ymd = todayISO().replace(/-/g, "");
    const st = (id, name, lat, lon) => ({ gtfsId: "SMOKEV2:" + id, name, lat, lon });
    const A = st("a", "Alkupysäkki", 60.98, 25.60), B = st("b", "Välipysäkki", 60.98, 25.61),
      C = st("c", "Keskipysäkki", 60.98, 25.62), D = st("d", "Päätepysäkki", 60.98, 25.63), X = st("x", "Varikko", 60.99, 25.615);
    const probe = Object.fromEntries(activeProbeDates().map((_, i) => ["p" + i, [{ gtfsId: "SMOKEV2:t" }]]));
    const pMain = { code: "SMOKEV2:r:0:01", directionId: 0, ...probe, stops: [A, B, C, D] };
    const pVar = { code: "SMOKEV2:r:0:02", directionId: 0, ...probe, stops: [X, C, D] };
    const trip = (id, stops, dep) => ({ gtfsId: "SMOKEV2:" + id, serviceId: "SMOKEV2:s",
      stoptimes: stops.map((s, i) => ({ timepoint: true, scheduledDeparture: dep + i * 120, stop: s })) });
    const main = [300, 1500, 2700].map((m, i) => trip("m" + i, pMain.stops, t0 + m));
    const vari = [trip("v0", pVar.stops, t0 + 900)];
    const tripsOf = { [pMain.code]: main, [pVar.code]: vari };
    cachedGql = async (key, query, vars) => {
      if (/^deskline:SMOKEV2/.test(key)) return { data: { routes: [{ gtfsId: "SMOKEV2:r", shortName: "V2",
        longName: "Alkupysäkki - Päätepysäkki", color: null, textColor: null, mode: "BUS", patterns: [pMain, pVar] }] }, cachedAt: null };
      if (/^patgeo:SMOKEV2/.test(key)) return { data: { pattern: null }, cachedAt: null };
      if (/^matrix2:SMOKEV2/.test(key)) {
        const data = {};
        for (const m of query.matchAll(/c(\d+): pattern\(id: "([^"]+)"\)/g))
          data["c" + m[1]] = { tripsForDate: vars.date === ymd ? (tripsOf[m[2]] || []) : [] };
        return { data, cachedAt: null };
      }
      if (/^tt4:SMOKEV2/.test(key)) return { data: { stop: { stoptimesForServiceDate: vars.date !== ymd ? [] : [{
        pattern: { code: pMain.code },
        stoptimes: main.map(tr => { const f = tr.stoptimes[0], l = tr.stoptimes[tr.stoptimes.length - 1];
          return { scheduledDeparture: f.scheduledDeparture, realtimeDeparture: f.scheduledDeparture, realtime: false, serviceDay: sd,
            trip: { gtfsId: tr.gtfsId, serviceId: tr.serviceId, wheelchairAccessible: "POSSIBLE",
              departureStoptime: { scheduledDeparture: f.scheduledDeparture, stop: f.stop },
              arrivalStoptime: { scheduledArrival: l.scheduledDeparture, stop: l.stop } } }; }) }] } }, cachedAt: null };
      return orig(key, query, vars);
    };
    try {
      const a = document.createElement("a");
      a.href = "#/linjakartta/" + encodeURIComponent("SMOKEV2:r");
      document.querySelector(".desk").appendChild(a);
      a.click();
      a.remove();
      for (let i = 0; i < 60 && document.querySelectorAll("#deskLineDeps tbody tr").length < 4; i++) await new Promise(r => setTimeout(r, 200));
      const rows = [...document.querySelectorAll("#deskLineDeps tbody tr")];
      return {
        jaettu: typeof lineDirDeps === "function",
        otsikko: document.getElementById("deskLineDepsH")?.textContent.trim() || "",
        // Erä B (B5): tiskin aika on muotoa "21:19 (5 min)", joten minuutit luetaan sulkeista (muuten alusta).
        minuutit: rows.map(tr => { const tx = tr.lastElementChild.textContent, m = /\((\d+) min\)/.exec(tx); return m ? Number(m[1]) : parseInt(tx, 10); }),
        lahtopysakit: rows.map(tr => tr.querySelector(".dep-from")?.textContent.trim() || ""),
        viesti: document.querySelector("#deskLineDeps > p.muted")?.textContent || "",
      };
    } finally {
      cachedGql = orig;
      document.querySelector('.dcard-tab[data-dcard="stop"]')?.click();   // linjan ajastin pois, kartta koko verkkoon
    }
  });
  const v2Asc = v2Line.minuutit.length === 4 && v2Line.minuutit.every((m, i, a) => Number.isFinite(m) && (i === 0 || m > a[i - 1]));
  (v2Line.jaettu && v2Asc && v2Line.lahtopysakit[1] === "Lähtee pysäkiltä Varikko"
    && v2Line.lahtopysakit.filter(Boolean).length === 1 && v2Line.otsikko.includes("Alkupysäkki"))
    ? ok(`palvelutiski V2: linjakortti näyttää eri pysäkiltä alkavan vuoron aikajärjestyksessä lähtöpysäkkeineen (${v2Line.minuutit.join("/")} min)`)
    : fail("palvelutiski V2: linjakortin varianttivuoro: " + JSON.stringify(v2Line));

  // 2) Viimeinen bussi haun päivälle ja Esteetön reitti -valinnalla, junavinkki haun ajasta. Lähtö ja
  //    määränpää ovat yllä haetut (Matkakeskus → Mukkulankatu 2). Kyselyn muuttujat luetaan pyynnöstä.
  //    Tila palautetaan: Nyt-aika ja esteettömyys pois.
  const v2Vars = [];
  const v2Listener = req => {
    const pd = req.method() === "POST" ? (req.postData() || "") : "";
    if (pd.includes('searchWindow: \\"PT12H\\"')) { try { v2Vars.push(JSON.parse(pd).variables); } catch (e) { /* ei JSONia */ } }
  };
  page.on("request", v2Listener);
  await page.click('.dcard-tab[data-dcard="route"]');
  const v2Day = await page.evaluate(() => {
    const n = new Date(), d = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
    return { iso: isoOf(d), next: isoOf(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 2)),
      label: d.toLocaleDateString("fi-FI", { weekday: "short", day: "numeric", month: "numeric" }) };
  });
  // Kenttien input vaihtaa Nyt-tilan lähtöajaksi käynnistämättä hakua (napin klikkaus hakisi, ja
  // myöhästyvä reittitulos voisi korvata viimeisen bussin tuloksen kesken tarkistuksen).
  const v2SetWhen = (date, time) => page.evaluate((d, tm) => {
    document.getElementById("deskWheelchair").checked = true;   // ilman change-tapahtumaa: ei käynnistä hakua
    const de = document.getElementById("deskDate"), te = document.getElementById("deskTime");
    de.value = d; de.dispatchEvent(new Event("input", { bubbles: true }));
    te.value = tm; te.dispatchEvent(new Event("input", { bubbles: true }));
  }, date, time);
  await v2SetWhen(v2Day.iso, "22:00");
  await sleep(500);
  await page.evaluate(() => { document.getElementById("deskResults").innerHTML = ""; document.getElementById("deskLastBusBtn").click(); });
  await page.waitForSelector("#deskResults .desk-tell-h, #deskResults > p.muted", { timeout: 25000 }).catch(() => {});
  const v2Last = await page.evaluate(() => ({
    nappi: document.getElementById("deskLastBusBtn")?.textContent.trim() || "",
    otsikko: document.querySelector("#deskResults .desk-tell-h")?.textContent.trim() || "",
    runko: (document.querySelector("#deskResults .desk-tell-body")?.textContent || "").trim(),
    vaihtoehto: !!document.querySelector("#deskResults .desk-opt"),
    viesti: document.querySelector("#deskResults > p.muted")?.textContent || "",
  }));
  const lv = v2Vars[v2Vars.length - 1] || {};
  const la = new Date(lv.dateTime?.latestArrival || 0);
  const laOk = await page.evaluate(ms => { const d = new Date(ms); return isoOf(d) + " " + d.getHours() + ":" + d.getMinutes(); }, la.getTime());
  (v2Last.otsikko === "Viimeinen bussi " + v2Day.label && v2Last.nappi === v2Last.otsikko && v2Last.runko && v2Last.vaihtoehto
    // Haku jatkuu haun päivää seuraavaan aamuun klo 4.30 (liikennöintivuorokauden yövuorot, erä A / A2).
    && laOk === v2Day.next + " 4:30" && lv.preferences?.accessibility?.wheelchair?.enabled === true)
    ? ok(`palvelutiski V2: viimeinen bussi haun päivälle (${v2Last.otsikko}) esteettömyysvalinnalla`)
    : fail("palvelutiski V2: viimeinen bussi: " + JSON.stringify({ ...v2Last, odotettu: v2Day.label, laOk, wc: lv.preferences }));
  page.off("request", v2Listener);
  // Junavinkki: haku 6 h päähän (live-junadata kattaa noin vuorokauden) näyttää vain sen jälkeen lähteviä
  // junia; haku 5 vrk päähän piilottaa vinkin (ei nykyhetken junia).
  const v2Rail = async (ms) => {
    await page.evaluate(ms => {
      const d = new Date(ms);
      const de = document.getElementById("deskDate"), te = document.getElementById("deskTime");
      de.value = isoOf(d); de.dispatchEvent(new Event("input", { bubbles: true }));
      te.value = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      te.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("deskResults").innerHTML = "";
      document.getElementById("deskRouteBtn").click();
    }, ms);
    await page.waitForFunction(() => { const h = document.querySelector("#deskResults [data-railhint]");
      return h && h.hasAttribute("data-railhint-done") && (h.hidden || !!h.querySelector(".rail-next")); }, { timeout: 30000 }).catch(() => {});
    return page.evaluate(() => {
      const h = document.querySelector("#deskResults [data-railhint]");
      const tm = document.getElementById("deskTime").value, from = new Date(document.getElementById("deskDate").value + "T" + tm).getTime();
      // piilossa = hidden JA laskettu display none (CSS ei saa ohittaa piilotusta)
      return { vinkki: !!h, piilossa: !!h && h.hidden && getComputedStyle(h).display === "none", from,
        junat: h ? [...h.querySelectorAll(".rail-next")].map(x => Number(x.dataset.sched)) : [] };
    });
  };
  const nowMs = Date.now();
  const r6 = await v2Rail(nowMs + 6 * 3600e3);
  const r5d = await v2Rail(nowMs + 5 * 86400e3);
  (r6.vinkki && !r6.piilossa && r6.junat.length > 0 && r6.junat.every(s => s >= r6.from - 60000)
    && r5d.vinkki && r5d.piilossa && r5d.junat.length === 0)
    ? ok(`palvelutiski V2: junavinkki alkaa haun ajasta (${r6.junat.length} junaa) ja piiloutuu, kun haun ajalle ei ole junadataa`)
    : fail("palvelutiski V2: junavinkki: " + JSON.stringify({ r6, r5d }));
  // Hakujen järjestys (4.10.2026): reittihaun vastaus viivästetään 5 s ja viimeinen bussi klikataan perään.
  // Viimeisen bussin tulos ei saa vaihtua, kun viivästetty reittivastaus saapuu. gql palautetaan aina.
  await v2SetWhen(v2Day.iso, "12:00");
  const order = await page.evaluate(async () => {
    const orig = gql, wait = ms => new Promise(r => setTimeout(r, ms));
    let viivastetty = 0, saapui = 0;
    gql = async (query, vars, opts) => {
      if (!viivastetty && query === PLAN_QUERY) { viivastetty = Date.now(); await wait(5000); saapui = Date.now(); }
      return orig(query, vars, opts);
    };
    try {
      const res = document.getElementById("deskResults");
      res.innerHTML = "";
      document.getElementById("deskRouteBtn").click();
      await wait(100);
      document.getElementById("deskLastBusBtn").click();
      for (let i = 0; i < 100 && !res.innerHTML.trim(); i++) await wait(100);
      const ennen = res.innerHTML, ennenAika = Date.now();
      for (let i = 0; i < 100 && !saapui; i++) await wait(100);
      await wait(2500);   // viivästetty reittihaku ehtii piirtää, jos se piirtäisi
      return { viivastetty: !!viivastetty, ehtiEnnen: !!ennen && ennenAika < (saapui || Infinity), saapui: !!saapui,
        sama: res.innerHTML === ennen, otsikko: res.querySelector(".desk-tell-h")?.textContent.trim() || res.textContent.trim().slice(0, 60) };
    } finally { gql = orig; }
  });
  (order.viivastetty && order.ehtiEnnen && order.saapui && order.sama)
    ? ok(`palvelutiski: myöhästyvä reittivastaus ei korvaa uudempaa viimeisen bussin tulosta (${order.otsikko})`)
    : fail("palvelutiski: hakujen järjestys: " + JSON.stringify(order));
  await page.evaluate(() => {
    document.getElementById("deskWheelchair").checked = false;
    document.getElementById("deskResults").innerHTML = "";
    document.querySelector('.desk-when .dseg[data-tm="now"]').click();
  });
  await sleep(500);

  // --- Erä A (4.10.2026): tiski ei anna itsevarmaa väärää vastausta ---
  // Tiskin omat tarkistukset synteettisellä reitittimellä: gql (tai fetch) kääritään hetkeksi ja palautetaan aina
  // finally-lohkossa. Lähtö ja määränpää ovat yllä haetut (Matkakeskus → Mukkulankatu 2), ellei lause vaihda niitä.
  const deskAt = () => page.evaluate(() => {
    const n = new Date(), f = o => isoOf(new Date(n.getFullYear(), n.getMonth(), n.getDate() + o));
    return { today: f(0), tomorrow: f(1), after: f(2), h: n.getHours() };
  });
  const dA = await deskAt();
  // A2: viimeinen bussi näkee haun päivän liikennöintivuorokauden yövuorot. Synteettinen reititin antaa vain vuorot,
  // jotka ovat perillä ennen kyselyn latestArrivalia: haun päivän 23:35, sen jälkeisen yön 00:35 (liikennöintipäivä
  // = haun päivä) ja seuraavan päivän 04:10 (eri liikennöintipäivä, ei saa näkyä viimeisenä).
  const lb = await page.evaluate(async (dayIso, nextIso) => {
    const orig = gql, wait = ms => new Promise(r => setTimeout(r, ms));
    const at = (d, hm) => isoWithOffset(d + "T" + hm);
    const node = (dep, arr, d, sd) => ({ start: at(d, dep), end: at(d, arr), numberOfTransfers: 0, legs: [
      { mode: "BUS", serviceDate: sd, start: { scheduledTime: at(d, dep) }, end: { scheduledTime: at(d, arr) },
        from: { name: "Kauppatori E", stop: { platformCode: "E" } }, to: { name: "Jalkaranta", stop: {} },
        route: { gtfsId: "SMOKEA:98", shortName: "98" }, intermediateStops: [] }] });
    const all = [node("23:35", "23:46", dayIso, dayIso), node("00:35", "00:46", nextIso, dayIso), node("04:10", "04:21", nextIso, nextIso)];
    gql = async (q, v, o) => q !== DESK_LASTBUS_QUERY ? orig(q, v, o)
      : { planConnection: { edges: all.filter(x => new Date(x.end) <= new Date(v.dateTime.latestArrival)).map(node => ({ node })) } };
    try {
      document.querySelector('.dcard-tab[data-dcard="route"]')?.click();
      const de = document.getElementById("deskDate"), te = document.getElementById("deskTime");
      de.value = dayIso; de.dispatchEvent(new Event("input", { bubbles: true }));
      te.value = "12:00"; te.dispatchEvent(new Event("input", { bubbles: true }));
      const res = document.getElementById("deskResults");
      res.innerHTML = "";
      document.getElementById("deskLastBusBtn").click();
      for (let i = 0; i < 100 && !res.querySelector(".desk-tell-body, p.muted"); i++) await wait(100);
      return (res.querySelector(".desk-tell-body")?.textContent || res.textContent).replace(/\s+/g, " ").trim();
    } finally { gql = orig; }
  }, dA.tomorrow, dA.after);
  (/linja 98 pysäkiltä Kauppatori E klo 00:35 \(yöllä\)/.test(lb) && !/23:35|04:10/.test(lb))
    ? ok(`palvelutiski: viimeinen bussi näkee puolenyön jälkeisen yövuoron (${lb})`)
    : fail("palvelutiski: viimeinen bussi yövuoro: " + lb);

  // A6 + A7: saapumisaikahaussa vaihtoehdot myöhäisin lähtö ensin, joten ylin tulostenappi tulostaa saman vuoron kuin
  // Kerro asiakkaalle (ennen tulostui tuntia aiempi vuoro).
  const arrDesk = await page.evaluate(async dayIso => {
    const orig = gql, wait = ms => new Promise(r => setTimeout(r, ms));
    const at = hm => isoWithOffset(dayIso + "T" + hm);
    const node = (dep, arr, line, walk = 300) => ({ start: at(dep), end: at(arr), numberOfTransfers: 0, walkDistance: walk, legs: [
      { mode: "BUS", duration: 600, distance: 3000, start: { scheduledTime: at(dep) }, end: { scheduledTime: at(arr) },
        from: { name: "Matkakeskus B", lat: 60.977, lon: 25.658, stop: { platformCode: "B" } },
        to: { name: "Keskussairaala", lat: 60.99, lon: 25.68, stop: {} }, route: { gtfsId: "SMOKEA:" + line, shortName: line },
        trip: { tripHeadsign: "Keskussairaala" }, intermediateStops: [], intermediatePlaces: [], legGeometry: { points: "" }, alerts: [] }] });
    // 06:55 lähtee myöhäisimpänä mutta vaatii 350 m enemmän kävelyä: kerrotaan 06:48 (Trio C → PHKS, Ville 5.10.2026).
    const nodes = [node("05:49", "06:00", "4"), node("06:48", "06:57", "14"), node("06:18", "06:30", "4"), node("06:55", "06:59", "4", 650)];
    gql = async (q, v, o) => q === PLAN_QUERY ? { planConnection: { pageInfo: {}, edges: nodes.map(node => ({ node })) } } : orig(q, v, o);
    window.print = () => {};   // tulostusdialogi pois (sama kuin pysäkkiaikataulun tarkistuksessa)
    try {
      document.querySelector('.desk-when .dseg[data-tm="arr"]').click();
      const de = document.getElementById("deskDate"), te = document.getElementById("deskTime");
      de.value = dayIso; de.dispatchEvent(new Event("input", { bubbles: true }));
      te.value = "07:00"; te.dispatchEvent(new Event("input", { bubbles: true }));
      const res = document.getElementById("deskResults");
      await wait(300);
      res.innerHTML = "";
      document.getElementById("deskRouteBtn").click();
      for (let i = 0; i < 100 && !res.querySelector(".deskOptPrint"); i++) await wait(100);
      const tell = (res.querySelector(".desk-tell-body")?.textContent || "").replace(/\s+/g, " ").trim();
      const opts = [...res.querySelectorAll(".desk-opt .desk-opt-time")].map(e => e.textContent.trim());
      document.getElementById("deskPrintOut").innerHTML = "";
      res.querySelector(".deskOptPrint")?.click();
      for (let i = 0; i < 50 && !document.querySelector("#deskPrintOut .itin-print"); i++) await wait(100);
      return { tell, opts, print: (document.querySelector("#deskPrintOut .itin-print .ip-sum")?.textContent || "").replace(/\s+/g, " ").trim() };
    } finally { gql = orig; }
  }, dA.tomorrow);
  (/Linja 14 pysäkiltä Matkakeskus B klo 06:48/.test(arrDesk.tell) && /^06:48/.test(arrDesk.opts[0] || "")
    && arrDesk.opts.map(x => x.slice(0, 5)).join(" ") === "06:48 06:18 05:49 06:55" && /Lähtö 06:48, perillä 06:57/.test(arrDesk.print))
    ? ok("palvelutiski: saapumisaikahaussa kerrottu vuoro on ensimmäinen vaihtoehto ja sen tulosteessa, pitkä kävely ei voita")
    : fail("palvelutiski: saapumisaikahaun järjestys/tuloste: " + JSON.stringify(arrDesk));

  // Kun kävely voittaa, tiski hakee seuraavan bussin erikseen (NEXT_BUS_QUERY). Varahaku välittää Esteetön reitti
  // -valinnan, ettei pyörätuoliasiakkaalle tarjota ei-esteetöntä vuoroa (ennen vain vaihtoajan). Valinta palautetaan.
  const wcFb = await page.evaluate(async dayIso => {
    const orig = gql, wait = ms => new Promise(r => setTimeout(r, ms));
    const at = hm => isoWithOffset(dayIso + "T" + hm);
    const walkOnly = { start: at("10:00"), end: at("10:12"), numberOfTransfers: 0, walkDistance: 900, legs: [
      { mode: "WALK", duration: 720, distance: 900, start: { scheduledTime: at("10:00") }, end: { scheduledTime: at("10:12") },
        from: { name: "Origin", lat: 60.977, lon: 25.658 }, to: { name: "Destination", lat: 60.98, lon: 25.66 },
        intermediateStops: [], intermediatePlaces: [], legGeometry: { points: "" }, alerts: [] }] };
    let seen = null;
    gql = async (q, v, o) => {
      if (q === PLAN_QUERY) return { planConnection: { pageInfo: {}, edges: [{ node: walkOnly }] } };
      if (q === NEXT_BUS_QUERY) { seen = (v && v.preferences) || {}; return { planConnection: { edges: [] } }; }
      return orig(q, v, o);
    };
    const wc = document.getElementById("deskWheelchair");
    try {
      wc.checked = true;   // ilman change-tapahtumaa: ei käynnistä omaa hakua
      const res = document.getElementById("deskResults");
      res.innerHTML = "";
      document.getElementById("deskRouteBtn").click();
      for (let i = 0; i < 100 && !seen; i++) await wait(100);
      await wait(200);
      return { haettu: !!seen, esteeton: seen?.accessibility?.wheelchair?.enabled === true, vaihtoaika: seen?.transit?.transfer?.slack || null };
    } finally { gql = orig; wc.checked = false; }
  }, dA.tomorrow);
  (wcFb.haettu && wcFb.esteeton && /^PT\d+S$/.test(wcFb.vaihtoaika || ""))
    ? ok(`palvelutiski: seuraavan bussin varahaku välittää Esteetön reitti -valinnan ja vaihtoajan (${wcFb.vaihtoaika})`)
    : fail("palvelutiski: varahaun preferenssit: " + JSON.stringify(wcFb));

  // A3 tiskillä: "huomenna klo 7" asettaa päiväkenttään huomisen, ja mennyt kellonaika ilman päivää siirtyy huomiseen
  // näkyvällä huomautuksella. Reittivastaus synteettinen; paikat haetaan oikeasta geokooderista.
  const nlDesk = await page.evaluate(async h => {
    const orig = gql, wait = ms => new Promise(r => setTimeout(r, ms));
    const at = hm => isoWithOffset(isoOf(new Date()) + "T" + hm);
    const one = { start: at("23:00"), end: at("23:20"), numberOfTransfers: 0, walkDistance: 100, legs: [
      { mode: "BUS", duration: 1200, distance: 5000, start: { scheduledTime: at("23:00") }, end: { scheduledTime: at("23:20") },
        from: { name: "Matkakeskus C", lat: 60.977, lon: 25.658, stop: { platformCode: "C" } }, to: { name: "Mukkula", lat: 61.01, lon: 25.66, stop: {} },
        route: { gtfsId: "SMOKEA:32", shortName: "32" }, trip: {}, intermediateStops: [], intermediatePlaces: [], legGeometry: { points: "" }, alerts: [] }] };
    gql = async (q, v, o) => q === PLAN_QUERY ? { planConnection: { pageInfo: {}, edges: [{ node: one }] } } : orig(q, v, o);
    const input = document.getElementById("deskNlInput"), res = document.getElementById("deskResults");
    const run = async txt => {
      res.innerHTML = "";
      input.value = txt;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      for (let i = 0; i < 150 && !res.querySelector(".desk-tell-body"); i++) await wait(100);
      return { date: document.getElementById("deskDate").value, time: document.getElementById("deskTime").value,
        from: document.getElementById("deskFrom").value, note: (res.querySelector(".desk-when-note")?.textContent || "").trim() };
    };
    try {
      const a = await run("huomenna klo 7 Matkakeskukselta Mukkulaan");
      const b = h >= 2 ? await run(`klo ${String(h - 2).padStart(2, "0")} Matkakeskukselta Mukkulaan`) : null;
      return { a, b };
    } finally { gql = orig; }
  }, dA.h);
  (nlDesk.a.date === dA.tomorrow && nlDesk.a.time === "07:00" && !/huomenna/i.test(nlDesk.a.from) && !nlDesk.a.note)
    ? ok("palvelutiski: lauseen 'huomenna klo 7' haku tehdään huomiselle")
    : fail("palvelutiski: 'huomenna klo 7': " + JSON.stringify({ ...nlDesk.a, odotettu: dA.tomorrow }));
  if (!nlDesk.b) info("palvelutiski: mennyt kellonaika -tarkistus ohitettu (kello alle 2, ei aiempaa tuntia tälle päivälle)");
  else (nlDesk.b.date === dA.tomorrow && /huomise/.test(nlDesk.b.note))
    ? ok(`palvelutiski: mennyt kellonaika siirtyy huomiseen ja se kerrotaan ("${nlDesk.b.note}")`)
    : fail("palvelutiski: mennyt kellonaika: " + JSON.stringify({ ...nlDesk.b, odotettu: dA.tomorrow }));

  // A4: toisen kunnan nimi ei ratkea hiljaa kaupungin kaduksi ("Helsinkiin" -> Helsingintie 15). Kohde näytetään,
  // ja alueen ulkopuolisuus ja kaukoliikenne kerrotaan. Oikea geokooderi ja reititin (Lahdesta ei paikallisyhteyttä).
  const outA = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const input = document.getElementById("deskNlInput"), res = document.getElementById("deskResults");
    res.innerHTML = "";
    input.value = "Matkakeskukselta Helsinkiin";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    for (let i = 0; i < 250 && !(res.textContent || "").trim(); i++) await wait(100);
    return { to: document.getElementById("deskTo").value, note: (res.querySelector(".plan-outside")?.textContent || "").trim() };
  });
  (/^Helsinki\b/.test(outA.to) && !/tie/.test(outA.to) && /Helsinki on Lahden joukkoliikennealueen ulkopuolella/.test(outA.note) && /VR/.test(outA.note))
    ? ok("palvelutiski: 'Helsinkiin' ratkeaa Helsingiksi, ja alueen ulkopuolisuus ja kaukoliikenne kerrotaan")
    : fail("palvelutiski: kunnan ulkopuolinen kohde: " + JSON.stringify(outA));

  // A5 (reittihaku): uusi haku himmentää edellisen vastauksen (M10), ja virhe näkyy virheenä Yritä uudelleen
  // -napilla eikä vanha vastaus jää näkyviin. Lähtö ja määränpää palautetaan paikallisiksi synteettisellä haulla.
  const rErr = await page.evaluate(async () => {
    const orig = gql, wait = ms => new Promise(r => setTimeout(r, ms));
    const at = hm => isoWithOffset(isoOf(new Date()) + "T" + hm);
    const one = { start: at("23:00"), end: at("23:20"), numberOfTransfers: 0, walkDistance: 100, legs: [
      { mode: "BUS", duration: 1200, distance: 5000, start: { scheduledTime: at("23:00") }, end: { scheduledTime: at("23:20") },
        from: { name: "Kauppatori E", lat: 60.98, lon: 25.65, stop: { platformCode: "E" } }, to: { name: "Ahtiala", lat: 61.0, lon: 25.79, stop: {} },
        route: { gtfsId: "SMOKEA:4", shortName: "4" }, trip: {}, intermediateStops: [], intermediatePlaces: [], legGeometry: { points: "" }, alerts: [] }] };
    let mode = "ok";
    gql = async (q, v, o) => {
      if (q !== PLAN_QUERY) return orig(q, v, o);
      if (mode === "slow") await wait(2500);
      if (mode === "fail") throw new TypeError("Failed to fetch");
      return { planConnection: { pageInfo: {}, edges: [{ node: one }] } };
    };
    const res = document.getElementById("deskResults"), msg = document.getElementById("deskMsg");
    try {
      document.querySelector('.desk-when .dseg[data-tm="now"]').click();
      const input = document.getElementById("deskNlInput");
      res.innerHTML = "";
      input.value = "Kauppatorilta Ahtialaan";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      for (let i = 0; i < 150 && !res.querySelector(".desk-tell-body"); i++) await wait(100);
      const told = !!res.querySelector(".desk-tell-body");
      mode = "slow";
      document.getElementById("deskRouteBtn").click();
      await wait(600);
      const kesken = { himmea: res.classList.contains("desk-busy") && Number(getComputedStyle(res).opacity) < 0.6, vanha: !!res.querySelector(".desk-tell-body") };
      await wait(2600);
      mode = "fail";
      document.getElementById("deskRouteBtn").click();
      for (let i = 0; i < 50 && !msg.querySelector(".error"); i++) await wait(100);
      return { told, kesken, virhe: (msg.querySelector(".error")?.textContent || "").trim(), nappi: !!msg.querySelector(".desk-retry"),
        vanhaJai: !!res.querySelector(".desk-tell-body") };
    } finally { gql = orig; }
  });
  (rErr.told && (rErr.kesken.himmea || !rErr.kesken.vanha) && /Reittejä ei saatu haettua/.test(rErr.virhe) && rErr.nappi && !rErr.vanhaJai)
    ? ok("palvelutiski: uusi reittihaku himmentää vanhan vastauksen, ja hakuvirhe näkyy virheenä Yritä uudelleen -napilla")
    : fail("palvelutiski: reittihaun virhetila: " + JSON.stringify(rErr));

  // A5 (paikkahaku): verkkokatko luonnollisen kielen haussa näkyy virheenä, ei kirjoitusvirheen vihjeenä
  // ("En saanut kiinni lähtöä ja määränpäätä"). fetch palautetaan finallyssä.
  const nlErr = await page.evaluate(async () => {
    const of = window.fetch, wait = ms => new Promise(r => setTimeout(r, ms));
    window.fetch = (u, o) => /workers\.dev|digitransit/.test(String(u)) ? Promise.reject(new TypeError("Failed to fetch")) : of(u, o);
    try {
      const input = document.getElementById("deskNlInput"), m = document.getElementById("deskNlMsg");
      m.innerHTML = "";
      input.value = "Kauppatorilta Mukkulaan";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      for (let i = 0; i < 50 && !/[.]$|uudelleen/.test((m.textContent || "").trim()); i++) await wait(100);
      return { txt: (m.textContent || "").trim(), virhe: !!m.querySelector(".error"), nappi: !!m.querySelector(".nl-retry") };
    } finally { window.fetch = of; }
  });
  (nlErr.virhe && nlErr.nappi && !/En saanut kiinni/.test(nlErr.txt))
    ? ok("palvelutiski: paikkahaun yhteysvirhe näkyy virheenä Yritä uudelleen -napilla")
    : fail("palvelutiski: paikkahaun yhteysvirhe: " + JSON.stringify(nlErr));

  // A5 (pysäkin lähdöt): päivityksen verkkovirhe jättää näkyvän listan näkyviin merkinnällä "Päivitys epäonnistui",
  // ja ensimmäisen haun virhe näkyy virheenä (ei "Ei tulevia lähtöjä"). Synteettinen pysäkki linkin kautta.
  const depErr = await page.evaluate(async () => {
    const orig = gql, wait = ms => new Promise(r => setTimeout(r, ms));
    const n = new Date(), sd = Math.floor(new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() / 1000);
    const t0 = Math.floor(n.getTime() / 1000) - sd;
    const stop = id => ({ gtfsId: id, name: "Smoketesti " + id.slice(-1), code: "S1", lat: 60.98, lon: 25.66, wheelchairBoarding: "NO_INFORMATION",
      routes: [{ gtfsId: "SMOKEA:r", shortName: "S1" }],
      stoptimesWithoutPatterns: [600, 1500, 2400].map(d => ({ scheduledDeparture: t0 + d, realtimeDeparture: t0 + d, realtime: false, serviceDay: sd,
        headsign: "Testikylä", trip: { wheelchairAccessible: "NO_INFORMATION", occupancy: null, route: { gtfsId: "SMOKEA:r", shortName: "S1" } } })) });
    let mode = "ok";
    gql = async (q, v, o) => {
      if (q !== DESK_DEPS_QUERY || !/^SMOKEA:/.test(v.id)) return orig(q, v, o);
      if (mode === "fail") throw new TypeError("Failed to fetch");
      return { stop: stop(v.id) };
    };
    const open = id => { const a = document.createElement("a"); a.href = "#/pysakki/" + encodeURIComponent(id);
      document.querySelector(".desk").appendChild(a); a.click(); a.remove(); };
    const dep = () => document.getElementById("deskDeps");
    try {
      open("SMOKEA:a");
      for (let i = 0; i < 50 && !dep()?.querySelector("table.deps tbody tr"); i++) await wait(100);
      const rivit = dep()?.querySelectorAll("table.deps tbody tr").length || 0;
      mode = "fail";
      document.querySelector('.dcard-tab[data-dcard="stop"]').click();   // päivitys (loadDeskDeps)
      for (let i = 0; i < 50 && !dep()?.querySelector(".desk-upd-fail"); i++) await wait(100);
      const paivitys = { rivit: dep()?.querySelectorAll("table.deps tbody tr").length || 0,
        merkinta: (dep()?.querySelector(".desk-upd-fail")?.textContent || "").trim() };
      open("SMOKEA:b");
      for (let i = 0; i < 50 && !dep()?.querySelector(".error"); i++) await wait(100);
      const eka = { virhe: (dep()?.querySelector(".error")?.textContent || "").trim(), nimi: (dep()?.querySelector(".stophead")?.textContent || "").trim(),
        tyhja: /Ei tulevia lähtöjä/.test(dep()?.textContent || ""), nappi: !!dep()?.querySelector(".desk-retry") };
      mode = "ok";
      dep()?.querySelector(".desk-retry")?.click();
      for (let i = 0; i < 50 && !dep()?.querySelector("table.deps tbody tr"); i++) await wait(100);
      return { rivit, paivitys, eka, uudelleen: dep()?.querySelectorAll("table.deps tbody tr").length || 0 };
    } finally { gql = orig; }
  });
  (depErr.rivit === 3 && depErr.paivitys.rivit === 3 && /Päivitys epäonnistui klo \d\d:\d\d/.test(depErr.paivitys.merkinta)
    && /Lähtöjä ei saatu haettua/.test(depErr.eka.virhe) && depErr.eka.nappi && !depErr.eka.tyhja && depErr.uudelleen === 3)
    ? ok("palvelutiski: lähtöjen päivitysvirhe säilyttää listan merkinnällä, ensimmäisen haun virhe näkyy virheenä ja Yritä uudelleen toimii")
    : fail("palvelutiski: lähtöjen virhetila: " + JSON.stringify(depErr));

  // A5 (häiriöt): ensimmäisen latauksen virhe näkyy virheenä eikä tekstinä "Ei aktiivisia häiriöitä". Tiski piirretään
  // uudelleen (#/ ja takaisin), jotta häiriöt haetaan alusta; gql palautetaan ja Yritä uudelleen hakee ne.
  await page.evaluate(() => {
    window.__smokeOrigGql = gql;
    alertsPromise = null;
    gql = async (q, v, o) => /alerts\(feeds/.test(q) ? Promise.reject(new TypeError("Failed to fetch")) : window.__smokeOrigGql(q, v, o);
    location.hash = "#/";
  });
  await page.waitForSelector("#homeFromInput, #routeList", { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => { location.hash = "#/palvelutiski"; });
  await page.waitForFunction(() => { const a = document.getElementById("deskAlerts"); return a && !/Haetaan|Loading|Hämtar/.test(a.textContent); },
    { timeout: 20000 }).catch(() => {});
  const alErr = await page.evaluate(() => ({ virhe: !!document.querySelector("#deskAlerts .error"), nappi: !!document.querySelector("#deskAlerts .desk-retry"),
    txt: (document.getElementById("deskAlerts")?.textContent || "").replace(/\s+/g, " ").trim() }));
  await page.evaluate(() => { gql = window.__smokeOrigGql; delete window.__smokeOrigGql; document.querySelector("#deskAlerts .desk-retry")?.click(); });
  await page.waitForFunction(() => { const a = document.getElementById("deskAlerts"); return a && !a.querySelector(".error") && !/Haetaan|Loading|Hämtar/.test(a.textContent); },
    { timeout: 20000 }).catch(() => {});
  const alBack = await page.evaluate(() => !document.querySelector("#deskAlerts .error") && !!(document.getElementById("deskAlerts")?.textContent || "").trim());
  (alErr.virhe && alErr.nappi && !/Ei aktiivisia häiriöitä/.test(alErr.txt) && alBack)
    ? ok("palvelutiski: häiriöiden latausvirhe näkyy virheenä eikä tyhjänä tilana, ja Yritä uudelleen hakee ne")
    : fail("palvelutiski: häiriöiden virhetila: " + JSON.stringify({ ...alErr, alBack }));

  // --- Erä B (4.10.2026): tiski nopeammaksi ja selkeämmäksi kiireessä ---
  // Tiski piirretään alusta (Lahden oletus = Trion terminaali). Synteettinen reittivastaus ja häiriöt: gql ja
  // loadAllAlerts kääritään hetkeksi ja palautetaan finally-lohkossa. Ajat ovat nykyhetkestä laskettuja (ei kiinteää
  // aikavyöhykettä). Lopuksi lomake avataan, näkymän koko palautetaan ja tiski piirretään uudelleen.
  await page.evaluate(() => { location.hash = "#/"; });
  await sleep(400);
  await page.evaluate(() => { location.hash = "#/palvelutiski"; });
  const termHead = () => page.waitForFunction(() => /kaikki pysäkit/.test(document.querySelector("#deskDeps .stophead")?.textContent || "")
    && !!document.querySelector("#deskDeps .desk-deps-upd"), { timeout: 30000 }).then(() => true).catch(() => false);
  const platOpen = () => page.waitForFunction(() => /^Trio \S+$/.test((document.querySelector("#deskDeps .stophead")?.textContent || "").trim())
    && !!document.getElementById("deskBackTerm"), { timeout: 20000 }).then(() => true).catch(() => false);
  await termHead();
  // B9: terminaalista avatun pysäkin kortissa paluunappi terminaaliin, ja selaimen Takaisin palauttaa terminaalin
  // tiskillä (ennen Takaisin vei pois palvelutiskiltä).
  await page.evaluate(() => document.querySelector("#deskDeps .desk-terminal-plats a.dep-plat")?.click());
  const b9a = await platOpen();
  const b9Btn = await page.evaluate(() => document.getElementById("deskBackTerm")?.textContent.trim() || "");
  await page.evaluate(() => document.getElementById("deskBackTerm")?.click());
  const b9b = await termHead();
  await page.evaluate(() => document.querySelector("#deskDeps .desk-terminal-plats a.dep-plat")?.click());
  const b9c = await platOpen();
  await page.evaluate(() => history.back());
  const b9d = await termHead();
  const b9s = await page.evaluate(() => ({ hash: location.hash, desk: document.body.classList.contains("desk-mode") }));
  (b9a && b9Btn === "← Trio, kaikki pysäkit" && b9b && b9c && b9d && b9s.hash === "#/palvelutiski" && b9s.desk)
    ? ok("palvelutiski B9: pysäkin kortista paluunapilla ja selaimen Takaisin-napilla takaisin Trion terminaaliin, tiski pysyy auki")
    : fail("palvelutiski B9: paluu terminaaliin: " + JSON.stringify({ b9a, b9Btn, b9b, b9c, b9d, ...b9s }));

  // B5: tiskin lähtölistassa kellonaika ja minuutit samalla rivillä, ja myöhästyminen aikataulun kellonaikoineen.
  const b5 = await page.evaluate(() => {
    const now = new Date(), sd = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const sec = Math.floor(now.getTime() / 1000 - sd);
    const st = { serviceDay: sd, scheduledDeparture: sec + 300, realtimeDeparture: sec + 480, realtime: true, headsign: "B5 testi",
      trip: { route: { shortName: "B5" } } };
    const html = typeof depTableRows === "function" && typeof DESK_DEP_OPTS !== "undefined" ? depTableRows([st], DESK_DEP_OPTS) : "";
    const box = document.createElement("table"); box.innerHTML = html;
    const cell = (box.querySelector("td.dep-when")?.textContent || "").replace(/\s+/g, " ").trim();
    const rows = document.querySelectorAll("#deskDeps table.deps tbody tr").length;
    return { cell, clock: fmtSec(sec + 480), sched: fmtSec(sec + 300), rows, whenCells: document.querySelectorAll("#deskDeps td.dep-when").length };
  });
  (b5.cell.startsWith(b5.clock + " (8 min)") && b5.cell.includes("myöhässä 3 min") && b5.cell.includes("(aikataulu " + b5.sched + ")")
    && b5.whenCells === b5.rows)
    ? ok(`palvelutiski B5: lähtörivillä kellonaika, minuutit ja myöhästyminen ("${b5.cell}"), terminaalin ${b5.rows} riviä samassa muodossa`)
    : fail("palvelutiski B5: lähtöaika ja viive: " + JSON.stringify(b5));

  // B7: sarkainpolku tulostusnappeihin (ennen linjakortin ensimmäiseen 77 ja pysäkkikortin 35 painallusta).
  const tabsTo = async sel => {
    await page.evaluate(() => { const q = document.getElementById("deskStop"); q.value = ""; q.focus(); });
    for (let i = 1; i <= 60; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(s => !!document.activeElement && document.activeElement.matches(s), sel)) return i;
    }
    return -1;
  };
  await page.evaluate(() => document.querySelector("#deskDeps .desk-terminal-plats a.dep-plat")?.click());
  await platOpen();
  await page.waitForSelector("#deskPrintBtn", { timeout: 15000 }).catch(() => {});
  const tabStop = await tabsTo("#deskPrintBtn");
  await page.evaluate(() => document.querySelector("#deskLines a.badgelink")?.click());
  await page.waitForFunction(() => !document.getElementById("deskCardLine").hidden && !!document.querySelector("#deskLineCard .deskLinePrint")
    && !!document.querySelector("#deskLineDeps table.deps, #deskLineDeps p.muted:not(:empty)"), { timeout: 30000 }).catch(() => {});
  const tabLine = await tabsTo("#deskLineCard .deskLinePrint");
  (tabStop > 0 && tabStop <= 15 && tabLine > 0 && tabLine <= 30)
    ? ok(`palvelutiski B7: sarkainpolku hausta pysäkkikortin tulostusnappiin ${tabStop} ja linjakortin ensimmäiseen tulostenappiin ${tabLine} painallusta`)
    : fail("palvelutiski B7: sarkainpolku: " + JSON.stringify({ tabStop, tabLine }));

  // B7: pikanäppäimet. "/" ja Ctrl+K hakuun, Alt+3 reittikortti, Alt+1 pysäkkikortti, ? avaa ohjeen ja Esc sulkee sen.
  const keyState = () => page.evaluate(() => ({ focus: document.activeElement?.id || "", card: document.querySelector(".dcard-tab[aria-pressed=true]")?.dataset.dcard,
    keys: !!document.getElementById("deskKeys")?.open }));
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("/");
  const k1 = await keyState();
  await page.keyboard.down("Alt"); await page.keyboard.press("Digit3"); await page.keyboard.up("Alt");
  const k2 = await keyState();
  await page.evaluate(() => document.getElementById("deskWheelchair")?.focus());
  await page.keyboard.down("Control"); await page.keyboard.press("KeyK"); await page.keyboard.up("Control");
  const k3 = await keyState();
  await page.keyboard.down("Alt"); await page.keyboard.press("Digit1"); await page.keyboard.up("Alt");
  const k4 = await keyState();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("?");
  const k5 = await keyState();
  await page.keyboard.press("Escape");
  const k6 = await keyState();
  (k1.focus === "deskStop" && k2.card === "route" && k3.focus === "deskStop" && k4.card === "stop" && k5.keys && !k6.keys)
    ? ok("palvelutiski B7: pikanäppäimet (/, Ctrl+K, Alt+1, Alt+3, ? ja Esc) ja ohje")
    : fail("palvelutiski B7: pikanäppäimet: " + JSON.stringify({ k1, k2, k3, k4, k5, k6 }));

  // B3 (pysäkki- ja linjakortti): pysäkkiä koskeva häiriö näkyy pysäkkikortin yläosassa ja linjan häiriö linjamerkkinä,
  // josta avautuvassa linjakortissa tiedote on yläosassa. Synteettiset tiedotteet terminaalin pysäkille ja linjalle.
  await page.evaluate(() => document.getElementById("deskBackTerm")?.click() || document.querySelector('.dcard-tab[data-dcard="stop"]')?.click());
  await termHead();
  const b3 = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const origAlerts = loadAllAlerts;
    const st = history.state && history.state.desk && history.state.desk.stop;
    const plat = document.querySelector("#deskDeps .desk-terminal-plats a.dep-plat");
    const platId = plat ? decodeURIComponent(plat.getAttribute("href").split("/pysakki/")[1]) : "";
    const route = st && (st.routes || [])[0];
    if (!platId || !route) return { ohita: true, platId, route };
    loadAllAlerts = async () => [
      { alertHeaderText: "B3 pysäkki suljettu", alertDescriptionText: "Vuorot siirretty viereiselle pysäkille.", alertEffect: "NO_SERVICE",
        alertSeverityLevel: "SEVERE", entities: [{ __typename: "Stop", gtfsId: platId }] },
      { alertHeaderText: "B3 linjan poikkeusreitti", alertDescriptionText: "Linja kiertää.", alertEffect: "DETOUR",
        alertSeverityLevel: "WARNING", entities: [{ __typename: "Route", gtfsId: route.gtfsId }] },
      { alertHeaderText: "B3 tiedote", alertEffect: "OTHER_EFFECT", alertSeverityLevel: "INFO", entities: [{ __typename: "Stop", gtfsId: platId }] }];
    try {
      document.querySelector('.dcard-tab[data-dcard="stop"]').click();
      const box = () => document.getElementById("deskStopAlerts");
      for (let i = 0; i < 100 && !/B3 pysäkki/.test(box()?.textContent || ""); i++) await wait(100);
      const stopTxt = (box()?.innerText || "").replace(/\s+/g, " ").trim();
      const lineBadge = [...(box()?.querySelectorAll(".desk-alert-lines a.badgelink") || [])].map(a => a.textContent.trim());
      const firstOpen = !!box()?.querySelector("details.alert[open]");
      box()?.querySelector(".desk-alert-lines a.badgelink")?.click();
      const lb = () => document.getElementById("deskLineAlerts");
      for (let i = 0; i < 150 && !/B3 linjan/.test(lb()?.textContent || ""); i++) await wait(100);
      const lineTxt = (lb()?.innerText || "").replace(/\s+/g, " ").trim();
      return { stopTxt, lineBadge, firstOpen, lineTxt, route: route.shortName };
    } finally { loadAllAlerts = origAlerts; }
  });
  (!b3.ohita && /Häiriöt tällä pysäkillä/.test(b3.stopTxt) && /B3 pysäkki suljettu/.test(b3.stopTxt) && /viereiselle/.test(b3.stopTxt)
    && !/B3 tiedote/.test(b3.stopTxt) && b3.firstOpen && b3.lineBadge.includes(b3.route) && /Häiriöt tällä linjalla B3 linjan poikkeusreitti/.test(b3.lineTxt))
    ? ok(`palvelutiski B3: häiriö pysäkkikortin yläosassa, linjan ${b3.route} häiriö linjamerkkinä ja linjakortin yläosassa (tiedote ei)`)
    : fail("palvelutiski B3: häiriöt korteissa: " + JSON.stringify(b3));

  // B4: kotipysäkki id:llä. Hämeenlinnan linja-autoaseman paikallispysäkit A-E ovat kahden emoaseman alla, ja nimihaku
  // osuisi kaukoliikenteen tulolaituriin (Hameenlinna:300360). Kaikilla kaupungeilla on id tai nimi.
  const b4 = await page.evaluate(async () => {
    const t = await deskHomeById(CONFIGS.hameenlinna.deskHomeStop).catch(e => ({ virhe: e.message }));
    const puuttuu = Object.entries(CONFIGS).filter(([k, c]) => k !== "raasepori" && !(c.deskHomeStop && (c.deskHomeStop.id || c.deskHomeStop.ids) && c.deskHomeStop.name)).map(([k]) => k);
    return { name: t && t.name, terminal: t && t.terminal, n: t && (t.group || []).length, tulo: !!(t && (t.group || []).includes("Hameenlinna:300360")), puuttuu };
  });
  (b4.name === "Linja-autoasema" && b4.terminal && b4.n === 5 && !b4.tulo && !b4.puuttuu.length)
    ? ok("palvelutiski B4: Hämeenlinnan tiski avautuu linja-autoaseman viiteen paikallispysäkkiin (kaksi emoasemaa), ei tulolaituriin; kaikilla kaupungeilla kotipysäkki id:llä")
    : fail("palvelutiski B4: kotipysäkki: " + JSON.stringify(b4));

  // B6: Joensuun vyöhykehinnat tiskille (deskOnly: ei #/liput-sivua) ja reittivastauksen hintarivi vyöhykkeittäin.
  const b6j = await page.evaluate(() => {
    const f = CONFIGS.joensuu && CONFIGS.joensuu.fares;
    const box = document.createElement("div"); box.innerHTML = f && typeof deskFareLineHtml === "function" ? deskFareLineHtml(f) : "";
    return { deskOnly: !!(f && f.deskOnly), zones: f ? (f.zones || []).length : 0, url: f && f.url, line: box.textContent.replace(/\s+/g, " ").trim() };
  });
  (b6j.deskOnly && b6j.zones === 4 && /jojo\.joensuu\.fi/.test(b6j.url || "") && /1 vyöhyke 3,00 € \/ 1,50 €/.test(b6j.line) && /4 vyöhykettä 9,00 € \/ 4,50 €/.test(b6j.line))
    ? ok(`palvelutiski B6: Joensuun kertalippuhinnat vyöhykkeittäin tiskille ("${b6j.line.slice(0, 70)}…")`)
    : fail("palvelutiski B6: Joensuun hinnat: " + JSON.stringify(b6j));

  // B1, B2, B3 (reitti), B6, B7 (pikakohde, viimeisimmät, myöhemmät/aiemmat) ja B8 synteettisellä reittivastauksella.
  // Pikakohde "Keskussairaala" hakee reitin tiskin omalta pysäkiltä (Trio). Vastaus: vaihdollinen yhteys, jonka
  // toisella linjalla on häiriö.
  const b1Setup = await page.evaluate(() => {
    window.__b = { vars: [], copied: null };
    window.__bOrig = { gql, loadAllAlerts, write: navigator.clipboard && navigator.clipboard.writeText };
    const at = m => new Date(Date.now() + m * 60000).toISOString();
    const leg = (mode, a, b, from, to, line, rid) => ({ mode, duration: (b - a) * 60, distance: 1000, realtimeState: null, interlineWithPreviousLeg: false,
      start: { scheduledTime: at(a) }, end: { scheduledTime: at(b) },
      from: { name: from, lat: 60.983 + a / 1000, lon: 25.66, stop: mode === "WALK" ? null : { code: "1", platformCode: "D", name: from } },
      to: { name: to, lat: 60.99 + b / 1000, lon: 25.6, stop: mode === "WALK" ? null : { code: "2", name: to } },
      route: line ? { gtfsId: rid, shortName: line } : null, trip: null, intermediateStops: [], intermediatePlaces: [], legGeometry: null,
      alerts: rid === "SMOKEB:2" ? [{ alertHeaderText: "B3 reitin häiriö", alertSeverityLevel: "WARNING" }] : [] });
    const node = off => ({ start: at(off), end: at(off + 30), numberOfTransfers: 1, walkDistance: 300, legs: [
      leg("WALK", off, off + 2, "Trio", "Trio D"), leg("BUS", off + 3, off + 12, "Trio D", "Matkakeskus B", "SB1", "SMOKEB:1"),
      leg("BUS", off + 15, off + 27, "Matkakeskus B", "Keskussairaala E", "SB2", "SMOKEB:2"), leg("WALK", off + 27, off + 30, "Keskussairaala E", "Keskussairaala")] });
    gql = async (q, v, o) => {
      if (q !== PLAN_QUERY) return window.__bOrig.gql(q, v, o);
      window.__b.vars.push(JSON.parse(JSON.stringify(v)));
      const base = v.after ? 60 : v.before ? -60 : 5;
      return { planConnection: { pageInfo: { startCursor: "S" + base, endCursor: "E" + base, hasNextPage: true, hasPreviousPage: true },
        edges: [node(base), node(base + 20)].map(n => ({ node: n })) } };
    };
    loadAllAlerts = async () => [{ alertHeaderText: "B3 reitin häiriö", alertDescriptionText: "Linja SB2 kiertää.", alertEffect: "DETOUR",
      alertSeverityLevel: "WARNING", entities: [{ __typename: "Route", gtfsId: "SMOKEB:2" }] }];
    if (navigator.clipboard) navigator.clipboard.writeText = async txt => { window.__b.copied = txt; };
    const q = (CONFIG.deskQuick || []).findIndex(x => x.k === "hospital");
    return { q, label: q >= 0 ? (CONFIG.deskQuick[q].fi || "") : "", homeLat: null };
  });
  const b1 = [];
  try {
    for (const [w, h, dsf] of [[1920, 1080, 1], [1536, 864, 1.25], [1366, 768, 1]]) {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: dsf });
      await sleep(300);
      await page.evaluate(() => { scrollTo(0, 0); document.getElementById("deskResults").innerHTML = ""; });
      await page.evaluate(q => document.querySelector(`#deskQuick button[data-q="${q}"]`)?.click(), b1Setup.q);
      await page.waitForSelector("#deskResults .desk-tell .desk-tell-tools", { timeout: 20000 }).catch(() => {});
      await sleep(400);
      b1.push(await page.evaluate((w, h) => {
        const r = document.querySelector("#deskResults .desk-tell")?.getBoundingClientRect();
        return { vp: w + "x" + h, top: r ? Math.round(r.top) : null, bottom: r ? Math.round(r.bottom) : null, vh: innerHeight, sy: Math.round(scrollY),
          formHidden: document.getElementById("deskRouteForm").hidden, sum: (document.getElementById("deskRouteSumTxt")?.textContent || "").trim() };
      }, w, h));
    }
    const b1ok = b1.every(x => x.top != null && x.top >= 0 && x.bottom <= x.vh && x.formHidden);
    const map = await page.evaluate(() => ({ paths: document.querySelectorAll("#deskMap path.leaflet-interactive").length,
      status: document.getElementById("deskMapStatus")?.textContent || "" }));
    const v0 = await page.evaluate(() => window.__b.vars[0] || null);
    (b1ok && b1.every(x => /^Trio → .+/.test(x.sum)) && map.paths >= 2 && /SB1, SB2/.test(map.status))
      ? ok(`palvelutiski B1: vastaus näkyy kokonaan heti haun jälkeen, myös häiriörivin kanssa (${b1.map(x => `${x.vp} ${x.top}-${x.bottom}/${x.vh}${x.sy ? ", tiski vieritti " + x.sy + " px" : ""}`).join("; ")}), lomake tiivistyy ja reitti piirtyy karttaan`)
      : fail("palvelutiski B1: vastauksen paikka tai kartta: " + JSON.stringify({ b1, map, v0: !!v0 }));
    await page.setViewport({ width: 800, height: 600 });
    await sleep(300);
    // B3 (reitti) ja B6 (hinta reittivastauksessa).
    const r3 = await page.evaluate(() => ({
      alerts: (document.querySelector("#deskResults .desk-card-alerts")?.innerText || "").replace(/\s+/g, " ").trim(),
      optAlerts: document.querySelectorAll("#deskResults .desk-opt .desk-opt-alert").length,
      fare: (document.querySelector("#deskResults .desk-tell .desk-tell-fare")?.textContent || "").replace(/\s+/g, " ").trim(),
      adult: CONFIG.fares?.single?.cardApp?.adult, child: CONFIG.fares?.single?.cardApp?.child }));
    (/Häiriöt tällä reitillä B3 reitin häiriö/.test(r3.alerts) && r3.optAlerts === 2
      && r3.fare.includes(`aikuinen ${r3.adult} €`) && r3.fare.includes(`lapsi ${r3.child} €`))
      ? ok(`palvelutiski B3/B6: reitin häiriö vastauksen yläosassa ja vaihtoehdoissa, hinta vastauksessa ("${r3.fare}")`)
      : fail("palvelutiski B3/B6: reitin häiriö tai hinta: " + JSON.stringify(r3));
    // B2: Kopioi vastaus -> lyhyt teksti (enintään noin 160 merkkiä) ja linkki samaan reittiin, näkyvä kuittaus.
    await page.evaluate(() => document.querySelector("#deskResults .desk-copy")?.click());
    await page.waitForFunction(() => !!window.__b.copied, { timeout: 5000 }).catch(() => {});
    const b2 = await page.evaluate(() => {
      const [txt, link] = String(window.__b.copied || "").split("\n");
      return { txt, link, st: document.querySelector("#deskResults .desk-copy-st")?.textContent || "",
        day: new Date().toLocaleDateString("fi-FI", { weekday: "short", day: "numeric", month: "numeric" }) };
    });
    (b2.txt && b2.txt.length <= 160 && /^\S+ \d{1,2}\.\d{1,2}\. Trio → Keskussairaala: linja SB1 pysäkiltä Trio D klo \d\d:\d\d, vaihto pysäkillä Matkakeskus B linjaan SB2 klo \d\d:\d\d, perillä \d\d:\d\d\./.test(b2.txt)
      && /#\/reitti\/[^/]+\/[^/]+/.test(b2.link || "") && b2.st === "Kopioitu!")
      ? ok(`palvelutiski B2: kopioitu vastaus ${b2.txt.length} merkkiä ja linkki samaan reittiin ("${b2.txt}")`)
      : fail("palvelutiski B2: kopioitu vastaus: " + JSON.stringify(b2));
    // B8: Näytä asiakkaalle -> iso vastaus (vähintään 40 px) ja QR-koodi; Esc sulkee ja fokus palaa nappiin.
    await page.evaluate(() => document.querySelector("#deskResults .desk-show-btn")?.focus());
    await page.evaluate(() => document.querySelector("#deskResults .desk-show-btn")?.click());
    await page.waitForSelector("#deskShow #deskShowQr canvas", { timeout: 10000 }).catch(() => {});
    const b8 = await page.evaluate(() => ({ auki: !document.getElementById("deskShow").hidden,
      px: parseFloat(getComputedStyle(document.querySelector("#deskShow .desk-show-body") || document.body).fontSize),
      qr: !!document.querySelector("#deskShow #deskShowQr canvas"), otsikko: document.getElementById("deskShowH")?.textContent || "" }));
    await page.keyboard.press("Escape");
    const b8b = await page.evaluate(() => ({ kiinni: document.getElementById("deskShow").hidden,
      fokus: !!document.activeElement && document.activeElement.classList.contains("desk-show-btn") }));
    (b8.auki && b8.px >= 40 && b8.qr && b8.otsikko === "Trio → Keskussairaala" && b8b.kiinni && b8b.fokus)
      ? ok(`palvelutiski B8: asiakkaalle näytettävä tila (teksti ${b8.px} px, QR) ja Esc palaa tiskille`)
      : fail("palvelutiski B8: asiakasnäkymä: " + JSON.stringify({ ...b8, ...b8b }));
    // B7: viimeisimmät haut ja myöhemmät/aiemmat vuorot samalla haulla (kursori).
    await page.evaluate(() => document.getElementById("deskLaterBtn")?.click());
    await page.waitForFunction(() => window.__b.vars.some(v => v.after), { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => document.getElementById("deskEarlierBtn")?.click());
    await page.waitForFunction(() => window.__b.vars.some(v => v.before), { timeout: 10000 }).catch(() => {});
    const b7 = await page.evaluate(() => {
      const nx = window.__b.vars.find(v => v.after), pv = window.__b.vars.find(v => v.before), first = window.__b.vars[0];
      return { after: nx && nx.after, nFirst: nx && nx.first, before: pv && pv.before, nLast: pv && pv.last,
        sameOrigin: !!(nx && first && JSON.stringify(nx.origin) === JSON.stringify(first.origin)),
        recent: [...document.querySelectorAll("#deskQuick button[data-r]")].map(b => b.textContent.trim()) };
    });
    (b7.after === "E5" && b7.nFirst === 5 && b7.before && b7.nLast === 5 && b7.sameOrigin && b7.recent.some(r => r === "Trio → Keskussairaala"))
      ? ok(`palvelutiski B7: pikakohde, myöhemmät ja aiemmat vuorot samalla haulla sekä viimeisimmät haut (${b7.recent.length})`)
      : fail("palvelutiski B7: pikakohde, sivutus tai viimeisimmät: " + JSON.stringify(b7));
  } finally {
    await page.evaluate(() => {
      gql = window.__bOrig.gql; loadAllAlerts = window.__bOrig.loadAllAlerts;
      if (navigator.clipboard && window.__bOrig.write) navigator.clipboard.writeText = window.__bOrig.write;
      try { sessionStorage.removeItem("deskRecent:" + cityKey); } catch (e) {}
    });
    await page.setViewport({ width: 800, height: 600 });
    await page.evaluate(() => { location.hash = "#/"; });
    await sleep(400);
    await page.evaluate(() => { location.hash = "#/palvelutiski"; });
    await page.waitForSelector("#deskFrom", { timeout: 15000 }).catch(() => {});
  }

  // --- Erä V3 (4.10.2026): taskuaikataulu A->B (D3), vastaus asiakkaan kielellä (D4), terminaalin Minne?-suodatin (B10)
  // ja pysäkkikortin asiakasnäkymä. Synteettinen data: gql kääritään ja palautetaan finally-lohkossa, joten tulos ei
  // riipu päivän aikataulusta eikä kellonajasta (ajopäivät lasketaan tästä päivästä, kellonajat sekunteina). Tila
  // palautetaan: Iso teksti, muutosvahdin välimuisti, kääntäjä, muistit ja kielivalinta (tiski piirretään uudelleen).
  const v3Term = () => page.waitForFunction(() => /kaikki pysäkit/.test(document.querySelector("#deskDeps .stophead")?.textContent || "")
    && !!document.querySelector("#deskDeps .desk-deps-upd"), { timeout: 30000 }).then(() => true).catch(() => false);
  await v3Term();
  const v3Large = await page.evaluate(() => localStorage.getItem("printLarge"));
  const v3Setup = await page.evaluate(() => {
    const day0 = new Date(); day0.setHours(12, 0, 0, 0);
    const ad = dows => { const out = []; for (let i = 0; i < 60; i++) { const d = new Date(day0); d.setDate(d.getDate() + i);
      if (dows.includes((d.getDay() + 6) % 7)) out.push(isoOf(d).replace(/-/g, "")); } return out; };
    const H = (h, m) => h * 3600 + m * 60;
    const st = (id, dep, arr, pick, drop) => ({ scheduledArrival: arr == null ? dep : arr, scheduledDeparture: dep,
      pickupType: pick || "SCHEDULED", dropoffType: drop || "SCHEDULED", stop: { gtfsId: id } });
    const trip = (sid, dows, sts) => ({ serviceId: sid, activeDates: ad(dows), stoptimes: sts });
    const ARKI = [0, 1, 2, 3, 4];
    // P1 (S1): A -> M -> B -> Z. B:n saapuminen 07:20 ja lähtö 07:21 (tulosteeseen saapuminen). Perjantain yövuoro saa
    // kirjaimen. 08:00 ei jätä B:llä ja 09:00 ei ota A:lla kyytiin: kumpikaan ei ole suora lähtö A -> B.
    // P2 (S2) kulkee B -> A eikä kuulu tulosteeseen. P3 (S3) ajaa vain sunnuntaisin.
    const TRIPS = {
      P1: [trip("SMK arki", ARKI, [st("SMK:A", H(7, 0)), st("SMK:M", H(7, 10)), st("SMK:B", H(7, 21), H(7, 20)), st("SMK:Z", H(7, 30))]),
        trip("SMK pe", [4], [st("SMK:A", H(23, 30)), st("SMK:M", H(23, 40)), st("SMK:B", H(23, 50)), st("SMK:Z", H(23, 55))]),
        trip("SMK la", [5], [st("SMK:A", H(10, 0)), st("SMK:M", H(10, 8)), st("SMK:B", H(10, 18)), st("SMK:Z", H(10, 25))]),
        trip("SMK arki", ARKI, [st("SMK:A", H(8, 0)), st("SMK:M", H(8, 10)), st("SMK:B", H(8, 20), null, "SCHEDULED", "NONE"), st("SMK:Z", H(8, 30))]),
        trip("SMK arki", ARKI, [st("SMK:A", H(9, 0), null, "NONE"), st("SMK:M", H(9, 10)), st("SMK:B", H(9, 20)), st("SMK:Z", H(9, 30))])],
      P2: [trip("SMK arki", ARKI, [st("SMK:B", H(6, 0)), st("SMK:A", H(6, 30))])],
      P3: [trip("SMK su", [6], [st("SMK:A", H(12, 0)), st("SMK:B", H(12, 30))])],
    };
    const PATS = [
      { code: "P1", route: { gtfsId: "SMK:R1", shortName: "S1" }, stops: ["SMK:A", "SMK:M", "SMK:B", "SMK:Z"].map(gtfsId => ({ gtfsId })) },
      { code: "P2", route: { gtfsId: "SMK:R2", shortName: "S2" }, stops: ["SMK:B", "SMK:A"].map(gtfsId => ({ gtfsId })) },
      { code: "P3", route: { gtfsId: "SMK:R3", shortName: "S3" }, stops: ["SMK:A", "SMK:B"].map(gtfsId => ({ gtfsId })) }];
    const at = m => new Date(Date.now() + m * 60000).toISOString();
    const leg = (mode, a, b, from, to, line, fromId, toId) => ({ mode, duration: (b - a) * 60, distance: 800, realtimeState: null,
      interlineWithPreviousLeg: false, start: { scheduledTime: at(a) }, end: { scheduledTime: at(b) },
      from: { name: from, lat: 60.983, lon: 25.656, stop: mode === "WALK" ? null : { gtfsId: fromId, code: "1", platformCode: "", name: from } },
      to: { name: to, lat: 60.99, lon: 25.6, stop: mode === "WALK" ? null : { gtfsId: toId, code: "2", name: to } },
      route: line ? { gtfsId: "SMK:R" + line, shortName: line } : null, trip: null, intermediateStops: [], intermediatePlaces: [], legGeometry: null, alerts: [] });
    const direct = { start: at(5), end: at(30), numberOfTransfers: 0, walkDistance: 200, legs: [leg("WALK", 5, 7, "Trio", "Smoke A"),
      leg("BUS", 8, 28, "Smoke A", "Smoke B", "S1", "SMK:A", "SMK:B"), leg("WALK", 28, 30, "Smoke B", "Kohde")] };
    const via = { start: at(10), end: at(50), numberOfTransfers: 1, walkDistance: 300, legs: [leg("BUS", 10, 20, "Smoke A", "Smoke M", "S1", "SMK:A", "SMK:M"),
      leg("BUS", 25, 48, "Smoke M", "Smoke B", "S9", "SMK:M", "SMK:B")] };
    const muutos = new Date(day0); muutos.setDate(muutos.getDate() + 60);
    window.__v3 = { gql, print: window.print, write: navigator.clipboard && navigator.clipboard.writeText, T: window.Translator,
      hadT: "Translator" in window, printed: 0, copied: null, failTrips: false, muutos: isoOf(muutos) };
    gql = async (q, v, o) => {
      if (q === PLAN_QUERY) return { planConnection: { pageInfo: { startCursor: null, endCursor: null, hasNextPage: false, hasPreviousPage: false },
        edges: [{ node: direct }, { node: via }] } };
      if (String(q).startsWith("query PocketPatterns")) return { stop: { gtfsId: v.id, name: "Smoke A", patterns: PATS } };
      if (String(q).startsWith("query PocketTrips")) {
        if (window.__v3.failTrips) throw new Error("synteettinen verkkovirhe");
        const out = {};
        Object.keys(v).forEach(k => { out["p" + k.slice(1)] = { trips: TRIPS[v[k]] || [] }; });
        return out;
      }
      return window.__v3.gql(q, v, o);
    };
    window.print = () => { window.__v3.printed++; };
    if (navigator.clipboard) navigator.clipboard.writeText = async txt => { window.__v3.copied = txt; };
    changeWatchPromise = Promise.resolve({ ajettu: todayISO() + "T09:00:00.000Z", pysakit: [{ id: "SMK:A", tulossa: true, voimaan: isoOf(muutos), voimaanTarkka: true }] });
    pocketPatMemo.clear(); pocketTripMemo.clear();
    setPrintLarge(false);
    const q = (CONFIG.deskQuick || []).findIndex(x => x.k === "hospital");
    document.getElementById("deskResults").innerHTML = "";
    document.querySelector(`#deskQuick button[data-q="${q}"]`)?.click();
    return { q };
  });
  try {
    await page.waitForSelector("#deskResults .deskOptPocket", { timeout: 20000 }).catch(() => {});
    // D3: taskuaikataulu. Rivit Ma-Pe, La ja Su erikseen, saapumisaika (ei B:n lähtöaika), perjantain kirjain ja selite,
    // B->A-reitti ja ilman nousua tai jättöä olevat vuorot pois. Kansi: linjat, matka-aika, voimassaolo, ikkuna ja QR.
    const pocket = async large => page.evaluate(async lg => {
      setPrintLarge(lg);
      const po = document.getElementById("deskPrintOut");
      po.innerHTML = ""; document.getElementById("pageOrient")?.remove();
      const n0 = window.__v3.printed;
      document.querySelector("#deskResults .desk-opt .deskOptPocket")?.click();
      for (let i = 0; i < 300 && window.__v3.printed === n0; i++) await new Promise(r => setTimeout(r, 100));
      for (let i = 0; i < 50 && !document.getElementById("pageOrient")?.textContent; i++) await new Promise(r => setTimeout(r, 100));
      const panels = [...po.querySelectorAll(".pk-panel")];
      const days = {};
      for (const p of panels) {
        const h = (p.querySelector(".pk-day-h")?.textContent || "").replace(/, jatkuu$/, "");
        if (!h) continue;
        days[h] = (days[h] || []).concat([...p.querySelectorAll(".pk-col li")].map(li => li.textContent.replace(/\s+/g, " ").trim()));
      }
      const valid = po.querySelector(".pk-valid");
      return { printed: window.__v3.printed > n0, orient: document.getElementById("pageOrient")?.textContent || "", days,
        large: !!po.querySelector(".pocket.pk-large"), sheets: po.querySelectorAll(".pk-sheet").length,
        legend: [...po.querySelectorAll(".pk-legend")].map(l => l.textContent.trim()),
        lines: po.querySelector(".pk-lines")?.textContent.replace(/\s+/g, " ").trim() || "",
        travel: po.querySelector(".pk-travel")?.textContent || "", window: po.querySelector(".pk-window")?.textContent || "",
        valid: valid?.dataset.valid || "", validTxt: valid?.textContent || "", odotus: fmtDateLong(window.__v3.muutos),
        qr: !!po.querySelector(".pk-qr img"), title: po.querySelector(".pk-title")?.textContent || "",
        note: [...document.querySelectorAll("#deskResults .desk-opt")].map(o => !!o.querySelector(".deskOptPocket") + "/" + !!o.querySelector(".desk-pocket-note")) };
    }, large);
    const pkMeasure = async () => {
      await page.emulateMediaType("print");
      const m = await page.evaluate(() => {
        const out = { n: 0, min: Infinity, pienin: "", yli: [], tiski: true, tuloste: false };
        const vis = el => { for (let e = el; e && e.id !== "app"; e = e.parentElement) if (getComputedStyle(e).display === "none") return false; return true; };
        out.tiski = vis(document.querySelector(".desk"));
        out.tuloste = vis(document.querySelector("#deskPrintOut .pocket"));
        for (const p of document.querySelectorAll("#deskPrintOut .pk-panel"))
          if (p.scrollHeight > p.clientHeight + 1) out.yli.push(p.className + " " + p.scrollHeight + ">" + p.clientHeight);
        for (const el of document.querySelectorAll("#deskPrintOut .pocket *")) {
          if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || !el.getClientRects().length) continue;
          const px = parseFloat(cs.fontSize);
          out.n++;
          if (px < out.min) { out.min = px; out.pienin = el.className + ": " + el.textContent.trim().slice(0, 30); }
        }
        return out;
      });
      await page.emulateMediaType(null);
      return m;
    };
    const pn = await pocket(false);
    const mn = await pkMeasure();
    const row = (list, re) => (list || []).find(r => re.test(r));
    const wk = pn.days["Ma–Pe"] || [], la = pn.days["La"] || [], su = pn.days["Su"] || [];
    const all = [...wk, ...la, ...su];
    (pn.printed && /size: A4 portrait; margin: 0/.test(pn.orient) && wk.length === 2 && row(wk, /^07:00→07:20 S1$/) && row(wk, /^23:30a→23:50 S1$/)
      && la.length === 1 && row(la, /^10:00→10:18 S1$/) && su.length === 1 && row(su, /^12:00→12:30 S3$/)
      && !all.some(r => /^0[689]:00|^06:30/.test(r)) && pn.legend.some(l => l === "a = vain Pe"))
      ? ok(`taskuaikataulu (D3): suorat lähdöt A -> B saapumisaikoineen Ma–Pe ${wk.length}, La ${la.length}, Su ${su.length}, kirjain ja selite ("${pn.legend[0]}"), A4 neljäksi paneeliksi`)
      : fail("taskuaikataulu (D3): lähdöt tai päivätyypit väärin: " + JSON.stringify(pn));
    (pn.title === "Smoke A → Smoke B" && /^Linjat S1 S3$/.test(pn.lines) && pn.travel === "Matka-aika 18–30 min" && pn.valid === "until"
      && pn.validTxt.includes("Smoke A") && pn.validTxt.includes(pn.odotus) && /\d{4} aikataulusta\.$/.test(pn.window) && pn.qr
      && pn.note[0] === "true/false" && pn.note[1] === "false/true")
      ? ok(`taskuaikataulu (D3): kansi (linjat, matka-aika, voimassaolo "${pn.validTxt}", ikkuna, QR) ja vaihdolliselle ohje reittitulosteeseen`)
      : fail("taskuaikataulu (D3): kansi tai vaihdollisen ohje: " + JSON.stringify(pn));
    (!mn.tiski && mn.tuloste && !mn.yli.length && mn.n >= 10)
      ? ok(`taskuaikataulu (D3): paperille vain tuloste, mikään paneeli ei vuoda yli (${mn.n} tekstiä, pienin ${(mn.min * 0.75).toFixed(1)} pt)`)
      : fail("taskuaikataulu (D3): printtihygienia tai ylivuoto: " + JSON.stringify(mn));
    const pl = await pocket(true);
    const ml = await pkMeasure();
    const allL = Object.values(pl.days).flat();
    (pl.printed && pl.large && allL.length === all.length && !ml.yli.length && ml.n >= 10 && ml.min >= 18.6)
      ? ok(`taskuaikataulu (D3): Iso teksti, pienin teksti ${(ml.min * 0.75).toFixed(1)} pt, ${pl.sheets} arkki(a), ei ylivuotoa`)
      : fail("taskuaikataulu (D3): iso teksti alle 14 pt, ylivuoto tai rivejä puuttuu: " + JSON.stringify({ ml, sheets: pl.sheets, n: allL.length }));
    // Verkkovirhe: ei tulostetta eikä "ei lähtöjä" -paperia, vaan virheilmoitus.
    const pe = await page.evaluate(async () => {
      pocketTripMemo.clear(); window.__v3.failTrips = true;
      const po = document.getElementById("deskPrintOut"); po.innerHTML = "";
      const n0 = window.__v3.printed;
      const b = document.querySelector("#deskResults .desk-opt .deskOptPocket");
      b?.click();
      const stEl = b?.parentElement.querySelector('[role="status"]');
      for (let i = 0; i < 100 && !/Yritä uudelleen/.test(stEl?.textContent || ""); i++) await new Promise(r => setTimeout(r, 100));
      window.__v3.failTrips = false;
      return { st: stEl?.textContent || "", printed: window.__v3.printed > n0, pocket: !!po.querySelector(".pocket") };
    });
    (pe.st === "Taskuaikataulua ei saatu koottua. Yritä uudelleen." && !pe.printed && !pe.pocket)
      ? ok("taskuaikataulu (D3): verkkovirhe ei tulosta vajaata paperia vaan kertoo virheen")
      : fail("taskuaikataulu (D3): virhetila: " + JSON.stringify(pe));
    // Sama taskuaikataulu ja reittituloste Tulosteet-välilehden Yhteys-ryhmästä (5.10.2026). Välilehdet vaihdetaan
    // JS-klikkauksella, koska tulostuksen valmisteluruutu jää mockatun printin jälkeen sivun päälle.
    const yp = await page.evaluate(async () => {
      document.querySelector('.dtab[data-dtab="tulosteet"]').click();
      pocketTripMemo.clear();
      const po = document.getElementById("deskPrintOut");
      const run = async (id, sel) => {
        po.innerHTML = "";
        const n0 = window.__v3.printed;
        document.getElementById(id)?.click();
        for (let i = 0; i < 300 && window.__v3.printed === n0; i++) await new Promise(r => setTimeout(r, 100));
        return { printed: window.__v3.printed > n0, out: !!po.querySelector(sel), title: po.querySelector(".pk-title")?.textContent || "" };
      };
      const note = document.querySelector("#deskPrintsTrip .dp-note")?.textContent || "";
      const r = { pocket: await run("deskTripPocket", ".pk-sheet"), itin: await run("deskTripItin", ".itin-print"), note };
      document.querySelector('.dtab[data-dtab="neuvonta"]').click();
      return r;
    });
    (yp.pocket.printed && yp.pocket.out && yp.pocket.title === "Smoke A → Smoke B" && yp.itin.printed && yp.itin.out
      && yp.note.includes("Smoke A") && yp.note.includes("Smoke B"))
      ? ok("palvelutiski: Tulosteiden Yhteys-ryhmä tulostaa saman taskuaikataulun ja reittitulosteen kuin Neuvonta")
      : fail("palvelutiski: Yhteys-ryhmän tulosteet: " + JSON.stringify(yp));

    // D4: Kerro asiakkaalle asiakkaan kielellä. SV valmiista käännöksistä: vastaus, kopio ja asiakasnäkymä ruotsiksi,
    // pysäkin ja linjan nimet ennallaan.
    const ans = () => page.evaluate(() => { const b = document.querySelector("#deskResults .desk-tell-body");
      return { lang: b?.lang || "", dir: b?.dir || "", txt: (b?.textContent || "").trim(), note: document.querySelector("#deskResults .desk-ans-mt-note")?.textContent || "",
        pressed: [...document.querySelectorAll("#deskResults .desk-ans-lang button[aria-pressed=true]")].map(x => x.dataset.alang),
        sel: !!document.querySelector("#deskResults .desk-ans-mt"), nomt: document.querySelector("#deskResults .desk-ans-nomt")?.textContent || "" }; });
    const fi0 = await ans();
    await page.evaluate(() => document.querySelector('#deskResults .desk-ans-lang button[data-alang="sv"]')?.click());
    const sv = await ans();
    await page.evaluate(() => { window.__v3.copied = null; document.querySelector("#deskResults .desk-copy")?.click(); });
    await page.waitForFunction(() => !!window.__v3.copied, { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => document.querySelector("#deskResults .desk-show-btn")?.click());
    await page.waitForSelector("#deskShow #deskShowQr canvas", { timeout: 10000 }).catch(() => {});
    const svShow = await page.evaluate(() => ({ k: document.querySelector("#deskShow .desk-show-k")?.textContent || "",
      body: document.querySelector("#deskShow .desk-show-body")?.textContent.trim() || "", lang: document.querySelector("#deskShow .desk-show-body")?.lang || "",
      cap: document.querySelector("#deskShow figcaption")?.textContent || "", copied: window.__v3.copied || "" }));
    await page.keyboard.press("Escape");
    (fi0.pressed.join() === "fi" && /^Linja S1 pysäkiltä Smoke A klo \d\d:\d\d( \(seuraava \d\d:\d\d\))?\. Jää pois pysäkillä Smoke B/.test(fi0.txt)
      && sv.lang === "sv" && sv.pressed.join() === "sv" && /^Linje S1 från hållplats Smoke A kl\. \d\d:\d\d( \(\S+ \d\d:\d\d\))?\. Stig av vid hållplats Smoke B/.test(sv.txt)
      && /^\S+ \d{1,2}\.\d{1,2}\.? .*linje S1 från hållplats Smoke A kl\. \d\d:\d\d, framme \d\d:\d\d\.\n.*#\/reitti\//.test(svShow.copied)
      && /^Rutt · /.test(svShow.k) && svShow.body === sv.txt && svShow.lang === "sv" && svShow.cap === "Skanna koden med telefonen så öppnas rutten där.")
      ? ok(`vastaus asiakkaan kielellä (D4): SV vastaus, kopio ja asiakasnäkymä ruotsiksi, nimet ennallaan ("${sv.txt.slice(0, 60)}…")`)
      : fail("vastaus asiakkaan kielellä (D4): SV: " + JSON.stringify({ fi0, sv, svShow }));
    // D4: ilman selaimen kääntäjää muut kielet piiloon ja selitys; kääntäjän kanssa (synteettinen, laitteella) kielilista,
    // konekäännös merkittynä, nimet ja kellonajat ennallaan ja sama teksti kopioon ja asiakasnäkymään. Jos kääntäjä
    // hukkaa nimen, käännöstä ei näytetä.
    const rerun = async () => {
      await page.evaluate(q => { mtListP = null; document.getElementById("deskResults").innerHTML = "";
        document.querySelector(`#deskQuick button[data-q="${q}"]`)?.click(); }, v3Setup.q);
      await page.waitForSelector("#deskResults .desk-tell .desk-ans-lang", { timeout: 20000 }).catch(() => {});
      await sleep(300);
    };
    await page.evaluate(() => { window.Translator = undefined; });
    await rerun();
    const noT = await ans();
    await page.evaluate(() => {
      window.__v3.mtCalls = 0;
      window.Translator = { availability: async o => (o.targetLanguage === "uk" ? "available" : "unavailable"),
        create: async o => ({ translate: async s => { window.__v3.mtCalls++; return window.__v3.mtBreak ? s.replace(/73\d\d/g, "X") : "[" + o.targetLanguage + "] " + s; } }) };
      mtTranslators.clear(); mtCache.clear();
    });
    await rerun();
    const opts = await page.evaluate(() => [...document.querySelectorAll("#deskResults .desk-ans-mt option")].map(o => o.value));
    await page.select("#deskResults .desk-ans-mt", "uk").catch(() => {});
    await page.waitForFunction(() => /Konekäännös|ei onnistunut/.test(document.querySelector("#deskResults .desk-ans-mt-note")?.textContent || ""), { timeout: 10000 }).catch(() => {});
    const uk = await ans();
    await page.evaluate(() => { window.__v3.copied = null; document.querySelector("#deskResults .desk-copy")?.click(); });
    await page.waitForFunction(() => !!window.__v3.copied, { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => document.querySelector("#deskResults .desk-show-btn")?.click());
    await sleep(500);
    const ukShow = await page.evaluate(() => ({ body: document.querySelector("#deskShow .desk-show-body")?.textContent.trim() || "",
      lang: document.querySelector("#deskShow .desk-show-body")?.lang || "", mt: document.querySelector("#deskShow .desk-show-mt")?.textContent || "",
      k: document.querySelector("#deskShow .desk-show-k")?.textContent || "", copied: window.__v3.copied || "" }));
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.__v3.mtBreak = true; mtCache.clear(); document.querySelector('#deskResults .desk-ans-lang button[data-alang="fi"]')?.click(); });
    await page.select("#deskResults .desk-ans-mt", "uk").catch(() => {});
    await page.waitForFunction(() => /Konekäännös|ei onnistunut/.test(document.querySelector("#deskResults .desk-ans-mt-note")?.textContent || ""), { timeout: 10000 }).catch(() => {});
    const broken = await ans();
    (noT.nomt === "Muut kielet vain Chrome- ja Edge-selaimessa" && !noT.sel)
      ? ok("vastaus asiakkaan kielellä (D4): ilman selaimen kääntäjää muut kielet piilossa ja syy näkyy")
      : fail("vastaus asiakkaan kielellä (D4): kääntäjätön tila: " + JSON.stringify(noT));
    (opts.join() === ",uk" && uk.lang === "uk" && /^\[uk\] Line S1 from stop Smoke A at \d\d:\d\d( \(\S+ \d\d:\d\d\))?\. Get off at stop Smoke B/.test(uk.txt)
      && /^Konekäännös: ukraina/.test(uk.note) && /Alkuperäinen: Linja S1 pysäkiltä Smoke A/.test(uk.note)
      && /^\[uk\] .*bus line S1 from stop Smoke A at \d\d:\d\d.*\n.*#\/reitti\//.test(ukShow.copied)
      && ukShow.body === uk.txt && ukShow.lang === "uk" && /^\[uk\] Machine translation/.test(ukShow.mt) && /^\[uk\] Route · /.test(ukShow.k)
      && /^Linja S1 pysäkiltä Smoke A/.test(broken.txt) && broken.note === "Konekäännös ei onnistunut. Vastaus näkyy alkuperäisellä kielellä.")
      ? ok(`vastaus asiakkaan kielellä (D4): konekäännös merkittynä, nimet ja kellonajat ennallaan, sama teksti kopioon ja asiakasnäkymään, hukattu nimi = ei käännöstä ("${uk.txt.slice(0, 50)}…")`)
      : fail("vastaus asiakkaan kielellä (D4): konekäännös: " + JSON.stringify({ opts, uk, ukShow, broken }));
  } finally {
    await page.evaluate(lg => {
      gql = window.__v3.gql; window.print = window.__v3.print;
      if (navigator.clipboard && window.__v3.write) navigator.clipboard.writeText = window.__v3.write;
      if (window.__v3.hadT) window.Translator = window.__v3.T; else delete window.Translator;
      mtListP = null; mtTranslators.clear(); mtCache.clear(); pocketPatMemo.clear(); pocketTripMemo.clear();
      changeWatchPromise = null;
      setPrintLarge(lg === "1"); if (lg == null) localStorage.removeItem("printLarge"); printLargeMem = null;
      document.getElementById("deskPrintOut").innerHTML = "";
      setPageOrientation("portrait");
      try { sessionStorage.removeItem("deskRecent:" + cityKey); } catch (e) {}
    }, v3Large);
    // Tiski alusta: kielivalinta (ansLang) ja suodatin nollautuvat.
    await page.evaluate(() => { location.hash = "#/"; });
    await sleep(400);
    await page.evaluate(() => { location.hash = "#/palvelutiski"; });
  }

  // B10: terminaalin Minne?-suodatin. Synteettiset reitit ja lähdöt Trion oikeille pysäkeille: kohde löytyy reitin
  // välipysäkiltä (ei vain kilvestä), linja tarkalla tunnuksella, ja haku koskee vain osuvia pysäkkejä 4 tunnin ajalta.
  // Tuntematon haku ei näytä "ei lähtöjä" -tekstiä. Valinta nollautuu pysäkkiä vaihdettaessa.
  await v3Term();
  const b10Setup = await page.evaluate(() => {
    const plats = [...document.querySelectorAll("#deskDeps .desk-terminal-plats a.dep-plat")].map(a => decodeURIComponent(a.getAttribute("href").split("/pysakki/")[1]));
    if (plats.length < 2) return { ohita: true, plats };
    const [P0, P1] = plats;
    const now = new Date(), sd = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const base = Math.floor(now.getTime() / 1000 - sd);
    const dep = (plat, code, line, head, min) => { const s = base + min * 60; return { scheduledDeparture: s, realtimeDeparture: s, realtime: false, serviceDay: sd, headsign: head,
      trip: { pattern: { code }, wheelchairAccessible: null, occupancy: null, route: { gtfsId: "SMK:" + line, shortName: line },
        departureStoptime: { scheduledDeparture: s, stop: { gtfsId: plat } }, arrivalStoptime: { scheduledArrival: s + 1800, stop: { gtfsId: "X:end" } } } }; };
    const D = { [P0]: [], [P1]: [] };
    for (let i = 0; i < 10; i++) D[P0].push(dep(P0, "TP1", "V31", "Kaukokylä", 5 + i * 20));
    for (let i = 0; i < 24; i++) D[P0].push(dep(P0, "TPX", "V39", "Muu suunta", 1 + i * 5));
    for (let i = 0; i < 13; i++) D[P1].push(dep(P1, "TP2", "V32", "Muualla", 3 + i * 15));
    const PATS = { [P0]: [{ code: "TP1", headsign: "Kaukokylä", route: { gtfsId: "SMK:V31", shortName: "V31" }, stops: [{ gtfsId: P0, name: "Trio" }, { gtfsId: "X:1", name: "Välikylä" }, { gtfsId: "X:2", name: "Kaukokylä" }] },
      { code: "TPX", headsign: "Muu suunta", route: { gtfsId: "SMK:V39", shortName: "V39" }, stops: [{ gtfsId: P0, name: "Trio" }, { gtfsId: "X:5", name: "Muu" }] },
      { code: "TP0", headsign: "Trio", route: { gtfsId: "SMK:V30", shortName: "V30" }, stops: [{ gtfsId: "X:6", name: "Välikylä" }, { gtfsId: P0, name: "Trio" }] }],
      [P1]: [{ code: "TP2", headsign: "Muualla", route: { gtfsId: "SMK:V32", shortName: "V32" }, stops: [{ gtfsId: P1, name: "Trio" }, { gtfsId: "X:3", name: "Muualla" }] }] };
    window.__b10 = { gql, vars: [] };
    gql = async (q, v, o) => {
      if (q === DESK_TERM_PATTERNS_QUERY) return { stops: v.ids.map(id => ({ gtfsId: id, patterns: PATS[id] || [] })) };
      if (q === DESK_TERM_DEPS_QUERY) { window.__b10.vars.push(JSON.parse(JSON.stringify(v)));
        return { stops: v.ids.map(id => ({ gtfsId: id, name: "Trio", platformCode: "", lat: 60.98, lon: 25.65, routes: [], stoptimesWithoutPatterns: D[id] || [] })) }; }
      return window.__b10.gql(q, v, o);
    };
    return { P0, P1 };
  });
  const v3TermQ = async q => {
    await page.evaluate(() => { const i = document.getElementById("deskTermQ"); if (i) i.value = ""; });
    await page.type("#deskTermQ", q, { delay: 10 }).catch(() => {});
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !/Haetaan|Loading|Hämtar/.test(document.getElementById("deskTermInfo")?.textContent || ""), { timeout: 20000 }).catch(() => {});
    await sleep(200);
    return page.evaluate(() => {
      const rows = [...document.querySelectorAll("#deskDeps table.deps tbody tr")];
      const mins = rows.map(tr => { const m = /(\d\d):(\d\d)/.exec(tr.querySelector("td.dep-when")?.textContent || ""); return m ? +m[1] * 60 + +m[2] : null; }).filter(x => x != null);
      return { info: document.getElementById("deskTermInfo")?.textContent || "", n: rows.length,
        lines: [...new Set(rows.map(tr => tr.querySelector(".badge")?.textContent.trim()))],
        span: mins.length > 1 ? ((mins[mins.length - 1] - mins[0]) + 1440) % 1440 : 0,
        muted: [...document.querySelectorAll("#deskDeps p.muted:not(.desk-deps-upd)")].map(p => p.textContent), vars: window.__b10 && window.__b10.vars.slice(-1)[0] };
    });
  };
  try {
    if (b10Setup.ohita) fail("terminaalin Minne?-suodatin (B10): Trion pysäkit puuttuvat: " + JSON.stringify(b10Setup));
    else {
      const kohde = await v3TermQ("Välikylä");
      const linja = await v3TermQ("v32");
      const tyhja = await v3TermQ("qqqx");
      (kohde.n === 10 && kohde.lines.join() === "V31" && kohde.span >= 170 && /V31/.test(kohde.info) && !/V30|V39/.test(kohde.info)
        && kohde.vars && kohde.vars.ids.join() === b10Setup.P0 && kohde.vars.range === 14400 && kohde.vars.n === 100
        && linja.n === 12 && linja.lines.join() === "V32" && /^Linja V32: lähdöt seuraavan 4 tunnin ajalta\.$/.test(linja.info)
        && tyhja.n === 0 && /^Haulla "qqqx" ei löytynyt/.test(tyhja.info) && !tyhja.muted.some(m => /Ei tulevia/.test(m)))
        ? ok(`terminaalin Minne?-suodatin (B10): kohde reitin varrelta ${kohde.n} lähtöä ${kohde.span} min ajalta, linja V32 ${linja.n} lähtöä, tuntematon haku ilman "ei lähtöjä" -väitettä`)
        : fail("terminaalin Minne?-suodatin (B10): " + JSON.stringify({ kohde, linja, tyhja }));
    }
  } finally {
    await page.evaluate(() => { if (window.__b10) gql = window.__b10.gql; });
  }
  // Pysäkin vaihto nollaa suodattimen (oikea data: pysäkin kortti ja paluu terminaaliin).
  await page.evaluate(() => document.querySelector("#deskDeps .desk-terminal-plats a.dep-plat")?.click());
  await page.waitForSelector("#deskBackTerm", { timeout: 20000 }).catch(() => {});
  // Pysäkkikortin asiakasnäkymä: seuraavat lähdöt isolla ja QR pysäkin sivulle (synteettiset lähdöt), Esc palaa.
  const sShow = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const orig = gql;
    const now = new Date(), sd = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000, b = Math.floor(now.getTime() / 1000 - sd);
    const id = history.state && history.state.desk && history.state.desk.stop && history.state.desk.stop.gtfsId;
    const mk = (min, line, head) => ({ scheduledDeparture: b + min * 60, realtimeDeparture: b + min * 60, realtime: false, serviceDay: sd, headsign: head,
      trip: { route: { gtfsId: "SMK:" + line, shortName: line }, departureStoptime: null, arrivalStoptime: { scheduledArrival: b + min * 60 + 900, stop: { gtfsId: "X:end" } } } });
    gql = async (q, v, o) => q === DESK_DEPS_QUERY ? { stop: { gtfsId: v.id, name: "Trio Smoke", code: "999", lat: 60.98, lon: 25.65, routes: [],
      stoptimesWithoutPatterns: [mk(3, "W1", "Asema"), mk(9, "W2", "Sairaala"), mk(14, "W1", "Asema")] } } : orig(q, v, o);
    try {
      document.querySelector('.dcard-tab[data-dcard="stop"]').click();
      for (let i = 0; i < 100 && !/Trio Smoke/.test(document.querySelector("#deskDeps .stophead")?.textContent || ""); i++) await wait(100);
      const btn = document.getElementById("deskShowStopBtn");
      btn?.focus(); btn?.click();
      for (let i = 0; i < 100 && !document.querySelector("#deskShow #deskShowQr canvas"); i++) await wait(100);
      const list = document.querySelector("#deskShow .desk-show-deps");
      return { id, auki: !document.getElementById("deskShow").hidden, rivit: [...(list?.querySelectorAll("li") || [])].map(li => li.textContent.replace(/\s+/g, " ").trim()),
        px: list ? parseFloat(getComputedStyle(list).fontSize) : 0, qr: !!document.querySelector("#deskShow #deskShowQr canvas"),
        h: document.getElementById("deskShowH")?.textContent || "", k: document.querySelector("#deskShow .desk-show-k")?.textContent || "" };
    } finally { gql = orig; }
  });
  await page.keyboard.press("Escape");
  const sShow2 = await page.evaluate(() => ({ kiinni: document.getElementById("deskShow").hidden, fokus: document.activeElement?.id || "" }));
  (sShow.auki && sShow.rivit.length === 3 && /^W1 Asema \d\d:\d\d \(3 min\)$/.test(sShow.rivit[0]) && sShow.px >= 40 && sShow.qr
    && /^Trio Smoke 999$/.test(sShow.h) && /^Seuraavat lähdöt · /.test(sShow.k) && sShow2.kiinni && sShow2.fokus === "deskShowStopBtn")
    ? ok(`pysäkkikortin asiakasnäkymä: ${sShow.rivit.length} lähtöä ${sShow.px} px:llä ja QR, Esc palaa nappiin`)
    : fail("pysäkkikortin asiakasnäkymä: " + JSON.stringify({ ...sShow, ...sShow2 }));
  await page.evaluate(() => document.getElementById("deskBackTerm")?.click());
  await v3Term();
  const b10Reset = await page.evaluate(() => ({ arvo: document.getElementById("deskTermQ")?.value ?? null, info: document.getElementById("deskTermInfo")?.textContent ?? null,
    rivit: document.querySelectorAll("#deskDeps table.deps tbody tr").length }));
  (b10Reset.arvo === "" && b10Reset.info === "")
    ? ok(`terminaalin Minne?-suodatin (B10): valinta nollautuu pysäkkiä vaihdettaessa (${b10Reset.rivit} riviä ilman suodatinta)`)
    : fail("terminaalin Minne?-suodatin (B10): nollaus: " + JSON.stringify(b10Reset));

  // 390 px: tiskissä ei vaakavieritystä (viewport palautetaan heti).
  await page.setViewport({ width: 390, height: 800 });
  await sleep(1200);
  const d390 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth,
    kartta: Math.round(document.getElementById("deskMap")?.getBoundingClientRect().width || 0) }));
  await page.setViewport({ width: 800, height: 600 });
  (d390.sw <= 390 && d390.bw <= 390 && d390.kartta > 0 && d390.kartta <= 390)
    ? ok(`palvelutiski: 390 px ilman vaakavieritystä (scrollWidth ${d390.sw}, kartta ${d390.kartta} px)`)
    : fail("palvelutiski: 390 px vaakavieritys: " + JSON.stringify(d390));
  // Hinnat jaetusta lähteestä (loadEffectiveFares): ylläpidon julkaisu korvataan merkkihinnalla, ja
  // sen on näyttävä sekä #/liput-sivulla että tiskillä. Julkaisun välimuisti nollataan lopuksi.
  const fz = await page.evaluate(async () => {
    if (typeof loadEffectiveFares !== "function" || !CONFIG.fares || CONFIG.fares.zones || !CONFIG.fares.single?.cardApp) return { ohita: true };
    const f = JSON.parse(JSON.stringify(CONFIG.fares));
    delete f.i18n;
    f.single.cardApp.adult = "9,87";
    publishedPromise = Promise.resolve({ alerts: [], fares: f, a11y: null });
    const jaettu = (await loadEffectiveFares())?.single?.cardApp?.adult;
    location.hash = "#/liput";
    return { jaettu };
  });
  if (fz.ohita) fail("palvelutiski: hintatarkistus ei voinut ajaa (loadEffectiveFares tai Lahden CONFIG.fares puuttuu)");
  else {
    await page.waitForSelector("table.fare", { timeout: 15000 }).catch(() => {});
    const liput = await page.evaluate(() => (document.getElementById("app")?.innerText || "").includes("9,87"));
    await page.evaluate(() => { location.hash = "#/palvelutiski"; });
    await page.waitForSelector("table.desk-fares", { timeout: 15000 }).catch(() => {});
    const tiski = await page.evaluate(() => (document.querySelector(".desk-fares-wrap table.desk-fares")?.innerText || "").includes("9,87"));
    await page.evaluate(() => { publishedPromise = null; });
    (fz.jaettu === "9,87" && liput && tiski)
      ? ok("palvelutiski: hinnat samasta lähteestä kuin #/liput (ylläpidon julkaisu näkyy tiskillä)")
      : fail("palvelutiski: tiskin ja hintasivun hinnat eri lähteestä: " + JSON.stringify({ ...fz, liput, tiski }));
  }
  // Erä D6 (4.10.2026): tiskin tietopankki. Synteettinen worker: /published kertoo kb-tuen ja /kb palauttaa kortit
  // (window.fetch kääritään vain /kb-osoitteelle, palautus finally-lohkossa, ei kirjoituksia tuotannon workeriin).
  // Tarkistetaan: välilehti näkyy, yhteishaku löytää kortin ja vahva osuma on ylimpänä, Enter avaa kortin tiskillä
  // (kappaleet, linkki, lähde, tarkistettu, Kopioi teksti), ylläpidon teksti ei renderöidy HTML:nä eikä javascript:-lähde
  // linkiksi, selattava lista, kieli (sv/en, suomi varalla), tyhjä tila, latausvirhe virheenä (ei tyhjänä listana) ja
  // vanha worker (ei kb-kenttää): välilehti piilossa, hakuun ei ryhmää eikä /kb-kutsua. Kieli palautetaan finallyssä.
  {
    const kbRes = await page.evaluate(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms = 10000) => { for (let i = 0; i < ms / 100; i++) { const v = fn(); if (v) return v; await wait(100); } return fn(); };
      const items0 = [
        { id: "smoke-kb-1", title: "Löytötavarat", order: 0, checked: "2026-09-15", url: "https://www.lsl.fi/asiakaspalvelu/",
          body: "Bussiin unohtuneet tavarat toimitetaan palvelupisteeseen.\n\nLisätietoa https://www.lsl.fi/asiakaspalvelu/. Kiitos.\nToinen rivi <img src=x onerror=\"window.__kbXss=1\">",
          titleSv: "Hittegods", bodySv: "Glömda saker lämnas till servicepunkten.", titleEn: "", bodyEn: "",
          keywords: ["löytötavara", "unohtunut", "kadonnut"] },
        { id: "smoke-kb-2", title: "Polkupyörä bussissa", order: 1, checked: "2025-01-10", url: "javascript:window.__kbXss=2",
          body: "Polkupyörää ei voi ottaa kaupunkiliikenteen bussiin.", titleSv: "", bodySv: "", titleEn: "Bicycles on the bus", bodyEn: "",
          keywords: ["pyörä", "fillari"] },
      ];
      let items = items0, status = 200, kbCalls = 0;
      const of = window.fetch;
      window.fetch = (u, o) => {
        if (/\/kb\?city=/.test(String(u))) {
          kbCalls++;
          return Promise.resolve(new Response(JSON.stringify(status === 200 ? { items } : { error: "x" }),
            { status, headers: { "Content-Type": "application/json" } }));
        }
        return of(u, o);
      };
      const tab = () => document.querySelector('.dcard-tab[data-dcard="kb"]');
      const box = () => document.getElementById("deskKbCard");
      const resetKb = () => { kbPromise = null; kbLast = null; kbAt = 0; };
      const open = async pub => {
        publishedPromise = Promise.resolve(pub); resetKb();
        location.hash = "#/";
        await until(() => !document.body.classList.contains("desk-mode"));
        location.hash = "#/palvelutiski";
        await until(() => box() && document.getElementById("deskStop") && !/Haetaan/.test(box().textContent));
      };
      const search = async q => {
        const el = document.getElementById("deskStop");
        el.focus(); el.value = q; el.dispatchEvent(new Event("input", { bubbles: true }));
        await until(() => !document.getElementById("deskStopList").hidden && document.querySelector('#deskStopList [role="option"], #deskStopList .desk-search-msg'), 20000);
        await wait(400);
      };
      const out = {};
      const langWas = lang;
      try {
        // 1) Uusi worker: välilehti, haku, kortti
        await open({ alerts: [], fares: null, a11y: null, kb: true });
        out.tabNakyy = !!tab() && !tab().hidden;
        await search("löytö");
        const first = document.querySelector('#deskStopList [role="option"]');
        out.ekaOnKb = !!first && first.hasAttribute("data-k");
        out.ryhmat = [...document.querySelectorAll("#deskStopList li.search-cat")].map(x => x.textContent.trim());
        document.getElementById("deskStop").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await until(() => document.querySelector('[data-dcard-panel="kb"]')?.hidden === false && box().querySelector(".desk-kb-art"));
        const art = box().querySelector(".desk-kb-art");
        out.otsikko = art?.querySelector(".desk-kb-h")?.textContent.trim() || "";
        out.kappaleet = art ? art.querySelectorAll(".desk-kb-body p").length : 0;
        out.linkit = art ? [...art.querySelectorAll(".desk-kb-body a")].map(a => a.getAttribute("href") + "|" + a.target) : [];
        out.lahde = art?.querySelector(".desk-kb-src a")?.getAttribute("href") || "";
        out.tarkistettu = art?.querySelector(".desk-kb-checked")?.textContent.trim() || "";
        out.imgt = document.querySelectorAll("#deskKbCard img").length;
        out.tekstina = (art?.querySelector(".desk-kb-body")?.textContent || "").includes("<img src=x");
        out.lista = box().querySelectorAll(".desk-kb-list li").length;
        out.valittu = box().querySelector('.desk-kb-pick[aria-current="true"]')?.dataset.kb || "";
        out.hash = location.hash;
        out.valilehti = tab()?.getAttribute("aria-pressed");
        let leike = null;
        try { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async s => { leike = s; } } }); } catch (e) {}
        box().querySelector(".desk-kb-copy")?.click();
        await until(() => leike);
        out.leike = leike;
        out.kopioituTila = box().querySelector(".desk-kb-tools .desk-copy-st")?.textContent || "";
        // Selattava lista: toinen kortti, javascript:-lähde ei linkiksi
        box().querySelectorAll(".desk-kb-pick")[1]?.click();
        await until(() => box().querySelector(".desk-kb-h")?.textContent.includes("Polkupyörä"));
        out.toinen = box().querySelector(".desk-kb-h")?.textContent.trim() || "";
        out.toinenLahde = box().querySelectorAll(".desk-kb-src, a[href^='javascript']").length;
        out.xss = window.__kbXss || 0;
        // Haku taivutetulla sanalla ja liian lyhyellä haulla (puhdas funktio)
        const its = kbClean(items0);
        out.taivutus = kbMatch(its, "polkupyörän").map(h => h.c.id + ":" + h.sc).join(",");
        out.avainsana = kbMatch(its, "fillari").map(h => h.c.id + ":" + h.sc).join(",");
        out.lyhyt = kbMatch(its, "p").length + kbMatch(its, "4").length;
        out.lahdeSiivottu = its[1].url === "";
        // Kieli: ruotsi ja englanti, suomi varalla (lang palautetaan finallyssä)
        lang = "sv";
        out.sv = [kbLocal(its[0]).title, kbLocal(its[1]).title, kbLocal(its[1]).titleLang, kbMatch(its, "hitte").map(h => h.c.id).join(",")];
        lang = "en";
        out.en = [kbLocal(its[1]).title, kbLocal(its[1]).bodyLang, kbLocal(its[0]).title];
        lang = langWas;
        // 2) Tyhjä tietopankki: ohjeteksti
        items = [];
        await open({ alerts: [], fares: null, a11y: null, kb: true });
        tab()?.click();
        await until(() => box().querySelector(".desk-kb-empty"));
        out.tyhja = box().textContent.trim();
        out.tyhjaTab = !!tab() && !tab().hidden;
        // 3) Latausvirhe: virhe ja Yritä uudelleen, ei tyhjää listaa
        items = items0; status = 500;
        await open({ alerts: [], fares: null, a11y: null, kb: true });
        tab()?.click();
        await until(() => box().querySelector(".desk-err"));
        out.virhe = box().querySelector(".desk-err")?.textContent.trim() || "";
        status = 200;
        box().querySelector(".desk-retry")?.click();
        await until(() => box().querySelectorAll(".desk-kb-list li").length === 2);
        out.uudelleen = box().querySelectorAll(".desk-kb-list li").length;
        // 4) Vanha worker: /published ilman kb-kenttää
        kbCalls = 0;
        await open({ alerts: [], fares: null, a11y: null });
        await wait(500);
        out.vanhaTab = tab() ? tab().hidden : null;
        await search("löytö");
        out.vanhaKbOsumat = document.querySelectorAll("#deskStopList [data-k]").length;
        out.vanhaKutsut = kbCalls;
      } finally {
        window.fetch = of; lang = langWas; publishedPromise = null; resetKb();
        try { delete navigator.clipboard; } catch (e) {}   // oma ominaisuus pois: selaimen oma leikepöytä takaisin
        const el = document.getElementById("deskStop");
        if (el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
        document.querySelector('.dcard-tab[data-dcard="stop"]')?.click();
      }
      return out;
    });
    const k = kbRes;
    (k.tabNakyy && k.ekaOnKb && k.ryhmat[0] === "Tietopankki" && k.otsikko === "Löytötavarat" && k.kappaleet === 2
      && k.linkit.length === 1 && k.linkit[0] === "https://www.lsl.fi/asiakaspalvelu/|_blank" && k.lahde === "https://www.lsl.fi/asiakaspalvelu/"
      && k.tarkistettu === "Tarkistettu 15.9.2026" && k.lista === 2 && k.valittu === "smoke-kb-1" && k.hash === "#/palvelutiski" && k.valilehti === "true")
      ? ok(`palvelutiski D6: yhteishaku löytää tietopankin kortin ylimpänä ja Enter avaa sen tiskillä (${k.kappaleet} kappaletta, lähde, tarkistettu, lista ${k.lista})`)
      : fail("palvelutiski D6: tietopankin haku tai kortti: " + JSON.stringify(k));
    (k.leike === "Löytötavarat\nBussiin unohtuneet tavarat toimitetaan palvelupisteeseen.\n\nLisätietoa https://www.lsl.fi/asiakaspalvelu/. Kiitos.\nToinen rivi <img src=x onerror=\"window.__kbXss=1\">\nhttps://www.lsl.fi/asiakaspalvelu/"
      && /Kopioitu/.test(k.kopioituTila))
      ? ok("palvelutiski D6: Kopioi teksti kopioi otsikon, vastauksen ja lähteen")
      : fail("palvelutiski D6: kopiointi: " + JSON.stringify({ leike: k.leike, tila: k.kopioituTila }));
    (k.imgt === 0 && k.tekstina && k.xss === 0 && k.toinen === "Polkupyörä bussissa" && k.toinenLahde === 0 && k.lahdeSiivottu)
      ? ok("palvelutiski D6: ylläpidon teksti näkyy tekstinä (ei HTML:ää), javascript:-lähde ei muutu linkiksi")
      : fail("palvelutiski D6: turvallinen renderöinti: " + JSON.stringify({ imgt: k.imgt, tekstina: k.tekstina, xss: k.xss, toinen: k.toinen, lahde: k.toinenLahde, siivottu: k.lahdeSiivottu }));
    (k.taivutus === "smoke-kb-2:1" && k.avainsana === "smoke-kb-2:0" && k.lyhyt === 0
      && k.sv.join("|") === "Hittegods|Polkupyörä bussissa|fi|smoke-kb-1" && k.en.join("|") === "Bicycles on the bus|fi|Löytötavarat")
      ? ok("palvelutiski D6: haku taivutetulla sanalla ja avainsanalla, kortti käyttöliittymän kielellä suomi varalla")
      : fail("palvelutiski D6: haku tai kieli: " + JSON.stringify({ taivutus: k.taivutus, avainsana: k.avainsana, lyhyt: k.lyhyt, sv: k.sv, en: k.en }));
    (k.tyhjaTab && /Kunnan omia vastauskortteja ei ole vielä lisätty\. Ylläpito lisää ne kohdasta Tietopankki\./.test(k.tyhja)
      && /Tietopankki ei latautunut/.test(k.virhe) && !/vastauskortteja ei ole/.test(k.virhe) && k.uudelleen === 2)
      ? ok("palvelutiski D6: tyhjä tietopankki näyttää ohjeen, latausvirhe näkyy virheenä ja Yritä uudelleen lataa kortit")
      : fail("palvelutiski D6: tyhjä tila tai virhe: " + JSON.stringify({ tab: k.tyhjaTab, tyhja: k.tyhja, virhe: k.virhe, uudelleen: k.uudelleen }));
    (k.vanhaTab === true && k.vanhaKbOsumat === 0 && k.vanhaKutsut === 0)
      ? ok("palvelutiski D6: vanha worker (ei kb-kenttää): välilehti piilossa, ei hakuryhmää eikä /kb-kutsua")
      : fail("palvelutiski D6: vanha worker: " + JSON.stringify({ tab: k.vanhaTab, osumat: k.vanhaKbOsumat, kutsut: k.vanhaKutsut }));
  }
  // Poistuminen purkaa koko ruudun tilan
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  (await page.evaluate(() => document.body.classList.contains("desk-mode")))
    ? fail("palvelutiski: desk-mode ei purkaudu poistuttaessa")
    : ok("palvelutiski: desk-mode purkautuu poistuttaessa");

  // Erä D5 (4.10.2026): ylläpidon häiriötiedote käyttäjän kielellä. Synteettinen julkaisu kuten hintatestissä:
  // A:ssa ruotsi kokonaan ja englanniksi vain otsikko (kuvaus palaa suomeen), B on vanhan workerin muoto
  // ilman käännöskenttiä. Kieli vaihtuu vain uudelleenlatauksessa; kieli ja julkaisun välimuisti palautetaan.
  {
    const kieliEnnen = await page.evaluate(() => localStorage.getItem("lang"));
    const tulos = [];
    for (const kieli of ["sv", "en", "fi"]) {
      await page.evaluate(l => localStorage.setItem("lang", l), kieli);
      await page.reload({ waitUntil: "networkidle2" });
      tulos.push(await page.evaluate(async k => {
        publishedPromise = Promise.resolve({ fares: null, a11y: null, alerts: [
          { title: "D5 otsikko suomeksi", body: "D5 kuvaus suomeksi", titleSv: "D5 rubrik på svenska", bodySv: "D5 beskrivning på svenska",
            titleEn: "D5 title in English", bodyEn: "", severity: "SEVERE", lines: ["4"] },
          { title: "D5 vain suomeksi", body: "D5 vanha worker", severity: "SEVERE", lines: [] }] });
        try {
          const a = (await loadAllAlerts()).filter(x => x._admin).map(x => x.alertHeaderText + " | " + x.alertDescriptionText);
          const box = document.createElement("div");
          await loadAlertsInto(box);
          return { kieli: k, lang, a, nakyy: box.textContent.replace(/\s+/g, " ") };
        } finally { publishedPromise = null; }
      }, kieli));
    }
    await page.evaluate(l => { if (l == null) localStorage.removeItem("lang"); else localStorage.setItem("lang", l); }, kieliEnnen);
    await page.reload({ waitUntil: "networkidle2" });
    const odotus = {
      sv: ["D5 rubrik på svenska | D5 beskrivning på svenska", "D5 vain suomeksi | D5 vanha worker"],
      en: ["D5 title in English | D5 kuvaus suomeksi", "D5 vain suomeksi | D5 vanha worker"],
      fi: ["D5 otsikko suomeksi | D5 kuvaus suomeksi", "D5 vain suomeksi | D5 vanha worker"] };
    const vika = tulos.filter(r => r.lang !== r.kieli || JSON.stringify(r.a) !== JSON.stringify(odotus[r.kieli])
      || !odotus[r.kieli].every(s => s.split(" | ").every(o => r.nakyy.includes(o))));
    !vika.length
      ? ok("häiriötiedote: ylläpidon tiedote näkyy käyttäjän kielellä (sv/en), puuttuva käännös ja vanha worker palaavat suomeen")
      : fail("häiriötiedote: kieliversio väärin: " + JSON.stringify(vika));
  }

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

  // --- Kertalippujen hinnat 11 kaupungissa (erä E1 4.10.2026) ---
  // Rakenteellinen tarkistus, ei euromääriä kaupungeittain: #/liput avautuu (ei ohjausta etusivulle), kertalippu-
  // taulukoita on yksi vyöhykettä kohden ja vyöhykeotsikot vain vyöhykekaupungissa, jokainen hintasolu on "n,nn €"
  // tai "–", lähdelinkki osoittaa kaupungin oman hinnaston palvelimelle, ja samasta hinnastosta piirtyvät tiskin
  // hintalohko (yksi sarake per vyöhyke) ja reittikortin hintarivi. Yksi luku esimerkiksi: Oulun aikuisen kertalippu
  // 2,90 € (osl.fi, luettu 4.10.2026). Smoke on tässä kohtaa ruotsiksi; tarkistus ei lue tekstejä, joten kieli ei
  // vaikuta, eikä se vaihda kieltä. Lopuksi palataan Vaasaan kuten ennenkin (alla).
  const e1Kaupungit = ["kuopio", "salo", "kajaani", "kotka", "kouvola", "mikkeli", "hameenlinna", "jyvaskyla", "oulu", "pori", "rovaniemi"];
  const e1 = [];
  for (const c of e1Kaupungit) {
    await page.goto(BASE + `/?city=${c}#/liput`, { waitUntil: "networkidle2" });
    await page.waitForSelector("table.fare", { timeout: 15000 }).catch(() => {});
    e1.push(await page.evaluate(k => {
      const f = CONFIG.fares;
      const zones = f && Array.isArray(f.zones) && f.zones.length ? f.zones.length : 1;
      const tables = [...document.querySelectorAll("table.fare")];
      const cells = tables.flatMap(tb => [...tb.querySelectorAll("tbody td")].map(td => td.textContent.trim()));
      const host = f && f.url ? new URL(f.url).host : "?";
      const box = document.createElement("div");
      box.innerHTML = f ? deskFaresHtml(f) : "";
      return { k, city: document.documentElement.dataset.city, hash: location.hash, zones,
        h4: document.querySelectorAll("h4.fare-zone").length, taulukot: tables.length,
        sarakkeet: tables[0] ? tables[0].querySelectorAll("thead th").length : 0,
        solut: cells.length, solutOk: cells.every(s => /^\d+,\d\d\s€$|^–$/.test(s)), lukuja: cells.filter(s => /\d/.test(s)).length,
        lahde: [...document.querySelectorAll(".fares-source a")].some(a => a.host === host),
        tiskiSarakkeet: box.querySelectorAll("table.desk-fares thead th").length,
        tiskiRivit: box.querySelectorAll("table.desk-fares tbody tr:not(.desk-fares-method)").length,
        reitti: f ? /\d+,\d\d\s€/.test(planFareHtml(f)) : false,
        luku: k === "oulu" ? (document.getElementById("app")?.innerText || "").includes("2,90") : true };
    }, c));
  }
  const e1Vika = e1.filter(r => !(r.city === r.k && r.hash === "#/liput" && r.taulukot === r.zones
    && r.h4 === (r.zones > 1 ? r.zones : 0) && r.sarakkeet >= 3 && r.solut >= 2 * r.zones && r.solutOk
    && r.lukuja >= 2 * r.zones && r.lahde && r.tiskiSarakkeet === (r.zones > 1 ? r.zones : 0) && r.tiskiRivit >= 2
    && r.reitti && r.luku));
  e1Vika.length === 0
    ? ok(`hinnat (erä E1): kertalippuhinnasto renderöityy ${e1.length} kaupungissa (#/liput, tiski, reittikortti; ${e1.reduce((s, r) => s + r.zones, 0)} hintataulukkoa, Oulu 2,90 €)`)
    : fail("hinnat (erä E1): kertalippuhinnasto puuttuu tai on rikki: " + JSON.stringify(e1Vika));
  // Takaisin Vaasaan: seuraavat tarkistukset (teema, tiski) lukevat sivun tilan
  // navigoimatta itse, joten Lahti-välikäynti ei saa jäädä voimaan.
  await page.goto(BASE + "/?city=vaasa#/", { waitUntil: "networkidle2" });
  // Vaasan demo: Liftin pinkki brändiväri (per-kaupunki) — tunnus/yläraita + primary-napit magenta (R>B),
  // kirkas #E6007E aksenttiraita. data-city="vaasa" gating → muut kaupungit (sininen) ennallaan.
  // Ilme 25.9.2026: ylätunniste on valkoinen, kaupungin väri on tunnuksessa ja yläraidassa.
  const vTheme = await page.evaluate(() => {
    const rgb = s => (s.match(/\d+/g) || []).map(Number);
    const hdr = rgb(getComputedStyle(document.getElementById("brandGlyph")).backgroundColor);
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
  // Hintalohko piirtyy vasta kun ylläpidon julkaisu on luettu (loadEffectiveFares, V1 4.10.2026).
  await page.waitForSelector("table.desk-fares", { timeout: 15000 }).catch(() => {});
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
  // Erä B, B4: Vaasan tiski avautuu Liftin asiakaspalvelupisteen ovelle (Raastuvankatu / Rewell 2, kauppakeskus Rewell),
  // ei matkakeskukselle 506 m päähän. Tunnistus id:llä, koska näkymä on tässä kohtaa ruotsiksi.
  await page.waitForFunction(() => document.querySelector("#deskDeps .desk-deps-upd, #deskDeps .error"), { timeout: 30000 }).catch(() => {});
  const vB4Home = await page.evaluate(() => ({ id: (history.state && history.state.desk && history.state.desk.stop || {}).gtfsId || "",
    nimi: (document.querySelector("#deskDeps .stophead")?.textContent || "").replace(/\s+/g, " ").trim() }));
  (vB4Home.id === "Vaasa:159824")
    ? ok(`palvelutiski B4 (Vaasa): oletuksena asiakaspalvelupisteen pysäkki ${vB4Home.nimi}`)
    : fail("palvelutiski B4 (Vaasa): oletuspysäkki: " + JSON.stringify(vB4Home));
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
  // Kielenvaihto SV → otsikko "Reittari Vasa" (cityNames.sv) ja alaotsikko "Lifti" (headerSub.sv), linjasivun
  // suuntavalinnassa ruotsinkielinen pysäkkinimi (name@L → translations.txt-data).
  // EI hyväksytä FI-fallbackia: "Vasa" (ei "Vaasa") ja vägen/gatan/esplanaden ovat sv-spesifejä.
  await page.goto(BASE + "/?city=vaasa#/", { waitUntil: "networkidle2" });
  await page.click('[data-lang-opt="sv"]');
  const svHome = await page.waitForFunction(
    () => document.documentElement.lang === "sv"
      && (document.getElementById("appTitle")?.textContent || "") === "Reittari Vasa"
      && (document.getElementById("appSub")?.textContent || "") === "Lifti",
    { timeout: 10000 }).then(() => true).catch(() => false);
  svHome ? ok("kaksikielisyys (Vaasa, SV): otsikko 'Reittari Vasa', alaotsikko 'Lifti' + lang=sv")
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
          const counts = [...new Set([...g.querySelectorAll("tr")].map(tr => [...tr.children].reduce((s, c) => s + (c.colSpan || 1), 0)))];
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
      // Lahdella tiivis tila on 2.9.2026 alkaen CONFIG-oletus, joten kumpaakaan tilaa ei oleteta:
      // väljä versio kootaan valinta pois päältä ja tiivis valinta päällä, ja tuloste tyhjennetään
      // välissä, jotta odotus ei osu edelliseen koosteeseen. page.pdf laukaisee afterprintin, joka
      // palauttaa @page-säännön oletukseen, siksi pageStyle luetaan vasta tiiviin koosteen jälkeen.
      if (posterOk && await page.$("#posterCompactCb")) {
        await page.evaluate(() => { document.getElementById("posterCompactCb").checked = false; document.getElementById("stopPrintOut").innerHTML = ""; });
        await page.click("#stopPosterBtn");
        await page.waitForFunction(
          () => !!document.querySelector("#stopPrintOut .hourgrid tr") && !document.querySelector("#stopPrintOut .poster-compact"),
          { timeout: 20000 }).catch(() => {});
        const loosePages = await pdfPages();
        await page.evaluate(() => { document.getElementById("posterCompactCb").checked = true; document.getElementById("stopPrintOut").innerHTML = ""; });
        await page.click("#stopPosterBtn");
        const compactOk = await page.waitForFunction(
          () => !!document.querySelector("#stopPrintOut .poster-compact .poster-stop[data-fit] .hourgrid tr"),
          { timeout: 20000 }).then(() => true).catch(() => false);
        const cp = await page.evaluate(() => {
          const bad = [];
          document.querySelectorAll("#stopPrintOut .hourgrid").forEach((g, i) => {
            const counts = [...new Set([...g.querySelectorAll("tr")].map(tr => [...tr.children].reduce((s, c) => s + (c.colSpan || 1), 0)))];
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
        const mlPoster = await minuuttiLinjaus(page, "#stopPrintOut", "print");
        mlPoster.n >= 5 && !mlPoster.viat.length
          ? ok(`pysäkkijuliste (yksi arkki): minuutit kymmenluvuittain allekkain (${mlPoster.n} mitattua)`)
          : fail(`pysäkkijuliste (yksi arkki): minuutit eivät ole allekkain (${mlPoster.n} mitattua): ${mlPoster.viat.join(" · ")}`);
        // Täysauditointi 27.9.2026, kaksi julisteen sisältövikaa, vahdit ajavat korjatut funktiot suoraan:
        // (1) sama lähtöaika kahdesta lohkosta (Ma–To ja Pe) sai ensimmäisen lohkon kirjaimen "vain Ma–To",
        //     vaikka se ajetaan myös perjantaina (Lahden yölinja 97). Oikein: ei kirjainta.
        // (2) keskustaan saapuva vuoro tunnistetaan myös, kun pysäkin nimi on käännetty (ruotsinkielinen
        //     Vaasan juliste näytti 33 saapuvaa vuoroa lähtöinä): syötekielinen nimi ratkaisee.
        const sisalto = await page.evaluate(() => {
          const L = times => ({ route: { shortName: "97" }, headsign: "Testi", times });
          const out = canonicalPosterBlocks([
            { dows: new Set([0, 1, 2, 3]), school: "", period: null, lines: [L([83940, 87540])] },
            { dows: new Set([4]), school: "", period: null, lines: [L([83940, 87540, 91140])] },
          ]);
          const arki = out.find(b => b.dows.size === 5), T = arki && arki.lines[0];
          const c = (CONFIG.centerStopNames || [])[0] || "";
          return {
            yhteinen: T ? (T.codes.get(83940) || "") : "?", vainPe: T ? (T.codes.get(91140) || "") : "",
            selitteita: arki ? arki.legend.length : -1, keskusta: c,
            saapuu: c ? arrivingHere("Muualle", "Käännetty nimi", 120, false, c) : null,
            eiNatiivia: c ? arrivingHere("Muualle", "Käännetty nimi", 120, false) : null,
          };
        });
        (sisalto.yhteinen === "" && sisalto.vainPe && sisalto.selitteita === 1)
          ? ok(`julisteen kirjaimet: Ma–To + Pe -lähtö ilman kirjainta, vain Pe -lähtö kirjaimella "${sisalto.vainPe}"`)
          : fail("julisteen kirjaimet: saman lähtöajan lohkot eivät yhdisty: " + JSON.stringify(sisalto));
        (sisalto.saapuu === true && sisalto.eiNatiivia === false)
          ? ok(`julisteen saapuvat vuorot: keskustapysäkki "${sisalto.keskusta}" tunnistetaan syötekielisestä nimestä`)
          : fail("julisteen saapuvat vuorot: käännetty pysäkkinimi ohittaa keskustasäännön: " + JSON.stringify(sisalto));
        await printHygiene(page, "Lahti, yksi arkki");
        // palauta CONFIG-oletus, ettei valinta vuoda seuraaviin tarkistuksiin
        await page.evaluate(() => { document.getElementById("posterCompactCb").checked = CONFIG.posterCompact !== false; });
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
  // Vanha #/tulosta -> ohjautuu keskukseen vihko-välilehdelle (QR-yhteensopivuus); 6 välilehteä,
  // kaikki paneelit DOMissa (sidonnat toimivat tabista riippumatta).
  await page.goto(BASE + "/#/tulosta", { waitUntil: "networkidle2" });
  await sleep(400);
  const pc = await page.evaluate(() => ({
    hash: location.hash, tabs: document.querySelectorAll(".ptab").length,
    active: document.querySelector('.ptab[aria-pressed="true"]')?.dataset.ptab,
    booklet: !!document.getElementById("buildBtn"), batch: !!document.getElementById("batchGo"), hub: !!document.getElementById("hubStopSearch"),
  }));
  (pc.tabs === 7 && pc.active === "vihko" && /#\/tulosteet\/vihko/.test(pc.hash) && pc.booklet && pc.batch && pc.hub)
    ? ok(`tulosteet-keskus: #/tulosta ohjautuu vihko-välilehdelle, 6 välilehteä (${pc.hash})`)
    : fail("tulosteet-keskus: #/tulosta-ohjaus tai välilehdet pielessä: " + JSON.stringify(pc));
  // Muutosvahti-välilehti: lukee viikkoajon tuloksen docs/muutosvahti/<city>.json (sama origin).
  // Kaupunki jolle ajo on tehty (index.json listaa) → yhteenveto + pysäkkilista; muu → "ei vielä
  // ajettu" ilman konsolivirhettä (puuttuvaa tiedostoa ei saa hakea, 404 olisi smoke-vika).
  {
    const ix = await page.evaluate(async () => {
      try { const r = await fetch("docs/muutosvahti/index.json", { cache: "no-cache" }); return r.ok ? await r.json() : null; }
      catch (e) { return null; }
    });
    const ajettu = ix?.kaupungit ? Object.keys(ix.kaupungit) : [];
    const city = ajettu.includes("vaasa") ? "vaasa" : ajettu[0];
    await page.goto(BASE + "/?city=" + (city || "lahti") + "#/tulosteet/muutokset", { waitUntil: "networkidle2" });
    const ready = await page.waitForFunction(() => {
      const s = document.getElementById("chgSummary")?.textContent || "";
      return s && !/Haetaan|Loading|Hämtar/.test(s);
    }, { timeout: 20000 }).then(() => true).catch(() => false);
    const chg = await page.evaluate(() => ({
      sum: (document.getElementById("chgSummary")?.textContent || "").slice(0, 80),
      rows: document.querySelectorAll("#chgList li").length,
      go: !!document.getElementById("chgGo"),
      active: document.querySelector('.ptab[aria-pressed="true"]')?.dataset.ptab,
    }));
    const expectRows = !!city;
    (ready && chg.go && chg.active === "muutokset" && (expectRows ? chg.rows > 0 && /\d/.test(chg.sum) : chg.rows === 0))
      ? ok(`muutosvahti-välilehti (${city || "ei ajettu"}): ${chg.rows} pysäkkiä, "${chg.sum}…"`)
      : fail("muutosvahti-välilehti: " + JSON.stringify({ city, ready, ...chg }));
    // Muutosvahdin "Yksi arkki" noudattaa samaa oletusta kuin pysäkkisivu ja linjan erätuloste
    // (CONFIG.posterCompact !== false). 23.9.2026 muutosvahti tulosti Turussa vanhan monisivuisen
    // julisteen, koska sen valinta vaati erillisen posterCompact: true -asetuksen (vain Lahti ja Vaasa).
    // Siksi tarkistus ajetaan kunnassa, jolla asetusta ei ole.
    await page.goto(BASE + "/?city=joensuu#/tulosteet/muutokset", { waitUntil: "networkidle2" });
    await page.waitForSelector("#chgCompactCb", { timeout: 20000 }).catch(() => {});
    const yksiArkki = await page.evaluate(() => ({
      muutosvahti: document.getElementById("chgCompactCb")?.checked,
      eratuloste: document.getElementById("batchCompactCb")?.checked,
    }));
    (yksiArkki.muutosvahti === true && yksiArkki.eratuloste === true)
      ? ok("muutosvahti: yhden arkin juliste oletuksena kuten erätulosteessa (joensuu)")
      : fail("muutosvahti: yhden arkin valinnan oletus eri kuin erätulosteessa: " + JSON.stringify(yksiArkki));
    // Tulostuksen ajaksi piilotetut välilehdet ja muutosvahdin lista pois DOMista (esikatselun
    // nopeus, 23.9.2026) ja takaisin samoina: valinnat eivät saa kadota tulostuksen jälkeen.
    await page.waitForFunction(() => document.querySelectorAll("#chgList input[type=checkbox]").length >= 2,
      { timeout: 20000 }).catch(() => {});
    const irrotus = await page.evaluate(() => {
      const cbs = [...document.querySelectorAll("#chgList input[type=checkbox]")];
      cbs.forEach((c, i) => { c.checked = i < 2; });
      window.dispatchEvent(new Event("beforeprint"));
      const aikana = { lista: !!document.getElementById("chgList"), piilopaneeleja: document.querySelectorAll(".ppanel[hidden]").length };
      window.dispatchEvent(new Event("afterprint"));
      return { aikana, rivit: cbs.length, jalkeen: document.querySelectorAll("#chgList input[type=checkbox]").length,
        valitut: document.querySelectorAll("#chgList input[type=checkbox]:checked").length, paneeleja: document.querySelectorAll(".ppanel").length };
    });
    (!irrotus.aikana.lista && irrotus.aikana.piilopaneeleja === 0 && irrotus.jalkeen === irrotus.rivit
      && irrotus.valitut === 2 && irrotus.paneeleja === 7)
      ? ok(`tulostus: muutosvahdin lista ja piilotetut välilehdet pois tulostuksen ajaksi, palautuvat valintoineen (${irrotus.rivit} riviä)`)
      : fail("tulostus: irrotus/palautus pielessä: " + JSON.stringify(irrotus));
    // Erätulosteen julisteissa QR kuten pysäkkisivun julisteessa (muutosvahti, 2 pysäkkiä).
    await page.evaluate(() => { window.print = () => {}; });
    await page.click("#chgGo");
    const qr = await page.waitForFunction(() => {
      const st = [...document.querySelectorAll("#chgOut .poster-stop")];
      return st.length >= 2 ? st.map(s => !!s.querySelector("img.poster-qr")) : null;
    }, { timeout: 60000 }).then(h => h.jsonValue()).catch(() => null);
    (qr && qr.length >= 2 && qr.every(Boolean))
      ? ok(`muutosvahti: erätulosteen jokaisessa julisteessa QR (${qr.length} julistetta)`)
      : fail("muutosvahti: erätulosteen julisteesta puuttuu QR: " + JSON.stringify(qr));
    // Smoke on peräkkäinen ja tilallinen: palauta oletuskaupunki ja vihko-välilehti, muuten seuraava
    // tarkistus klikkaa piilotetun paneelin nappia (CI 2.9.2026: "Node is either not clickable").
    await page.goto(BASE + "/#/tulosteet/vihko", { waitUntil: "networkidle2" });
    await sleep(400);
  }
  if (await expect(".lineCb", "tulostusvihko: linjavalinta latautuu")) {
    await page.evaluate(() => { document.querySelector(".lineCb").checked = true; });
    // Tiivis vihko on oletus 23.9.2026 alkaen; nämä tarkistukset koskevat laajaa (kellonajat
    // isoilla pysäkeillä). Tiivis tarkistetaan omassa lohkossaan alempana.
    await page.select("#bookletLayout", "full");
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
      // Reittikaavio linjan otsikon alla: SVG-viiva + nimilaput tekstinä. Kuvia saa olla vain
      // taustakarttaryhmässä (.pm-base, MML-tiilet workerin /mml/-reitiltä, 23.9.2026).
      const bm = await page.evaluate(() => {
        const fig = document.querySelector("#bookletOut .booklet-line .print-map");
        const imgs = fig ? [...fig.querySelectorAll("img, image")] : [];
        return { has: !!fig, paths: fig ? fig.querySelectorAll("svg path").length : 0,
                 texts: fig ? fig.querySelectorAll("svg text").length : 0,
                 tiles: imgs.filter(i => i.closest(".pm-base") && /\/mml\/selkokartta\/\d+\/\d+\/\d+\.png$/.test(i.getAttribute("href") || "")).length,
                 imgs: imgs.length,
                 attr: !!fig?.querySelector(".pm-attr text"),
                 afterH2: !!fig && fig.previousElementSibling?.tagName === "H2" };
      });
      (bm.has && bm.paths >= 1 && bm.texts >= 3 && bm.imgs === bm.tiles && bm.tiles >= 1 && bm.tiles <= 48 && bm.attr && bm.afterH2)
        ? ok(`tulostusvihko: reittikaavio linjan alla (${bm.paths} viivaa, ${bm.texts} tekstiä, ${bm.tiles} taustakarttatiiltä + lähdemerkintä)`)
        : fail("tulostusvihko: reittikaavio puuttuu tai pielessä: " + JSON.stringify(bm));
      // Kartan nimilaput (25.9.2026): pitkä nimi rivittyy eikä katkea "…":iin, ja teksti pysyy lapun
      // sisällä. Ennen nimi katkesi 30 merkkiin (Lappeenranta 28 lappua) ja leveys arvattiin merkkimäärästä.
      const pmLab = await page.evaluate(() => {
        const names = ["Muukontie-Hakalinkatu keskustaan", "Keskusta", "Hallituskatu- Itsenäisyydenkatu keskustaan"];
        const stops = names.map((name, i) => ({ name, lat: 61.06 - i * 0.005, lon: 28.10 + i * 0.07 }));
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;left:-9999px;top:0;width:640px";
        host.innerHTML = printMapSvg([{ shortName: "1", dirs: [{ points: stops.map(s => [s.lat, s.lon]), stops }] }], {});
        document.body.appendChild(host);
        const norm = s => s.replace(/\s+/g, "");
        const labs = [...host.querySelectorAll(".pm-label")].map(g => {
          const r = g.querySelector("rect").getBBox(), ts = [...g.querySelectorAll("text")];
          return { txt: ts.map(t => t.textContent).join(" "),
                   inside: ts.every(t => { const b = t.getBBox(); return b.x + b.width <= r.x + r.width + 0.5 && b.y + b.height <= r.y + r.height + 1.5; }) };
        });
        host.remove();
        return { labs, whole: [names[0], names[2]].every(nm => labs.some(l => norm(l.txt) === norm(nm))) };
      });
      (pmLab.whole && pmLab.labs.every(l => l.inside && !l.txt.includes("…")))
        ? ok(`tulostusvihko: kartan pitkät nimilaput rivittyvät kokonaisina lapun sisälle (${pmLab.labs.length} lappua)`)
        : fail("tulostusvihko: kartan nimilappu katkeaa tai valuu yli: " + JSON.stringify(pmLab));
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
    // Solmupysäkit tunnuksella (täysauditointi 27.9.2026): ruotsiksi Vaasan "Raastuvankatu" ei osunut
    // "Rådhusgatan"-pysäkkeihin, ja lehtitelineestä puuttuivat keskustan sarakkeet. Käännetty nimi, joka ei
    // muistuta solmun nimeä, tunnistetaan tunnuksesta; solmusta otetaan yksi pysäkki; reittijana säilyttää
    // lähdön ja päätteen (Vaasan jana päättyi Palosaareen, kun .slice(0, 8) pudotti päätepysäkin).
    const solmu = await page.evaluate(() => {
      const h = (CONFIG.hubs || []).find(x => typeof x.name === "string");
      if (!h) return { eiSolmua: true };
      const tunnus = "TESTI:solmu-1";
      HUB_STOPS.set(tunnus, h.key);
      const kaannetty = { gtfsId: tunnus, name: "Käännetty nimi 57" };
      const mk = n => Array.from({ length: n }, (_, i) => ({ stop: i === 30 ? kaannetty : i === 31 ? { gtfsId: "TESTI:solmu-2", name: h.name + " 41" } : { gtfsId: "s" + i, name: "P" + i }, idx: i }));
      const valitut = pickKeyStops(mk(60));
      const jana = stripStops(Array.from({ length: 12 }, (_, i) => ({ gtfsId: "j" + i, name: "J" + i })), 8);
      HUB_STOPS.delete(tunnus);
      return {
        kaannettyMukana: valitut.some(s => s.gtfsId === tunnus),
        yksiSolmusta: valitut.filter(s => s.gtfsId === tunnus || s.gtfsId === "TESTI:solmu-2").length,
        janaPituus: jana.length, janaPaat: jana[0].gtfsId === "j0" && jana[jana.length - 1].gtfsId === "j11",
      };
    }).catch(e => ({ virhe: String(e.message).slice(0, 120) }));
    (solmu.eiSolmua || (solmu.kaannettyMukana && solmu.yksiSolmusta === 1 && solmu.janaPituus === 8 && solmu.janaPaat))
      ? ok(solmu.eiSolmua ? "solmupysäkit: kaupungilla ei solmuja, tarkistus ohitettu"
          : "solmupysäkit: käännetty nimi tunnistetaan tunnuksesta, yksi pysäkki per solmu, reittijanassa lähtö ja pääte")
      : fail("solmupysäkit tai reittijana pielessä: " + JSON.stringify(solmu));
    // A4-vihko: suunta alkaa sivun yläreunasta (Villen linjaus 23.9.2026). Reittikaavion jälkeen
    // 1. suuntakin vaihtaa sivua; suoraan linjaotsikon alla (ei kaaviota) se saa jatkaa.
    await page.emulateMediaType("print");
    const bk = await page.evaluate(() => [...document.querySelectorAll("#bookletOut .booklet-line > h3")]
      .map(h => ({ b: getComputedStyle(h).breakBefore, h2: h.previousElementSibling?.tagName === "H2" })));
    await page.emulateMediaType("screen");
    (bk.length && bk.every(x => x.h2 ? x.b !== "page" : x.b === "page"))
      ? ok(`vihko A4: jokainen suunta alkaa sivun yläreunasta (${bk.length} suuntaa)`)
      : fail("vihko A4: suunta voi alkaa kesken sivun: " + JSON.stringify(bk));
    // Vihko (A5, taitettava): mittaa-ja-jaa A5-sivutus + saddle-stitch imposition; A4-vakio säilyy
    if (await page.$("#bookletPrintA5")) {
      // stub-print kirjaa näkyikö valmistelu-indikaattori juuri tulostushetkellä (#16)
      await page.evaluate(() => { window.__rp = window.print; window.__prepAtPrint = false; window.__printed = false;
        window.print = () => { const e = document.getElementById("printPrep"); window.__prepAtPrint = !!(e && !e.hidden && /\S/.test(e.textContent)); window.__printed = true; }; });
      await page.click("#bookletPrintA5");
      // Tulostus odottaa reittikartan taustatiilet (imagesReady, enintään 8 s), joten odotetaan
      // itse print()-kutsua eikä kiinteää aikaa.
      await page.waitForFunction(() => window.__printed, { timeout: 15000 }).catch(() => {});
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
        // Linja ja suunta alkavat A5:n yläreunasta (Villen linjaus 23.9.2026): linjaotsikko on
        // sivun 1. elementti, suuntaotsikko 1. tai heti linjaotsikon jälkeen. Rikkeet listataan
        // sivunumeroina, jotta vika näkyy suoraan.
        otsikkoKesken: [...document.querySelectorAll("#vihkoPrint .vihko-page-content")].flatMap((pg, n) => {
          const kids = [...pg.children];
          return kids.some((el, i) => el.classList.contains("vk-h2") ? i !== 0
            : el.classList.contains("vk-h3") ? !(i === 0 || (i === 1 && kids[0].classList.contains("vk-h2")))
            : false) ? [n + 1] : [];
        }),
      }));
      vk.otsikkoKesken.length === 0
        ? ok("vihko: jokainen linja ja suunta alkaa A5-sivun yläreunasta")
        : fail(`vihko: linja tai suunta alkaa kesken A5-sivun (paikat ${vk.otsikkoKesken.join(", ")})`);
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
    // --- Tiivis vihko (oletus 23.9.2026, JOJO:n talviaikatauluvihkon malli) ---
    // Yksi aukeama linjaa kohden: kartta + reittijana vasemmalla, suuntien tuntiruudukot oikealla.
    // Vartijat: ruudukossa on oikeita lähtöminuutteja (ei tyhjää taulua), reittijanassa matka-ajat,
    // A5:llä linja alkaa parilliselta sivulta ja ruudukot seuraavalta, eikä mikään vuoda sivun yli.
    await page.select("#bookletLayout", "compact");
    // DOM-klikkaus: edellinen koonti vierittää sivua pehmeästi, ja koordinaattiklikkaus osui ohi
    // (ensimmäinen ajo 23.9.2026 klikkasi linkkiä ja vei sivun pois tulosteista).
    await page.$eval("#buildBtn", el => el.click());
    if (await expect("#bookletOut .booklet-line.compact .cb-grid tbody tr", "tiivis vihko: tuntiruudukko kootaan")) {
      const cb = await page.evaluate(() => {
        const L = document.querySelector("#bookletOut .booklet-line.compact");
        const mins = [...L.querySelectorAll(".cb-grid tbody td")].flatMap(td => td.textContent.trim().split(/\s+/).filter(Boolean));
        return {
          dirs: L.querySelectorAll(".cb-dir").length,
          lahtoja: mins.length,
          muoto: mins.every(m => /^\d{2}[a-z]*$/.test(m)),
          tunnit: [...L.querySelectorAll(".cb-grid tbody th")].map(th => th.textContent.trim()).every(h => /^\d{2}$/.test(h)),
          jana: L.querySelectorAll(".cb-strip circle").length,
          janaMin: [...L.querySelectorAll(".cb-strip text")].filter(x => /\d+ min/.test(x.textContent)).length,
          kartta: !!L.querySelector(".print-map .pm-base image"),
          kansi: /reittijanassa|route strip|linjeschemat/.test(document.querySelector(".booklet-head")?.textContent || ""),
        };
      });
      (cb.dirs >= 1 && cb.lahtoja >= 5 && cb.muoto && cb.tunnit && cb.jana >= 2 && cb.janaMin >= 1 && cb.kartta && cb.kansi)
        ? ok(`tiivis vihko: ${cb.dirs} suuntaa, ${cb.lahtoja} lähtöminuuttia, reittijanassa ${cb.jana} pysäkkiä ja ${cb.janaMin} matka-aikaa, taustakartta`)
        : fail("tiivis vihko: sisältö pielessä: " + JSON.stringify(cb));
      const mlVihko = await minuuttiLinjaus(page, "#bookletOut");
      mlVihko.n >= 5 && !mlVihko.viat.length
        ? ok(`tiivis vihko: minuutit kymmenluvuittain allekkain (${mlVihko.n} mitattua)`)
        : fail(`tiivis vihko: minuutit eivät ole allekkain (${mlVihko.n} mitattua): ${mlVihko.viat.join(" · ")}`);
      await page.emulateMediaType("print");
      const cbA4 = await page.evaluate(() => [...document.querySelectorAll("#bookletOut .booklet-line.compact")].map(l => getComputedStyle(l).breakBefore));
      await page.emulateMediaType("screen");
      cbA4.every(b => b === "page")
        ? ok("tiivis vihko A4: jokainen linja alkaa omalta sivultaan")
        : fail("tiivis vihko A4: linja voi alkaa kesken sivun: " + JSON.stringify(cbA4));
      const cb5 = await page.evaluate(() => {
        const pages = vkPaginate(vkCollectAtoms(document.getElementById("bookletOut")));
        const lineP = pages.map((h, i) => /class="vk-h2"/.test(h) ? i + 1 : 0).filter(Boolean);
        const gridP = pages.map((h, i) => /class="cb-grids/.test(h) ? i + 1 : 0).filter(Boolean);
        const m = document.createElement("div");
        m.className = "vihko-page-content";
        m.style.cssText = "position:fixed;left:-9999px;top:0;width:128mm;visibility:hidden";
        document.body.appendChild(m);
        const yli = pages.map((h, i) => { m.innerHTML = h;
          const r = m.getBoundingClientRect();
          return { s: i + 1, h: Math.round(r.height - 190 * 96 / 25.4), w: Math.round(m.scrollWidth - m.clientWidth) }; })
          .filter(x => x.h > 0 || x.w > 1);
        m.remove();
        return { lineP, gridP, yli };
      });
      (cb5.lineP.length && cb5.lineP.every(n => n % 2 === 0) && cb5.gridP.length && cb5.gridP[0] === cb5.lineP[0] + 1 && !cb5.yli.length)
        ? ok(`tiivis vihko A5: aukeama (linja sivulla ${cb5.lineP.join(",")}, ruudukot sivulla ${cb5.gridP.join(",")}), ei ylivuotoa`)
        : fail("tiivis vihko A5: aukeama tai ylivuoto pielessä: " + JSON.stringify(cb5));
      // Lukujärjestys (27.9.2026): ruudulle ja yksipuoliseen tulostukseen arkit [tyhjä | kansi], [2 | 3] ...,
      // jolloin linjan kartta ja aikataulu ovat samalla arkilla. Taitettu vihko näytti PDF:nä linjan 1 kartan
      // vieressä viimeisen linjan aikataulun, ja Ville luuli aikatauluja vääriksi.
      if (await page.$("#bookletPrintA5Read")) {
        await page.evaluate(() => { window.__rp2 = window.print; window.__printed2 = false; window.print = () => { window.__printed2 = true; }; });
        await page.$eval("#bookletPrintA5Read", el => el.click());
        await page.waitForFunction(() => window.__printed2, { timeout: 20000 }).catch(() => {});
        const lj = await page.evaluate(() => {
          const sh = [...document.querySelectorAll("#vihkoPrint .vihko-sheet")];
          const side = (s, i) => s.querySelectorAll(".vihko-a5")[i];
          return {
            arkkeja: sh.length,
            kansi: !!sh[0] && side(sh[0], 0)?.classList.contains("vihko-blank") && !!side(sh[0], 1)?.querySelector(".vk-cover"),
            aukeama: sh.slice(1).some(s => side(s, 0)?.querySelector(".vk-h2") && side(s, 1)?.querySelector(".cb-grids")),
          };
        });
        await page.evaluate(() => { document.getElementById("vihkoPrint")?.remove(); document.body.classList.remove("vihko-printing"); window.print = window.__rp2; });
        (lj.arkkeja >= 2 && lj.kansi && lj.aukeama)
          ? ok(`vihko lukujärjestyksessä: ${lj.arkkeja} arkkia, kansi ensin, linjan kartta ja aikataulu samalla arkilla`)
          : fail("vihko lukujärjestyksessä pielessä: " + JSON.stringify(lj));
      } else fail("vihko: lukujärjestyksen nappi #bookletPrintA5Read puuttuu");
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
  // Valintayhteenveto napin viereen (Villen palaute 23.9.2026): pikavalinnan jälkeen näkymän on
  // kerrottava mitä valittiin ilman vieritystä listaan. Ahtialan käytävä = 4, 14, 24, 34K.
  const corrSum = await page.$eval("#corrStatus", el => el.textContent.trim());
  (/\b4\b/.test(corrSum) && /34K/.test(corrSum) && /\d/.test(corrSum))
    ? ok(`tulosteet: pikavalinta näkyy napin vieressä ("${corrSum}")`)
    : fail(`tulosteet: pikavalinnan yhteenveto puuttuu napin vierestä ("${corrSum}")`);
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
        mapImgs: [...document.querySelectorAll("#corridorOut .print-map img, #corridorOut .print-map image")].filter(i => !i.closest(".pm-base")).length,   // taustakarttatiilet (.pm-base) sallittu 23.9.2026
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
    // Suunta alkaa sivun yläreunasta (Villen linjaus 23.9.2026): Joensuun näytteessä suunta alkoi
    // sivun alaosasta kolmella rivillä ja katkesi. Reittikaavion jälkeen jokainen suunta alkaa
    // uudelta sivulta; print-median laskettu break-before kertoo sen ilman PDF:ää.
    const corrBrk = await page.evaluate(() => ({
      kartta: !!document.querySelector("#corridorOut .corridor-head")?.classList.contains("has-map"),
      dirs: [...document.querySelectorAll("#corridorOut .corridor-dir")].map(d => getComputedStyle(d).breakBefore),
    }));
    await page.emulateMediaType("screen");
    (corrBrk.dirs.length >= 2 && corrBrk.dirs.slice(1).every(b => b === "page")
      && corrBrk.dirs[0] === (corrBrk.kartta ? "page" : "auto"))
      ? ok(`yhdistetyt suunnat: jokainen suunta alkaa uuden sivun yläreunasta (${corrBrk.dirs.join(", ")}${corrBrk.kartta ? ", kaavio kansisivulla" : ""})`)
      : fail("yhdistetyt suunnat: suunta voi alkaa kesken sivun: " + JSON.stringify(corrBrk));
    rk && rk.korkeudet.length === 1
      ? ok(`yhdistetyt suunnat: rivikorkeus tasainen printissä (${rk.riveja} riviä, ${rk.korkeudet[0]} px)`)
      : fail("yhdistetyt suunnat: rivikorkeudet vaihtelevat printissä → taulukko lukee vinona: "
          + JSON.stringify(rk));
  } else fail("yhdistetyt suunnat: taulukko ei koostunut (Ahtiala 4/14/24/34K)");

  // Välilehden vaihto: klikkaa "Näyttöverkosto" -> naytot-paneeli näkyviin + URL päivittyy (replaceState)
  // Odotus on aria-pressedissä eikä sleepissä: 200 ms ei riittänyt kun edellinen tarkistus oli juuri
  // emuloinut print-mediaa (CI 3f0baec 31.8. ja paikallinen ajo 3.9. kaatuivat molemmat siihen, että
  // klikkaus ei ollut vielä rekisteröitynyt). Uusinta oli aina vihreä, eli vika oli vartijassa.
  // DOM-klikkaus: käytävätuloste vierittää sivua pehmeästi, ja koordinaattiklikkaus osui ohi
  // (CI fe7f146 23.9.2026: aktiivinen jäi 'kaytava', vaikka paikallinen ajo oli vihreä).
  await page.$eval('.ptab[data-ptab="naytot"]', el => el.click());
  await page.waitForFunction(
    () => document.querySelector('.ptab[aria-pressed="true"]')?.dataset.ptab === "naytot",
    { timeout: 10000 }).catch(() => {});
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
      // Odotetaan näkymää eikä kiinteää aikaa: 150 ms ei aina riittänyt CI:ssä (prod-smoke 24.9.).
      // Aikakatkaisu ei kaada tässä, vaan alla oleva tarkistus raportoi vajaan näkymän.
      await page.waitForFunction((i, l) => {
        const el = document.getElementById(i);
        return el && el.getAttribute("lang") === l && el.querySelector("h2") && el.querySelectorAll("h3").length >= 5;
      }, { timeout: 5000 }, id, lg).catch(() => {});
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
  // Eristys seuraavista: kielenvaihdot käynnistävät näkymien latauksia, jotka voivat valmistua vasta
  // seuraavan testin aikana ja piirtää sen päälle (CI 25.9.2026: #batchLine katosi 30 ms piirtymisen
  // jälkeen, kun legal-silmukka ei enää odottanut kiinteää aikaa). Täysi lataus katkaisee ne.
  await page.reload({ waitUntil: "networkidle2" });

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
  // Linjatulosteet samalta sivulta (3.9.2026): ennen ne olivat vain linjasivulla, jonne
  // pääsi etusivun kautta. Napit vievät #/linja/<id>?print=..., joka ajaa saman
  // tulostusfunktion kuin linjasivun napit; tarkistetaan valikko, napit ja se että
  // hashin kyselyosa siivotaan pois JA ?city= säilyy (regressio 3.9.: href.split("?") söi molemmat).
  if (await expect("#linePrintSel", "tulosteet-keskus: linjatulosteet löytyvät samalta sivulta")) {
    const lp = await page.evaluate(() => ({
      lines: document.querySelectorAll("#linePrintSel option").length,
      btns: [...document.querySelectorAll(".linePrintBtn")].map(b => b.dataset.lp).join(","),
    }));
    (lp.lines > 1 && lp.btns === "rack,key,all")
      ? ok(`tulosteet-keskus: linjatulosteet (${lp.lines} linjaa, napit ${lp.btns})`)
      : fail("tulosteet-keskus: linjatulosteiden valikko tai napit puuttuvat: " + JSON.stringify(lp));
  }
  // --- Tiskin tulostepolut: kysely esivalitsee JA koonti käynnistyy (3.9.2026) ---
  // Palvelutiski ei kokoa mitään itse vaan avaa nämä osoitteet uuteen välilehteen. Jos
  // kysely lakkaa toimimasta, tiskin napit näyttäisivät toimivan mutta tuottaisivat tyhjän
  // lomakkeen. Assertio vaatii kootun tulosteen, ei pelkkää sivun latausta.
  // Tulostusdialogi pois kaikista seuraavista latauksista jo ennen sivun skriptejä:
  // koonti kutsuu window.printia itse, ja headless jäisi odottamaan dialogia.
  await page.evaluateOnNewDocument(() => { window.print = () => {}; });
  const kaksiLinjaa = await page.evaluate(() =>
    [...document.querySelectorAll(".lineCb")].slice(0, 2).map(c => c.value));
  await page.goto(BASE + "/#/tulosteet/vihko?lines=" + kaksiLinjaa.map(encodeURIComponent).join(",") + "&go=1",
    { waitUntil: "networkidle2" });
  const vihkoKoonti = await page.waitForFunction(
    () => document.querySelectorAll("#bookletOut .booklet-line").length >= 2 ? true : null,
    { timeout: 90000 }).then(() => true).catch(() => false);
  vihkoKoonti
    ? ok(`tiskin tulostepolut: ?lines= kokoaa vihkon kahdesta linjasta (${kaksiLinjaa.join(", ")})`)
    : fail("tiskin tulostepolut: ?lines=&go=1 ei koonnut vihkoa 90 s kuluessa");
  const presetKey = await page.evaluate(() => (CONFIG.corridors || [])[0]?.key || "");
  if (presetKey) {
    await page.goto(BASE + "/#/tulosteet/kaytava?corridor=" + encodeURIComponent(presetKey) + "&go=1",
      { waitUntil: "networkidle2" });
    const rivit = await page.waitForFunction(
      () => document.querySelectorAll("#corridorOut table.corridor tbody tr").length > 5
        ? document.querySelectorAll("#corridorOut table.corridor tbody tr").length : null,
      { timeout: 90000 }).then(h => h.jsonValue()).catch(() => 0);
    rivit > 5 ? ok(`tiskin tulostepolut: ?corridor=${presetKey} kokoaa yhdistetyn suunnan (${rivit} riviä)`)
              : fail(`tiskin tulostepolut: ?corridor=${presetKey}&go=1 ei koonnut käytävää 90 s kuluessa`);
  } else info("tiskin tulostepolut: kaupungilla ei ole käytäväpresettejä");
  // Erätulostus: koonti on pitkä (kymmeniä pysäkkejä, patternit ja vuorot haetaan ensin
  // esikyselyinä), joten vartija hyväksyy kaksi todistetta: edistymislaskuri n/m TAI
  // valmis arkkinippu. Pelkkä "valmistellaan" ei riitä, se näkyy heti klikkauksesta.
  // Mitattu 3.9.2026: Lahti linja 1 ei ehtinyt laskuriin 60 s:ssa, linja 3 kokosi 90 s:ssa.
  await page.goto(BASE + "/#/tulosteet/julisteet?line=" + encodeURIComponent(kaksiLinjaa[0]) + "&go=1",
    { waitUntil: "networkidle2" });
  const eraTila = await page.waitForFunction(
    () => {
      if (document.querySelector("#batchOut .poster-day")) return "koottu";
      const st = document.getElementById("batchStatus")?.textContent || "";
      return /\d+\s*\/\s*\d+/.test(st) ? "kaynnissa" : null;
    },
    { timeout: 120000 }).then(h => h.jsonValue()).catch(() => "");
  const eraValinta = await page.evaluate(() => document.getElementById("batchLine")?.value || "");
  (eraTila && eraValinta === kaksiLinjaa[0])
    ? ok(`tiskin tulostepolut: ?line=&go=1 esivalitsee linjan ja käynnistää erätulostuksen (${eraTila})`)
    : fail(`tiskin tulostepolut: erätulostus ei käynnistynyt 120 s kuluessa (tila "${eraTila}", valinta "${eraValinta}")`);
  // Yhden linjan tulosteet: linjasivun ?print= on tiskin ainoa reitti näihin kolmeen.
  for (const tila of ["rack", "key", "all"]) {
    await page.goto(BASE + "/#/linja/" + encodeURIComponent(kaksiLinjaa[0]) + "?print=" + tila,
      { waitUntil: "networkidle2" });
    const koottu = await page.waitForFunction(
      () => document.querySelectorAll("#linePrintOut table").length ? true : null,
      { timeout: 60000 }).then(() => true).catch(() => false);
    koottu ? ok(`tiskin tulostepolut: ?print=${tila} kokoaa linjatulosteen`)
           : fail(`tiskin tulostepolut: ?print=${tila} ei koonnut tulostetta 60 s kuluessa`);
    // Lehtiteline: toinen suunta alkaa uuden arkin yläreunasta (Villen linjaus 23.9.2026).
    if (tila === "rack" && koottu) {
      await page.emulateMediaType("print");
      const rb = await page.evaluate(() =>
        [...document.querySelectorAll("#linePrintOut .rack-dir")].map(d => getComputedStyle(d).breakBefore));
      await page.emulateMediaType("screen");
      (rb.length >= 2 && rb[0] !== "page" && rb.slice(1).every(b => b === "page"))
        ? ok(`lehtiteline: 1. suunta otsikon alla, muut suunnat uuden arkin yläreunasta (${rb.join(", ")})`)
        : fail("lehtiteline: suunta voi alkaa kesken arkin: " + JSON.stringify(rb));
      // Päivätyyppi taulukon toistuvassa otsikkorivissä (täysauditointi 27.9.2026): palstasta toiseen jatkuva
      // lauantaitaulukko näytti ilman otsikkoa arkiaikojen jatkolta.
      const dr = await page.evaluate(() => [...document.querySelectorAll("#linePrintOut .rack-day")].map(d => ({
        h4: d.querySelector("h4.daytype")?.textContent.trim(), rivi: d.querySelector("thead tr.rack-dayrow th")?.textContent.trim() })));
      (dr.length && dr.every(x => x.rivi && x.rivi === x.h4))
        ? ok(`lehtiteline: päivätyyppi toistuvassa otsikkorivissä (${dr.length} päivälohkoa)`)
        : fail("lehtiteline: päivätyyppi puuttuu taulukon otsikkoriviltä: " + JSON.stringify(dr.slice(0, 3)));
    }
  }

  // Yhden pysäkin juliste Tulosteet-sivulta (27.9.2026): haku, valinta ja nappi vievät pysäkin
  // sivulle ?print=poster, joka kokoaa saman julisteen kuin pysäkin oma nappi. Ennen tätä
  // yksittäistä pysäkkiä ei voinut tulostaa Tulosteet-sivulta lainkaan (Villen havainto).
  await page.goto(BASE + "/#/tulosteet/julisteet", { waitUntil: "networkidle2" });
  if (!await page.waitForSelector("#posterStopQ", { timeout: 20000 }).then(() => true).catch(() => false)) {
    fail("tulosteet: pysäkin juliste, hakukenttä #posterStopQ puuttuu");
  } else {
    await page.evaluate(() => { window.__psPrinted = false; window.print = () => { window.__psPrinted = true; }; });
    await page.type("#posterStopQ", "Matkakeskus", { delay: 30 });
    if (!await page.waitForSelector("#posterStopList button[data-s]", { timeout: 20000 }).then(() => true).catch(() => false)) {
      fail("tulosteet: pysäkin juliste, haku ei antanut pysäkkiehdotuksia");
    } else {
      await page.$eval("#posterStopList button[data-s]", b => b.click());
      await page.$eval("#posterStopGo", b => b.click());
      const ps = await page.waitForFunction(() =>
        window.__psPrinted && document.querySelector("#stopPrintOut .poster-day .hourgrid tr")
          ? { hash: location.hash, rivit: document.querySelectorAll("#stopPrintOut .hourgrid tbody tr").length } : null,
        { timeout: 60000 }).then(h => h.jsonValue()).catch(() => null);
      (ps && /^#\/pysakki\/[^?]+$/.test(ps.hash) && ps.rivit >= 3)
        ? ok(`tulosteet: pysäkin juliste haulla, pysäkin sivu kokosi ja tulosti julisteen (${ps.rivit} tuntiriviä, kysely poistettu osoitteesta)`)
        : fail("tulosteet: pysäkin juliste ei koostunut haun kautta: " + JSON.stringify(ps));
      // A1-juliste (28.9.2026): A4-asettelu skaalattuna A1-arkille (594 x 841 mm), yksi arkki, isommat portaat.
      // Chrome ei tunne A1-avainsanaa, joten sivukoko on millimetreinä; avainsanalla PDF tuli Letter-koossa.
      if (ps) {
        await page.evaluate(() => { window.__psPrinted = false; });
        await page.goto(BASE + "/" + ps.hash + "?print=poster&size=A1", { waitUntil: "networkidle2" });
        const a1 = await page.waitForFunction(() => window.__psPrinted && document.querySelector("#stopPrintOut .poster-day")
          ? { page: document.getElementById("pageOrient")?.textContent || "",
              size: document.querySelector("#stopPrintOut .print-only")?.dataset.size,
              zoom: parseFloat(document.querySelector("#stopPrintOut .print-only")?.style.zoom || "0"),
              status: document.getElementById("stopPrintStatus")?.textContent || "" } : null,
          { timeout: 60000 }).then(h => h.jsonValue()).catch(() => null);
        (a1 && /594mm 841mm/.test(a1.page) && a1.size === "A1" && Math.abs(a1.zoom - 2.828) < 0.01 && !/\d/.test(a1.status))
          ? ok(`tulosteet: A1-juliste yhdellä arkilla (${a1.page.trim()}, zoom ${a1.zoom.toFixed(2)})`)
          : fail("tulosteet: A1-juliste pielessä: " + JSON.stringify(a1));
      }
    }
  }

  // Rengaslinjan pysäkkisarakkeet (28.9.2026): lähtö- ja päätepysäkki ovat sama pysäkki. Tunnusavaimella
  // päätteen poisto keepMonotonessa osui myös lähtösarakkeeseen, ja Imatran linjan 21 lähtösarake oli
  // pelkkiä pisteitä. Vakioaineisto: A 07.00, B 07.05, C 07.10, A 07.15.
  {
    const cells = await page.evaluate(() => {
      const box = document.createElement("div");
      box.innerHTML = bookletRowsHtml([{ stoptimes: [
        { stop: { gtfsId: "A" }, scheduledDeparture: 25200 }, { stop: { gtfsId: "B" }, scheduledDeparture: 25500 },
        { stop: { gtfsId: "C" }, scheduledDeparture: 25800 }, { stop: { gtfsId: "A" }, scheduledDeparture: 26100 }] }],
        [{ gtfsId: "A", name: "A" }, { gtfsId: "B", name: "B" }, { gtfsId: "C", name: "C" }, { gtfsId: "A", name: "A" }]);
      return [...box.querySelectorAll("tbody td")].map(td => td.textContent.trim());
    });
    cells.join(" ") === "07:00 07:05 07:10 07:15"
      ? ok("vihon pysäkkisarakkeet: rengaslinjan lähtö- ja päätesarake saavat omat aikansa (vakioaineisto)")
      : fail("vihon pysäkkisarakkeet: rengaslinja väärin: " + JSON.stringify(cells));
    // Kesken lenkin alkava vuoro käy A:lla vain lopussa: aika kuuluu viimeiseen sarakkeeseen, ei ensimmäiseen.
    const mid = await page.evaluate(() => {
      const box = document.createElement("div");
      box.innerHTML = bookletRowsHtml([{ stoptimes: [
        { stop: { gtfsId: "B" }, scheduledDeparture: 25500 }, { stop: { gtfsId: "C" }, scheduledDeparture: 25800 },
        { stop: { gtfsId: "A" }, scheduledDeparture: 26100 }] }],
        [{ gtfsId: "A", name: "A" }, { gtfsId: "B", name: "B" }, { gtfsId: "C", name: "C" }, { gtfsId: "A", name: "A" }]);
      return [...box.querySelectorAll("tbody td")].map(td => td.textContent.trim());
    });
    mid.join(" ") === "· 07:05 07:10 07:15"
      ? ok("vihon pysäkkisarakkeet: kesken lenkin alkavan vuoron paluu viimeiseen sarakkeeseen (vakioaineisto)")
      : fail("vihon pysäkkisarakkeet: kesken lenkin alkava vuoro väärin: " + JSON.stringify(mid));
  }

  // Julisteen kolme korjausta (kaupunkitarkastus 29.9.2026), vakioaineisto:
  // (1) keskustan solmupysäkin saapuva vuoro pysäkkien koordinaateilla: kauas jatkava lähtee (Inkoo 11
  //     15.30), seuraavalle pysäkille päättyvä saapuu ajasta riippumatta (Turku C4 24, 330 s), kahden pysäkin
  //     päähän päättyvä ja koordinaatiton ennallaan (Turku B9 ei saa tyhjentyä);
  // (2) kokonaan uusi linja saa jakson "alkaen" ja ikkunan omasta alustaan (Lahti 28, perjantai putosi);
  // (3) arkkimäärä sivunvaihdot simuloiden: katkeamaton lohko siirtyy seuraavalle arkille (Oulu 4 vs 5).
  {
    const r = await page.evaluate(() => {
      const c = (CONFIG.centerStopNames || [])[0];
      if (!c) return { skip: true };
      const far = { stopsLeft: 6, remainingM: 2784, terminalM: 2513 }, near = { stopsLeft: 1, remainingM: 494, terminalM: 494 };
      const days = [];
      for (let k = 14; k < 70; k++) {
        const x = new Date(); x.setDate(x.getDate() + k);
        if (x.getDay() >= 1 && x.getDay() <= 5) days.push(isoOf(x).replace(/-/g, ""));
      }
      const g = groupTripsByDays([{ serviceId: "uusi", activeDates: days, stoptimes: [{ scheduledDeparture: 64800 }] }],
        todayISO(), { markNew: true });
      const box = document.createElement("div");
      box.className = "poster-measure poster-compact";
      document.body.appendChild(box);
      const st = document.createElement("div");
      st.className = "poster-stop";
      st.innerHTML = `<div class="poster-head" style="height:100px;width:100%"></div>` +
        [0, 1, 2].map(() => `<section class="poster-day" style="height:600px;width:100%"></section>`).join("");
      let sheets;
      try { sheets = posterSheetCount(st, box); } finally { box.remove(); }
      return {
        rule: [arrivingHere("Kaukokylä", c, 300, false, c, far), arrivingHere(CONFIG.city, c, 300, false, c, far),
          arrivingHere("Kaukokylä", c, 330, false, c, near), arrivingHere("Kaukokylä", c, 300, false, c),
          arrivingHere("Kaukokylä", c, 330, false, c), arrivingHere("Kaukokylä", c, 330, false, c, { stopsLeft: 2, remainingM: 700, terminalM: 470 })],
        groups: g.map(x => ({ dows: [...x.dows].sort().join(","), from: x.period && x.period.from, to: x.period && x.period.to })),
        first: +days[0], sheets, simple: Math.ceil(1900 / POSTER_SHEET_PX),
      };
    });
    if (r.skip) ok("julisteen korjaukset: kaupungilla ei keskustan solmupysäkkejä, sääntötesti ohitettu");
    else {
      JSON.stringify(r.rule) === "[false,true,true,true,false,false]"
        ? ok("julisteen saapuvat vuorot: kauas jatkava lähtee, kaupunkikilpi ja seuraavalle pysäkille päättyvä saapuvat, kahden pysäkin ja koordinaatiton ennallaan")
        : fail("julisteen saapuvat vuorot väärin (odotettu [false,true,true,true,false,false]): " + JSON.stringify(r.rule));
      r.groups.length === 1 && r.groups[0].dows === "0,1,2,3,4" && r.groups[0].from === r.first && !r.groups[0].to
        ? ok(`julisteen uusi linja: Ma–Pe ja jakso ${r.first} alkaen (vakioaineisto)`)
        : fail("julisteen uusi linja väärin: " + JSON.stringify(r));
      r.sheets === 3 && r.simple === 2
        ? ok("julisteen arkkimäärä: sivunvaihtojen simulointi 3 arkkia, pelkkä korkeus olisi antanut 2 (vakioaineisto)")
        : fail("julisteen arkkimäärä väärin: " + JSON.stringify({ sheets: r.sheets, simple: r.simple }));
    }
  }

  // Kaupungin vihkon malli, painovalmis kapea vihko (Lappeenranta 100 x 200 mm, 28.9.2026). Rakenne:
  // sivumäärä neljällä jaollinen, ei leikkautuvaa sisältöä, kansi ja takakansi, kaupungin omien sivujen
  // paikat, ja sisällysluettelon sivunumero osuu sivulle, jolla linja oikeasti alkaa. Kaupunki palautetaan.
  // Linjastokartat (29.9.2026): paikallisliikenteen (1, 4, 8) ja Imatran (21, 22) kartat piirretään kaistoina
  // (maplibre-gl-lanes-ydin, g.pm-lanes). Varapiirto (vanha sääntö, g.pm-par tai data-lanes-error) on virhe eikä kelpaa.
  {
    const prevCity = await page.evaluate(() => cityKey);
    await page.goto(BASE + "/?city=lappeenranta#/tulosteet/vihko", { waitUntil: "networkidle2" });
    let vn = null;
    if (await page.waitForSelector(".lineCb", { timeout: 30000 }).then(() => true).catch(() => false)) {
      await page.evaluate(() => {
        window.__vnRp = window.print; window.__vnPrinted = false; window.print = () => { window.__vnPrinted = true; };
        document.getElementById("bookletLayout").value = "city";
        document.querySelectorAll(".lineCb").forEach(c => {
          c.checked = ["1", "4", "8", "21", "22", "300"].includes(c.closest("li").querySelector(".badge")?.textContent.trim());
        });
        document.getElementById("buildBtn").click();
      });
      if (await page.waitForSelector("#bookletPrintNarrow", { timeout: 120000 }).then(() => true).catch(() => false)) {
        await page.$eval("#bookletPrintNarrow", b => b.click());
        await page.waitForFunction(() => window.__vnPrinted, { timeout: 60000 }).catch(() => {});
        vn = await page.evaluate(() => {
          const w = document.getElementById("vihkoPrint");
          if (!w || !w.classList.contains("vk-n")) return { puuttuu: true };
          const pages = [...w.querySelectorAll(".vk-np")];
          const kind = k => pages.filter(p => p.classList.contains("vk-np-" + k)).length;
          const clipped = pages.filter(p => { const c = p.querySelector(":scope > .vihko-page-content");
            return c && (c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1); }).length;
          const toc = [];
          for (const pg of pages.filter(p => p.classList.contains("vk-np-toc")))
            for (const tr of pg.querySelectorAll("table.vk-toc tr")) {
              const label = tr.cells[0]?.textContent.trim() || "", n = parseInt(tr.cells[1]?.textContent, 10);
              if (/^\d/.test(label)) toc.push({ label, n, osuu: !!pages[n - 1] && pages[n - 1].textContent.replace(/\s+/g, " ").includes(label.replace(/^\S+\s+/, "")) });
            }
          // Linjastokarttasivut: kaistojen määrä kuvittain, varapiirto ja keskustan suurennos.
          const kartat = pages.filter(p => p.classList.contains("vk-np-map")).map(p => ({
            otsikko: p.querySelector(".vk-h2")?.textContent || "",
            kaistat: [...p.querySelectorAll(".vk-netmap figure.print-map > svg")].map(s => +(s.querySelector("g.pm-lanes")?.getAttribute("data-lanes") || 0)),
            vara: p.querySelectorAll(".vk-netmap g.pm-par, .vk-netmap [data-lanes-error]").length,
            suurennos: p.querySelectorAll(".vk-netinset figure.print-map > svg > g.pm-lanes").length,
            alue: p.querySelectorAll(".vk-netmain .pm-inset-area").length }));
          const res = { sivuja: pages.length, kansi: kind("cover"), taka: kind("back"), kaupunki: kind("city"),
            leikkautuu: clipped, toc, koko: pages[0]?.style.width + " " + pages[0]?.style.height,
            page: document.getElementById("pageOrient")?.textContent || "", kartat };
          w.remove(); document.body.classList.remove("vihko-printing");
          return res;
        });
        // Painotalolle (leikkuuvarat 3 mm + leikkuumerkit, arkki 116 x 216 mm) ja itse tulostettava A4-arkitus.
        for (const [btn, mode] of [["#bookletPrintNarrowBleed", "bleed"], ["#bookletPrintNarrowA4", "a4"]]) {
          await page.evaluate(() => { window.__vnPrinted = false; });
          await page.$eval(btn, b => b.click());
          await page.waitForFunction(() => window.__vnPrinted, { timeout: 60000 }).catch(() => {});
          vn[mode] = await page.evaluate(() => {
            const w = document.getElementById("vihkoPrint");
            if (!w) return null;
            const sheets = [...w.querySelectorAll(".vk-sheet")];
            const r = { tila: w.dataset.mode, sivuja: +w.dataset.pages, arkkeja: sheets.length,
              merkit: sheets.map(s => s.querySelectorAll("i.vk-crop").length),
              page: document.getElementById("pageOrient")?.textContent || "",
              arkki: sheets[0] ? sheets[0].style.width + " " + sheets[0].style.height : "" };
            w.remove(); document.body.classList.remove("vihko-printing");
            return r;
          });
        }
        await page.evaluate(() => { window.print = window.__vnRp; });
      }
    }
    (vn && !vn.puuttuu && vn.sivuja % 4 === 0 && vn.leikkautuu === 0 && vn.kansi === 1 && vn.taka === 1 && vn.kaupunki === 13
      && vn.toc.length >= 3 && vn.toc.every(x => x.osuu) && vn.koko === "100mm 200mm" && /100mm 200mm/.test(vn.page)
      && vn.bleed?.tila === "bleed" && vn.bleed.arkkeja === vn.sivuja && vn.bleed.merkit.every(n => n === 8) && /116mm 216mm/.test(vn.bleed.page)
      && vn.a4?.tila === "a4" && vn.a4.arkkeja * 2 === vn.sivuja && /297mm 210mm/.test(vn.a4.page))
      ? ok(`kapea vihko: ${vn.sivuja} sivua 100 x 200 mm, 0 leikkautuu, 13 kaupungin sivun paikkaa, sisällysluettelo osuu (${vn.toc.length} linjaa); painotalolle ${vn.bleed.arkkeja} arkkia 116 x 216 mm leikkuumerkein, A4-arkitus ${vn.a4.arkkeja} arkkia`)
      : fail("kapea vihko: rakenne pielessä: " + JSON.stringify(vn));
    const km = vn && !vn.puuttuu ? vn.kartat || [] : [];
    const lprKartta = km.find(k => /Lappeenrannan paikallisliikenne/.test(k.otsikko)), imaKartta = km.find(k => /Imatran/.test(k.otsikko));
    (lprKartta && imaKartta && km.every(k => k.vara === 0 && k.kaistat.length > 0 && k.kaistat.every(n => n > 0))
      && lprKartta.kaistat.length === 2 && lprKartta.suurennos === 1 && lprKartta.alue === 1 && imaKartta.kaistat.length === 1)
      ? ok(`kapea vihko: linjastokartat kaistoina (${km.map(k => k.kaistat.join("+")).join(", ")} kaistapolkua), paikallisliikenteen sivulla keskustan suurennos ja sen alue, ei varapiirtoa`)
      : fail("kapea vihko: linjastokartan kaistat pielessä tai varapiirto: " + JSON.stringify(km));
    await page.goto(BASE + "/?city=" + (prevCity || "lahti") + "#/", { waitUntil: "networkidle2" });
  }

  // Lähipysäkkipaketti ("rehtoripaketti", 28.9.2026): paikka kyselyllä, kansisivu (kartta, pysäkit,
  // linjat) ja jokaiselle pysäkille tiivis juliste. Assertio vaatii kootun paketin: virheteksti tai
  // tyhjä linjataulukko ei kelpaa. Kansisivun kirjaimet ovat yhteisiä: sama kirjain ei saa tarkoittaa
  // kahta eri asiaa (pysäkkien julisteissa kirjaimet ovat pysäkkikohtaisia).
  {
    const f = await page.evaluate(() => ({ lat: AREA.focus.lat, lon: AREA.focus.lon }));
    await page.goto(BASE + "/#/tulosteet/lahipysakit?lat=" + f.lat + "&lon=" + f.lon + "&name=" +
      encodeURIComponent("Testipaikka, Keskusta") + "&r=500&go=1", { waitUntil: "networkidle2" });
    const np = await page.waitForFunction(() => {
      const st = document.getElementById("nearStatus")?.textContent || "";
      if (document.querySelector("#nearOut .near-cover")) {
        const legend = [...document.querySelectorAll("#nearOut .near-cover .poster-legend b")].map(b => b.textContent);
        return {
          stops: document.querySelectorAll("#nearOut table.near-stops tbody tr").length,
          lines: document.querySelectorAll("#nearOut table.near-lines tbody tr").length,
          zero: [...document.querySelectorAll("#nearOut table.near-lines tbody tr")].filter(tr => !(parseInt(tr.lastElementChild.textContent, 10) > 0)).length,
          posters: document.querySelectorAll("#nearOut .poster-compact .poster-stop").length,
          marks: document.querySelectorAll("#nearOut .near-cover .pm-stopmark").length,
          place: document.querySelectorAll("#nearOut .near-cover .pm-place").length,
          legendDup: legend.length - new Set(legend).size,
          title: document.querySelector("#nearOut .print-brandhead h2")?.textContent || "",
        };
      }
      return /[a-zäö]{4}/i.test(st) && !/\d+\s*\/\s*\d+|…/.test(st) ? { error: st } : null;
    }, { timeout: 120000 }).then(h => h.jsonValue()).catch(() => null);
    (np && !np.error && np.stops >= 1 && np.lines >= 1 && !np.zero && np.posters === np.stops
      && np.marks === np.stops && np.place === 1 && !np.legendDup && /Testipaikka/.test(np.title))
      ? ok(`lähipysäkit: paketti koottu kyselyllä (${np.stops} pysäkkiä kartalla ja julisteina, ${np.lines} linjariviä, selite yksiselitteinen)`)
      : fail("lähipysäkit: paketti ei koostunut oikein: " + JSON.stringify(np));
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
  await page.waitForSelector("#rpOthers .rpCb", { timeout: 30000 }).catch(() => {});
  await sleep(300);
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

  // --- Etusivun uusintapainatus-nosto: montako painettu tuloste on vanhentunut ---
  // Lahdessa 3.9.2026 seitsemän merkittyä tulostetta oli vanhentunut eikä mikään kertonut
  // sitä: luku oli olemassa vain sen takana että käyttäjä avaa näkymän. Vartija ajaa kolme
  // tilaa: merkinnän jälkeen 0 ilman uutta kyselyä, keinotekoisesti vanhennetulla
  // perustasolla 1, ja tyhjällä perustasolla EI YHTÄÄN kyselyä (uusi kävijä ei maksa tästä).
  // Kyselyt lasketaan kietomalla sormenjälkifunktiot: hash-navigointi ei lataa dokumenttia
  // uudelleen, joten kääre säilyy näkymästä toiseen. Assertiot vertaavat sovelluksen omaan
  // t()-käännökseen, eivät kovakoodattuun tekstiin (kieli voi vuotaa edellisestä lohkosta).
  await page.evaluate(() => {
    localStorage.removeItem(reprintKey());
    localStorage.removeItem(reprintHlKey());
  });
  // Etusivun uudelleenpiirto hash-navigoinnilla + kesto siihen asti kun linjalista on valmis.
  const rpGoHome = () => page.evaluate(() => new Promise(resolve => {
    window.__rpSnapCalls = 0;
    location.hash = "#/tulosteet";
    setTimeout(() => {
      const t0 = performance.now();
      location.hash = "#/";
      const tick = () => {
        const list = document.getElementById("routeList");
        if (list && list.querySelector("a")) return resolve(Math.round(performance.now() - t0));
        if (performance.now() - t0 > 25000) return resolve(-1);
        setTimeout(tick, 50);
      };
      tick();
    }, 400);
  }));
  const rpKaannos = key => page.evaluate(k => t(k, { n: 1 }), key);
  const rpOdotaTeksti = (want, timeout = 90000) => page.waitForFunction(
    w => (document.getElementById("hlReprintDesc")?.textContent || "") === w,
    { timeout }, want).then(() => true).catch(() => false);

  // (c) Oikea polku: valitse yksi linja, aja tarkistus, merkitse painetuksi.
  await page.goto(BASE + "/#/uusintapainatus", { waitUntil: "networkidle2" });
  await page.waitForSelector("#rpOthers .rpCb", { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => {
    window.__rpSnapCalls = 0;
    // Kääre asennetaan tasan kerran: page.goto samaan hash-URLiin EI lataa dokumenttia
    // uudelleen, joten kaksi asennusta laskisi saman kyselyn kahdesti (mitattu 4.9.2026).
    if (!window.__rpWrapped) {
      window.__rpWrapped = true;
      const line = window.reprintLineSnap, corr = window.reprintCorridorSnap;
      window.reprintLineSnap = (...a) => { window.__rpSnapCalls++; return line(...a); };
      window.reprintCorridorSnap = (...a) => { window.__rpSnapCalls++; return corr(...a); };
    }
    document.querySelectorAll(".rpCb").forEach(c => { c.checked = false; });
    const cb = document.querySelector('#rpOthers input.rpCb:not([value^="corr:"])');
    if (cb) { cb.checked = true; document.getElementById("rpGo").click(); }
  });
  const rpMerkitty = await page.waitForFunction(
    () => document.querySelector("#rpOut .rpMark") ? true : null, { timeout: 120000 })
    .then(() => page.evaluate(() => {
      document.querySelector("#rpOut .rpMark").click();
      return Object.keys(reprintLoad()).length;
    })).catch(() => -1);
  const tMerkinnan = await rpGoHome();
  const rpOkTeksti = await rpOdotaTeksti(await rpKaannos("heroHlReprintOk1"), 20000);
  const rpKyselytMerkinnan = await page.evaluate(() => window.__rpSnapCalls);
  (rpMerkitty === 1 && rpOkTeksti && rpKyselytMerkinnan === 0)
    ? ok("etusivun uusintapainatus-nosto: merkinnän jälkeen 0 vanhentunutta, ei uutta kyselyä")
    : fail(`etusivun uusintapainatus-nosto: merkintä ei nollannut lukua (perustasoja ${rpMerkitty}, ` +
           `teksti ${rpOkTeksti}, kyselyitä ${rpKyselytMerkinnan})`);

  // (b) Keinotekoisesti vanhennettu perustaso: nosto näyttää luvun ja tekee tasan 1 kyselyn.
  const rpVanhennettu = await page.evaluate(() => {
    const all = reprintLoad();
    const id = Object.keys(all)[0];
    if (!id || !all[id].sig) return false;
    all[id].sig = { v: 1, kind: all[id].sig.kind, label: all[id].sig.label, dirs: [{
      label: "Vanha päätepysäkki",
      groups: [{ label: "Ma-To", n: 1, first: "00:00", last: "00:01", h: "vanha" }] }] };
    localStorage.setItem(reprintKey(), JSON.stringify(all));
    localStorage.removeItem(reprintHlKey());
    return true;
  });
  const tVanhentuneen = await rpGoHome();
  const rpStaleTeksti = await rpOdotaTeksti(await rpKaannos("heroHlReprintStale1"));
  const rpKyselytVanha = await page.evaluate(() => window.__rpSnapCalls);
  (rpVanhennettu && rpStaleTeksti && rpKyselytVanha === 1)
    ? ok("etusivun uusintapainatus-nosto: vanhentunut perustaso näkyy lukuna (1 kysely)")
    : fail(`etusivun uusintapainatus-nosto: vanhentunut perustaso ei näy (perustaso ${rpVanhennettu}, ` +
           `teksti ${rpStaleTeksti}, kyselyitä ${rpKyselytVanha})`);

  // (a) Tyhjä perustaso: ei yhtään kyselyä, kuvaus jää yleistekstiin.
  await page.evaluate(() => {
    localStorage.removeItem(reprintKey());
    localStorage.removeItem(reprintHlKey());
  });
  const tTyhjan = await rpGoHome();
  await sleep(2000);
  const rpTyhja = await page.evaluate(() => ({
    teksti: document.getElementById("hlReprintDesc")?.textContent || "",
    yleis: t("heroHlReprintDesc"),
    kyselyt: window.__rpSnapCalls,
  }));
  (rpTyhja.teksti === rpTyhja.yleis && rpTyhja.kyselyt === 0)
    ? ok("etusivun uusintapainatus-nosto: tyhjä perustaso ei tee yhtään kyselyä")
    : fail("etusivun uusintapainatus-nosto: tyhjä perustaso: " + JSON.stringify(rpTyhja));

  // Etusivun latausaika ei saa kasvaa: nosto on taustatyötä eikä saa estää ensimmäistä maalausta.
  (tTyhjan > 0 && tVanhentuneen > 0 && tVanhentuneen <= tTyhjan + 1500)
    ? ok(`etusivun uusintapainatus-nosto: etusivu ei hidastu (tyhjä ${tTyhjan} ms, seuranta ${tVanhentuneen} ms, merkitty ${tMerkinnan} ms)`)
    : fail(`etusivun uusintapainatus-nosto: etusivun piirto hidastui (tyhjä ${tTyhjan} ms, seuranta ${tVanhentuneen} ms)`);

  // --- Palvelinvahti: perustaso palvelimelle kaupungin omalla avaimella (4.9.2026) ---
  // Perustaso elää oletuksena vain selaimessa. Kaupungin avaimella se synkronoituu palvelimelle,
  // mutta ILMAN AVAINTA ei saa lähteä yhtään pyyntöä: sama kuri kuin etusivun nostossa, ja se on
  // myös se mikä pitää tämän vartijan vihreänä ennen kuin worker on deployattu.
  const rpSrvReqs = [];
  const rpSrvListener = req => { if (/\/reprint\//.test(req.url())) rpSrvReqs.push(req.url()); };
  page.on("request", rpSrvListener);
  await page.evaluate(() => {
    localStorage.removeItem(reprintSrvKeyName());
    localStorage.removeItem(reprintKey());
    localStorage.removeItem(reprintHlKey());
  });
  await page.goto(BASE + "/#/uusintapainatus", { waitUntil: "networkidle2" });
  await page.waitForSelector("#rpOthers .rpCb", { timeout: 30000 }).catch(() => {});
  await sleep(800);
  const srv = await page.evaluate(() => ({
    paneeli: !!document.querySelector("details.rp-srv"),
    kentta: !!document.getElementById("rpSrvKey"),
    nappi: !!document.getElementById("rpSrvSave"),
    tila: document.getElementById("rpSrvState")?.textContent || "",
    yleis: t("reprintSrvOff"),
    avain: localStorage.getItem(reprintSrvKeyName()),
  }));
  page.off("request", rpSrvListener);
  (srv.paneeli && srv.kentta && srv.nappi && srv.tila === srv.yleis && !srv.avain && rpSrvReqs.length === 0)
    ? ok("palvelinvahti: avainkenttä näkyy ja ilman avainta ei lähde yhtään palvelinkutsua")
    : fail("palvelinvahti: " + JSON.stringify({ ...srv, kutsuja: rpSrvReqs.length }));

  // Yhdistämissääntö on sama molemmin puolin (client reprintMergeUnits, worker mergeReprintUnits):
  // molempien puolten merkinnät säilyvät ja uudempi painomerkintä voittaa. Ilman tätä toinen kone
  // pyyhkisi ensimmäisen merkinnät, ja juuri se hukkaisi sen tiedon jonka takia koko vahti on olemassa.
  const rpMerge = await page.evaluate(() => {
    const sig = { dirs: [] };
    const palvelin = { x: { printed: "2026-09-01T00:00:00Z", sig }, y: { printed: "2026-08-01T00:00:00Z", sig } };
    const paikallinen = { x: { printed: "2026-08-23T00:00:00Z", sig }, z: { printed: "2026-08-23T00:00:00Z", sig } };
    const m = reprintMergeUnits(palvelin, paikallinen);
    return { avaimet: Object.keys(m).sort().join(","), voittaja: m.x.printed };
  });
  (rpMerge.avaimet === "x,y,z" && rpMerge.voittaja === "2026-09-01T00:00:00Z")
    ? ok("palvelinvahti: yhdistäminen säilyttää molempien puolten merkinnät, uudempi voittaa")
    : fail("palvelinvahti: yhdistämissääntö väärin: " + JSON.stringify(rpMerge));

  // --- Vaihtolista ja ajantasaisuusmittari (erä D7, 4.10.2026) ---
  // Pysäkkijuliste on uusintapainatusvahdin oma yksikkö ("stop:<gtfsId>"), painettu ja vaihdettu
  // ovat eri merkintöjä, ja vaihtolista järjestää vanhentuneet ja vaihtoa odottavat asennusreitiksi.
  // Kaikki alla oleva ajetaan synteettisellä datalla: sormenjäljet, osoitteet ja palvelin kääritään
  // sivulla, joten tulos ei riipu päivän aikataulusta eikä yhtään kutsua lähde tuotannon workerille.
  // (1) Puhtaat funktiot: kielestä riippumaton sormenjälki ja luettava ero, ja kuittaus voittaa yhdistämisen.
  const vtPuhdas = await page.evaluate(() => {
    if (typeof reprintStopSigFrom !== "function") return { puuttuu: true };
    const r = { shortName: "4" };
    const blk = (n, shift) => [{ dows: new Set([0, 1, 2, 3, 4]), lines: [{ route: r, headsign: "Keskusta",
      times: Array.from({ length: n }, (_, i) => 18000 + i * 1800 + shift), codes: new Map() }] }];
    const meta = { name: "Testipysäkki", code: "T1", lat: 61.1234567, lon: 25.7654321 };
    const a = reprintStopSigFrom(meta, blk(30, 0)), b = reprintStopSigFrom(meta, blk(28, 0)), c = reprintStopSigFrom(meta, blk(30, 60));
    const u = { printed: "2026-10-01T08:00:00Z", sig: a };
    const m = reprintMergeUnits({ x: u }, { x: { ...u, installed: "2026-10-02T08:00:00Z" } });
    return { k: a.dirs[0].groups[0].k, lat: a.lat, ero: reprintDiff(a, b), aika: reprintDiff(a, c), sama: reprintDiff(a, a).length,
      odotus: t("reprintDiffTrips", { label: dowLabel(new Set([0, 1, 2, 3, 4])) + " · 4 Keskusta", a: 30, b: 28 }),
      kuittaus: m.x.installed || "" };
  });
  (!vtPuhdas.puuttuu && vtPuhdas.k === "01234|4|Keskusta" && vtPuhdas.lat === 61.12346 && vtPuhdas.ero.length === 1 &&
   vtPuhdas.ero[0] === vtPuhdas.odotus && vtPuhdas.aika.length === 1 && vtPuhdas.sama === 0 && vtPuhdas.kuittaus === "2026-10-02T08:00:00Z")
    ? ok(`vaihtolista: pysäkkijulisteen sormenjälki kielestä riippumaton, ero luettava ("${vtPuhdas.ero[0]}"), kuittaus voittaa yhdistämisen`)
    : fail("vaihtolista: pysäkkijulisteen sormenjälki: " + JSON.stringify(vtPuhdas));

  // (2) Asennusreitti: sekoitettu jono pisteitä suoralla linjalla kulkee järjestyksessä, ja ristikkäinen
  // lähin naapuri -reitti oikaistaan (2-opt) lyhyemmäksi.
  const vtReitti = await page.evaluate(() => {
    if (typeof reprintRouteOrder !== "function") return { puuttuu: true };
    const start = { lat: 61, lon: 25.6 };
    const pts = [5, 1, 4, 2, 3].map(k => ({ lat: 61 + k * 0.01, lon: 25.6 }));
    const jarjestys = reprintRouteOrder(pts, start).map(i => Math.round((pts[i].lat - 61) * 100));
    // Lähin naapuri tuottaa tähän ristikkäisen reitin; oikaisun jälkeen kokonaismatka on lyhyempi.
    const zz = [{ lat: 61, lon: 25.6368 }, { lat: 61.0058, lon: 25.6084 }, { lat: 61.0146, lon: 25.6213 },
      { lat: 61.0066, lon: 25.6301 }, { lat: 61.0151, lon: 25.6217 }];
    const len = o => o.reduce((s, i, k) => s + distM(k ? zz[o[k - 1]] : start, zz[i]), 0);
    const nn = [];
    { const left = new Set([0, 1, 2, 3, 4]); let cur = start;
      while (left.size) { let b = -1, bd = Infinity; for (const i of left) { const d = distM(cur, zz[i]); if (d < bd) { bd = d; b = i; } } nn.push(b); left.delete(b); cur = zz[b]; } }
    const opt = reprintRouteOrder(zz, start);
    return { jarjestys: jarjestys.join(","), nn: Math.round(len(nn)), opt: Math.round(len(opt)), kaikki: opt.slice().sort().join(",") };
  });
  (!vtReitti.puuttuu && vtReitti.jarjestys === "1,2,3,4,5" && vtReitti.opt < vtReitti.nn && vtReitti.kaikki === "0,1,2,3,4")
    ? ok(`vaihtolista: asennusreitti lähimmästä alkaen ja oikaistuna (${vtReitti.nn} m -> ${vtReitti.opt} m)`)
    : fail("vaihtolista: asennusreitti: " + JSON.stringify(vtReitti));

  // (3) Näkymä: synteettinen perustaso viidellä pysäkkijulisteella keskustan pohjoispuolella.
  // A vanhenee (30 -> 28 lähtöä), B on painettu mutta ei vaihdettu, C (77 m B:stä) ja D vanhenevat,
  // E on ajan tasalla. Odotus: reitti A, B+C (sama paikka, 2 julistetta), D; mittari 1/5 = 20 %.
  const vtAvaimet = ["reprintBase:", "reprintHl:", "reprintStops:", "reprintAddr:"];
  const vtAlku = await page.evaluate((avaimet) => {
    const talteen = {};
    for (const p of avaimet) { const k = p + cityKey; talteen[k] = localStorage.getItem(k); localStorage.removeItem(k); }
    talteen.__srv = localStorage.getItem(reprintSrvKeyName());
    localStorage.removeItem(reprintSrvKeyName());
    window.__vtTalteen = talteen;
    const f = AREA.focus;
    const sig = (name, code, dLat, dLon, n) => ({ v: 1, kind: "stop", label: name, code, lat: f.lat + dLat, lon: f.lon + dLon,
      dirs: [{ label: "", groups: [{ k: "01234|4|Keskusta", n, h: "h" + n }] }] });
    const P = "2026-10-01T08:00:00.000Z", I = "2026-10-02T08:00:00.000Z", P2 = "2026-10-03T08:00:00.000Z";
    const base = {
      "stop:T:A": { label: "Testi A", printed: P, installed: I, sig: sig("Testi A", "TA", 0.002, 0, 30) },
      "stop:T:B": { label: "Testi B", printed: P2, sig: sig("Testi B", "TB", 0.010, 0, 30) },
      "stop:T:C": { label: "Testi C", printed: P, installed: I, sig: sig("Testi C", "TC", 0.0105, 0.001, 30) },
      "stop:T:D": { label: "Testi D", printed: P, installed: I, sig: sig("Testi D", "TD", 0.020, 0, 30) },
      "stop:T:E": { label: "Testi E", printed: P, installed: I, sig: sig("Testi E", "TE", -0.030, 0, 30) },
    };
    localStorage.setItem(reprintKey(), JSON.stringify(base));
    // Nykytila: A, C ja D muuttuneet. Kääre korvaa verkkohaun (sama tapa kuin reprintLineSnap-kääre yllä).
    window.__vtOrigSnaps = window.reprintStopSnaps;
    window.reprintStopSnaps = async (ids) => new Map(ids.map(g => {
      const u = base["stop:" + g];
      if (!u) return [g, null];
      const muuttunut = ["T:A", "T:C", "T:D"].includes(g);
      return [g, { ...u.sig, dirs: [{ label: "", groups: [{ k: "01234|4|Keskusta", n: muuttunut ? 28 : 30, h: muuttunut ? "h28" : "h30" }] }] }];
    }));
    // Osoitevihje: käänteinen geokoodaus synteettisenä, ei verkkoa.
    window.__vtOrigFetch = window.fetch;
    window.__vtReprintKutsut = 0;
    window.fetch = (url, opts) => {
      const u = String(url);
      if (/\/reprint\//.test(u)) window.__vtReprintKutsut++;
      if (/\/geocoding\/reverse/.test(u)) {
        const lat = Number(new URL(u, location.href).searchParams.get("point.lat"));
        return Promise.resolve(new Response(JSON.stringify({ features: [{ properties: { name: "Testikatu " + Math.round((lat - f.lat) * 1000) } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return window.__vtOrigFetch(url, opts);
    };
    window.__vtOrigPrint = window.print;
    window.__vtPrinted = 0;
    window.print = () => { window.__vtPrinted++; };
    return true;
  }, vtAvaimet);
  const vtPalauta = () => page.evaluate(() => {
    if (window.__vtOrigSnaps) window.reprintStopSnaps = window.__vtOrigSnaps;
    if (window.__vtOrigFetch) window.fetch = window.__vtOrigFetch;
    if (window.__vtOrigPrint) window.print = window.__vtOrigPrint;
    document.body.classList.remove("rp-vt-printing");
    const t0 = window.__vtTalteen || {};
    for (const [k, v] of Object.entries(t0)) {
      const key = k === "__srv" ? reprintSrvKeyName() : k;
      if (v == null) localStorage.removeItem(key); else localStorage.setItem(key, v);
    }
    delete window.__vtOrigSnaps; delete window.__vtOrigFetch; delete window.__vtOrigPrint;
  }).catch(() => {});
  const vtAvaa = async () => {
    await page.evaluate(() => { location.hash = "#/tulosteet/vihko"; });
    await sleep(300);
    await page.evaluate(() => { location.hash = "#/tulosteet/uusintapainatus"; });
    await page.waitForSelector("#rpVt:not([hidden]) #rpVtBody", { timeout: 30000 }).catch(() => {});
  };
  try {
    await vtAvaa();
    const ennen = await page.evaluate(() => ({
      paikat: document.querySelectorAll("#rpVtList > li").length,
      tarkistamatta: document.getElementById("rpVtSrc")?.textContent || "",
      odotus: t("reprintVtUnknown", { n: 4 }),
    }));
    // Tarkistus vain pysäkkijulisteille (perustasossa ei ole muuta), kääre antaa nykytilan.
    await page.evaluate(() => {
      document.querySelectorAll(".rpCb").forEach(c => { c.checked = c.value.startsWith("stop:T:"); });
      document.getElementById("rpGo").click();
    });
    await page.waitForFunction(() => document.querySelectorAll("#rpVtList > li").length === 3, { timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() => /Testikatu/.test(document.querySelector("#rpVtList .rp-vt-addr")?.textContent || ""), { timeout: 10000 }).catch(() => {});
    const lista = await page.evaluate(() => ({
      paikat: [...document.querySelectorAll("#rpVtList > li")].map(li => [...li.querySelectorAll(".rp-vt-stop")].map(s => s.dataset.id.slice(7)).join("+")).join(","),
      julisteita: document.querySelectorAll("#rpVtList > li")[1]?.querySelector(".rp-vt-title .muted")?.textContent || "",
      odotusJulisteita: t("reprintVtPosters", { n: 2 }),
      osoite: document.querySelector("#rpVtList .rp-vt-addr")?.textContent || "",
      ero: document.querySelector('#rpVtList .rp-vt-stop[data-id="stop:T:A"] .rp-vt-what')?.textContent || "",
      odotusEro: t("reprintDiffTrips", { label: dowLabel(new Set([0, 1, 2, 3, 4])) + " · 4 Keskusta", a: 30, b: 28 }),
      mittari: document.getElementById("rpMeterPct")?.textContent || "",
      huomio: (document.getElementById("rpMeterBody")?.textContent || "").includes(t("reprintMeterNote")),
      merkitseKaikki: !!document.getElementById("rpMarkAll"),
    }));
    (ennen.paikat === 1 && ennen.tarkistamatta.includes(ennen.odotus) && lista.paikat === "A,B+C,D" &&
     lista.julisteita.startsWith(lista.odotusJulisteita) && /^Testikatu \d+$/.test(lista.osoite) &&
     lista.ero.includes(lista.odotusEro) && lista.mittari === "20 %" && lista.huomio && lista.merkitseKaikki)
      ? ok(`vaihtolista: asennusjärjestys ${lista.paikat} keskustasta, vierekkäiset yhdeksi kohteeksi, osoitevihje ja syy (${lista.ero}), mittari ${lista.mittari}`)
      : fail("vaihtolista: näkymä: " + JSON.stringify({ ennen, lista }));

    // (4) Kuittaus: B odotti vaihtoa (painettu, ei vaihdettu) -> sormenjälki säilyy, vain kuittaus.
    // A oli vanhentunut -> uusi sormenjälki nykytilasta, painettu = vaihdettu = nyt.
    const kuittaa = id => page.evaluate(id => document.querySelector(`#rpVtList .rpAck[data-id="${id}"]`)?.click(), id);
    await kuittaa("stop:T:B");
    await page.waitForFunction(() => !document.querySelector('#rpVtList .rpAck[data-id="stop:T:B"]'), { timeout: 10000 }).catch(() => {});
    const b = await page.evaluate(() => ({ u: reprintLoad()["stop:T:B"], pct: document.getElementById("rpMeterPct")?.textContent || "",
      tila: document.getElementById("rpVtStatus")?.textContent || "", odotus: t("reprintVtDoneOk") }));
    await kuittaa("stop:T:A");
    await page.waitForFunction(() => !document.querySelector('#rpVtList .rpAck[data-id="stop:T:A"]'), { timeout: 10000 }).catch(() => {});
    const a = await page.evaluate(() => ({ u: reprintLoad()["stop:T:A"], pct: document.getElementById("rpMeterPct")?.textContent || "",
      jaljella: document.querySelectorAll("#rpVtList .rp-vt-stop").length }));
    (b.u && b.u.installed && b.u.printed === "2026-10-03T08:00:00.000Z" && b.u.sig.dirs[0].groups[0].n === 30 && b.pct === "40 %" &&
     b.tila.startsWith(b.odotus) && a.u && a.u.installed && a.u.installed === a.u.printed && a.u.sig.dirs[0].groups[0].n === 28 &&
     a.pct === "60 %" && a.jaljella === 2)
      ? ok("vaihtolista: kuittaus erottaa painetun ja vaihdetun (odottanut säilyttää sormenjäljen, vanhentunut saa nykyisen), mittari 20 -> 40 -> 60 %")
      : fail("vaihtolista: kuittaus: " + JSON.stringify({ b, a }));

    // (5) Tulostus: A4-lista asennusjärjestyksessä rastitusruutuineen, ja paperille vain lista.
    await page.evaluate(() => document.getElementById("rpVtPrintBtn")?.click());
    await page.waitForFunction(() => window.__vtPrinted > 0, { timeout: 15000 }).catch(() => {});
    const paperi = await page.evaluate(() => ({
      rivit: [...document.querySelectorAll("#rpVtPrint tbody tr")].map(tr => tr.querySelector("b")?.textContent || "").join(","),
      ruudut: document.querySelectorAll("#rpVtPrint td.rp-vt-box span").length,
      otsikko: document.querySelector("#rpVtPrint .print-brandhead h2")?.textContent || "",
      odotusOtsikko: t("reprintVtTitle"),
    }));
    await page.emulateMediaType("print");
    const nakyy = await page.evaluate(() => {
      const d = id => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : "puuttuu"; };
      return { lista: !["none", "puuttuu"].includes(d("rpVtPrint")), tulokset: d("rpOut"), kortti: d("rpVt") };
    });
    await page.emulateMediaType(null);
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    const siivottu = await page.evaluate(() => !document.body.classList.contains("rp-vt-printing") && !document.getElementById("rpVtPrint")?.innerHTML);
    const kutsut = await page.evaluate(() => window.__vtReprintKutsut);
    (paperi.rivit === "Testi C,Testi D" && paperi.ruudut === 2 && paperi.otsikko === paperi.odotusOtsikko &&
     nakyy.lista && nakyy.tulokset === "none" && nakyy.kortti === "none" && siivottu && kutsut === 0)
      ? ok("vaihtolista: tuloste on A4-lista asennusjärjestyksessä rastitusruutuineen, paperille vain lista, ilman avainta 0 palvelinkutsua")
      : fail("vaihtolista: tuloste: " + JSON.stringify({ paperi, nakyy, siivottu, kutsut }));

    // (6) Palvelin kaupungin avaimella (kääritty fetch, ei verkkoa): vahdin päivittäinen tila ja
    // kuukausirivit näkyvät, ja kuittaus lähtee samalla avaimella kuin painomerkintä.
    // Vanha palvelin (ei ack-kenttää): historia ja kuittauksen palvelinosa kertovat sen, eikä mikään kaadu.
    const vtPalvelin = async (ack) => {
      await page.evaluate((ack) => {
        const base = JSON.parse(localStorage.getItem(reprintKey()) || "{}");
        for (const id of Object.keys(base)) delete base[id].installed;   // kaikki odottavat vaihtoa
        base["stop:T:E"].installed = "2026-10-02T08:00:00.000Z";
        base["stop:T:E"].printed = "2026-10-01T08:00:00.000Z";
        localStorage.setItem(reprintKey(), JSON.stringify(base));
        localStorage.removeItem(reprintHlKey());
        localStorage.setItem(reprintSrvKeyName(), "testiavain-ei-oikea-0123456789");
        const kk = todayISO().slice(0, 7);
        window.__vtPost = [];
        const vastaus = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } }));
        const tila = { stale: ["stop:T:E"], checkedAt: todayISO() + "T03:20:00.000Z" };
        const hist = { "2026-09": { d: "2026-09-30", n: 5, ok: 2 }, [kk]: { d: todayISO(), n: 5, ok: 1 } };
        window.fetch = (url, opts) => {
          const u = String(url);
          if (/\/reprint\/status/.test(u)) return vastaus(ack ? { ok: true, ack: true, units: base, updated: null, state: tila, hist }
            : { ok: true, units: base, updated: null, state: tila });
          if (/\/reprint\/baseline/.test(u)) {
            window.__vtPost.push(JSON.parse(opts.body));
            return vastaus(ack ? { ok: true, ack: true, units: {}, state: tila, hist } : { ok: true, units: {}, state: tila });
          }
          if (/\/reprint\//.test(u)) return Promise.resolve(new Response("{}", { status: 404 }));
          return window.__vtOrigFetch(url, opts);
        };
      }, ack);
      await vtAvaa();
      await page.waitForFunction(() => document.querySelectorAll("#rpVtList .rpAck").length > 0, { timeout: 15000 }).catch(() => {});
      const nakyma = await page.evaluate(() => ({
        kuukausia: document.querySelectorAll("#rpMeterHist tbody tr").length,
        huomio: document.getElementById("rpMeterHistNote")?.textContent || "",
        lahde: document.getElementById("rpVtSrc")?.textContent || "",
        eVanha: !!document.querySelector('#rpVtList .rp-vt-stop[data-id="stop:T:E"]'),
      }));
      await page.evaluate(() => document.querySelector('#rpVtList .rpAck[data-id="stop:T:B"]')?.click());
      await page.waitForFunction(() => window.__vtPost.length > 0 && /\S/.test(document.getElementById("rpVtStatus")?.textContent || ""), { timeout: 10000 }).catch(() => {});
      return page.evaluate((nakyma) => {
        const p = window.__vtPost[0] || {};
        const u = (p.units || {})["stop:T:B"] || {};
        return { ...nakyma, avain: p.key === "testiavain-ei-oikea-0123456789", kentat: Object.keys(u).sort().join(","),
          tila: document.getElementById("rpVtStatus")?.textContent || "",
          paikallinen: t("reprintVtAckLocal"), vanhaHuomio: t("reprintMeterOldSrv"),
          palvelinLahde: t("reprintVtSrcServer", { date: fmtDateLong(todayISO()) }) };
      }, nakyma);
    };
    const uusi = await vtPalvelin(true);
    const vanha = await vtPalvelin(false);
    (uusi.kuukausia === 2 && uusi.lahde.includes(uusi.palvelinLahde) && uusi.eVanha && uusi.avain &&
     uusi.kentat === "installed,label,printed,sig" && !uusi.tila.includes(uusi.paikallinen) &&
     vanha.kuukausia === 0 && vanha.huomio === vanha.vanhaHuomio && vanha.avain && vanha.tila.includes(vanha.paikallinen))
      ? ok("vaihtolista: palvelimen päivittäinen tila ja kuukausirivit näkyvät, kuittaus lähtee kaupungin avaimella; vanha palvelin ei kaada vaan kertoo")
      : fail("vaihtolista: palvelin: " + JSON.stringify({ uusi, vanha }));
  } finally {
    await vtPalauta();
  }

  // (7) Etusivu ei laske pysäkkijulisteita: niitä voi olla satoja. Ilman tätä vanha nosto kysyi
  // jokaisen "stop:"-yksikön linjana (reprintLineSnap) ja jokainen etusivun avaus maksoi kyselyn.
  await page.evaluate(() => {
    // Sama kertakääre kuin nostovartijassa yllä (asennetaan vain jos sitä ei vielä ole).
    if (!window.__rpWrapped) {
      window.__rpWrapped = true;
      const line = window.reprintLineSnap, corr = window.reprintCorridorSnap;
      window.reprintLineSnap = (...a) => { window.__rpSnapCalls++; return line(...a); };
      window.reprintCorridorSnap = (...a) => { window.__rpSnapCalls++; return corr(...a); };
    }
    window.__vtTalteen2 = { b: localStorage.getItem(reprintKey()), h: localStorage.getItem(reprintHlKey()) };
    localStorage.setItem(reprintKey(), JSON.stringify({ "stop:T:A": { label: "Testi A", printed: "2026-10-01T08:00:00.000Z",
      sig: { v: 1, kind: "stop", label: "Testi A", lat: AREA.focus.lat, lon: AREA.focus.lon, dirs: [{ label: "", groups: [] }] } } }));
    localStorage.removeItem(reprintHlKey());
  });
  await rpGoHome();
  await sleep(2000);
  const vtEtusivu = await page.evaluate(() => ({ kyselyt: window.__rpSnapCalls, teksti: document.getElementById("hlReprintDesc")?.textContent || "",
    yleis: t("heroHlReprintDesc") }));
  await page.evaluate(() => {
    const s = window.__vtTalteen2 || {};
    if (s.b == null) localStorage.removeItem(reprintKey()); else localStorage.setItem(reprintKey(), s.b);
    if (s.h == null) localStorage.removeItem(reprintHlKey()); else localStorage.setItem(reprintHlKey(), s.h);
  });
  (vtEtusivu.kyselyt === 0 && vtEtusivu.teksti === vtEtusivu.yleis)
    ? ok("vaihtolista: etusivun nosto ei hae pysäkkijulisteita (0 kyselyä), tila tulee tarkistuksesta")
    : fail("vaihtolista: etusivun nosto haki pysäkkijulisteen: " + JSON.stringify(vtEtusivu));

  // (8) Linjan pysäkit seurantaan yhdellä painalluksella (oikea data: linjalla on aina pysäkkejä).
  await page.goto(BASE + "/#/uusintapainatus", { waitUntil: "networkidle2" });
  await page.waitForSelector("#rpStopLineBtn", { timeout: 30000 }).catch(() => {});
  const vtLinja = await page.evaluate(async () => {
    if (!document.getElementById("rpStopLineBtn")) return { puuttuu: true };
    const ennen = localStorage.getItem(reprintStopsKey());
    document.getElementById("rpStopLineBtn").click();
    const t0 = performance.now();
    while (performance.now() - t0 < 20000 && !document.querySelector('.rpCb[value^="stop:"]:checked')) await new Promise(r => setTimeout(r, 200));
    const r = { rastit: document.querySelectorAll('.rpCb[value^="stop:"]:checked').length, ehdokkaat: reprintStopsLoad().length,
      viesti: document.getElementById("rpStopMsg")?.textContent || "" };
    if (ennen == null) localStorage.removeItem(reprintStopsKey()); else localStorage.setItem(reprintStopsKey(), ennen);
    return r;
  });
  (!vtLinja.puuttuu && vtLinja.rastit > 0 && vtLinja.rastit === vtLinja.ehdokkaat && /\d/.test(vtLinja.viesti))
    ? ok(`vaihtolista: linjan pysäkit seurantaan yhdellä painalluksella (${vtLinja.rastit} pysäkkiä rastitettu)`)
    : fail("vaihtolista: linjan pysäkkien lisäys: " + JSON.stringify(vtLinja));
  await page.goto(BASE + "/#/uusintapainatus", { waitUntil: "networkidle2" });

  // --- Navigointi: uusintapainatus on tulostekeskuksen välilehti, ja paluu toimii (4.9.2026) ---
  // Uusintapainatus oli oma irrallinen näkymänsä, josta pääsi pois vain etusivun kautta, vaikka se
  // on tulosteiden ylläpitoa siinä missä muutosvahti. Vanhan osoitteen #/uusintapainatus pitää yhä
  // toimia (etusivun nosto ja QR-linkit osoittavat siihen), mutta sen pitää avata välilehti.
  await page.goto(BASE + "/#/uusintapainatus", { waitUntil: "networkidle2" });
  await page.waitForSelector("#rpOthers .rpCb", { timeout: 30000 }).catch(() => {});
  const rpTab = await page.evaluate(() => ({
    valilehtia: document.querySelectorAll(".ptab").length,
    valittu: document.querySelector('.ptab[aria-pressed="true"]')?.dataset.ptab || "",
    paneeliNakyy: !document.querySelector('.ppanel[data-ppanel="uusintapainatus"]')?.hidden,
    yksikoita: document.querySelectorAll(".rpCb").length,
    osoite: location.hash,
  }));
  (rpTab.valilehtia === 7 && rpTab.valittu === "uusintapainatus" && rpTab.paneeliNakyy &&
   rpTab.yksikoita > 50 && rpTab.osoite === "#/tulosteet/uusintapainatus")
    ? ok(`navigointi: #/uusintapainatus avaa tulostekeskuksen välilehden (${rpTab.valilehtia} välilehteä, ${rpTab.yksikoita} yksikköä)`)
    : fail("navigointi: uusintapainatus-välilehti: " + JSON.stringify(rpTab));

  // Välilehdeltä toiselle ja takaisin: vaihto ei saa piirtää näkymää uudelleen eikä hukata paneelia.
  const rpTabSwitch = await page.evaluate(async () => {
    document.querySelector('.ptab[data-ptab="vihko"]').click();
    const valissa = location.hash;
    document.querySelector('.ptab[data-ptab="uusintapainatus"]').click();
    return { valissa, lopussa: location.hash,
      yksikoita: document.querySelectorAll(".rpCb").length,
      paneeliNakyy: !document.querySelector('.ppanel[data-ppanel="uusintapainatus"]')?.hidden };
  });
  (rpTabSwitch.valissa === "#/tulosteet/vihko" && rpTabSwitch.lopussa === "#/tulosteet/uusintapainatus" &&
   rpTabSwitch.yksikoita > 50 && rpTabSwitch.paneeliNakyy)
    ? ok("navigointi: välilehden vaihto ja paluu säilyttää uusintapainatuksen sisällön")
    : fail("navigointi: välilehtien vaihto: " + JSON.stringify(rpTabSwitch));

  // Paluupolku: suoraan avatussa näkymässä EI Takaisin-nappia (history.back veisi ulos
  // palvelusta), mutta sovelluksen sisällä liikkumisen jälkeen nappi on ja se palaa oikeaan
  // näkymään. Tämä on se vartija joka estää paluun rikkoutumisen QR-koodista tullessa.
  await page.goto(BASE + "/#/liput", { waitUntil: "networkidle2" });
  // Aito uusi dokumentti, kuten QR-koodista tullessa: pelkka page.goto samaan osoitteeseen
  // eri hashilla EI lataa dokumenttia uudelleen vaan on sovelluksen sisainen siirtyma.
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(500);
  const suoraan = await page.evaluate(() => ({
    back: !!document.querySelector(".crumb-back"),
    koti: !!document.querySelector('nav.crumb a[href="#/"]'),
  }));
  (!suoraan.back && suoraan.koti)
    ? ok("navigointi: suoraan avatussa näkymässä vain Etusivu, ei Takaisin-nappia")
    : fail("navigointi: suora avaus: " + JSON.stringify(suoraan));

  await page.evaluate(() => { location.hash = "#/poikkeukset"; });
  await sleep(700);
  const sisalta = await page.evaluate(() => ({
    back: !!document.querySelector(".crumb-back"),
    hash: location.hash,
  }));
  await page.evaluate(() => document.querySelector(".crumb-back")?.click());
  await sleep(700);
  const paluu = await page.evaluate(() => location.hash);
  (sisalta.back && sisalta.hash === "#/poikkeukset" && paluu === "#/liput")
    ? ok("navigointi: Takaisin ilmestyy sovelluksen sisällä ja palaa edelliseen näkymään")
    : fail(`navigointi: paluu ei toiminut (nappi ${sisalta.back}, ${sisalta.hash} -> ${paluu}, odotus #/liput)`);

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
  // Käännetty pysäkkinimi etusivun haussa (4.10.2026): feedin nimet ovat ruotsiksi, ja suomeksi "Tammisaari"
  // ei antanut Pysäkit-ryhmään mitään. Nyt linja-autoasema löytyy pysäkkilinkkinä.
  await page.evaluate(() => { const q = document.getElementById("uniSearch"); q.focus(); q.value = "Tammisaari"; q.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForSelector('#searchResults a[href^="#/pysakki/"]', { timeout: 20000 }).catch(() => {});
  const tmsHome = await page.evaluate(() => ({ kieli: lang,
    pysakit: [...document.querySelectorAll('#searchResults a[href^="#/pysakki/"]')].map(a => a.textContent.replace(/\s+/g, " ").trim()) }));
  await page.evaluate(() => { const q = document.getElementById("uniSearch"); q.value = ""; q.dispatchEvent(new Event("input", { bubbles: true })); });
  (tmsHome.kieli === "fi" && tmsHome.pysakit.some(p => p.startsWith("Tammisaaren linja-autoasema")))
    ? ok(`etusivun haku (Raasepori): suomenkielinen "Tammisaari" löytää pysäkit (${tmsHome.pysakit.length})`)
    : fail("etusivun haku (Raasepori): Tammisaari: " + JSON.stringify(tmsHome));
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
  // Käännetty pysäkkinimi (4.10.2026): Raaseporin feedin nimet ovat ruotsiksi, ja stops(name:) vertaa vain niihin.
  // Suomeksi "Tammisaari" ei löytänyt yhtään pysäkkiä; nyt linja-autoasema löytyy linjoineen listan kärjestä.
  await page.evaluate(() => { const q = document.getElementById("deskStop"); q.focus(); q.value = "Tammisaari"; q.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForSelector("#deskStopList button[data-s]", { timeout: 20000 }).catch(() => {});
  const tms = await page.evaluate(() => ({ kieli: lang,
    rivit: [...document.querySelectorAll("#deskStopList button[data-s]")].map(b => b.textContent.replace(/\s+/g, " ").trim()) }));
  (tms.kieli === "fi" && (tms.rivit[0] || "").startsWith("Tammisaaren linja-autoasema") && /\d/.test(tms.rivit[0]))
    ? ok(`palvelutiski (Raasepori): suomenkielinen "Tammisaari" löytää pysäkit (${tms.rivit.length}, ensin ${tms.rivit[0]})`)
    : fail("palvelutiski (Raasepori): Tammisaari-haku: " + JSON.stringify(tms));
  // Palvelutiski V2 (4.10.2026): areaScoped-kaupungin (Inkoo) yhteishaun pysäkkiriveillä on linjanumerot,
  // ja ne ovat alueen linjoja (loadRoutes). Linjat haetaan yhdellä stops(ids:)-kyselyllä per haku.
  await page.goto(BASE + "/?city=inkoo#/palvelutiski", { waitUntil: "networkidle2" });
  await page.waitForSelector("#deskStop", { timeout: 15000 }).catch(() => {});
  const ikReqs = [];
  const ikListener = req => {
    const pd = req.method() === "POST" ? (req.postData() || "") : "";
    if (pd.includes("stops(ids: $ids) { gtfsId routes")) ikReqs.push(1);
  };
  page.on("request", ikListener);
  await page.evaluate(() => { const q = document.getElementById("deskStop"); q.focus(); q.value = "Inkoo"; q.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForSelector("#deskStopList button[data-s]", { timeout: 20000 }).catch(() => {});
  await sleep(1500);
  page.off("request", ikListener);
  const ik = await page.evaluate(async () => {
    const area = new Set((await loadRoutes()).map(r => r.shortName).filter(Boolean));
    const rows = [...document.querySelectorAll("#deskStopList button[data-s]")].map(b => {
      const m = b.querySelector(".muted")?.textContent || "";
      return m.replace(/^[^:]*:\s*/, "").split(",").map(s => s.trim()).filter(Boolean);
    });
    return { areaScoped: !!CONFIG.areaScoped, pysakit: rows.length, linjallisia: rows.filter(r => r.length).length,
      vieraat: [...new Set(rows.flat().filter(l => !area.has(l)))] };
  });
  (ik.areaScoped && ik.pysakit > 0 && ik.linjallisia > 0 && ik.vieraat.length === 0 && ikReqs.length === 1)
    ? ok(`palvelutiski V2 (Inkoo): hakulistan pysäkeillä linjanumerot (${ik.linjallisia}/${ik.pysakit} pysäkkiä, alueen linjat, 1 linjakysely)`)
    : fail("palvelutiski V2 (Inkoo): pysäkkirivien linjat: " + JSON.stringify({ ...ik, linjakyselyt: ikReqs.length }));
  // Erä B, B6: Inkoon tiskillä on linkki kunnan joukkoliikennesivulle (liput ja hinnat), mutta ei keksittyä hintaa:
  // virallista kertalipun hintaa ei löytynyt (Matkahuolto, matkan pituuden mukaan).
  await page.waitForSelector("#deskFaresSlot a", { timeout: 15000 }).catch(() => {});
  const ikFares = await page.evaluate(() => ({ linkki: document.querySelector("#deskFaresSlot a[href*='inkoo.fi']")?.textContent.trim() || "",
    hinta: /\d,\d\d\s*€/.test(document.getElementById("deskFaresSlot")?.textContent || "") }));
  (ikFares.linkki && !ikFares.hinta)
    ? ok(`palvelutiski B6 (Inkoo): linkki viralliselle lippusivulle ("${ikFares.linkki}"), ei arvattua hintaa`)
    : fail("palvelutiski B6 (Inkoo): hintalinkki: " + JSON.stringify(ikFares));
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
  // Nyt rail voi olla lista. Tarkistus assertoi RAKENNETTA (kaksi asemaotsikkoa, asemaa kohden
  // lähtevät + saapuvat, ei virhelohkoa) eika asemien nimia tai lahtojen sisaltoa: junatarjonta
  // vaihtuu vuorokaudenajan mukaan, mutta asemien maara ei.
  await page.goto(BASE + "/?city=raasepori#/junat", { waitUntil: "networkidle2" });
  await expect("#trainsOut table", "junanaytto (Raasepori): junalahdot renderoityvat");
  const railTwo = await page.evaluate(() => ({
    otsikot: [...document.querySelectorAll("#trainsOut h3.rail-station")].map(h => h.textContent.trim()),
    osiot: document.querySelectorAll("#trainsOut .rail-cols > section").length,
    taulukot: document.querySelectorAll("#trainsOut table").length,
    virhe: !!document.querySelector("#trainsOut .error"),
    intro: document.getElementById("trainsIntro")?.textContent || "",
  }));
  (railTwo.otsikot.length === 2 && railTwo.otsikot[0] !== railTwo.otsikot[1] && railTwo.osiot === 4
    && railTwo.taulukot === 4 && !railTwo.virhe && railTwo.intro.length > 0)
    ? ok(`junanaytto (Raasepori): kaksi asemaa omina lohkoinaan, lähtevät + saapuvat (${railTwo.otsikot.join(" + ")})`)
    : fail("junanaytto (Raasepori): " + JSON.stringify(railTwo));

  // Regressio: yhden aseman kaupungissa ei asemaotsikkoa, lähtevät + saapuvat.
  await page.goto(BASE + "/?city=lahti#/junat", { waitUntil: "networkidle2" });
  await expect("#trainsOut table", "junanaytto (Lahti): junalahdot renderoityvat");
  const railOne = await page.evaluate(() => ({
    otsikot: document.querySelectorAll("#trainsOut .rail-station").length,
    osiot: document.querySelectorAll("#trainsOut .rail-cols > section").length,
    taulukot: document.querySelectorAll("#trainsOut table").length,
    virhe: !!document.querySelector("#trainsOut .error"),
  }));
  (railOne.otsikot === 0 && railOne.osiot === 2 && railOne.taulukot === 2 && !railOne.virhe)
    ? ok("junanaytto: yhden aseman kaupunki ilman asemaotsikkoa, lähtevät + saapuvat")
    : fail("junanaytto (Lahti): " + JSON.stringify(railOne));

  // Siirtojunat pois (Joensuun palaveri 24.9.2026: "MV 10410 Parikkala" näkyi matkustajajunana) ja
  // saapuvat junat (Joensuun toive samasta palaverista). Rajapinnan vastaus korvataan vakioaineistolla
  // omalla sivulla, jotta tarkistus ei riipu päivän junista: lähtevissä IC 99 + MV 10410, saapuvissa
  // IC 98 Helsingistä + MV 10411. Vain IC-junat saavat näkyä, saapuvassa lähtöasema.
  const railPage = await browser.newPage();
  await railPage.setRequestInterception(true);
  const aika = new Date(Date.now() + 30 * 60000).toISOString();
  const rivi = (asema, tyyppi) => ({ stationShortCode: asema, type: tyyppi, scheduledTime: aika,
    trainStopping: true, commercialStop: true, commercialTrack: "1" });
  const juna = (tyyppi, numero, rivit) => ({ trainNumber: numero, trainType: tyyppi,
    trainCategory: "Long-distance", cancelled: false, timeTableRows: rivit });
  const lahtevat = [juna("IC", 99, [rivi("LH", "DEPARTURE"), rivi("HKI", "ARRIVAL")]),
    juna("MV", 10410, [rivi("LH", "DEPARTURE"), rivi("HKI", "ARRIVAL")])];
  const saapuvat = [juna("IC", 98, [rivi("HKI", "DEPARTURE"), rivi("LH", "ARRIVAL")]),
    juna("MV", 10411, [rivi("HKI", "DEPARTURE"), rivi("LH", "ARRIVAL")])];
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
  railPage.on("request", req => {
    if (!req.url().includes("rata.digitraffic.fi/api/v1/live-trains/station/")) return req.continue();
    if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: cors });
    const saapuvatKysely = /[?&]arriving_trains=[1-9]/.test(req.url());
    req.respond({ status: 200, contentType: "application/json", headers: cors,
      body: JSON.stringify(saapuvatKysely ? saapuvat : lahtevat) });
  });
  await railPage.goto(BASE + "/?city=lahti#/junat", { waitUntil: "networkidle2" });
  await railPage.waitForSelector("#trainsOut table", { timeout: 15000 }).catch(() => {});
  const railFix = await railPage.evaluate(() => {
    const osiot = [...document.querySelectorAll("#trainsOut .rail-cols > section")];
    const tunnukset = s => s ? [...s.querySelectorAll("tbody .badge")].map(b => b.textContent.trim()) : null;
    return { lahtevat: tunnukset(osiot[0]), saapuvat: tunnukset(osiot[1]),
      mista: osiot[1]?.querySelector("tbody td:nth-child(3)")?.textContent.trim() || "" };
  });
  // Palvelutiski samalla vakioaineistolla: sivupalstassa lähtevät ja saapuvat, ei siirtoja.
  await railPage.goto(BASE + "/?city=lahti#/palvelutiski", { waitUntil: "networkidle2" });
  await railPage.waitForFunction(() => document.querySelectorAll("#deskTrains table").length >= 2,
    { timeout: 20000 }).catch(() => {});
  railFix.tiski = await railPage.evaluate(() => [...document.querySelectorAll("#deskTrains table")]
    .map(tb => [...tb.querySelectorAll("tbody .badge")].map(b => b.textContent.trim())));
  await railPage.close();
  (JSON.stringify(railFix.lahtevat) === '["IC 99"]')
    ? ok("junanaytto: siirtojuna (MV) ei näy lähtevissä, matkustajajuna (IC) näkyy")
    : fail("junanaytto: siirtojunasuodatin: " + JSON.stringify(railFix));
  (JSON.stringify(railFix.saapuvat) === '["IC 98"]' && railFix.mista && railFix.mista !== "LH")
    ? ok(`junanaytto: saapuvat junat omana taulukkonaan lähtöasemineen (IC 98 ${railFix.mista}), ei siirtoja`)
    : fail("junanaytto: saapuvat junat: " + JSON.stringify(railFix));
  (JSON.stringify(railFix.tiski) === '[["IC 99"],["IC 98"]]')
    ? ok("palvelutiski: junalohkossa lähtevät ja saapuvat, siirtojunat pois (vakioaineisto)")
    : fail("palvelutiski: junalohko vakioaineistolla: " + JSON.stringify(railFix.tiski));

  // --- Päätepysäkin saapumiset eivät ole lähtöjä (Joensuun seutulinjat 24.9.2026) ---
  // Pysäkin JOENSUU julisteessa ja lähtölistassa näkyi saapuvia vuoroja lähtöinä: päätepysäkille
  // saapuvat ja kilvellä "Joensuu - PKKS" 5 min keskussairaalaan jatkavat. Sääntö testataan
  // vakioaineistolla, koska oikean pysäkin sisältö riippuu kellonajasta.
  const saapumiset = await page.evaluate(() => {
    const st = (headsign, dep, loppuId, loppu, alkuId, alku) => ({ headsign, scheduledDeparture: dep,
      trip: { arrivalStoptime: { scheduledArrival: loppu, stop: { gtfsId: loppuId } },
              departureStoptime: { scheduledDeparture: alku, stop: { gtfsId: alkuId } } } });
    const stop = { gtfsId: "X:1", name: "JOENSUU", stoptimesWithoutPatterns: [
      st("Joensuu", 65000, "X:1", 65000, "X:9", 60000),               // päätepysäkille saapuva
      st("Joensuu - PKKS", 25500, "X:2", 25800, "X:9", 22000),        // 5 min jatko sairaalaan
      st("Outokumpu", 65700, "X:3", 69300, "X:9", 64000),             // oikea lähtö
      st("Joensuu", 30000, "X:1", 30600, "X:1", 30000),               // lyhyt silmukka alkaa tästä
      st("Joensuu", 40000, "X:5", 43000, "X:9", 38000)] };            // jatkaa yli 15 min: lähtö
    dropArrivals(stop, "X:1");
    return stop.stoptimesWithoutPatterns.map(s => s.headsign + "@" + s.scheduledDeparture);
  }).catch(e => "virhe: " + e.message);
  (JSON.stringify(saapumiset) === '["Outokumpu@65700","Joensuu@30000","Joensuu@40000"]')
    ? ok("lähtölistat: päätepysäkin saapumiset ja lyhyet jatkot pois, alkupysäkki ja pitkä jatko jäävät")
    : fail("lähtölistat: saapumissuodatin: " + JSON.stringify(saapumiset));

  // --- Julisteen päivätyypit: neljä vertailussa löytynyttä virhettä (Mattersoft-vertailu 25.9.2026) ---
  // Vakioaineistolla, koska oikean syötteen tapahtumavuorot ja aikataulumuutokset ovat ohi viikossa.
  // Viitepäivä pe 25.9.2026, ikkuna 42 pv. Päivät lasketaan viikonpäivistä, ei kirjoiteta käsin.
  const julisteFix = await page.evaluate(async () => {
    const REF = "2026-09-25";
    const paivat = (dows, alku = REF, loppu = "2026-11-05") => {
      const out = [];
      for (const d = new Date(alku + "T12:00:00"); d <= new Date(loppu + "T12:00:00"); d.setDate(d.getDate() + 1))
        if (dows.includes((d.getDay() + 6) % 7)) out.push(isoOf(d).replace(/-/g, ""));
      return out;
    };
    const vuoro = (serviceId, activeDates, sec, headsign) => ({ serviceId, tripHeadsign: headsign, activeDates,
      stoptimes: [{ scheduledDeparture: sec, pickupType: "SCHEDULED", headsign, stop: { gtfsId: "T:1", name: "Testi" } },
                  { scheduledDeparture: sec + 600, pickupType: "SCHEDULED", headsign, stop: { gtfsId: "T:2", name: "Loppu" } }] });
    const r = {};
    // (1) Tapahtumavuoro omalla kilvellä ei saa tulostua viikoittaisena "Pe"-lähtönä, kun linjalla on
    // toistuvia vuoroja. Kokonaan päättyvä linja (vain viimeinen viikko ikkunassa) näkyy yhä.
    const pats = [
      { code: "P:S5a", headsign: "PALOKKA", route: { shortName: "S5" } },
      { code: "P:S5b", headsign: "Keskusta", route: { shortName: "S5" } },
      { code: "P:7", headsign: "Kylä", route: { shortName: "7" } },
      { code: "P:N", headsign: "Yö", route: { shortName: "N1" } },
      { code: "P:C", headsign: "X", route: { shortName: "C1", longName: "Kaupunki-Kylä" } },
    ];
    const memo = new Map([
      ["P:S5a", [vuoro("M-P", paivat([0, 1, 2, 3, 4]), 21600, "PALOKKA")]],
      ["P:S5b", [vuoro("Valon kaupunki pe", ["20260925"], 66180, "Keskusta")]],
      ["P:7", [vuoro("M-P viim", paivat([0, 1, 2, 3, 4], REF, "2026-10-01"), 25200, "Kylä")]],
      // (2 kierros) perjantain yövuoro: Ma–Pe-sarakkeeseen kirjaimella "vain Pe", ei omaa "Pe"-lohkoa
      ["P:N", [vuoro("Pe yö", paivat([4]), 84600, "Yö")]],
      // (2 kierros) kilpi on pelkkä kaupungin nimi -> vuoron päätepysäkki ("Loppu")
      ["P:C", [vuoro("M-P", paivat([0, 1, 2, 3, 4]), 30000, CONFIG.city)]],
    ]);
    const blocks = await stopPosterBlocks("T:1", REF, memo, 2, pats);
    const nakyy = blocks.flatMap(b => b.lines.map(l => (l.route.shortName || "") + " " + l.headsign));
    r.tapahtuma = { keskusta: nakyy.includes("S5 Keskusta"), palokka: nakyy.includes("S5 PALOKKA"), paattyva: nakyy.includes("7 Kylä") };
    r.kanoninen = { lohkot: blocks.map(b => b.label).join("|"), selite: blocks.flatMap(b => (b.legend || []).map(l => l.text)).join("|"),
      kilpi: nakyy.find(x => x.startsWith("C1 ")) || "",
      odotusLohko: dowLabel(new Set([0, 1, 2, 3, 4])), odotusPe: t("compactOnlyDays", { days: dowLabel(new Set([4])) }) };
    // (2) "ei koulp" on loma-aika, "koulp" koulupäivä.
    const koulu = sid => groupTripsByDays([vuoro(sid, paivat([0, 1, 2, 3, 4]), 30000, "X")], REF).map(g => g.school).join(",");
    r.koulu = { eiKoulp: koulu("LINKKI:M-P ei koulp talvi 2025-2026"), koulp: koulu("LINKKI:M-P koulp talvi 2026-2027") };
    // (3) Peräkkäiset eri aikataulut jaetaan voimassaolojaksoiksi; sama aikataulu kahdessa jaksossa ei jakaudu.
    const jaksot = (tB) => groupTripsByDays([
      vuoro("Pe KP alk 9_23", ["20260925", "20261002"], 88860, "X"),
      vuoro("Pe KP alk 10_5", ["20261009", "20261016", "20261030"], tB, "X")], REF)
      .map(g => ({ from: g.period?.from || null, to: g.period?.to || null, n: g.trips.length }));
    r.jakso = { eri: jaksot(88740), sama: jaksot(88860) };
    // (4) Paloitellun päivälohkon otsikko ei saa jäädä yksin arkin alareunaan.
    const box = document.createElement("div");
    box.className = "poster-compact";
    box.innerHTML = `<div class="poster-day poster-day-split"><p class="poster-sub">Su</p></div>`;
    document.body.appendChild(box);
    r.orpo = getComputedStyle(box.querySelector(".poster-sub")).breakAfter;
    box.remove();
    return r;
  }).catch(e => ({ virhe: e.message }));
  const jf = julisteFix;
  (jf.kanoninen && jf.kanoninen.lohkot === jf.kanoninen.odotusLohko && jf.kanoninen.selite === jf.kanoninen.odotusPe
    && jf.kanoninen.kilpi === "C1 Loppu")
    ? ok("juliste: vain Ma–Pe/La/Su, perjantain yövuoro kirjaimella, kaupungin nimi -kilpi päätepysäkiksi (vakioaineisto)")
    : fail("juliste: päivätyypit ja kilpi: " + JSON.stringify(jf.kanoninen || jf));
  (jf.tapahtuma && !jf.tapahtuma.keskusta && jf.tapahtuma.palokka && jf.tapahtuma.paattyva)
    ? ok("juliste: tapahtumavuoro omalla kilvellä ei tulostu viikoittaisena, päättyvä linja näkyy (vakioaineisto)")
    : fail("juliste: tapahtumavuoron suodatus: " + JSON.stringify(jf.tapahtuma || jf));
  (jf.koulu && jf.koulu.eiKoulp === "loma" && jf.koulu.koulp === "koul")
    ? ok("juliste: \"ei koulp\" = loma-aika, \"koulp\" = koulupäivä (vakioaineisto)")
    : fail("juliste: koulu/loma-tunnistus: " + JSON.stringify(jf.koulu || jf));
  (jf.jakso && JSON.stringify(jf.jakso.eri) === '[{"from":null,"to":20261002,"n":1},{"from":20261009,"to":null,"n":1}]'
    && JSON.stringify(jf.jakso.sama) === '[{"from":null,"to":null,"n":1}]')
    ? ok("juliste: kesken ikkunan vaihtuva aikataulu jaetaan jaksoiksi, sama aikataulu ei jakaudu (vakioaineisto)")
    : fail("juliste: voimassaolojaksot: " + JSON.stringify(jf.jakso || jf));
  (jf.orpo === "avoid")
    ? ok("juliste: paloitellun lohkon päivätyyppiotsikko kulkee taulukon mukana (break-after: avoid)")
    : fail("juliste: päivätyyppiotsikon break-after = " + JSON.stringify(jf.orpo ?? jf));

  // --- Lappeenrannan auditoinnin yleiset korjaukset (25.9.2026), vakioaineistolla ---
  // Jokainen näistä oli Lappeenrannan demossa näkyvä vika, mutta korjaus koskee kaikkia kaupunkeja.
  const lprFix = await page.evaluate(() => {
    const r = {};
    // Jokainen tapaus omassa try-lohkossaan: puuttuva funktio ei saa peittää muiden tapausten tulosta
    // (vastatestissä 25.9. koko lohko kaatui ensimmäiseen puuttuvaan funktioon).
    const koe = (nimi, fn) => { try { r[nimi] = fn(); } catch (e) { r[nimi] = "virhe: " + e.message; } };
    // (1) koulu/loma-tunnistus: "koulujen loma-ajat" ja "ei koul" = loma, "ei loma" = koulupäivä
    koe("koulu", () => ["Ma-Pe koulujen loma-ajat 2026-2027", "M-P ei koulp talvi", "Koulupäiväliikenne 2026-2027",
      "M-P ei loma", "Ma-To KP 20261101 asti", "Ma-Pe LP"].map(schoolOf).join(","));
    // (2) rengaslinjan päätepysäkki: edellisen kierroksen saapuminen ja seuraavan lähtö samalla
    // avaimella; saapuminen ensin ei saa poistaa lähtöä
    const st = (dep, loppuId, loppu, alkuId, alku) => ({ headsign: "Vuoksenniska", scheduledDeparture: dep, serviceDay: 0,
      trip: { route: { gtfsId: "X:21", shortName: "21" },
              arrivalStoptime: { scheduledArrival: loppu, stop: { gtfsId: loppuId } },
              departureStoptime: { scheduledDeparture: alku, stop: { gtfsId: alkuId } } } });
    const stop = { gtfsId: "X:1", name: "Vuoksenniska P", routes: [{ gtfsId: "X:21", shortName: "21" }],
      stoptimesWithoutPatterns: [st(45300, "X:1", 45300, "X:1", 42600), st(45300, "X:1", 48000, "X:1", 45300)] };
    try { cleanStopDepartures(stop, "X:1"); r.rengas = stop.stoptimesWithoutPatterns.map(s => s.trip.departureStoptime.scheduledDeparture).join(","); }
    catch (e) { r.rengas = "virhe: " + e.message; }
    // (3) syötteen väärä directionId: pattern kulkee oman suuntansa vastaisesti kadun toisen puolen
    // pysäkeillä (eri gtfsId, ~20 m päässä) -> siirretään toiseen suuntaan
    const s = (id, lat) => ({ gtfsId: id, name: id, lat, lon: 28.0 });
    koe("suunta", () => assignDirKeys([
      { code: "A0", directionId: 0, stops: [s("a1", 61.00), s("a2", 61.01), s("a3", 61.02), s("a4", 61.03)] },
      { code: "B1", directionId: 1, stops: [s("b4", 61.0302), s("b3", 61.0202), s("b2", 61.0102), s("b1", 61.0002)] },
      { code: "V0", directionId: 0, stops: [s("b3", 61.0202), s("b2", 61.0102), s("b1", 61.0002)] },
    ]).map(p => p.code + ":" + dirKey(p)).join(","));
    // (4) keskustan solmupysäkillä kilpi Keskusta/kaupunki ja <= 5 min jäljellä = saapuminen
    const vanha = { c: CONFIG.centerStopNames, city: CONFIG.city };
    CONFIG.centerStopNames = ["Testikatu"]; CONFIG.city = "Testilä";
    // (kierros 2: silmukkakilpi "Lpr-Partala-Soskua-Lpr" päättyy 0 min päästä -> saapuminen kilvestä riippumatta)
    koe("saapuu", () => [arrivingHere("Keskusta", "Testikatu L", 120, false), arrivingHere("Keskusta", "Testikatu L", 600, false),
      arrivingHere("Testilä", "Testikatu I", 200, false), arrivingHere("Lpr-Partala-Soskua-Lpr", "Testikatu L", 0, false),
      arrivingHere("Keskusta", "Muukatu 5", 120, false)].join(","));
    CONFIG.centerStopNames = vanha.c; CONFIG.city = vanha.city;
    // (5) haku: 34 km päässä oleva tarkka alueosuma voittaa lähellä olevan sanan alun; pyöräparkki taakse
    const f = AREA.focus;
    koe("haku", () => rankPlaceHits("Imatra", [{ gtfsId: "x:1", name: "Imatrantie L", lat: f.lat + 0.004, lon: f.lon }],
      [{ name: "Imatra", layer: "localadmin", lat: f.lat + 0.3, lon: f.lon }])[0]?.name);
    koe("pyora", () => rankPlaceHits("matkakeskus", [], [{ name: "Matkakeskus", layer: "bikepark", lat: f.lat, lon: f.lon },
      { name: "Lappeenrannan matkakeskus", layer: "venue", lat: f.lat + 0.01, lon: f.lon }])[0]?.layer);
    // (6) taivutus: -ukse-vartalo
    koe("nl", () => [parseNlTrip("Matkakeskukselta yliopistolle").from, trimFiDest("Matkakeskukseen")].join(","));
    // (7) linjastokartan kaupunkikohtainen hex-väri
    const vs = CONFIG.netLineStyles;
    CONFIG.netLineStyles = { T1: ["#ffdd00", 1] };
    koe("vari", () => { const ns = netStyleFor("T1", "BUS"); return [ns.color, ns.dash === PM_DASHES[1], ns.badgeText].join(","); });
    CONFIG.netLineStyles = vs;
    // (8) napautus osuu myös piirtämättömään varianttiin
    koe("napautus", () => linesNear([{ key: "A", pts: [[0, 0], [0, 0.001]], ptsList: [[[0, 0], [0, 0.001]], [[1, 1], [1, 1.001]]] }],
      { lat: 1, lng: 1.0005 }).map(l => l.key).join(","));
    // (9) vihon reittijana: Lappeenrannan linjan 1 pitkät pysäkkinimet eivät mene päällekkäin eivätkä
    // yli kuvan reunan. Jana rakennetaan oikealla cbStripSvg:llä, ja nimien tekstilaatikot mitataan.
    koe("jana", () => {
      const nimet = ["Kiiskinmäki", "Suolavuorentie-Sahurinkatu keskustasta", "Hallituskatu 42 keskustaan", "Keskusta L",
        "Merenlahdentie 33 keskustasta", "Viipurintie-Ajurinkatu keskustaan"];
      const stops = nimet.map((nimi, i) => ({ gtfsId: "J:" + i, name: nimi }));
      const vuoro = k => ({ _stops: "J", stoptimes: stops.map((stop, i) => ({ stop, timepoint: true, scheduledDeparture: 21600 + k * 1800 + i * 300 })) });
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;width:600px";
      host.innerHTML = cbStripSvg([{ groups: [{ trips: [vuoro(0), vuoro(1)] }] }, { groups: [] }]);
      document.body.appendChild(host);
      const svg = host.querySelector("svg");
      const W = svg.viewBox.baseVal.width;
      // rivi = y-attribuutti: saman nimen rivit ovat 14 yksikön välein ja tekstilaatikko on sitä korkeampi,
      // joten päällekkäisyys lasketaan saman rivin teksteistä
      const tx = [...svg.querySelectorAll('text[font-size="13"]')].map(e => ({ y: e.getAttribute("y"), b: e.getBBox() }));
      host.remove();
      const yli = tx.filter(({ b }) => b.x < 0 || b.x + b.width > W).length;
      let paalle = 0;
      for (let i = 0; i < tx.length; i++) for (let j = i + 1; j < tx.length; j++) {
        const a = tx[i].b, b = tx[j].b;
        if (tx[i].y === tx[j].y && a.x < b.x + b.width && b.x < a.x + a.width) paalle++;
      }
      const bb = tx;
      return [bb.length > 0, yli, paalle].join(",");
    });
    return r;
  }).catch(e => ({ virhe: e.message }));
  const lf = lprFix;
  (lf.koulu === "loma,loma,koul,koul,koul,loma")
    ? ok("koulu/loma: \"koulujen loma-ajat\" ja \"ei koul\" = loma, \"ei loma\" = koulupäivä (vakioaineisto)")
    : fail("koulu/loma-tunnistus: " + JSON.stringify(lf.koulu ?? lf));
  (lf.rengas === "45300")
    ? ok("pysäkkisivu: rengaslinjan lähtö säilyy, kun edellisen kierroksen saapuminen on samalla avaimella (vakioaineisto)")
    : fail("pysäkkisivu: rengaslinjan lähtö: " + JSON.stringify(lf.rengas ?? lf));
  (lf.suunta === "A0:0,B1:1,V0:1")
    ? ok("suunnat: väärällä directionId:llä merkitty pattern siirtyy oikeaan suuntaan (vakioaineisto)")
    : fail("suunnat: " + JSON.stringify(lf.suunta ?? lf));
  (lf.saapuu === "true,false,true,true,false")
    ? ok("keskustan solmupysäkki: <= 5 min ennen loppua päättyvä vuoro on saapuminen kilvestä riippumatta, pitkä jatko ja muu pysäkki lähtö (vakioaineisto)")
    : fail("keskustan saapumiset: " + JSON.stringify(lf.saapuu ?? lf));
  (lf.haku === "Imatra" && lf.pyora === "venue")
    ? ok("haku: kaukainen tarkka alueosuma voittaa lähellä olevan sanan alun, pyöräparkki taakse (vakioaineisto)")
    : fail("haku: " + JSON.stringify({ haku: lf.haku, pyora: lf.pyora, virhe: lf.virhe }));
  (lf.nl === "Matkakeskus,Matkakeskus")
    ? ok("tiskin lause: \"Matkakeskukselta\" ja \"Matkakeskukseen\" -> Matkakeskus")
    : fail("tiskin lause: " + JSON.stringify(lf.nl ?? lf));
  (lf.vari === "#ffdd00,true,#1a1a1a")
    ? ok("linjastokartta: kaupungin oma hex-väri ja tumma teksti vaalealle")
    : fail("linjastokartan väri: " + JSON.stringify(lf.vari ?? lf));
  (lf.napautus === "A")
    ? ok("linjastokartta: napautus osuu myös piirtämättömään liikennöivään varianttiin")
    : fail("linjastokartan napautus: " + JSON.stringify(lf.napautus ?? lf));
  (lf.jana === "true,0,0")
    ? ok("vihon reittijana: pitkät pysäkkinimet eivät mene päällekkäin eivätkä yli reunan (vakioaineisto)")
    : fail("vihon reittijana (nimiä, yli reunan, päällekkäin): " + JSON.stringify(lf.jana ?? lf));

  // --- Myöhästynyt näkymä ei piirrä uudemman päälle (25.9.2026) ---
  // Linjalistan lataus hidastetaan 1,5 s:iin, avataan tulostekeskus ja siirrytään heti lippusivulle.
  // Ennen navSeq-tarkistusta tulostekeskus piirtyi lippusivun päälle latauksen valmistuttua (CI:ssä
  // #batchLine katosi 30 ms piirtymisensä jälkeen, kun vanhentunut näkymä piirsi päälle).
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  const staleNav = await page.evaluate(async () => {
    const orig = loadRoutes;
    loadRoutes = () => new Promise(r => setTimeout(() => r(orig()), 1500));
    try {
      location.hash = "#/tulosteet/julisteet";
      await new Promise(r => setTimeout(r, 200));
      location.hash = "#/liput";
      await new Promise(r => setTimeout(r, 2500));
      return { hash: location.hash, printCenter: !!document.getElementById("batchLine"),
               fares: !!document.querySelector("#app h2")?.textContent.includes(t("faresTitle")) };
    } finally { loadRoutes = orig; }
  });
  (staleNav.hash === "#/liput" && staleNav.fares && !staleNav.printCenter)
    ? ok("navigointi: myöhästynyt tulostekeskus ei piirry lippusivun päälle")
    : fail("navigointi: vanhentunut näkymä piirsi uudemman päälle: " + JSON.stringify(staleNav));
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });

  // --- Henkilöstön tilanne (#/tilanne, ilme 25.9.2026) ---
  // Neljä tilaruutua täyttyvät olemassa olevasta datasta (muutosvahdin yhteenveto, häiriöt, CONFIG.season),
  // päävalikossa Henkilöstö aktiivisena. Rakenne, ei tekstiä: smoke voi olla tässä kohtaa muulla kielellä.
  await page.goto(BASE + "/?city=lappeenranta#/tilanne", { waitUntil: "networkidle2" });
  await page.waitForFunction(() => ["stPosters", "stAlerts"].every(id =>
    (document.querySelector(`#${id} .st-v`)?.textContent || "…") !== "…"), { timeout: 20000 }).catch(() => {});
  const staff = await page.evaluate(() => ({
    ruudut: document.querySelectorAll(".st-tiles .st-tile").length,
    arvot: [...document.querySelectorAll(".st-tiles .st-v")].map(v => v.textContent.trim()),
    rivit: document.querySelectorAll(".st-panel .st-row").length,
    valikko: document.querySelector('#hdrNav a[aria-current="page"]')?.dataset.nav,
  }));
  (staff.ruudut === 4 && staff.arvot.every(v => v && v !== "…") && staff.rivit >= 5 && staff.valikko === "tilanne")
    ? ok(`henkilöstö (Lappeenranta): ${staff.ruudut} tilaruutua täynnä (${staff.arvot.join(" / ")}), ${staff.rivit} toimintoa`)
    : fail("henkilöstö: tilanne-näkymä vajaa: " + JSON.stringify(staff));
  // Kaikkien linjojen vihko (täysauditointi 27.9.2026): (1) SaiPan ottelubussit (CONFIG.eventLines) näkyivät
  // viikoittaisina "To"/"La"-vuoroina, vaikka ne ajetaan vain ottelupäivinä: niitä ei tarjota tulosteille.
  // (2) Silmukkalinjan 120 molemmat suunnat saivat saman otsikon "Joutseno linja-autoasema → Joutseno
  // linja-autoasema": otsikoiden on erotuttava. Linja 120 on kausidataa, joten sen puuttuminen on INFO.
  await page.goto(BASE + "/?city=lappeenranta#/tulosteet/vihko", { waitUntil: "networkidle2" });
  const vk = await page.waitForSelector(".lineCb", { timeout: 30000 }).then(() => page.evaluate(() => {
    const no = cb => (cb.closest("label")?.textContent || "").trim().split(/\s+/)[0];
    const cbs = [...document.querySelectorAll(".lineCb")];
    const ev = CONFIG.eventLines || [];
    const c120 = cbs.find(cb => no(cb) === "120");
    if (c120) { c120.checked = true; c120.dispatchEvent(new Event("change", { bubbles: true })); document.getElementById("buildBtn").click(); }
    return { linjoja: cbs.length, tapahtuma: ev, mukana: cbs.map(no).filter(n => ev.includes(n)), l120: !!c120 };
  })).catch(() => null);
  (vk && vk.linjoja > 10 && vk.tapahtuma.length && !vk.mukana.length)
    ? ok(`tulosteet: tapahtumalinjat (${vk.tapahtuma.join(", ")}) eivät ole vihkon linjalistassa (${vk.linjoja} linjaa)`)
    : fail("tulosteet: tapahtumalinjat vihkon linjalistassa: " + JSON.stringify(vk));
  if (vk && vk.l120) {
    const otsikot = await page.waitForFunction(() => {
      const h = [...document.querySelectorAll("#bookletOut .cb-dir h3")].map(x => x.textContent.trim());
      return h.length >= 2 ? h : null;
    }, { timeout: 90000 }).then(h => h.jsonValue()).catch(() => null);
    (otsikot && new Set(otsikot).size === otsikot.length)
      ? ok(`vihko: silmukkalinjan 120 suunnat erottuvat otsikossa (${otsikot.join(" | ")})`)
      : fail("vihko: silmukkalinjan 120 suuntaotsikot samat tai puuttuvat: " + JSON.stringify(otsikot));
  } else info("vihko: linjaa 120 ei ole Lappeenrannan linjalistassa (kausi?), silmukkaotsikko jäi tarkistamatta");
  await page.goto(BASE + "/?city=lappeenranta#/tilanne", { waitUntil: "networkidle2" });
  // Suuri kontrasti kaupungin värillä (25.9.2026): vaaleassa nappi/teksti ≥ 7:1 valkoista vasten ja kaupungin
  // sävyinen (Lappeenranta magenta, R > B), tummassa tekstisävy ≥ 7:1 mustaa vasten. Tila nollataan lopuksi.
  const hcCheck = async theme => {
    await page.evaluate(t => { localStorage.setItem("contrast", "high"); localStorage.setItem("theme", t); }, theme);
    await page.reload({ waitUntil: "networkidle2" });
    return page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
      const lum = h => { const v = rgb(h).map(c => c / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
      const btn = cs.getPropertyValue("--btn-bg").trim(), txt = cs.getPropertyValue("--blue").trim();
      return { btn, txt, btnWhite: 1.05 / (lum(btn) + 0.05), txtBlack: (lum(txt) + 0.05) / 0.05,
        pink: rgb(btn)[0] > rgb(btn)[2] + 40 };
    });
  };
  const hcLight = await hcCheck("light"), hcDark = await hcCheck("dark");
  await page.evaluate(() => { localStorage.removeItem("contrast"); localStorage.removeItem("theme"); });
  (hcLight.pink && hcLight.btnWhite >= 7 && hcDark.txtBlack >= 7 && hcDark.btnWhite >= 7)
    ? ok(`suuri kontrasti (Lappeenranta): kaupungin väri ${hcLight.btn} ${hcLight.btnWhite.toFixed(1)}:1, tummassa ${hcDark.txt} ${hcDark.txtBlack.toFixed(1)}:1`)
    : fail("suuri kontrasti: kaupungin väri puuttuu tai alle 7:1: " + JSON.stringify({ hcLight, hcDark }));
  // Jaettu reittilinkki ilman ?city (25.9.2026: kaverin jakama Kotkan reitti avautui Lahden sivulle, koska
  // jakonappi pudotti parametrin). about:blank välissä, jotta linkki avautuu tuoreena kuten oikeasti jaettuna.
  await page.goto("about:blank");
  await page.goto(BASE + "/#/reitti/60.57315%2C26.95551%2CTavastilan%20seisake%2C%20Kotka/60.48312%2C26.85813%2CKarhuvuori%2C%20Kotka",
    { waitUntil: "networkidle2" });
  const jako = await page.evaluate(() => ({ city: document.documentElement.dataset.city, search: location.search,
    share: typeof planHash === "function" ? appUrl(planHash()) : "" }));
  (jako.city === "kotka" && jako.search === "?city=kotka" && jako.share.includes("?city=kotka#/reitti/"))
    ? ok("jaettu reittilinkki ilman ?city: Kotka päätellään lähtöpisteestä ja jakolinkki kantaa kaupungin")
    : fail("jaettu reittilinkki: kaupunki väärin tai jakolinkki ilman ?city: " + JSON.stringify(jako));
  await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });

  // --- Kaupungin näkymä (#/kaupunki, 27.9.2026) ---
  // Henkilöstön tilannekuva muutosvahdin viikkoajosta Savikurki-ytimellä (kaupunki.js, vendor/savikurki-ydin/).
  // Odotusarvot lasketaan tässä suoraan docs/muutosvahti/<city>.json:n pysäkkiriveistä, ei sovelluksen
  // koodilla. Rakenne ja data-attribuutit, ei käyttöliittymätekstiä: smoke voi olla tässä kohtaa muulla
  // kielellä (ytimen oma sisältö on aina suomeksi). Näkymän tyylit (ydin.css:n @page) ja ytimen
  // beforeprint eivät saa jäädä päälle muihin näkymiin, joten tulostusturva tarkistetaan erikseen.
  // Viewport ja kaupunki palautetaan lopuksi.
  {
    const vp = page.viewport();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(BASE + "/?city=lappeenranta#/tilanne", { waitUntil: "networkidle2" });
    const ix = await page.evaluate(async () => {
      try { const r = await fetch("docs/muutosvahti/index.json", { cache: "no-cache" }); return r.ok ? await r.json() : null; }
      catch (e) { return null; }
    });
    const ajetut = ix && ix.kaupungit ? Object.keys(ix.kaupungit) : [];
    const lataa = city => page.evaluate(async c => {
      const r = await fetch("docs/muutosvahti/" + c + ".json", { cache: "no-cache" });
      return r.ok ? r.json() : null;
    }, city);
    const pvm = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    // Tilat: vanhentunut voittaa; tulossa + voimaantulo tänään tai myöhemmin = Erääntyy, ohi = Myöhässä,
    // ilman päivää = Uusi; muut ajan tasalla. Tarkastelupäivä = tämä päivä (tai ajopäivä, jos kello jätättää).
    const odotus = j => {
      const ajo = pvm(new Date(j.ajettu)), nyt = pvm(new Date()), T = nyt < ajo ? ajo : nyt;
      const v = (j.yhteenveto || {}).voimaan || null, ps = j.pysakit, n = ps.length;
      const vp = p => p.voimaan || v; // pysäkkikohtainen päivä, vanhassa datassa kaupungin päivä
      const vainR = ps.filter(p => p.tulossa && !p.muuttunut), vain = vainR.length;
      const valmis = ps.filter(p => !p.muuttunut && !p.tulossa).length;
      // Ajan tasalla tänään: tuleva muutos ei tee julisteesta väärää ennen voimaantulopäivää.
      const tanaan = ps.filter(p => !p.muuttunut && !(p.tulossa && vp(p) && vp(p) <= T)).length;
      return { n, valmis, tanaan, v, tarkka: !!(j.yhteenveto || {}).voimaanTarkka, mu: ps.filter(p => p.muuttunut).length, tu: ps.filter(p => p.tulossa).length,
        poik: ps.filter(p => p.poikkeus).length, avoimet: n - valmis, esti: vain,
        eraantyy: vainR.filter(p => vp(p) && vp(p) >= T).length, myohassa: vainR.filter(p => vp(p) && vp(p) < T).length, uusi: vainR.filter(p => !vp(p)).length,
        pros: n ? Math.round(tanaan / n * 100) : null };
    };

    // 1. Henkilöstön Tilanne-sivun yläosan laatta kolmella kielellä: tilannelaattojen alla ennen Tulosta-
    //    ja Asiakaspalvelu-paneeleja, linkki vie #/kaupunki, linkki on sivulla vain kerran, ja otsikko ja
    //    kuvaus ovat sivun kielen käännökset. Kieli palautetaan ennalleen (smoke on tilallinen).
    const kieliEnnen = await page.evaluate(() => localStorage.getItem("lang"));
    const laatat = [];
    for (const kieli of ["fi", "sv", "en"]) {
      await page.evaluate(l => localStorage.setItem("lang", l), kieli);
      await page.reload({ waitUntil: "networkidle2" });
      await page.waitForSelector("#stCity", { timeout: 15000 }).catch(() => {});
      laatat.push(await page.evaluate(k => {
        const laatta = document.getElementById("stCity"), tiles = document.querySelector(".staff .st-tiles");
        return { kieli: k, lang: document.documentElement.lang, kpl: document.querySelectorAll('.staff a[href="#/kaupunki"]').length,
          paikka: !!laatta && laatta.previousElementSibling === tiles && !!laatta.nextElementSibling && laatta.nextElementSibling.classList.contains("st-cols"),
          href: laatta && laatta.querySelector("a") ? laatta.querySelector("a").getAttribute("href") : null,
          otsikko: laatta && laatta.querySelector(".st-rt b") ? laatta.querySelector(".st-rt b").textContent.trim() : "",
          kuvaus: laatta && laatta.querySelector(".st-rt span") ? laatta.querySelector(".st-rt span").textContent.trim() : "",
          odOtsikko: t("cvTitle"), odKuvaus: t("cvDesc") };
      }, kieli));
    }
    await page.evaluate(l => { if (l == null) localStorage.removeItem("lang"); else localStorage.setItem("lang", l); }, kieliEnnen);
    await page.reload({ waitUntil: "networkidle2" });
    (laatat.every(l => l.lang === l.kieli && l.kpl === 1 && l.paikka && l.href === "#/kaupunki" && l.otsikko && l.otsikko === l.odOtsikko
      && l.kuvaus === l.odKuvaus) && new Set(laatat.map(l => l.otsikko)).size === 3)
      ? ok(`kaupungin näkymä: laatta Tilanne-sivun yläosassa tilannelaattojen alla (fi/sv/en: ${laatat.map(l => l.otsikko).join(" / ")}), linkki kerran`)
      : fail("kaupungin näkymä: Tilanne-sivun laatta pielessä: " + JSON.stringify(laatat));
    const linkki = await page.waitForSelector('#stCity a[href="#/kaupunki"]', { timeout: 15000 }).catch(() => null);
    if (linkki) await linkki.click();
    const auki = await page.waitForSelector('#knYdin #sy-nakyma[data-nakyma="yleiskuva"]', { timeout: 20000 }).then(() => true).catch(() => false);
    (linkki && auki)
      ? ok("kaupungin näkymä: Tilanne-sivun laatta avaa näkymän sovelluksen sisällä (Lappeenranta)")
      : fail("kaupungin näkymä: linkki tai näkymä puuttuu: " + JSON.stringify({ linkki: !!linkki, auki }));

    // 2. Yleiskuva (Lappeenranta): jonon laskurit ja kortit riippumattomasti pysäkkiriveistä; hakemusmallin kortit piilossa.
    if (ajetut.includes("lappeenranta") && auki) {
      const e = odotus(await lataa("lappeenranta"));
      const y = await page.evaluate(() => {
        const m = id => { const el = document.querySelector(`#knYdin .sy-kortti[data-mittari="${id}"]`);
          return el ? { arvo: el.dataset.arvo, naytto: el.querySelector(".sy-kortti__arvo").textContent.replace(/\s/g, ""), nakyy: getComputedStyle(el).display !== "none" } : null; };
        return {
          jono: Object.fromEntries([...document.querySelectorAll("#knYdin a.sy-tilanne__linkki")].map(a => [a.dataset.syTila, +a.dataset.syMaara])),
          n: m("pysakkeja"), ajan: m("ajan-tasalla"), mu: m("vanhentuneita"), tu: m("tulossa"), poik: m("poikkeusviikko"), uus: m("uusintapainatus"),
          piilossa: ["saapuneet", "ratkaistut", "maaraajassa", "kasittelyaika", "estetyt", "saasto"].map(m).filter(x => x && x.nakyy).length,
          roolit: getComputedStyle(document.querySelector("#knYdin .sy-roolit")).display,
        };
      });
      const hyva = y.jono.puutteellinen === e.mu && y.jono.eraantyy === e.eraantyy && y.jono.myohassa === e.myohassa
        && y.jono.uusi === e.uusi && y.jono.avoimet === e.avoimet && y.n && +y.n.arvo === e.n && +y.mu.arvo === e.mu
        && +y.tu.arvo === e.tu && +y.poik.arvo === e.poik && +y.uus.arvo === e.avoimet && y.ajan.naytto === `${e.pros}%`
        && y.piilossa === 0 && y.roolit === "none";
      hyva ? ok(`kaupungin näkymä (Lappeenranta): ${e.n} pysäkkiä, ajan tasalla ${e.pros} %, vanhentuneita ${e.mu}, tulossa ${e.tu}, poikkeusviikko ${e.poik} (laskettu JSONista)`)
        : fail("kaupungin näkymä (Lappeenranta): luvut eri kuin JSONista laskettu: " + JSON.stringify({ odotus: e, sivu: y }));
    } else info("kaupungin näkymä: Lappeenrannan muutosvahtia ei ole ajettu, yleiskuvan luvut jäivät tarkistamatta");

    // 3-6. Kaupunki, jolla on eniten uusittavia julisteita: työjono, CSV, Mitä palvelu esti, 390 px.
    const tk = ajetut.slice().sort((a, b) => (ix.kaupungit[b].muuttunut + ix.kaupungit[b].tulossa)
      - (ix.kaupungit[a].muuttunut + ix.kaupungit[a].tulossa))[0];
    if (tk) {
      const e = odotus(await lataa(tk));
      await page.goto(BASE + `/?city=${tk}#/kaupunki/tyojono`, { waitUntil: "networkidle2" });
      await page.waitForSelector("#knYdin #sy-jono-maara", { timeout: 20000 }).catch(() => {});
      const tj = await page.evaluate(() => ({
        laskurit: Object.fromEntries([...document.querySelectorAll("#knYdin [data-sy-laskuri]")].map(el => [el.dataset.syLaskuri, +el.textContent.replace(/\D/g, "")])),
        rivit: +(document.getElementById("sy-jono-maara") || { dataset: {} }).dataset.maara,
        trt: document.querySelectorAll("#knYdin tr[data-sy-kohde]").length,
        tilat: [...new Set([...document.querySelectorAll("#knYdin tr[data-sy-kohde]")].map(tr => tr.dataset.tila))],
        linkit: [...document.querySelectorAll("#knYdin tr[data-sy-kohde] a")].slice(0, 5).map(a => a.getAttribute("href")),
        sarakkeet: [...document.querySelectorAll("#knYdin .sy-jono thead th")].map(th => getComputedStyle(th).display === "none"),
      }));
      const L = tj.laskurit;
      const tilatOk = tj.tilat.every(t => ["puutteellinen", "eraantyy", "myohassa", "uusi"].includes(t));
      const rivitOk = e.avoimet ? tj.trt === e.avoimet && tilatOk && tj.linkit.length && tj.linkit.every(h => h.startsWith("#/pysakki/"))
        && JSON.stringify(tj.sarakkeet) === JSON.stringify([false, false, false, true, true, true, false]) : tj.trt === 0;
      (L.valmis === e.valmis && L.puutteellinen === e.mu && L.eraantyy === e.eraantyy && L.myohassa === e.myohassa && L.uusi === e.uusi
        && L.kasittelyssa === 0 && tj.rivit === e.avoimet && rivitOk)
        ? ok(`kaupungin näkymä (${tk}): työjonossa ${e.avoimet} uusittavaa (vanhentunut ${e.mu}, erääntyy ${e.eraantyy}, myöhässä ${e.myohassa}), ajan tasalla ${e.valmis}; rivit linkittävät pysäkkiin`)
        : fail(`kaupungin näkymä (${tk}): työjono eri kuin JSONista laskettu: ` + JSON.stringify({ odotus: e, sivu: tj }));

      // CSV: ladattu tiedosto siepataan sivulla (ei levylle): BOM, 12 saraketta, rivi per näkyvä juliste.
      const csv = await page.evaluate(async () => {
        const oCreate = URL.createObjectURL, oClick = HTMLAnchorElement.prototype.click;
        let blob = null, nimi = "";
        URL.createObjectURL = b => { blob = b; return "blob:kn-testi"; };
        HTMLAnchorElement.prototype.click = function () { nimi = this.download; };
        try { document.querySelector('#knYdin [data-sy-vie="csv"]').click(); }
        finally { URL.createObjectURL = oCreate; HTMLAnchorElement.prototype.click = oClick; }
        if (!blob) return null;
        const tavut = new Uint8Array(await blob.arrayBuffer());
        const teksti = new TextDecoder().decode(tavut);
        const rivit = teksti.split("\r\n").filter(Boolean);
        return { nimi, bom: tavut[0] === 0xEF && tavut[1] === 0xBB && tavut[2] === 0xBF, rivit: rivit.length, sarakkeet: rivit[0].split(";").length };
      });
      (csv && csv.bom && csv.sarakkeet === 12 && csv.rivit === e.avoimet + 1 && new RegExp(`^uusintapainatukset-${tk}-\\d{4}-\\d{2}-\\d{2}\\.csv$`).test(csv.nimi))
        ? ok(`kaupungin näkymä (${tk}): uusintapainatuslistan CSV ${csv.rivit - 1} riviä, 12 saraketta, UTF-8 BOM (${csv.nimi})`)
        : fail(`kaupungin näkymä (${tk}): CSV pielessä: ` + JSON.stringify({ odotus: e.avoimet, csv }));

      // Mitä palvelu esti = tulossa-pysäkit, joita ei ole jo merkitty vanhentuneiksi (ajojakso on oletusjakso).
      await page.goto(BASE + `/?city=${tk}#/kaupunki/estetyt`, { waitUntil: "networkidle2" });
      await page.waitForSelector("#knYdin #sy-estetyt-yht", { timeout: 20000 }).catch(() => {});
      const esti = await page.evaluate(() => { const el = document.getElementById("sy-estetyt-yht");
        return el ? { arvo: +el.dataset.arvo, teksti: el.textContent } : null; });
      (esti && esti.arvo === e.esti && !/virhe/i.test(esti.teksti))
        ? ok(`kaupungin näkymä (${tk}): Mitä palvelu esti = ${e.esti} julistetta nostettu ennen muutosta (ei hakemusmallin "virheitä")`)
        : fail(`kaupungin näkymä (${tk}): Mitä palvelu esti pielessä: ` + JSON.stringify({ odotus: e.esti, sivu: esti }));

      // Voimaantulopäivä: "noin" vain, kun muutosvahti ei saanut tarkkaa päivää (yhteenveto.voimaanTarkka).
      if (e.tu && e.v) {
        await page.goto(BASE + `/?city=${tk}#/kaupunki/yleiskuva`, { waitUntil: "networkidle2" });
        await page.waitForSelector('#knYdin .sy-kortti[data-mittari="tulossa"]', { timeout: 20000 }).catch(() => {});
        const tuTeksti = await page.evaluate(() => document.querySelector('#knYdin .sy-kortti[data-mittari="tulossa"]')?.textContent || "");
        const [vv, kk, pp] = e.v.split("-").map(Number);
        (tuTeksti.includes(`${pp}.${kk}.${vv}`) && /noin/.test(tuTeksti) === !e.tarkka)
          ? ok(`kaupungin näkymä (${tk}): voimaantulopäivä ${pp}.${kk}.${vv} ${e.tarkka ? "tarkka (ei noin)" : "arvio (noin)"}`)
          : fail(`kaupungin näkymä (${tk}): voimaantulopäivän teksti pielessä: ` + JSON.stringify({ v: e.v, tarkka: e.tarkka, teksti: tuTeksti }));
      }

      // 390 px: ei vaakavieritystä yleiskuvassa, työjonossa ja raportissa.
      await page.setViewport({ width: 390, height: 800 });
      const leveys = [];
      for (const nak of ["yleiskuva", "tyojono", "raportti"]) {
        await page.goto(BASE + `/?city=${tk}#/kaupunki/${nak}`, { waitUntil: "networkidle2" });
        await page.waitForSelector(`#knYdin #sy-nakyma[data-nakyma="${nak}"]`, { timeout: 20000 }).catch(() => {});
        leveys.push(await page.evaluate(n => ({ n, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
          nakyma: document.querySelector("#knYdin #sy-nakyma")?.dataset.nakyma }), nak));
      }
      await page.setViewport({ width: 1280, height: 900 });
      leveys.every(l => l.nakyma === l.n && l.sw <= l.cw)
        ? ok(`kaupungin näkymä (${tk}): 390 px ilman vaakavieritystä (yleiskuva, työjono, raportti)`)
        : fail("kaupungin näkymä: vaakavieritys 390 px:llä: " + JSON.stringify(leveys));
    } else info("kaupungin näkymä: muutosvahtia ei ole ajettu millekään kaupungille");

    // 7-9. Johtoraportti (Lappeenranta): luvut, tulostettava sisältö print-medialla ja yksi A4-sivu.
    if (ajetut.includes("lappeenranta")) {
      const e = odotus(await lataa("lappeenranta"));
      await page.goto(BASE + "/?city=lappeenranta#/kaupunki/raportti", { waitUntil: "networkidle2" });
      await page.waitForSelector('#sy-raportti-esikatselu [data-sy-r="kn-pysakkeja"]', { timeout: 20000 }).catch(() => {});
      const r = await page.evaluate(() => {
        const v = id => { const el = document.querySelector(`#sy-raportti-esikatselu [data-sy-r="${id}"]`); return el ? el.dataset.arvo.replace(/\s/g, "") : null; };
        const esti = document.querySelector('#sy-raportti-esikatselu [data-kn="esti"]');
        return { n: v("kn-pysakkeja"), ajan: v("kn-ajan-tasalla"), mu: v("kn-vanhentuneita"), tu: v("kn-tulossa"), poik: v("kn-poikkeus"),
          saasto: !!document.querySelector('#sy-raportti-esikatselu [data-sy-r="saasto"]'), esti: esti ? +esti.dataset.arvo : null,
          lista: !!document.querySelector('#sy-raportti-esikatselu [data-kn="uusinnat"]') };
      });
      (r.n === String(e.n) && r.ajan === `${e.pros}%` && r.mu === String(e.mu) && r.tu === String(e.tu) && r.poik === String(e.poik)
        && r.esti === e.esti && r.saasto && r.lista)
        ? ok(`johtoraportti (Lappeenranta): luvut ja uusintapainatuslista vastaavat JSONia (${e.n} / ${e.pros} % / ${e.mu} / ${e.tu})`)
        : fail("johtoraportti (Lappeenranta): luvut pielessä: " + JSON.stringify({ odotus: e, sivu: r }));
      // Tulostettaessa paperille menee vain raportti, ja sen otsikko näkyy (sovelluksen print-tyyli piilottaa headerit).
      await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
      await page.emulateMediaType("print");
      const pr = await page.evaluate(() => {
        const vis = el => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
        return { sovellus: vis(document.getElementById("app")), otsikko: vis(document.querySelector("#knTuloste header.sy-r-paa")),
          luvut: vis(document.querySelector('#knTuloste [data-sy-r="kn-pysakkeja"]')) };
      });
      await page.emulateMediaType(null);
      await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
      (!pr.sovellus && pr.otsikko && pr.luvut)
        ? ok("johtoraportti: tulosteessa vain raportti, otsikko ja julisteiden luvut näkyvät")
        : fail("johtoraportti: print-näkymä pielessä: " + JSON.stringify(pr) + " (odotus: sovellus=false, otsikko=true, luvut=true)");
      const buf = await page.pdf({ format: "A4", preferCSSPageSize: true });
      const sivuja = (Buffer.from(buf).toString("latin1").match(/\/Type\s*\/Page(?!s)/g) || []).length;
      sivuja === 1 ? ok("johtoraportti: yksi A4-sivu (PDF)") : fail(`johtoraportti: ${sivuja} sivua, odotus 1 A4`);

      // 10. Tulostusturva: kun näkymästä poistutaan raportilta, ytimen tyylit ovat pois päältä eikä ydin
      //     valmistele raporttia muiden näkymien tulosteisiin (julisteet, vihot).
      await page.evaluate(() => { location.hash = "#/tulosteet/muutokset"; });
      await page.waitForSelector("#chgSummary", { timeout: 20000 }).catch(() => {});
      const turva = await page.evaluate(() => {
        window.dispatchEvent(new Event("beforeprint"));
        const tulos = { luokka: document.documentElement.classList.contains("sy-tulostaa"),
          tyylitPois: [...document.querySelectorAll("link[data-kaupunki]")].every(l => l.disabled),
          tyyleja: document.querySelectorAll("link[data-kaupunki]").length,
          tuloste: (document.getElementById("knTuloste") || { innerHTML: "" }).innerHTML.length };
        window.dispatchEvent(new Event("afterprint"));
        return tulos;
      });
      (!turva.luokka && turva.tyylitPois && turva.tyyleja === 2 && turva.tuloste === 0)
        ? ok("kaupungin näkymä: muissa näkymissä ytimen tyylit pois ja raportti ei tulostu julisteiden mukana")
        : fail("kaupungin näkymä: tulostusturva pielessä: " + JSON.stringify(turva));
    }

    // 11. Säännöt: muutosvahdin säännöt lähteineen (tests/muutosvahti.js ja Digitransit).
    if (tk) {
      await page.goto(BASE + `/?city=${tk}#/kaupunki/saannot`, { waitUntil: "networkidle2" });
      await page.waitForSelector("#knYdin tr[data-sy-saanto]", { timeout: 20000 }).catch(() => {});
      const s = await page.evaluate(() => [...document.querySelectorAll("#knYdin tr[data-sy-saanto]")].map(tr =>
        ({ t: tr.dataset.sySaanto, lahde: (tr.querySelector('a[href^="https://"]') || {}).href || "" })));
      (s.length === 9 && s.every(x => /muutosvahti\.js$|digitransit\.fi/.test(x.lahde)))
        ? ok(`kaupungin näkymä: ${s.length} muutosvahdin sääntöä lähdelinkkeineen`)
        : fail("kaupungin näkymä: säännöt tai lähteet puuttuvat: " + JSON.stringify(s));
    }

    // 12. Kaupunki ilman muutosvahdin ajoa: selkeä tila, ei ydintä eikä taulukkoa, joka näyttäisi onnistumiselta.
    const ilman = (await page.evaluate(() => Object.keys(CONFIGS))).find(k => !ajetut.includes(k));
    if (ilman) {
      await page.goto(BASE + `/?city=${ilman}#/kaupunki`, { waitUntil: "networkidle2" });
      await page.waitForSelector("#knWrap", { timeout: 20000 }).catch(() => {});
      const t0 = await page.evaluate(() => ({ tila: document.getElementById("knWrap")?.dataset.knTila,
        ydin: !!document.getElementById("knYdin"), taulukoita: document.querySelectorAll("#app table").length,
        teksti: (document.querySelector("#knWrap .kn-tyhja")?.textContent || "").length }));
      (t0.tila === "ei-dataa" && !t0.ydin && t0.taulukoita === 0 && t0.teksti > 20)
        ? ok(`kaupungin näkymä (${ilman}): ei muutosvahdin ajoa, näytetään selkeä tila ilman taulukoita`)
        : fail(`kaupungin näkymä (${ilman}): tyhjä tila pielessä: ` + JSON.stringify(t0));
    }

    await page.setViewport(vp || { width: 800, height: 600 });
    await page.goto(BASE + "/#/", { waitUntil: "networkidle2" });
  }

  // --- Konsolivirheet ---
  // Nimeä verkkovirheet: jokainen "Failed to load resource: net::X" kuluttaa ensimmäisen
  // vielä käyttämättömän requestfailed-tapahtuman jolla on sama virheteksti. Osoitteesta
  // jätetään query pois (Digitransitin GraphQL-kyselyt ovat satoja merkkejä pitkiä) —
  // origin + polku riittää kertomaan kenen pää katkesi.
  const nimeaOsoite = (teksti) => {
    const m = teksti.match(/^Failed to load resource: (net::\S+)/);
    if (!m) return teksti;
    const osuma = failedRequests.find(r => !r.used && r.error === m[1]);
    if (!osuma) return teksti;
    osuma.used = true;
    let lyhyt = osuma.url;
    try { const u = new URL(osuma.url); lyhyt = u.origin + u.pathname; } catch (e) {}
    return teksti + " → " + lyhyt;
  };
  const realErrors = consoleErrors.filter(e => !e.includes("favicon")).map(nimeaOsoite);
  realErrors.length
    ? fail("konsolivirheitä:\n  " + realErrors.join("\n  "))
    : ok("ei konsolivirheitä");

  await browser.close();
  console.log(failures ? `\n${failures} TARKISTUSTA EPÄONNISTUI` : "\nKAIKKI TARKISTUKSET OK");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR: " + e.message); process.exit(1); });

#!/usr/bin/env node
// Muutosvahti: mitkä pysäkkijulisteet pitää tulostaa uudelleen.
//
// Reittiopas vastaa kysymykseen "miten pääsen A:sta B:hen". Tämä vastaa kaupungin omaan
// kysymykseen "mitkä katoksissa roikkuvat julisteet ovat vanhentuneet tai vanhenemassa".
// Nykyinen toimintatapa kaupungeissa on, että joku päättelee sen käsin kausivaihdoksen
// alla. Vahti laskee jokaiselle kaupungin pysäkille julisteen sisällön tunnisteen
// (lähdöt edustavana arkipäivänä, lauantaina ja sunnuntaina) kahdelle horisontille:
//   near = ensi viikko (D+7..)  = se aikataulu jonka juliste tänään tulostettuna näyttää
//   far  = neljä viikkoa myöhemmin (D+35..) = tuleeko muutos
// ja vertaa lisäksi near-tunnistetta edellisen ajon tunnisteeseen:
//   tulossa   = near != far        → juliste vanhenee ennen far-päivää (tulosta far-päivän jälkeen)
//   muuttunut = near != edellinen  → viime ajon jälkeen julisteen sisältö vaihtui (tulosta nyt)
//
// Yksi viikko ei riitä kummassakaan päässä: ensimmäinen koeajo (Vaasa 2.9.2026) osoitti 274/545
// pysäkin "muuttuvan" 13.10., joka on syyslomaviikko, eli yhden viikon poikkeus jonka juliste jo
// hoitaa koulupäivälohkoillaan. Siksi kumpikin horisontti mitataan KAHDELTA peräkkäiseltä viikolta:
// tila on vakaa vasta kun kaksi viikkoa ovat samat, ja muutos on "tulossa" vain kun vakaa uusi
// tila eroaa vakaasta nykytilasta. Yhden viikon poikkeamat raportoidaan erikseen (poikkeusviikko).
//
// Tulos kirjoitetaan docs/muutosvahti/<city>.json (sovellus lukee sen tulostekeskuksen
// Muutosvahti-välilehdelle ja etusivun nostoon) ja docs/muutosvahti/index.json (yhteenveto).
// Edellisen ajon tunnisteet luetaan samasta tiedostosta, joten historia kulkee repossa mukana.
//
// Ajo: node tests/muutosvahti.js [cityKey ...]   (oletus: kaikki CONFIGS-kaupungit)
// Kiintiökuri: aliasniputus 40 pysäkkiä per kysely, tauot kyselyjen ja kaupunkien välissä,
// 429 → jäähdytys. Lahti (~1 000 pysäkkiä) on noin 80 kyselyä.
//
// Sama lähtöjen poimintasääntö kuin julisteessa (stopPosterBlocks): pelkkä jättö
// (pickupType NONE) ja vuoron viimeinen pysäkki eivät ole lähtöjä.
//
// Aluerajatut kaupungit (CONFIG.areaScoped, Inkoo): feed on koko maan syöte, joten pysäkit
// rajataan kunnan alueeseen (ks. areaSelection). Muiden kaupunkien pysäkkijoukko on ennallaan:
// feedin linjojen patternien pysäkit.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PROXY = process.env.PROXY || "https://lsl-aikataulut-proxy.veikkoville.workers.dev/";
const CITY_GAP_MS = +(process.env.CITY_GAP_MS || 8000);
const QUERY_GAP_MS = +(process.env.QUERY_GAP_MS || 1200);
const CHUNK = +(process.env.CHUNK || 40);
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, "..", "docs", "muutosvahti");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- CONFIGS luetaan index.html:stä (sama totuus kuin tuotteessa; kopio kausivalidointi.js:stä) ---
function extractConfigs() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const start = html.indexOf("const CONFIGS = {");
  if (start < 0) throw new Error("CONFIGS-lohkoa ei löytynyt index.html:stä");
  const open = html.indexOf("{", start);
  let depth = 0, i = open, mode = null;
  for (; i < html.length; i++) {
    const c = html[i], n = html[i + 1];
    if (mode === "line") { if (c === "\n") mode = null; continue; }
    if (mode === "block") { if (c === "*" && n === "/") { mode = null; i++; } continue; }
    if (mode) { if (c === "\\") { i++; continue; } if (c === mode) mode = null; continue; }
    if (c === "/" && n === "/") { mode = "line"; i++; continue; }
    if (c === "/" && n === "*") { mode = "block"; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { mode = c; continue; }
    if (c === "{") depth++;
    if (c === "}") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error("CONFIGS-lohkon sulut eivät täsmää");
  const configs = new Function("return (" + html.slice(open, i + 1) + ")")();
  if (Object.keys(configs).length < 10 || !configs.lahti) throw new Error("CONFIGS-poiminta epäilyttävä");
  return configs;
}

async function gql(query, variables, router) {
  const target = router && router !== "waltti"
    ? PROXY + (PROXY.includes("?") ? "&" : "?") + "router=" + encodeURIComponent(router) : PROXY;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://demo.reittari.fi" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      if (attempt === 3) throw new Error("HTTP 429 (kiintiö) 3 yrityksen jälkeen");
      await sleep(60000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors.map(e => e.message).join("; "));
    return json.data;
  }
}

const compact = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// --- Juhlapyhät ja aattopäivät, joina ajetaan poikkeusliikennettä ---
// Pyhäpäivä ei kelpaa edustavaksi päiväksi eikä muutospäiväksi. Löydös 19.10.2026: 18.10. ajon nykytilan viikon
// lauantai oli pyhäinpäivä la 31.10. (sunnuntailiikenne), ja vahti tulkitsi paluun tavalliseen lauantaihin
// muutokseksi "7.11. alkaen" noin 1 370 pysäkillä (Kouvola, Mikkeli, Kotka, Pori, Oulu).
function easter(y) { // gregoriaaninen pääsiäispäivä (anonyymi algoritmi)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
const pyhaVuodet = new Map();
function pyhapaivat(y) {
  if (pyhaVuodet.has(y)) return pyhaVuodet.get(y);
  const p = new Set([`${y}-01-01`, `${y}-01-06`, `${y}-05-01`, `${y}-12-06`, `${y}-12-24`, `${y}-12-25`, `${y}-12-26`, `${y}-12-31`]);
  const e = easter(y);
  for (const n of [-2, 0, 1, 39]) p.add(addDays(e, n)); // pitkäperjantai, pääsiäispäivä, 2. pääsiäispäivä, helatorstai
  const viikonpaiva = (alku, loppu, w) => { for (let d = alku; d <= loppu; d = addDays(d, 1)) if (new Date(d + "T12:00:00").getDay() === w) return d; };
  p.add(viikonpaiva(`${y}-06-19`, `${y}-06-25`, 5)); // juhannusaatto
  p.add(viikonpaiva(`${y}-06-20`, `${y}-06-26`, 6)); // juhannuspäivä
  p.add(viikonpaiva(`${y}-10-31`, `${y}-11-06`, 6)); // pyhäinpäivä
  // Äitienpäivä ja isänpäivä (toinen sunnuntai toukokuussa ja marraskuussa) eivät ole pyhiä, mutta feedit ajavat niinä
  // lisävuoroja: Kotkassa su 8.11.2026 linjan 19 lisälähtö, joka teki 61 pysäkin "muutoksen 15.11." 18.10. ajossa.
  p.add(viikonpaiva(`${y}-05-08`, `${y}-05-14`, 0));
  p.add(viikonpaiva(`${y}-11-08`, `${y}-11-14`, 0));
  pyhaVuodet.set(y, p);
  return p;
}
const onPyha = isoPvm => pyhapaivat(+String(isoPvm).slice(0, 4)).has(String(isoPvm).slice(0, 10));

// Edustavat päivät: ensimmäinen tiistai joka on vähintään D+7 päässä, ja saman viikon la/su.
// Tiistai, koska maanantai ja perjantai kantavat useimmin poikkeuksia (feedit koodaavat
// perjantain yövuorot ja maanantain päättyvät palvelut erikseen, ks. 23.8.2026 löydös).
// Pyhäpäivälle osuva edustava päivä korvataan saman viikonpäivän pyhättömällä päivällä: nykytilan viikolla (W1)
// viikkoa aiemmin, muilla viikoilla viikkoa myöhemmin. W2 eteenpäin, koska W2:lla alkava muutos jatkuu W3:lla:
// taaksepäin korvattu W2 sekoittaisi vanhan ja uuden (Lahti linja 28 alkaa ma 2.11., isänpäivä su 8.11. -> su 1.11.
// olisi tehnyt 54 pysäkistä poikkeusviikon). Viikon ankkuri (tue) ei muutu, joten voimaantulopäivän laskenta
// (changeDates) käyttää edelleen oikeaa viikkoa; korvatut päivät ovat kentässä korvattu.
function representativeDays(offsetDays, alusta = new Date()) {
  const d = new Date(alusta); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offsetDays);
  while (d.getDay() !== 2) d.setDate(d.getDate() + 1);
  const tue = new Date(d), sat = new Date(d), sun = new Date(d);
  sat.setDate(sat.getDate() + 4); sun.setDate(sun.getDate() + 5);
  const suunta = offsetDays < 14 ? -7 : 7;
  const korvattu = {};
  const days = { tue, sat, sun };
  for (const k of ["tue", "sat", "sun"]) {
    const alku = iso(days[k]);
    let x = new Date(days[k]);
    for (let n = 0; n < 3 && onPyha(iso(x)); n++) x.setDate(x.getDate() + suunta);
    if (iso(x) !== alku) { korvattu[k] = { pyha: alku, tilalla: iso(x) }; days[k] = x; }
  }
  return { tue, sig: days, korvattu };
}

const hm = s => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;

// Pysäkin lähdöt yhdelle palvelupäivälle: sama poimintasääntö kuin julisteessa.
function departuresOf(stopNode) {
  const out = [];
  for (const sp of (stopNode?.stoptimesForServiceDate || [])) {
    const nStops = (sp.pattern?.stops || []).length;
    for (const st of (sp.stoptimes || [])) {
      if (st.pickupType === "NONE") continue;
      if (nStops && st.stopPositionInPattern === nStops - 1) continue;
      const r = st.trip?.route?.shortName || "";
      out.push(`${r}|${st.headsign || st.trip?.tripHeadsign || ""}|${hm(st.scheduledDeparture)}`);
    }
  }
  return [...new Set(out)].sort();
}

// Aliasniputettu haku: 40 pysäkkiä × 3 päivää yhdessä kyselyssä per horisontti.
async function signaturesFor(stopIds, days, router) {
  const sigs = new Map(); // id -> { hash, n, lines:Set }
  for (let i = 0; i < stopIds.length; i += CHUNK) {
    const ids = stopIds.slice(i, i + CHUNK);
    const vars = {};
    const parts = ids.map((id, k) => {
      vars["i" + k] = id;
      return ["tue", "sat", "sun"].map(dk =>
        `s${k}${dk}: stop(id: $i${k}) { stoptimesForServiceDate(date: "${compact(days[dk])}") {
           pattern { stops { gtfsId } }
           stoptimes { scheduledDeparture pickupType stopPositionInPattern headsign trip { tripHeadsign route { shortName } } } } }`).join("\n");
    }).join("\n");
    const varDefs = ids.map((_, k) => `$i${k}: String!`).join(", ");
    const data = await gql(`query (${varDefs}) { ${parts} }`, vars, router);
    ids.forEach((id, k) => {
      const lines = new Set();
      let n = 0;
      const text = ["tue", "sat", "sun"].map(dk => {
        const deps = departuresOf(data[`s${k}${dk}`]);
        n += deps.length;
        deps.forEach(d => { const r = d.split("|")[0]; if (r) lines.add(r); });
        return dk + ":" + deps.join(",");
      }).join("\n");
      sigs.set(id, { hash: crypto.createHash("sha1").update(text).digest("hex").slice(0, 12), n, lines: [...lines].sort() });
    });
    await sleep(QUERY_GAP_MS);
  }
  return sigs;
}

const addDays = (isoPvm, n) => { const d = new Date(isoPvm + "T12:00:00"); d.setDate(d.getDate() + n); return iso(d); };

// Pysäkin ensimmäinen muutospäivä viikonpäivittäin. Jokaiselle viikonpäivälle: vanha arvo = nykytilan viikko,
// uusi arvo = kaukoviikko (vahvistettu seuraavalta viikolta). Muutospäivä = ensimmäinen saman viikonpäivän päivä,
// jonka lähdöt ovat uusi arvo ja jonka jälkeen vanha arvo ei enää palaa. Päivä, joka ei ole kumpikaan (syysloma,
// pyhäpäivä, poikkeuslauantai), ei ratkaise mitään. Todennetut tapaukset 27.9.2026: Lahti linja 28 alkaa ma 2.11.;
// Kuopio ma 12.10. (lähdöt minuutin aiemmin); Joensuu syysloma 12.-18.10. ja muutos 19.10.; Oulu syysloma 19.-23.10.
// näytti uudelta tilalta, mutta 26.10. palasi vanhaan (muutos 2.11.); pyhäinpäivä la 31.10. ei ole muutos.
// Palauttaa aikaisimman muutospäivän (iso) tai null, jos yhtäkään viikonpäivää ei voitu todentaa.
// Pyhäpäivä (onPyha) ei ole vanha eikä uusi arvo eikä muutospäivä: jos nykytilan viikon päivä on pyhä, vanha arvo
// luetaan viikkoa aiemmin (changeDates hakee sen), muuten viikkoa myöhemmin; pyhänä kaukopäivänä uusi arvo luetaan
// pelkästä pyhättömästä kaukopäivästä. Todennettu 19.10.2026: nykytilan la 31.10. pyhäinpäivä ei saa tuottaa muutosta 7.11.
function firstChangeDay(lahdot, vanhaMa, uusiMa, uusi2Ma, pyha = onPyha) {
  let paras = null;
  const arvo = d => (d && !pyha(d) ? lahdot.get(d) : undefined);
  for (let i = 0; i < 7; i++) {
    const v0 = addDays(vanhaMa, i);
    const vanhaPvm = !pyha(v0) ? v0 : [addDays(v0, -7), addDays(v0, 7)].find(d => !pyha(d) && lahdot.get(d) !== undefined);
    const u1 = addDays(uusiMa, i), u2 = addDays(uusi2Ma, i);
    const vanha = arvo(vanhaPvm);
    let uusi = arvo(u1), uusi2 = arvo(u2);
    if (pyha(u1)) uusi = uusi2; else if (pyha(u2)) uusi2 = uusi;
    if (vanha === undefined || uusi === undefined || uusi !== uusi2 || uusi === vanha) continue;
    const paivat = [];
    for (let d = addDays(v0, 7); d <= u1; d = addDays(d, 7)) if (!pyha(d)) paivat.push(d);
    for (let k = 0; k < paivat.length; k++) {
      if (lahdot.get(paivat[k]) !== uusi) continue;
      if (paivat.slice(k + 1).some(d => lahdot.get(d) === vanha)) continue;
      if (!paras || paivat[k] < paras) paras = paivat[k];
      break;
    }
  }
  return paras;
}

// Lähdöt päivittäin (sama poimintasääntö kuin julisteessa), aliasniputettuna: enintään CHUNK pysäkkiä ja
// noin 3 x CHUNK aliasta kyselyä kohden, kuten signaturesFor.
async function dailyDepartures(stopIds, dates, router) {
  const out = new Map(stopIds.map(id => [id, new Map()]));
  for (let a = 0; a < stopIds.length; a += CHUNK) {
    const ids = stopIds.slice(a, a + CHUNK);
    const PER = Math.max(1, Math.floor((CHUNK * 3) / ids.length));
    for (let i = 0; i < dates.length; i += PER) {
      const ds = dates.slice(i, i + PER);
      const vars = {};
      const parts = ids.map((id, k) => {
        vars["i" + k] = id;
        return ds.map((d, j) => `s${k}_${j}: stop(id: $i${k}) { stoptimesForServiceDate(date: "${d.replace(/-/g, "")}") {
             pattern { stops { gtfsId } }
             stoptimes { scheduledDeparture pickupType stopPositionInPattern headsign trip { tripHeadsign route { shortName } } } } }`).join("\n");
      }).join("\n");
      const varDefs = ids.map((_, k) => `$i${k}: String!`).join(", ");
      const data = await gql(`query (${varDefs}) { ${parts} }`, vars, router);
      ids.forEach((id, k) => ds.forEach((d, j) => out.get(id).set(d, departuresOf(data[`s${k}_${j}`]).join(","))));
      await sleep(QUERY_GAP_MS);
    }
  }
  return out;
}

// Voimaantulopäivä jokaiselle muuttuvalle pysäkille (otanta ei riitä: Kuopiossa 27.9. osa pysäkeistä muuttui ma 12.10.
// ja osa 19.10.). Lähdöt haetaan päivittäin nykytilan viikon maanantaista kaukoviikkoa seuraavan viikon sunnuntaihin.
// Nykytilan viikko on W2, jos W1 on poikkeusviikko (poikkeus "near"), muuten W1.
async function changeDates(changed, near, near2, far, router) {
  const ma = tue => addDays(iso(tue), -1);
  const nearMa = ma(near.tue), near2Ma = ma(near2.tue), farMa = ma(far.tue), far2Ma = addDays(farMa, 7);
  const dates = [];
  // Viikko ennen nykytilan viikkoa mukaan vain pyhäpäivien takia: pyhän vanha arvo luetaan viikkoa aiemmin.
  for (let d = addDays(nearMa, -7); d <= addDays(far2Ma, 6); d = addDays(d, 1))
    if (d >= nearMa || onPyha(addDays(d, 7))) dates.push(d);
  const lahdot = await dailyDepartures(changed.map(r => r.id), dates, router);
  for (const r of changed) {
    const d = firstChangeDay(lahdot.get(r.id), r.poikkeus === "near" ? near2Ma : nearMa, farMa, far2Ma);
    if (d) { r.voimaan = d; r.voimaanTarkka = true; }
    else { r.voimaan = iso(far.tue); r.voimaanTarkka = false; }
  }
}

// Vakaa nykytila ja poikkeusviikko lähiviikoista W1 (n1) ja W2 (n2), kaukoviikoista W5 (f1) ja W6 (f2)
// sekä edellisen ajon nykytilasta (prev = tunniste). Palauttaa { base, poikkeus }.
function classifyNear(n1, n2, f1, f2, prev) {
  const same = (a, b) => !!(a && b && a.hash === b.hash);
  if (same(n1, n2)) return { base: n1, poikkeus: "" };
  // W1 ja W2 eroavat. Edellisen ajon nykytila ratkaisee ensin, kumpi on voimassa: viime viikon ajon
  // W2 on tämän ajon W1. Todennettu 27.9.2026 Joensuussa: W1 = nykytila, W2 13.10. = syysloma,
  // uusi aikataulu 19.10. alkaen; vanha sääntö oletti W1:n poikkeukseksi ja käski tulostaa heti.
  if (prev && n1 && n1.hash === prev) {
    // W2 on joko pysyvän muutoksen alku (W2 = vakaa kaukotila) tai poikkeusviikko.
    return { base: n1, poikkeus: same(f1, f2) && same(n2, f1) ? "" : "near2" };
  }
  if (prev && n2 && n2.hash === prev) return { base: n2, poikkeus: "near" };
  // Ilman edellistä ajoa: nykytila on se joka toistuu kaukopäässä; toinen on poikkeusviikko.
  // Ilman kaukopään tukea oletetaan W1 poikkeavaksi (kuten ennen).
  if (same(n2, f1) || same(n2, f2)) return { base: n2, poikkeus: "near" };
  if (same(n1, f1) || same(n1, f2)) return { base: n1, poikkeus: "near2" };
  return { base: n2, poikkeus: "near" };
}

// Onko edellinen ajo tehty ilman pyhäsääntöä niin, että sen lähiviikkojen (W1, W2) edustavissa päivissä oli pyhä?
// Silloin sen nykytila voi olla pyhäviikon tunniste, ja runCity kääntää sen pyhättömäksi tai jättää pois.
function prevPyhaviikko(prev) {
  if (!prev || prev.pyhasaanto || !prev.paivat) return false;
  const p = prev.paivat;
  const n2 = p.near2;
  const paivat = [p.near?.tue, p.near?.sat, p.near?.sun, n2, n2 && addDays(n2, 4), n2 && addDays(n2, 5)].filter(Boolean);
  return paivat.some(onPyha);
}

// --- Aluerajaus (CONFIG.areaScoped) ---
// Valtakunnallinen feed (Inkoossa MATKA, koko Suomi) ei rajaa kuntaa: "feedin linjojen pysäkit" olisi koko
// maa. Pysäkkijoukko = kaikki kunnan alueen (index.html: inMunicipality, area.rect + area.polygon) oman feedin
// tai lisäfeedin (extraFeeds, esim. lossi) pysäkit, joilla on vähintään yksi CONFIG.modes-kulkutavan linja;
// lähdöttömät putoavat myöhemmin kuten muissakin kaupungeissa. Julisteen voi tulostaa jokaiselle kunnan
// pysäkille, joten linjalistan vähimmäispysäkkisääntö (area.minStops, sovelluksen areaRouteIds) EI rajaa tätä
// joukkoa: Inkoossa se pudottaisi tien 25 kuusi pysäkkiä (linjat 112, 115, 291), joilla on lähtöjä (päätös
// 29.9.2026: ylimääräinen pysäkki maksaa vähemmän kuin puuttuva). Junapysäkit eivät ole mukana (junat eivät
// ole pysäkkijulisteella), eivätkä kunnan ulkopuoliset pysäkit (linjan 192 pysäkit Helsingissä). Toisin kuin
// sovellus, tyhjä joukko ei palaa pelkkään suorakaiteeseen vaan heittää: vahti ei saa raportoida väärää
// pysäkkijoukkoa ehjänä.

// Ray casting, kopio index.html:n pointInRing-funktiosta. ring = [[lon, lat], ...].
function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Sovelluksen inMunicipality: suorakaide (area.rect) ja kunnan raja (area.polygon).
function inMunicipality(lat, lon, area) {
  if (lat == null || lon == null) return false;
  const r = area?.rect;
  if (r && !(lat >= r.minLat && lat <= r.maxLat && lon >= r.minLon && lon <= r.maxLon)) return false;
  return !area?.polygon || pointInRing(lat, lon, area.polygon);
}

// bboxStops = stopsByBbox-vastaus (gtfsId name code lat lon routes { gtfsId mode }), feed = oma feedId.
// Palauttaa { routeIds, stops }: stops = [{ id, name, code }] id-järjestyksessä, routeIds = valittujen pysäkkien
// linjat (vain lokiin). Puhdas funktio (yksikkötesti).
function areaSelection(bboxStops, cfg, feed) {
  const area = cfg.area || {};
  const inCityFeed = id => String(id).startsWith(feed + ":") || (cfg.extraFeeds || []).some(f => String(id).startsWith(f + ":"));
  const modes = cfg.modes || ["BUS"];
  const chosen = (bboxStops || []).filter(s => inCityFeed(s.gtfsId) && inMunicipality(s.lat, s.lon, area) &&
    (s.routes || []).some(x => modes.includes(x.mode)));
  const routeIds = [...new Set(chosen.flatMap(s => (s.routes || []).filter(x => modes.includes(x.mode)).map(x => x.gtfsId)))].sort();
  const stops = chosen.map(s => ({ id: s.gtfsId, name: s.name, code: s.code || "" }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { routeIds, stops };
}

// Kunnan pysäkit yhdellä bbox-kyselyllä (Inkoo 29.9.2026: 360 pysäkkiä suorakaiteessa, 169 kt linjoineen, 1,3 s).
async function areaStops(key, cfg, feed, router) {
  const r = cfg.area?.rect;
  if (!r) throw new Error("areaScoped ilman area.rect-rajausta");
  const box = await gql(`query ($minLat: Float!, $minLon: Float!, $maxLat: Float!, $maxLon: Float!) {
      stopsByBbox(minLat: $minLat, minLon: $minLon, maxLat: $maxLat, maxLon: $maxLon) {
        gtfsId name code lat lon routes { gtfsId mode } } }`,
    { minLat: r.minLat, minLon: r.minLon, maxLat: r.maxLat, maxLon: r.maxLon }, router);
  const sel = areaSelection(box.stopsByBbox, cfg, feed);
  if (!sel.stops.length) throw new Error(`aluerajaus tyhjä: ${(box.stopsByBbox || []).length} pysäkkiä suorakaiteessa, 0 kunnan alueella`);
  console.log(`INFO [${key}] aluerajaus: ${sel.stops.length} pysäkkiä kunnan alueella, ${sel.routeIds.length} linjaobjektia (${(box.stopsByBbox || []).length} pysäkkiä suorakaiteessa)`);
  return new Map(sel.stops.map(s => [s.id, s]));
}

async function runCity(key, cfg, feedsByRouter) {
  const router = cfg.router || "waltti";
  if (!feedsByRouter[router]) {
    const fd = await gql(`{ feeds { feedId } }`, undefined, router);
    feedsByRouter[router] = (fd.feeds || []).map(f => f.feedId);
  }
  const feed = feedsByRouter[router].find(f => cfg.feedMatch.test(f));
  if (!feed) throw new Error(`feedMatch ei osu (router ${router})`);

  // Kaupungin pysäkit = linjojen patternien pysäkit (juuri ne joilla on juliste).
  // areaScoped: feed on koko maan syöte, joten pysäkit rajataan kuntaan (areaStops).
  const stops = cfg.areaScoped ? await areaStops(key, cfg, feed, router) : new Map();
  if (!cfg.areaScoped) {
    const rd = await gql(`query ($feeds: [String]) { routes(feeds: $feeds) { shortName patterns { stops { gtfsId name code } } } }`, { feeds: [feed] });
    for (const r of (rd.routes || [])) for (const p of (r.patterns || [])) for (const s of (p.stops || []))
      if (!stops.has(s.gtfsId)) stops.set(s.gtfsId, { id: s.gtfsId, name: s.name, code: s.code || "" });
  }
  const ids = [...stops.keys()].sort();
  await sleep(QUERY_GAP_MS);

  const near = representativeDays(7), near2 = representativeDays(14);
  const far = representativeDays(35), far2 = representativeDays(42);
  for (const [nimi, h] of Object.entries({ near, near2, far, far2 }))
    for (const [k, v] of Object.entries(h.korvattu)) console.log(`INFO [${key}] ${nimi} ${k} ${v.pyha} on pyhäpäivä -> ${v.tilalla}`);
  const sigNear = await signaturesFor(ids, near.sig, router);
  const sigNear2 = await signaturesFor(ids, near2.sig, router);
  const sigFar = await signaturesFor(ids, far.sig, router);
  const sigFar2 = await signaturesFor(ids, far2.sig, router);

  const outFile = path.join(OUT_DIR, key + ".json");
  const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : null;
  const prevHash = new Map(Object.entries(prev?.hashes || {}));
  // Siirtymä: ennen pyhäsääntöä tallennettu nykytila voi olla pyhäviikon tunniste (11.10.2026 ajo tallensi la 31.10.
  // viikon nykytilaksi, ja 18.10. ajo luotti siihen). Se ei osu tämän ajon pyhättömiin tunnisteisiin, joten se käännetään:
  // jos edellinen tunniste = saman viikon tunniste pyhäpäivän kanssa (raakatunniste), sitä vastaa saman viikon pyhätön
  // tunniste. Ilman käännöstä aito W2:lla alkava muutos (Kotka P004 ti 3.11.) luokittuisi poikkeusviikoksi. Tunniste,
  // jota ei voi kääntää, jätetään pois (ei poikkeusviikon ratkaisuun eikä "muuttunut viime ajosta" -tietoon).
  const prevEpaluotettava = prevPyhaviikko(prev);
  if (prevEpaluotettava) {
    const kaannos = new Map();
    for (const [h, sig] of [[near, sigNear], [near2, sigNear2]]) {
      if (!Object.keys(h.korvattu).length) { for (const id of ids) if (!kaannos.has(id) && prevHash.get(id) === sig.get(id)?.hash) kaannos.set(id, sig.get(id).hash); continue; }
      const raaka = Object.fromEntries(["tue", "sat", "sun"].map(k => [k, h.korvattu[k] ? new Date(h.korvattu[k].pyha + "T12:00:00") : h.sig[k]]));
      const sigRaaka = await signaturesFor(ids, raaka, router);
      for (const id of ids) if (!kaannos.has(id) && prevHash.get(id) === sigRaaka.get(id)?.hash) kaannos.set(id, sig.get(id).hash);
    }
    console.log(`INFO [${key}] edellisen ajon (${String(prev.ajettu).slice(0, 10)}) lähiviikoilla oli pyhä ilman pyhäsääntöä: ` +
      `${kaannos.size}/${prevHash.size} tunnistetta käännetty pyhättömiksi, loput jätetään pois`);
    prevHash.clear();
    for (const [id, h] of kaannos) prevHash.set(id, h);
  }

  const baseSig = new Map(); // vakaa nykytila per pysäkki
  const same = (a, b) => !!(a && b && a.hash === b.hash);
  const rows = ids.map(id => {
    const n1 = sigNear.get(id), n2 = sigNear2.get(id), f1 = sigFar.get(id), f2 = sigFar2.get(id);
    const farStable = same(f1, f2);
    let { base, poikkeus } = classifyNear(n1, n2, f1, f2, prevHash.get(id));
    if (base) baseSig.set(id, base);
    const tulossa = !!(base && farStable && f1.hash !== base.hash);
    // Kaukopään poikkeusviikko: kumpi W5/W6 eroaa nykytilasta. Todennettu 2.9.2026 Lahdessa: vahti
    // nimesi 13.10. poikkeusviikoksi, vaikka poikkeava viikko oli 20.10. (syysloma vk 43, serviceId "LP").
    if (base && !farStable) {
      if (same(f1, base)) poikkeus = poikkeus || "far2";
      else poikkeus = poikkeus || "far"; // W5 eroaa (tai molemmat eroavat, ei vakaata uutta tilaa)
    }
    const farShown = farStable ? f1 : (poikkeus === "far2" ? f2 : f1); // poikkeusviikon oma lähtömäärä
    const muuttunut = !!(base && prevHash.has(id) && prevHash.get(id) !== base.hash);
    return { id, name: stops.get(id).name, code: stops.get(id).code, lines: base?.lines || [],
      depsNear: base?.n ?? 0, depsFar: farShown?.n ?? 0, tulossa, muuttunut, poikkeus };
  }).filter(r => r.depsNear || r.depsFar); // pysäkit joilla ei ole lähtöjä kummallakaan → ei julistetta

  const changedIds = rows.filter(r => r.tulossa).map(r => r.id);
  let voimaan = null, voimaanTarkka = false;
  if (changedIds.length) {
    const changed = rows.filter(r => r.tulossa);
    try {
      await changeDates(changed, near, near2, far, router);
      // Kaupungin päivä = aikaisin pysäkkikohtainen päivä (sitä ennen ensimmäinen juliste on uusittava).
      const ens = changed.filter(r => r.voimaan).sort((a, b) => a.voimaan.localeCompare(b.voimaan))[0];
      if (ens) { voimaan = ens.voimaan; voimaanTarkka = !!ens.voimaanTarkka; }
    } catch (e) {
      console.log(`WARN [${key}] voimaantulopäivää ei saatu: ${e.message}`);
      for (const r of changed) { delete r.voimaan; delete r.voimaanTarkka; }
    }
  }

  const hashes = {};
  for (const id of ids) if (baseSig.get(id)) hashes[id] = baseSig.get(id).hash;
  const report = {
    city: key, ajettu: new Date().toISOString(), edellinen: prev?.ajettu || null, pyhasaanto: 1,
    paivat: { near: { tue: iso(near.sig.tue), sat: iso(near.sig.sat), sun: iso(near.sig.sun) }, near2: iso(near2.tue),
      far: { tue: iso(far.sig.tue), sat: iso(far.sig.sat), sun: iso(far.sig.sun) }, far2: iso(far2.tue),
      korvattu: Object.fromEntries(Object.entries({ near, near2, far, far2 }).filter(([, h]) => Object.keys(h.korvattu).length).map(([n, h]) => [n, h.korvattu])) },
    yhteenveto: { pysakkeja: rows.length, tulossa: changedIds.length, muuttunut: rows.filter(r => r.muuttunut).length,
      poikkeus: rows.filter(r => r.poikkeus).length,
      poikkeusviikot: { near: { pvm: iso(near.tue), n: rows.filter(r => r.poikkeus === "near").length },
                        near2: { pvm: iso(near2.tue), n: rows.filter(r => r.poikkeus === "near2").length },
                        far: { pvm: iso(far.tue), n: rows.filter(r => r.poikkeus === "far").length },
                        far2: { pvm: iso(far2.tue), n: rows.filter(r => r.poikkeus === "far2").length } },
      voimaan, voimaanTarkka },
    pysakit: rows,
    hashes,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report));
  return { key, ...report.yhteenveto };
}

module.exports = { classifyNear, firstChangeDay, addDays, pointInRing, inMunicipality, areaSelection, extractConfigs,
  onPyha, pyhapaivat, representativeDays, prevPyhaviikko };

if (require.main === module) (async () => {
  const configs = extractConfigs();
  const filter = process.argv.slice(2);
  const cities = Object.keys(configs).filter(k => !filter.length || filter.includes(k));
  const unknown = filter.filter(k => !configs[k]);
  if (unknown.length) { console.error("tuntematon kaupunki: " + unknown.join(", ")); process.exit(2); }
  const feedsByRouter = {};
  const index = fs.existsSync(path.join(OUT_DIR, "index.json"))
    ? JSON.parse(fs.readFileSync(path.join(OUT_DIR, "index.json"), "utf8")) : { kaupungit: {} };
  let fails = 0;
  for (const key of cities) {
    const t0 = Date.now();
    try {
      const r = await runCity(key, configs[key], feedsByRouter);
      if (r.skipped) { console.log(`INFO [${key}] ohitettu: ${r.skipped}`); continue; }
      index.kaupungit[key] = { ajettu: new Date().toISOString(), pysakkeja: r.pysakkeja, tulossa: r.tulossa, muuttunut: r.muuttunut, poikkeus: r.poikkeus, voimaan: r.voimaan };
      console.log(`OK   [${key}] ${r.pysakkeja} pysäkkiä · tulossa ${r.tulossa}${r.voimaan ? " (voimaan ~" + r.voimaan + ")" : ""} · muuttunut viime ajosta ${r.muuttunut} · poikkeusviikko ${r.poikkeus} · ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) {
      fails++;
      console.log(`FAIL [${key}] ${e.message}`);
    }
    await sleep(CITY_GAP_MS);
  }
  index.ajettu = new Date().toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 1));
  console.log(`\nYHTEENVETO: ${cities.length - fails} OK / ${fails} FAIL → ${OUT_DIR}`);
  process.exit(fails ? 1 : 0);
})();

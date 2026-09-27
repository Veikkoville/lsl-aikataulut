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
// Edustavat päivät: ensimmäinen tiistai joka on vähintään D+7 päässä, ja saman viikon la/su.
// Tiistai, koska maanantai ja perjantai kantavat useimmin poikkeuksia (feedit koodaavat
// perjantain yövuorot ja maanantain päättyvät palvelut erikseen, ks. 23.8.2026 löydös).
function representativeDays(offsetDays) {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offsetDays);
  while (d.getDay() !== 2) d.setDate(d.getDate() + 1);
  const tue = new Date(d), sat = new Date(d), sun = new Date(d);
  sat.setDate(sat.getDate() + 4); sun.setDate(sun.getDate() + 5);
  return { tue, sat, sun };
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
function firstChangeDay(lahdot, vanhaMa, uusiMa, uusi2Ma) {
  let paras = null;
  for (let i = 0; i < 7; i++) {
    const vanha = lahdot.get(addDays(vanhaMa, i)), uusi = lahdot.get(addDays(uusiMa, i)), uusi2 = lahdot.get(addDays(uusi2Ma, i));
    if (vanha === undefined || uusi === undefined || uusi !== uusi2 || uusi === vanha) continue;
    const paivat = [];
    for (let d = addDays(vanhaMa, i + 7); d <= addDays(uusiMa, i); d = addDays(d, 7)) paivat.push(d);
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
  for (let d = nearMa; d <= addDays(far2Ma, 6); d = addDays(d, 1)) dates.push(d);
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

async function runCity(key, cfg, feedsByRouter) {
  const router = cfg.router || "waltti";
  if (cfg.areaScoped) return { key, skipped: "areaScoped-feed (koko maan syöte) ei ole vielä tuettu" };
  if (!feedsByRouter[router]) {
    const fd = await gql(`{ feeds { feedId } }`, undefined, router);
    feedsByRouter[router] = (fd.feeds || []).map(f => f.feedId);
  }
  const feed = feedsByRouter[router].find(f => cfg.feedMatch.test(f));
  if (!feed) throw new Error(`feedMatch ei osu (router ${router})`);

  // Kaupungin pysäkit = linjojen patternien pysäkit (juuri ne joilla on juliste).
  const rd = await gql(`query ($feeds: [String]) { routes(feeds: $feeds) { shortName patterns { stops { gtfsId name code } } } }`, { feeds: [feed] });
  const stops = new Map();
  for (const r of (rd.routes || [])) for (const p of (r.patterns || [])) for (const s of (p.stops || []))
    if (!stops.has(s.gtfsId)) stops.set(s.gtfsId, { id: s.gtfsId, name: s.name, code: s.code || "" });
  const ids = [...stops.keys()].sort();
  await sleep(QUERY_GAP_MS);

  const near = representativeDays(7), near2 = representativeDays(14);
  const far = representativeDays(35), far2 = representativeDays(42);
  const sigNear = await signaturesFor(ids, near, router);
  const sigNear2 = await signaturesFor(ids, near2, router);
  const sigFar = await signaturesFor(ids, far, router);
  const sigFar2 = await signaturesFor(ids, far2, router);

  const outFile = path.join(OUT_DIR, key + ".json");
  const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : null;
  const prevHash = new Map(Object.entries(prev?.hashes || {}));

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
    city: key, ajettu: new Date().toISOString(), edellinen: prev?.ajettu || null,
    paivat: { near: { tue: iso(near.tue), sat: iso(near.sat), sun: iso(near.sun) }, near2: iso(near2.tue),
      far: { tue: iso(far.tue), sat: iso(far.sat), sun: iso(far.sun) }, far2: iso(far2.tue) },
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

module.exports = { classifyNear, firstChangeDay, addDays };

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

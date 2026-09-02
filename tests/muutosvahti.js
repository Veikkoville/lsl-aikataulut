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

// Ensimmäinen viikko jolla muutos näkyy: tiistaiviikot near→far, otanta muuttuneista pysäkeistä.
async function firstChangeWeek(sampleIds, near2, far, farSig, router) {
  const weeks = [];
  for (let d = new Date(near2.tue); d < far.tue; d.setDate(d.getDate() + 7)) weeks.push(new Date(d));
  weeks.shift(); // near2 itse on vielä nykytilaa
  for (const tue of weeks) {
    const days = { tue, sat: new Date(tue), sun: new Date(tue) };
    days.sat.setDate(days.sat.getDate() + 4); days.sun.setDate(days.sun.getDate() + 5);
    const s = await signaturesFor(sampleIds, days, router);
    const agree = sampleIds.filter(id => s.get(id)?.hash === farSig.get(id)?.hash).length;
    if (agree * 2 > sampleIds.length) return iso(tue);
  }
  return iso(far.tue);
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

  const baseSig = new Map(); // vakaa nykytila per pysäkki: W1 jos W1==W2, muuten W2 (W1 poikkeusviikko)
  const rows = ids.map(id => {
    const n1 = sigNear.get(id), n2 = sigNear2.get(id), f1 = sigFar.get(id), f2 = sigFar2.get(id);
    const nearStable = !!(n1 && n2 && n1.hash === n2.hash);
    const farStable = !!(f1 && f2 && f1.hash === f2.hash);
    const base = nearStable ? n1 : n2;
    if (base) baseSig.set(id, base);
    const tulossa = !!(base && farStable && f1.hash !== base.hash);
    // Poikkeusviikko: kumpi pää heilui. "near" = viikko near2 (W2) tai W1 poikkeaa, "far" = W5/W6.
    const poikkeus = !nearStable ? "near" : !farStable ? "far" : "";
    const muuttunut = !!(base && prevHash.has(id) && prevHash.get(id) !== base.hash);
    return { id, name: stops.get(id).name, code: stops.get(id).code, lines: base?.lines || [],
      depsNear: base?.n ?? 0, depsFar: (farStable ? f1 : f2)?.n ?? 0, tulossa, muuttunut, poikkeus };
  }).filter(r => r.depsNear || r.depsFar); // pysäkit joilla ei ole lähtöjä kummallakaan → ei julistetta

  const changedIds = rows.filter(r => r.tulossa).map(r => r.id);
  let voimaan = null;
  if (changedIds.length) {
    const sample = changedIds.filter((_, i) => i % Math.max(1, Math.floor(changedIds.length / 5)) === 0).slice(0, 5);
    try { voimaan = await firstChangeWeek(sample, near2, far, sigFar, router); } catch (e) { voimaan = null; }
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
                        far: { pvm: iso(far.tue), n: rows.filter(r => r.poikkeus === "far").length } },
      voimaan },
    pysakit: rows,
    hashes,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report));
  return { key, ...report.yhteenveto };
}

(async () => {
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

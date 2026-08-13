#!/usr/bin/env node
// Kausivalidointi: feeditason viikkovahti joka toistaa 12.8.2026 käsivalidoinnin
// ydintarkistukset kaikille CONFIGS-kaupungeille. Ajetaan GitHub Actionsissa
// (ajastettu) tai lokaalisti: node tests/kausivalidointi.js [cityKey ...]
//
// Tarkistukset per kaupunki:
//  1) serviceId-inventaario vs. baseline (tests/kausivalidointi-baseline.json):
//     uusi serviceId = WARN → tarkista osuuko KOUL/LOMA-tunnistus (sama luokittelu
//     kuin tuotteessa: /koul/i, /loma/i, \bKP\b, \bLP\b — Lahti 12.8. opetti että
//     feedi voi vaihtaa lyhennekäytäntöä hiljaa, ja leimat katoavat ilman virhettä).
//  2) Käytäväpresettien elinvoima: jokaisella presetin linjalla vuoroja D+7 (FAIL
//     jos 0) ja D+35 (WARN jos 0 = kausivaihtoennakko, Kajaani-luokan vika) sekä
//     parittainen yhteisten pysäkkien määrä ≥ 3 (WARN — corridorNoShared-raja).
//  3) Solmupysäkin pulssi: centerStopNames[0]-lähtömäärä D+7 vs D+35; WARN jos 0
//     tai muutos > 40 % (kausivaihto tulossa → presetit ja näytteet tarkistettava).
//
// Kiintiökuri (opit 10.–11.8.): kyselyt ovat kevyitä GraphQL-kutsuja (ei
// sivulatauksia), kaupunkien välissä tauko, ja ajastus eri päivälle/ajalle kuin
// Tuotanto-smoken erät. Kulutus < 10 % smoke-ajosta.

const fs = require("fs");
const path = require("path");

const PROXY = process.env.PROXY || "https://lsl-aikataulut-proxy.veikkoville.workers.dev/";
const CITY_GAP_MS = +(process.env.CITY_GAP_MS || 8000);
const QUERY_GAP_MS = +(process.env.QUERY_GAP_MS || 1500);
const BASELINE_PATH = path.join(__dirname, "kausivalidointi-baseline.json");
const REPORT_PATH = process.env.REPORT_PATH || path.join(__dirname, "..", "kausivalidointi-tulos.json");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- CONFIGS luetaan index.html:stä (sama totuus kuin tuotteessa, ei kopiota) ---
function extractConfigs() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const start = html.indexOf("const CONFIGS = {");
  if (start < 0) throw new Error("CONFIGS-lohkoa ei löytynyt index.html:stä");
  const open = html.indexOf("{", start);
  // Sulkulaskuri joka ohittaa merkkijonot, template-literaalit ja kommentit.
  let depth = 0, i = open, mode = null;
  for (; i < html.length; i++) {
    const c = html[i], n = html[i + 1];
    if (mode === "line") { if (c === "\n") mode = null; continue; }
    if (mode === "block") { if (c === "*" && n === "/") { mode = null; i++; } continue; }
    if (mode) { // merkkijono: '"', "'" tai "`"
      if (c === "\\") { i++; continue; }
      if (c === mode) mode = null;
      continue;
    }
    if (c === "/" && n === "/") { mode = "line"; i++; continue; }
    if (c === "/" && n === "*") { mode = "block"; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { mode = c; continue; }
    if (c === "{") depth++;
    if (c === "}") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error("CONFIGS-lohkon sulut eivät täsmää");
  const src = html.slice(open, i + 1);
  const configs = new Function("return (" + src + ")")();
  const keys = Object.keys(configs);
  if (keys.length < 10 || !configs.lahti) throw new Error("CONFIGS-poiminta epäilyttävä: " + keys.length + " avainta");
  return configs;
}

// --- GraphQL proxyn läpi (sama reitti kuin tuotteessa) ---
async function gql(query, variables) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(PROXY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) { // kiintiö: pitkä jäähdytys, sama oppi kuin smokessa
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

// Sama luokittelu kuin index.html:n päivätyyppiryhmittelyssä (yksi totuus tuotteessa,
// tämä on sen kopio vahtia varten — jos tuotteen regex muuttuu, päivitä tämä).
const classify = sid =>
  (/koul/i.test(sid) || /\bKP\b/.test(sid)) ? "koul"
  : (/loma/i.test(sid) || /\bLP\b/.test(sid)) ? "loma" : "";

const compact = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

const results = [];
let fails = 0, warns = 0;
const log = (level, city, check, msg) => {
  results.push({ level, city, check, msg });
  if (level === "FAIL") fails++;
  if (level === "WARN") warns++;
  console.log(`${level} [${city}] ${check} — ${msg}`);
};

async function runCity(key, cfg, feeds, baseline, dNear, dFar) {
  const feed = feeds.find(f => cfg.feedMatch.test(f));
  if (!feed) { log("FAIL", key, "feed", "feedMatch ei osu yhteenkään feediin"); return; }

  // 1) serviceId-inventaario
  const inv = await gql(
    `query ($feeds: [String]) { routes(feeds: $feeds) { shortName trips { serviceId } } }`,
    { feeds: [feed] });
  const sids = [...new Set((inv.routes || []).flatMap(r => (r.trips || []).map(t => t.serviceId || "")))]
    .filter(Boolean).sort();
  const known = new Set(baseline[key] || []);
  const fresh = sids.filter(s => !known.has(s));
  const counts = { koul: 0, loma: 0, muu: 0 };
  sids.forEach(s => counts[classify(s) || "muu"]++);
  if (!baseline[key]) {
    log("WARN", key, "serviceId-baseline", `puuttuu — ${sids.length} serviceId:tä kirjattu ehdotukseen`);
  } else if (fresh.length) {
    const unclassified = fresh.filter(s => !classify(s));
    log("WARN", key, "serviceId-uudet",
      `${fresh.length} uutta serviceId:tä (${unclassified.length} ilman koul/loma-luokkaa): ` +
      fresh.slice(0, 6).map(s => `"${s}"`).join(", ") + (fresh.length > 6 ? " …" : "") +
      " → tarkista tunnistus ja päivitä baseline");
  } else {
    log("PASS", key, "serviceId-inventaario", `${sids.length} serviceId:tä, ei uusia (koul ${counts.koul} / loma ${counts.loma} / muu ${counts.muu})`);
  }
  baseline["__ehdotus_" + key] = sids; // ehdotus talteen raporttiin
  await sleep(QUERY_GAP_MS);

  // 2) käytäväpresetit
  for (const corr of (cfg.corridors || [])) {
    const perLine = new Map(); // line -> {near, far, stops:Set}
    for (const line of corr.lines) {
      const d = await gql(
        `query ($feeds: [String], $name: String) {
           routes(feeds: $feeds, name: $name) { shortName patterns {
             stops { gtfsId }
             near: tripsForDate(serviceDate: "${dNear}") { gtfsId }
             far: tripsForDate(serviceDate: "${dFar}") { gtfsId } } } }`,
        { feeds: [feed], name: line });
      // name-haku on osittainen → suodata täsmälliseen shortNameen
      const routes = (d.routes || []).filter(r => r.shortName === line);
      let near = 0, far = 0; const stops = new Set();
      for (const r of routes) for (const p of (r.patterns || [])) {
        near += (p.near || []).length; far += (p.far || []).length;
        if ((p.near || []).length) (p.stops || []).forEach(s => stops.add(s.gtfsId));
      }
      perLine.set(line, { near, far, stops });
      if (near === 0) log("FAIL", key, `presetti ${corr.key}`, `linjalla ${line} 0 vuoroa ${dNear} — presetti kuollut (vrt. Kajaani 12.8.)`);
      else if (far === 0) log("WARN", key, `presetti ${corr.key}`, `linjalla ${line} 0 vuoroa ${dFar} — kausivaihto tulossa, tarkista presetti`);
      await sleep(QUERY_GAP_MS);
    }
    // parittainen yhteisten pysäkkien määrä (corridorNoShared-raja = 3)
    const lines = [...perLine.entries()].filter(([, v]) => v.near > 0);
    for (let a = 0; a < lines.length; a++) for (let b = a + 1; b < lines.length; b++) {
      const shared = [...lines[a][1].stops].filter(s => lines[b][1].stops.has(s)).length;
      if (shared < 3) log("WARN", key, `presetti ${corr.key}`,
        `linjoilla ${lines[a][0]}+${lines[b][0]} vain ${shared} yhteistä pysäkkiä ${dNear} — käytävä ei koostu`);
    }
    const total = [...perLine.values()].reduce((n, v) => n + v.near, 0);
    if (total > 0 && ![...results.slice(-6)].some(r => r.city === key && r.check === `presetti ${corr.key}` && r.level !== "PASS"))
      log("PASS", key, `presetti ${corr.key}`, `${corr.lines.join("+")}: ${total} vuoroa ${dNear}, jaettu jakso OK`);
  }

  // 3) solmupysäkin pulssi
  const stopName = (cfg.centerStopNames || [])[0];
  if (stopName) {
    const d = await gql(
      `query ($name: String) { stops(name: $name) { gtfsId
         near: stoptimesForServiceDate(date: "${dNear}", omitNonPickups: true) { stoptimes { scheduledDeparture } }
         far: stoptimesForServiceDate(date: "${dFar}", omitNonPickups: true) { stoptimes { scheduledDeparture } } } }`,
      { name: stopName });
    // stops(name:) EI ole feed-scoped (PLAYBOOK) → suodata feed-prefiksillä
    const own = (d.stops || []).filter(s => s.gtfsId.startsWith(feed + ":"));
    const count = sel => own.reduce((n, s) => n + (s[sel] || []).reduce((m, g) => m + (g.stoptimes || []).length, 0), 0);
    const near = count("near"), far = count("far");
    if (near === 0) log("FAIL", key, "solmupysäkki", `"${stopName}" 0 lähtöä ${dNear}`);
    else if (far === 0 || Math.abs(far - near) / near > 0.4)
      log("WARN", key, "solmupysäkki", `"${stopName}" ${near} lähtöä ${dNear} → ${far} lähtöä ${dFar} — kausivaihto tulossa`);
    else log("PASS", key, "solmupysäkki", `"${stopName}" ${near} → ${far} lähtöä, vakaa`);
  }
}

(async () => {
  const configs = extractConfigs();
  const cityFilter = process.argv.slice(2);
  const cities = Object.keys(configs).filter(k => !cityFilter.length || cityFilter.includes(k));
  const unknown = cityFilter.filter(k => !configs[k]);
  if (unknown.length) { console.error("tuntematon kaupunki: " + unknown.join(", ")); process.exit(2); }

  const baseline = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) : {};
  const feedsData = await gql(`{ feeds { feedId } }`);
  const feeds = (feedsData.feeds || []).map(f => f.feedId);
  const dNear = compact(plusDays(7)), dFar = compact(plusDays(35));
  console.log(`kausivalidointi: ${cities.length} kaupunkia, päivät ${dNear} / ${dFar}, proxy ${PROXY}`);

  for (const key of cities) {
    try { await runCity(key, configs[key], feeds, baseline, dNear, dFar); }
    catch (e) { log("FAIL", key, "ajo", "keskeytyi: " + e.message); }
    await sleep(CITY_GAP_MS);
  }

  // Raportti + baseline-ehdotus (workflow lataa artefaktina; baseline päivitetään
  // käsin committina kun uudet serviceId:t on katsottu läpi — ei automaattisesti,
  // ettei vahti hyväksy omaa poikkeamaansa)
  const proposal = {};
  for (const k of Object.keys(baseline)) if (k.startsWith("__ehdotus_")) proposal[k.replace("__ehdotus_", "")] = baseline[k];
  fs.writeFileSync(REPORT_PATH, JSON.stringify({ ajettu: new Date().toISOString(), dNear, dFar, results, baselineEhdotus: proposal }, null, 2));
  console.log(`\nYHTEENVETO: ${results.filter(r => r.level === "PASS").length} PASS / ${warns} WARN / ${fails} FAIL`);
  console.log("raportti: " + REPORT_PATH);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("kausivalidointi kaatui: " + e.message); process.exit(2); });

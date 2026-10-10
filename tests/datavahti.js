#!/usr/bin/env node
// Datavahti (10.10.2026): päivittäinen tarkistus siitä, että jokainen CONFIGS-viittaus Digitransit-dataan
// löytyy yhä nykyisestä datasta. Ajo: node tests/datavahti.js [cityKey ...]
//
// MIKSI. Syötteet muuttuvat ilman ilmoitusta. Raaseporin syöte muutti 6.-8.10.2026 varianttilinjojen
// tunnukset muotoon "192_V" (oli "192V"), ja käytäväpreset valitsi sen jälkeen hiljaa vain yhden linjan.
// Viikoittainen Tuotanto-smoke huomasi sen vasta 8.10. yöllä ja kausivalidointi olisi huomannut sen vasta
// tiistaina. Tämä vahti ajetaan kerran vuorokaudessa ja kaatuu (punainen ajo), kun viittaus ei enää löydy.
// Kevyt: pelkkiä GraphQL-kutsuja proxyn läpi (sama reitti kuin tuotteessa), ei selainta, ei riippuvuuksia.
//
// Tarkistukset per kaupunki. FAIL = viittaus rikki (ajo punainen), WARN = toimii, mutta katso.
//  1) feedMatch osuu feediin, extraFeeds löytyvät.
//  2) Linjaviittaukset: käytäväpresetit (corridors[].lines) sekä kaupungin vihkon osiot, yhdistelmät,
//     aikataulupisteiden linjat ja yhdistetyt linjat (vihko.*). shortName löytyy syötteestä (FAIL jos ei) täsmälleen
//     tai erotinmerkkiä vaille sama (molemmat hyväksytään, esim. "192V" ja syötteen "192_V"), ja linjalla on vuoroja
//     linjojen horisontissa (84 pv). Preset ilman vuoroja = FAIL (kesätauon aikana WARN), vihkon linja ilman vuoroja = WARN (kausilinjat),
//     tauko lähimmän viikon aikana = WARN (sovellus näyttää "liikennöi X alkaen", ks. loadPrintRoutes).
//     Tapahtumalinjat (eventLines, vihko.eventPages) ja lineNotes-avaimet: puuttuva = WARN (vain teksti).
//  3) Tiskin oletuspysäkki (deskHomeStop.id/ids): pysäkki löytyy (FAIL) ja sillä on lähtöjä 7 päivän
//     aikana (FAIL jos 0).
//  4) centerStopNames: nimihaku osuu omaan feediin (FAIL jos 0). Tiskin varakeino ja solmupysäkki.
//  5) hubs (#/laiturit): sama haku kuin sovelluksessa (loadHubStops): pysäkkejä, joilla on linjoja, on
//     vähintään 1 allow-suodatuksen jälkeen (FAIL jos 0). Puuttuvat allow-tunnukset = WARN.
//  6) rail (junalohko, #/junat): asemakoodi löytyy rata.digitrafficin asemalistasta ja asemalla on
//     henkilöliikennettä (FAIL).
//  7) Tuotanto-smoken pinnatut pysäkit (tests/prod-smoke.test.js: nightStopId, posterStopId): löytyvät ja
//     niillä on lähtöjä 7 päivän aikana (FAIL).
//  8) Linjatyylien avaimet (lineStyles, netLineStyles): puuttuvat = WARN (yksi rivi per kaupunki).
//
// Rakenne: collect() hakee kaupungin datan tilannekuvaksi, evaluate() tekee päätökset ilman verkkoa.
// Yksikkötesti (tests/datavahti.test.js) syöttää evaluatelle rikotun viittauksen ja vaatii FAILin.
// DATAVAHTI_CONFIGS=<polku.json> korvaa index.html:n CONFIGSin (mutaatiotesti oikeaa dataa vasten).

const fs = require("fs");
const path = require("path");

const PROXY = process.env.PROXY || "https://lsl-aikataulut-proxy.veikkoville.workers.dev/";
const RAIL_STATIONS = "https://rata.digitraffic.fi/api/v1/metadata/stations";
const CITY_GAP_MS = +(process.env.CITY_GAP_MS || 3000);
const REPORT_PATH = process.env.REPORT_PATH || path.join(__dirname, "..", "datavahti-tulos.json");
const HORIZON_DAYS = 84;   // = index.html LINE_HORIZON_DAYS (Digitransitin data-ikkuna, linja listoissa)
const NEAR_DAYS = 8;       // lähin viikko: tätä myöhemmin alkava linja näytetään "liikennöi X alkaen"
// Tunnetut tauot, joita horisontti ei aina kata (10.10.2026). Koulujen kesäloma kestää noin 10-11 viikkoa, ja
// kesäkuun alussa seuraavan kauden aikataulu ei yleensä ole vielä syötteessä: koulupäivälinjalla ei silloin ole
// vuoroja koko ikkunassa, vaikka se palaa elokuussa. Tauon aikana (ja viikko ennen) vuorottomuus on WARN eikä
// FAIL; muulloin vuoroton presetin linja on FAIL. Syys-, joulu-, talvi- ja pääsiäisloma mahtuvat ikkunaan.
const KNOWN_BREAKS = [{ nimi: "koulujen kesäloma", alku: [6, 1], loppu: [8, 20], ennen: 7 }];
function knownBreak(day) {   // day = YYYYMMDD
  const d = new Date(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8));
  return KNOWN_BREAKS.find(b => {
    const from = new Date(d.getFullYear(), b.alku[0] - 1, b.alku[1] - b.ennen), to = new Date(d.getFullYear(), b.loppu[0] - 1, b.loppu[1]);
    return d >= from && d <= to;
  }) || null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const norm = s => String(s == null ? "" : s).replace(/[\s_.\-]/g, "").toLowerCase();   // = index.html lineKeyNorm
const compact = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const dayList = (n, from = new Date()) =>
  [...Array(n)].map((_, i) => compact(new Date(from.getFullYear(), from.getMonth(), from.getDate() + i)));
const fmtDay = s => `${+s.slice(6, 8)}.${+s.slice(4, 6)}.`;

function extractConfigs() {
  if (process.env.DATAVAHTI_CONFIGS) return JSON.parse(fs.readFileSync(process.env.DATAVAHTI_CONFIGS, "utf8"),
    (k, v) => (k === "feedMatch" && typeof v === "string" ? new RegExp(v.replace(/^\/|\/[a-z]*$/g, ""), (v.match(/\/([a-z]*)$/) || [])[1] || "") : v));
  return require("./kausivalidointi.js").extractConfigs();
}

// Tuotanto-smoken pinnatut pysäkit luetaan testitiedostosta (yksi totuus, ei kopiota).
function smokePins() {
  const src = fs.readFileSync(path.join(__dirname, "prod-smoke.test.js"), "utf8");
  const block = src.slice(src.indexOf("let CITIES = ["), src.indexOf("];", src.indexOf("let CITIES = [")));
  const pins = {};
  for (const part of block.split(/\{\s*key:\s*/).slice(1)) {
    const key = (part.match(/^"([^"]+)"/) || [])[1];
    if (!key) continue;
    for (const m of part.matchAll(/(nightStopId|posterStopId):\s*"([^"]+)"/g)) (pins[key] = pins[key] || []).push({ field: m[1], id: m[2] });
  }
  return pins;
}

// Kaupungin linjaviittaukset: [{ line, src, kind }] kind = "preset" | "vihko" | "text"
function lineRefs(cfg) {
  const out = [];
  const add = (line, src, kind) => { if (line != null && line !== "") out.push({ line: String(line), src, kind }); };
  for (const c of cfg.corridors || []) for (const l of c.lines || []) add(l, `käytäväpreset ${c.key}`, "preset");
  const v = cfg.vihko || {};
  for (const s of v.sections || []) for (const l of s.lines || []) add(l, `vihkon osio ${s.key}`, "vihko");
  for (const c of v.combos || []) for (const l of c.lines || []) add(l, `vihkon yhdistelmä ${c.key}`, "vihko");
  for (const l of v.timingLines || []) add(l, "vihko.timingLines", "vihko");
  for (const [a, m] of Object.entries(v.merge || {})) { add(a, "vihko.merge", "vihko"); for (const b of Object.keys(m || {})) add(b, "vihko.merge", "vihko"); }
  for (const e of v.eventPages || []) add(e.line, "vihko.eventPages", "text");
  for (const l of cfg.eventLines || []) add(l, "eventLines", "text");
  for (const l of Object.keys(cfg.lineNotes || {})) add(l, "lineNotes", "text");
  return out;
}

async function gqlFetch(query, variables, router) {
  const target = router && router !== "waltti" ? PROXY + (PROXY.includes("?") ? "&" : "?") + "router=" + encodeURIComponent(router) : PROXY;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://demo.reittari.fi" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) { if (attempt === 3) throw new Error("HTTP 429 (kiintiö) 3 yrityksen jälkeen"); await sleep(60000 * attempt); continue; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors.map(e => e.message).join("; "));
    return json.data;
  }
}

// --- Tilannekuva verkosta ---
async function collect(key, cfg, ctx) {
  const router = cfg.router || "waltti";
  const q = (query, variables) => ctx.gql(query, variables, router);
  if (!ctx.feeds[router]) ctx.feeds[router] = ((await q(`{ feeds { feedId } }`)).feeds || []).map(f => f.feedId);
  const feeds = ctx.feeds[router];
  const snap = { router, feeds, feed: feeds.find(f => cfg.feedMatch.test(f)) || null, days: ctx.days,
    routes: [], service: {}, stops: {}, names: {}, hubs: {} };
  if (!snap.feed) return snap;
  const feed = snap.feed;

  // Linjat (kevyt: ei patterneja) ja viitattujen linjojen vuorot tulostusjaksolla.
  const refs = lineRefs(cfg);
  const styleKeys = [...Object.keys(cfg.lineStyles || {}), ...Object.keys(cfg.netLineStyles || {})];
  if (refs.length || styleKeys.length) {
    snap.routes = ((await q(`query ($feeds: [String]) { routes(feeds: $feeds) { gtfsId shortName mode } }`, { feeds: [feed] })).routes || [])
      .filter(Boolean).map(r => ({ gtfsId: r.gtfsId, shortName: r.shortName, mode: r.mode }));
    const want = new Set(refs.map(r => norm(r.line)));   // molemmat muodot ("192V" ja "192_V")
    const ids = snap.routes.filter(r => want.has(norm(r.shortName))).map(r => r.gtfsId);
    const aliases = ctx.days.map((d, i) => `d${i}: tripsForDate(serviceDate: "${d}") { gtfsId }`).join(" ");
    for (let i = 0; i < ids.length; i += 10) {
      await sleep(ctx.gap);
      const d = await q(`query ($ids: [String]) { routes(ids: $ids) { gtfsId patterns { ${aliases} } } }`, { ids: ids.slice(i, i + 10) });
      for (const r of (d.routes || []).filter(Boolean))
        snap.service[r.gtfsId] = ctx.days.map((_, k) => (r.patterns || []).reduce((n, p) => n + (p["d" + k] || []).length, 0));
    }
  }

  // Pysäkit tunnuksella: tiskin oletuspysäkki + smoken pinnatut.
  const home = cfg.deskHomeStop && typeof cfg.deskHomeStop === "object" ? cfg.deskHomeStop : null;
  const stopIds = [...new Set([...(home ? (home.ids || [home.id]) : []), ...(ctx.pins[key] || []).map(p => p.id)].filter(Boolean))];
  const week = ctx.days.slice(0, 7);
  for (const id of stopIds) {
    await sleep(ctx.gap);
    const d = await q(`query ($id: String!) { stop(id: $id) { gtfsId name
      ${week.map((x, i) => `w${i}: stoptimesForServiceDate(date: "${x}", omitNonPickups: true) { stoptimes { scheduledDeparture } }`).join(" ")} } }`, { id });
    const s = d.stop;
    snap.stops[id] = s ? { found: true, name: s.name,
      deps: week.reduce((n, _, i) => n + (s["w" + i] || []).reduce((m, g) => m + (g.stoptimes || []).length, 0), 0) } : { found: false };
  }

  // Nimihaut: centerStopNames ja hubit (sama haku kuin loadHubStops).
  for (const name of cfg.centerStopNames || []) {
    await sleep(ctx.gap);
    const d = await q(`query ($name: String!) { stops(name: $name) { gtfsId name platformCode routes { gtfsId } } }`, { name });
    snap.names[name] = (d.stops || []).filter(s => s.gtfsId.startsWith(feed + ":"));
  }
  for (const hub of cfg.hubs || []) {
    await sleep(ctx.gap);
    let list;
    if (cfg.areaScoped && hub.center) {
      const d = await q(`query ($lat: Float!, $lon: Float!) { stopsByRadius(lat: $lat, lon: $lon, radius: 1200, first: 80) {
        edges { node { stop { gtfsId name platformCode routes { gtfsId } } } } } }`, { lat: hub.center.lat, lon: hub.center.lon });
      list = ((d.stopsByRadius && d.stopsByRadius.edges) || []).map(e => e.node && e.node.stop).filter(Boolean);
    } else {
      const d = await q(`query ($name: String!) { stops(name: $name) { gtfsId name platformCode routes { gtfsId } } }`, { name: hub.name });
      list = d.stops || [];
    }
    snap.hubs[hub.key] = list.filter(s => s.gtfsId.startsWith(feed + ":"));
  }
  return snap;
}

// = index.html boardingInfo(): laiturin tunnus platformCodesta tai nimen loppuosasta.
function hubTag(stop, hubName) {
  if (stop.platformCode) return stop.platformCode;
  const n = (stop.name || "").trim();
  if (hubName && n.toLowerCase().startsWith(hubName.toLowerCase())) {
    const rest = n.slice(hubName.length).replace(/^[\s,–-]+/, "").trim();
    if (rest && /^(\d{1,2}\s?[A-ZÄÖÅ]?|[A-ZÄÖÅ])$/.test(rest)) return rest;
  }
  return "•";
}

// --- Päätökset tilannekuvasta (ei verkkoa) ---
function evaluate(key, cfg, snap, ctx) {
  const out = [];
  const log = (level, check, msg) => out.push({ level, city: key, check, msg });
  if (!snap.feed) {
    log("FAIL", "feed", `feedMatch ${cfg.feedMatch} ei osu yhteenkään feediin (router ${snap.router}, ${snap.feeds.length} feediä)`);
    return out;
  }
  for (const f of cfg.extraFeeds || []) if (!snap.feeds.includes(f)) log("FAIL", "feed", `lisäfeed ${f} puuttuu routerista ${snap.router}`);

  // 2) linjat
  const byShort = new Map();
  for (const r of snap.routes) { if (!byShort.has(r.shortName)) byShort.set(r.shortName, []); byShort.get(r.shortName).push(r); }
  const seen = new Set();
  for (const ref of lineRefs(cfg)) {
    const k = ref.line + "|" + ref.src;
    if (seen.has(k)) continue;
    seen.add(k);
    let exact = byShort.get(ref.line) || [];
    const check = `linja ${ref.line} (${ref.src})`;
    // Tunnuksen muotoero ("192V" ja syötteessä "192_V") hyväksytään: sovellus tunnistaa molemmat (lineKeyNorm)
    // ja näyttää muodon 192V (10.10.2026). Puuttuva linja on FAIL.
    let form = "";
    if (!exact.length) {
      exact = snap.routes.filter(r => norm(r.shortName) === norm(ref.line));
      if (exact.length) form = `; syötteessä muodossa ${[...new Set(exact.map(r => `"${r.shortName}"`))].join(", ")}, sovellus tunnistaa molemmat`;
    }
    if (!exact.length) {
      log(ref.kind === "text" ? "WARN" : "FAIL", check,
        `shortName "${ref.line}" puuttuu syötteestä ${snap.feed}: linja lakkautettu tai tunnus vaihtunut`);
      continue;
    }
    const counts = snap.days.map((_, i) => exact.reduce((n, r) => n + ((snap.service[r.gtfsId] || [])[i] || 0), 0));
    const first = counts.findIndex(n => n > 0);
    const brk = knownBreak(snap.days[0]);
    if (first < 0 && brk && ref.kind !== "text") {
      log("WARN", check, `ei vuoroja ${HORIZON_DAYS} päivään (${fmtDay(snap.days[0])}-${fmtDay(snap.days[snap.days.length - 1])}): ` +
        `${brk.nimi} on tunnettu tauko, jota horisontti ei kata ennen kuin syötteessä on seuraavan kauden aikataulu; ` +
        `${ref.kind === "preset" ? "preset ei koostu tauon aikana, harkitse kesäpresettiä" : "linja ei näy listoissa tauon aikana"}`);
    } else if (first < 0) {
      log(ref.kind === "preset" ? "FAIL" : "WARN", check,
        `ei vuoroja ${HORIZON_DAYS} päivään (${fmtDay(snap.days[0])}-${fmtDay(snap.days[snap.days.length - 1])})${ref.kind === "preset" ? ": preset ei koostu" : ""}`);
    } else if (first >= NEAR_DAYS && ref.kind !== "text") {
      log("WARN", check, `tauko lähimmän viikon aikana, liikennöi ${fmtDay(snap.days[first])} alkaen (linjalista ja tulosteet näyttävät alkamispäivän)${form}`);
    } else {
      log("PASS", check, `${counts.slice(0, NEAR_DAYS).reduce((a, b) => a + b, 0)} vuoroa lähimmän viikon aikana${form}`);
    }
  }
  const styleMiss = [...Object.keys(cfg.lineStyles || {}), ...Object.keys(cfg.netLineStyles || {})].filter(s => !byShort.has(s));
  if (styleMiss.length) log("WARN", "linjatyylit", `avaimia ilman linjaa syötteessä: ${[...new Set(styleMiss)].join(", ")}`);

  // 3) ja 7) pysäkit tunnuksella
  const home = cfg.deskHomeStop && typeof cfg.deskHomeStop === "object" ? cfg.deskHomeStop : null;
  const idChecks = [...(home ? (home.ids || [home.id]).filter(Boolean).map(id => ({ id, src: "tiskin oletuspysäkki" })) : []),
    ...((ctx.pins || {})[key] || []).map(p => ({ id: p.id, src: `prod-smoke ${p.field}` }))];
  for (const { id, src } of idChecks) {
    const s = snap.stops[id];
    if (!s || !s.found) log("FAIL", `${src} ${id}`, "pysäkkiä ei löydy syötteestä: tunnus vaihtunut tai pysäkki poistettu");
    else if (!s.deps) log("FAIL", `${src} ${id}`, `"${s.name}" 0 lähtöä 7 päivän aikana: pysäkki ei ole enää käytössä`);
    else log("PASS", `${src} ${id}`, `"${s.name}" ${s.deps} lähtöä 7 päivän aikana`);
  }

  // 4) solmupysäkkien nimet
  for (const name of cfg.centerStopNames || []) {
    const hits = snap.names[name] || [];
    const live = hits.filter(s => (s.routes || []).length);
    if (!live.length) log("FAIL", `centerStopNames "${name}"`, `nimihaku ei osu yhteenkään feedin ${snap.feed} pysäkkiin, jolla on linjoja`);
    else log("PASS", `centerStopNames "${name}"`, `${live.length} pysäkkiä`);
  }

  // 5) keskusterminaalit
  for (const hub of cfg.hubs || []) {
    const stops = (snap.hubs[hub.key] || []).filter(s => (s.routes || []).length);
    const shown = hub.allow ? stops.filter(s => hub.allow.includes(hubTag(s, hub.name))) : stops;
    if (!shown.length) {
      log("FAIL", `laiturit ${hub.key}`, `"${hub.name}": 0 pysäkkiä, joilla on linjoja${hub.allow ? " (allow-suodatuksen jälkeen)" : ""}: laiturinäkymä on tyhjä`);
    } else {
      const tags = new Set(stops.map(s => hubTag(s, hub.name)));
      const lost = (hub.allow || []).filter(a => !tags.has(a));
      lost.length
        ? log("WARN", `laiturit ${hub.key}`, `"${hub.name}": ${shown.length} pysäkkiä, allow-tunnukset ilman pysäkkiä: ${lost.join(", ")}`)
        : log("PASS", `laiturit ${hub.key}`, `"${hub.name}": ${shown.length} pysäkkiä`);
    }
  }

  // 6) juna-asemat
  const codes = cfg.rail ? (Array.isArray(cfg.rail) ? cfg.rail : [cfg.rail]) : [];
  for (const code of codes) {
    if (!ctx.stations) { log("WARN", `juna-asema ${code}`, "rata.digitrafficin asemalistaa ei saatu: ei tarkistettu"); continue; }
    const st = ctx.stations.get(code);
    if (!st) log("FAIL", `juna-asema ${code}`, "asemakoodia ei löydy rata.digitrafficin asemalistasta");
    else if (!st.passengerTraffic) log("FAIL", `juna-asema ${code}`, `${st.stationName}: ei henkilöliikennettä`);
    else log("PASS", `juna-asema ${code}`, st.stationName);
  }
  return out;
}

async function loadStations() {
  const res = await fetch(RAIL_STATIONS, { headers: { "Digitraffic-User": "Reittari", "Accept-Encoding": "gzip" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return new Map((await res.json()).map(s => [s.stationShortCode, s]));
}

if (require.main === module) (async () => {
  const configs = extractConfigs();
  const filter = process.argv.slice(2);
  const unknown = filter.filter(k => !configs[k]);
  if (unknown.length) { console.error("tuntematon kaupunki: " + unknown.join(", ")); process.exit(2); }
  const cities = Object.keys(configs).filter(k => !filter.length || filter.includes(k));
  const ctx = { gql: gqlFetch, feeds: {}, days: dayList(HORIZON_DAYS), pins: smokePins(), gap: +(process.env.QUERY_GAP_MS || 600), stations: null };
  try { ctx.stations = await loadStations(); } catch (e) { console.log("WARN rata.digitrafficin asemalista: " + e.message); }
  console.log(`datavahti: ${cities.length} kaupunkia, jakso ${ctx.days[0]}-${ctx.days[ctx.days.length - 1]}, proxy ${PROXY}`);
  const results = [];
  for (const key of cities) {
    let res;
    try { res = evaluate(key, configs[key], await collect(key, configs[key], ctx), ctx); }
    catch (e) { res = [{ level: "FAIL", city: key, check: "ajo", msg: "keskeytyi: " + e.message }]; }
    for (const r of res) if (r.level !== "PASS" || process.env.VERBOSE) console.log(`${r.level} [${r.city}] ${r.check}: ${r.msg}`);
    results.push(...res);
    await sleep(CITY_GAP_MS);
  }
  const n = lvl => results.filter(r => r.level === lvl).length;
  fs.writeFileSync(REPORT_PATH, JSON.stringify({ ajettu: new Date().toISOString(), jakso: [ctx.days[0], ctx.days[ctx.days.length - 1]], results }, null, 2));
  console.log(`\nYHTEENVETO: ${n("PASS")} PASS / ${n("WARN")} WARN / ${n("FAIL")} FAIL`);
  if (n("FAIL")) console.log("Rikkinäinen viittaus: korjaa CONFIG (index.html) tai prod-smoken pinnaus nykyisen datan mukaan.");
  process.exit(n("FAIL") ? 1 : 0);
})().catch(e => { console.error("datavahti kaatui: " + e.message); process.exit(2); });

module.exports = { evaluate, lineRefs, hubTag, smokePins, dayList, norm, knownBreak, HORIZON_DAYS };

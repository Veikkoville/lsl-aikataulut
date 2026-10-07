// Auditoinnin 3.10.2026 korjausten regressiotestit: R-01 (KV-kirjoitukset vain tilan muuttuessa,
// kirjoittavien reittien Origin- ja kokorajat), R-02 (vahvistusviestien raja osoitteen tiivisteellä
// kaupungista riippumatta), R-06 (Digitransit-proxyn käyttö- ja kokoraja), R-07 (/track ilman
// kaksoislaskentaa ja tulvaa) ja R-08 (feed johdetaan kaupungista). Lisäksi ristiintarkistus
// index.html:ään: workerin kaupunki-, feed- ja näkymälistat eivät saa jäädä jälkeen sovelluksesta.
// Mock-KV laskee kirjoitukset, Resend, Digitransit ja push-palvelu ovat tynkiä. Ei verkkoa.
// Aja: node write-guard.test.js   (REPO_ROOT=<polku> lukee index.html:n ja docs/:n muualta)
import * as W from "./worker.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const worker = W.default;
const ROOT = process.env.REPO_ROOT || fileURLToPath(new URL("..", import.meta.url));
let fail = 0, total = 0;
const check = (cond, msg) => { total++; console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };
const reset = () => { if (typeof W.resetIsolateLimits === "function") W.resetIsolateLimits(); };
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const MIN = 60 * 1000, H = 60 * MIN, D = 24 * H;

function countingKV() {
  const m = new Map(), ttl = new Map();
  const kv = {
    _m: m, _ttl: ttl, puts: 0, deletes: 0,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v, o) { kv.puts++; m.set(k, v); if (o && o.expirationTtl) ttl.set(k, o.expirationTtl); else ttl.delete(k); },
    async delete(k) { kv.deletes++; m.delete(k); ttl.delete(k); },
    async list({ prefix } = {}) {
      return { keys: [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })), list_complete: true, cursor: "" };
    },
  };
  return kv;
}
const writes = kv => kv.puts + kv.deletes;

// --- Tynkä-fetch ---
let currentAlerts = [], currentCmsPosts = [];
const alertFeedsAsked = [], pushSends = [], resendSends = [], upstreamCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("digitransit.fi/routing")) {
    const b = typeof opts.body === "string" ? opts.body : "";
    if (b.includes("alerts(feeds")) {
      try { alertFeedsAsked.push(...JSON.parse(b).variables.feeds); } catch (e) { /* ohita */ }
      return { json: async () => ({ data: { alerts: currentAlerts } }) };
    }
    upstreamCalls.push({ url: u, body: b });
    return new Response('{"data":{}}', { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("digitransit.fi/geocoding")) { upstreamCalls.push({ url: u }); return new Response("{}", { status: 200 }); }
  if (u.includes("/wp-json/")) return { ok: true, json: async () => currentCmsPosts };
  if (u.includes("api.resend.com")) { resendSends.push(JSON.parse(opts.body)); return { status: 200, ok: true }; }
  if (u.startsWith("https://push.example") || u.startsWith("https://fcm.googleapis.com")) { pushSends.push(u); return { status: 201 }; }
  throw new Error("odottamaton fetch: " + u);
};

// --- Aito ECDH-avain tilaajalle ja kertakäyttöinen VAPID (ei tuotantoavaimia) ---
const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const uaKp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const P256 = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", uaKp.publicKey)));
const AUTH = b64u(crypto.getRandomValues(new Uint8Array(16)));
const vapidKp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapidPriv = await crypto.subtle.exportKey("jwk", vapidKp.privateKey);
const vapidPub = await crypto.subtle.exportKey("jwk", vapidKp.publicKey);
const vapidPoint = (() => {
  const x = Buffer.from(vapidPub.x, "base64url"), y = Buffer.from(vapidPub.y, "base64url");
  const p = new Uint8Array(65); p[0] = 4; p.set(x, 1); p.set(y, 33); return b64u(p);
})();
const VAPID = { VAPID_PUBLIC: vapidPoint, VAPID_PRIVATE_JWK: JSON.stringify(vapidPriv), VAPID_SUBJECT: "mailto:test@example.com" };

// Sovelluksen PushSubscription.toJSON()-muoto
const pushSub = (n = 1) => ({ endpoint: "https://fcm.googleapis.com/fcm/send/testi-" + n, expirationTime: null, keys: { p256dh: P256, auth: AUTH } });

const ORIGIN = "https://demo.reittari.fi";
const req = (p, init = {}) => new Request("https://worker.test" + p, init);
const post = (p, body, o = {}) => {
  const headers = { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537" };
  if (o.origin !== null) headers.Origin = o.origin || ORIGIN;
  if (o.ip) headers["CF-Connecting-IP"] = o.ip;
  return req(p, { method: "POST", headers: { ...headers, ...(o.headers || {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
};
const ctx = { waitUntil() {} };

/* ===== R-01a: cronin KV-kirjoitukset vain tilan muuttuessa ===== */
{
  reset();
  const kv = countingKV();
  const env = { PUSH_KV: kv, DIGITRANSIT_KEY: "test", ...VAPID };
  await kv.put("sub:a", JSON.stringify({ endpoint: "https://push.example/a", keys: { p256dh: P256, auth: AUTH },
    routes: ["8"], gtfsRoutes: ["Lahti:8"], feed: "Lahti", city: "lahti", lang: "fi" }));
  const a8 = { alertHeaderText: "Linja 8 poikkeaa", alertDescriptionText: "Työmaa", effectiveStartDate: 0, effectiveEndDate: 0 };
  const recent = new Date(realNow() - D).toISOString();
  currentAlerts = [a8];
  currentCmsPosts = [{ date: recent, link: "https://www.lsl.fi/hairiotiedotteet/x/", title: { rendered: "Poikkeus" }, content: { rendered: "<p>Linja 4 poikkeaa</p>" } }];
  await W.runPushCheck(env);   // ensiajo kylvää kummankin kartan
  check(!!kv._m.get("seen:Lahti") && !!kv._m.get("seenCms:Lahti"), "R-01a: ensiajo kylvää seen- ja seenCms-kartan");
  let before = writes(kv);
  for (let i = 0; i < 288; i++) await W.runPushCheck(env);   // vuorokausi */5-ajoja samalla tilalla
  check(writes(kv) - before === 0, `R-01a: vuorokausi (288 ajoa) muuttumattomalla häiriötilalla = 0 KV-kirjoitusta (oli ${writes(kv) - before})`);

  const a8b = { alertHeaderText: "Linja 8 peruttu", alertDescriptionText: "Ilta", effectiveStartDate: 0, effectiveEndDate: 0 };
  before = writes(kv); let sends = pushSends.length;
  currentAlerts = [a8, a8b];
  await W.runPushCheck(env);
  check(writes(kv) - before === 1 && pushSends.length - sends === 1, "R-01a: uusi häiriö = 1 kirjoitus ja 1 push");
  before = writes(kv); sends = pushSends.length;
  currentAlerts = [a8];
  await W.runPushCheck(env);
  check(writes(kv) - before === 1 && pushSends.length - sends === 0, "R-01a: häiriön poistuminen = 1 kirjoitus, ei pushia");
  before = writes(kv);
  await W.runPushCheck(env);
  check(writes(kv) - before === 0, "R-01a: poistumisen jälkeen tila pysyy, 0 kirjoitusta");
  before = writes(kv); sends = pushSends.length;
  currentAlerts = [a8, a8b];
  await W.runPushCheck(env);
  check(pushSends.length - sends === 0 && writes(kv) - before === 1, "R-01a: säilytysaikana palaava häiriö ei lähetä uutta pushia (1 kirjoitus)");
  currentAlerts = [a8];
  await W.runPushCheck(env);
  clockOffset = 31 * D;
  before = writes(kv);
  await W.runPushCheck(env);
  const seen = JSON.parse(kv._m.get("seen:Lahti"));
  check(writes(kv) - before === 1 && Object.keys(seen).length === 1, "R-01a: yli 30 vrk sitten poistunut siivotaan yhdellä kirjoituksella");
  clockOffset = 0;
  // Vanha muoto (kaikki arvot positiivisia aikaleimoja) kelpaa: näkymättömät merkitään poistuneiksi kerran
  await kv.put("seen:Lahti", JSON.stringify({ ["Linja 8 poikkeaa|Työmaa|"]: realNow() - H, "vanha|x|": realNow() - 2 * D }));
  before = writes(kv); sends = pushSends.length;
  await W.runPushCheck(env);
  const migr = writes(kv) - before;
  await W.runPushCheck(env);
  check(migr === 1 && writes(kv) - before === 1 && pushSends.length === sends, `R-01a: vanhan muotoinen kartta muunnetaan yhdellä kirjoituksella, ei pushia (${migr}, ${writes(kv) - before}, ${pushSends.length - sends})`);
  await kv.put("seen:Lahti", "{rikki");
  let threw = false;
  try { await W.runPushCheck(env); } catch (e) { threw = true; }
  check(!threw, "R-01a: rikkinäinen seen-kartta ei kaada cronia (kylvetään uudelleen)");
  currentAlerts = []; currentCmsPosts = [];
}

/* ===== R-01b: kirjoittavien reittien Origin-, koko- ja kenttärajat ===== */
{
  reset();
  const kv = countingKV();
  const env = { PUSH_KV: kv, DIGITRANSIT_KEY: "test", RESEND_API_KEY: "t", EMAIL_FROM: "a@b.fi", EMAIL_LINK_BASE: "https://worker.test" };
  const nowS = Math.floor(realNow() / 1000);
  const bodies = {
    "/push/subscribe": { subscription: pushSub(1), routes: ["3"], gtfsRoutes: ["Lahti:3"], feed: "Lahti", city: "Lahti", lang: "fi" },
    "/push/unsubscribe": { endpoint: pushSub(1).endpoint },
    "/push/reminder": { subscription: pushSub(1), fireAt: nowS + 3600, title: "Linja 3", body: "x", tag: "rem-3-1" },
    "/email/subscribe": { email: "origin@example.fi", lines: ["3"], gtfsRoutes: ["Lahti:3"], feed: "Lahti", city: "Lahti", lang: "fi" },
    "/feedback": { category: "other", message: "Pysäkki rikki", contact: "", url: "https://demo.reittari.fi/", city: "lahti" },
    "/reprint/baseline": { city: "lahti", key: "x".repeat(40), units: { a: { printed: "2026-10-01", sig: { v: 1 } } } },
  };
  for (const [p, b] of Object.entries(bodies)) {
    const w0 = writes(kv), m0 = resendSends.length;
    const none = await worker.fetch(post(p, b, { origin: null, ip: "198.51.100.1" }), env, ctx);
    const evil = await worker.fetch(post(p, b, { origin: "https://evil.example", ip: "198.51.100.1" }), env, ctx);
    const prefix = await worker.fetch(post(p, b, { origin: "https://demo.reittari.fi.evil.example", ip: "198.51.100.1" }), env, ctx);
    check(none.status === 403 && evil.status === 403 && prefix.status === 403 && writes(kv) === w0 && resendSends.length === m0,
      `R-01b: ${p} ilman Originia, vieraalla ja etuliiteväärennetyllä Originilla → 403, ei KV-kirjoitusta eikä viestiä`);
  }
  // Kaikki sovelluksen tuotanto-originit pääsevät läpi (STAFF_HOSTS + demo + github.io)
  const prodOrigins = ["https://demo.reittari.fi", "https://veikkoville.github.io", "https://henkilosto.reittari.fi", "https://reittari-henkilosto.pages.dev"];
  for (const o of prodOrigins) {
    const r = await worker.fetch(post("/feedback", bodies["/feedback"], { origin: o, ip: "198.51.100.2" }), env, ctx);
    check(r.status === 200, `R-01b: tuotanto-origin ${o} → /feedback 200`);
  }

  // Muuttumaton push-tilaus = 0 kirjoitusta (sovellus synkronoi joka avauksella)
  const s1 = await worker.fetch(post("/push/subscribe", bodies["/push/subscribe"], { ip: "198.51.100.3" }), env, ctx);
  const w1 = writes(kv);
  const s2 = await worker.fetch(post("/push/subscribe", bodies["/push/subscribe"], { ip: "198.51.100.3" }), env, ctx);
  check(s1.status === 200 && s2.status === 200 && writes(kv) === w1, "R-01b: sama push-tilaus uudelleen → 200, 0 KV-kirjoitusta");
  const subKey = [...kv._m.keys()].find(k => k.startsWith("sub:"));
  const stored = JSON.parse(kv._m.get(subKey));
  check(Object.keys(stored.keys).sort().join(",") === "auth,p256dh" && stored.expirationTime === undefined,
    "R-01b: push-tilauksesta tallennetaan vain endpoint ja avaimet (ei ylimääräisiä kenttiä)");

  // Kokoraja: Content-Length ja chunked-runko
  const big = { ...bodies["/push/subscribe"], routes: ["x".repeat(9000)] };
  const w2 = writes(kv);
  const r413 = await worker.fetch(post("/push/subscribe", big, { ip: "198.51.100.4", headers: { "Content-Length": String(JSON.stringify(big).length) } }), env, ctx);
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(big))); c.close(); } });
  const r413b = await worker.fetch(req("/push/subscribe", { method: "POST", headers: { Origin: ORIGIN, "CF-Connecting-IP": "198.51.100.4" }, body: stream, duplex: "half" }), env, ctx);
  const fbBig = await worker.fetch(post("/feedback", { ...bodies["/feedback"], message: "a".repeat(20000) }, { ip: "198.51.100.4" }), env, ctx);
  check(r413.status === 413 && r413b.status === 413 && fbBig.status === 413 && writes(kv) === w2,
    "R-01b: ylisuuri runko (Content-Length, chunked, palaute 20 kt) → 413, ei kirjoitusta");

  // Kenttärajat
  const many = await worker.fetch(post("/push/subscribe", { ...bodies["/push/subscribe"], subscription: pushSub(2),
    routes: Array.from({ length: 500 }, (_, i) => String(i)) }, { ip: "198.51.100.5" }), env, ctx);
  const sub2 = JSON.parse(kv._m.get("sub:" + [...kv._m.keys()].filter(k => k.startsWith("sub:")).map(k => k.slice(4)).find(h => JSON.parse(kv._m.get("sub:" + h)).endpoint.endsWith("testi-2"))));
  check(many.status === 200 && sub2.routes.length === (W.PUSH_MAX_ROUTES ?? -1), "R-01b: 500 linjaa → tallennetaan enintään PUSH_MAX_ROUTES (100)");
  const http = await worker.fetch(post("/push/subscribe", { ...bodies["/push/subscribe"], subscription: { ...pushSub(3), endpoint: "http://push.example/x" } }, { ip: "198.51.100.5" }), env, ctx);
  const badKey = await worker.fetch(post("/push/subscribe", { ...bodies["/push/subscribe"], subscription: { ...pushSub(3), keys: { p256dh: "<script>", auth: AUTH } } }, { ip: "198.51.100.5" }), env, ctx);
  const longEp = await worker.fetch(post("/push/subscribe", { ...bodies["/push/subscribe"], subscription: { ...pushSub(3), endpoint: "https://push.example/" + "a".repeat(2000) } }, { ip: "198.51.100.5" }), env, ctx);
  check(http.status === 400 && badKey.status === 400 && longEp.status === 400, "R-01b: http-endpoint, väärän muotoinen avain ja yli 1024 merkin endpoint → 400");

  // R-08: kaupunki tunnettu, feed johdetaan kaupungista
  const w3 = writes(kv);
  const unknown = await worker.fetch(post("/push/subscribe", { ...bodies["/push/subscribe"], subscription: pushSub(4), city: "Atlantis" }, { ip: "198.51.100.6" }), env, ctx);
  check(unknown.status === 400 && writes(kv) === w3, "R-08: tuntematon kaupunki push-tilauksessa → 400, ei kirjoitusta");
  await worker.fetch(post("/push/subscribe", { ...bodies["/push/subscribe"], subscription: pushSub(5), city: "Hämeenlinna", feed: "OULU" }, { ip: "198.51.100.6" }), env, ctx);
  const sub5 = [...kv._m.values()].map(v => { try { return JSON.parse(v); } catch (e) { return {}; } }).find(o => o.endpoint && o.endpoint.endsWith("testi-5"));
  check(sub5 && sub5.feed === "Hameenlinna" && sub5.city === "hameenlinna", "R-08: Hämeenlinnan tilaus vieraalla feedillä (OULU) → feed Hameenlinna kaupungista");

  // Peruutus tuntemattomalle endpointille ei maksa poisto-operaatiota
  const d0 = kv.deletes;
  const un = await worker.fetch(post("/push/unsubscribe", { endpoint: "https://push.example/ei-ole" }, { ip: "198.51.100.7" }), env, ctx);
  check(un.status === 200 && kv.deletes === d0, "R-01b: tuntemattoman tilauksen peruutus → 200, 0 poisto-operaatiota");
  const unReal = await worker.fetch(post("/push/unsubscribe", { endpoint: pushSub(1).endpoint }, { ip: "198.51.100.7" }), env, ctx);
  check(unReal.status === 200 && kv.deletes === d0 + 1, "R-01b: olemassa olevan tilauksen peruutus poistaa sen");

  // Lähtömuistutus: aikaikkuna, tuplaklikkaus, katto per endpoint
  const rem = b => worker.fetch(post("/push/reminder", b, { ip: "198.51.100.8" }), env, ctx);
  const far = await rem({ ...bodies["/push/reminder"], fireAt: nowS + 3 * 24 * 3600 });
  check(far.status === 400, "R-01b: muistutus 3 vrk päähän → 400 (ikkuna 36 h)");
  const ok1 = await rem({ ...bodies["/push/reminder"], tag: "rem-3-a" });
  const w4 = writes(kv);
  const dup = await rem({ ...bodies["/push/reminder"], tag: "rem-3-a" });
  const dupBody = await dup.json();
  check(ok1.status === 200 && dup.status === 200 && dupBody.duplicate === true && writes(kv) === w4, "R-01b: sama muistutus kahdesti → yksi muistutus, 0 lisäkirjoitusta");
  for (let i = 0; i < 4; i++) await rem({ ...bodies["/push/reminder"], tag: "rem-x-" + i });
  const sixth = await rem({ ...bodies["/push/reminder"], tag: "rem-x-99" });
  const pend = JSON.parse(kv._m.get("rem:pending") || "{}");
  check(sixth.status === 429 && Object.keys(pend).length === (W.REMINDER_MAX_PER_ENDPOINT ?? -1), "R-01b: kuudes odottava muistutus samalle laitteelle → 429");
  check(Object.values(pend).every(r => r.url === "./" && !("expirationTime" in r)), "R-01b: muistutuksen url on aina suhteellinen (oletus ./)");

  // Nopeusraja per IP (isolaatti)
  let last = null;
  for (let i = 0; i < 11; i++) last = await worker.fetch(post("/feedback", bodies["/feedback"], { ip: "198.51.100.9" }), env, ctx);
  check(last.status === 429 && last.headers.get("Retry-After"), "R-01b: 11. palaute samalta IP:ltä 10 min sisällä → 429 + Retry-After");
  const other = await worker.fetch(post("/feedback", bodies["/feedback"], { ip: "198.51.100.10" }), env, ctx);
  check(other.status === 200, "R-01b: toisen IP:n palaute menee läpi");
  // Rate Limiting -sidonta (valmisteltu, oletuksena pois): kieltävä sidonta → 429
  const blocked = await worker.fetch(post("/feedback", bodies["/feedback"], { ip: "198.51.100.11" }),
    { ...env, RL_WRITE: { limit: async () => ({ success: false }) } }, ctx);
  const broken = await worker.fetch(post("/feedback", bodies["/feedback"], { ip: "198.51.100.12" }),
    { ...env, RL_WRITE: { limit: async () => { throw new Error("x"); } } }, ctx);
  check(blocked.status === 429 && broken.status === 200, "R-01b: RL_WRITE-sidonta: kielto → 429, sidonnan vika → läpi");
}

/* ===== Sovelluksen oikeat pyynnöt kaikista kaupungeista (index.html CONFIGS) ===== */
const html = existsSync(path.join(ROOT, "index.html")) ? readFileSync(path.join(ROOT, "index.html"), "utf8") : "";
const cfgStart = html.indexOf("const CONFIGS = {");
const cfgEnd = html.indexOf("\n};", cfgStart);
const cfgSrc = cfgStart >= 0 ? html.slice(cfgStart, cfgEnd) : "";
const cityBlocks = [];
{
  const re = /^ {2}([a-z0-9]+): \{$/gm;
  const heads = [...cfgSrc.matchAll(re)];
  heads.forEach((m, i) => {
    const block = cfgSrc.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : cfgSrc.length);
    const name = (block.match(/^ {4}city: "([^"]+)"/m) || [])[1];
    const fm = block.match(/^ {4}feedMatch: \/(.+?)\/([gimsuy]*),/m);
    cityBlocks.push({ key: m[1], name, feedMatch: fm ? new RegExp(fm[1], fm[2]) : null });
  });
}
{
  reset();
  const kv = countingKV();
  const env = { PUSH_KV: kv, RESEND_API_KEY: "t", EMAIL_FROM: "a@b.fi", EMAIL_LINK_BASE: "https://worker.test" };
  check(cityBlocks.length >= 18, `ristiintarkistus: index.html CONFIGS luettu (${cityBlocks.length} kaupunkia)`);
  const CF = W.CITY_FEEDS || {};
  const keysApp = cityBlocks.map(c => c.key).sort().join(","), keysWorker = Object.keys(CF).sort().join(",");
  check(keysApp === keysWorker, "ristiintarkistus: workerin CITY_FEEDS kattaa täsmälleen index.html:n kaupungit");
  for (const c of cityBlocks) {
    const feed = CF[c.key];
    check(!!feed && !!c.feedMatch && c.feedMatch.test(feed), `ristiintarkistus: ${c.key}: workerin feed ${feed} vastaa sovelluksen feedMatchia ${c.feedMatch}`);
    check(typeof W.resolveCity === "function" && W.resolveCity(c.name) === c.key && W.resolveCity(c.key) === c.key,
      `ristiintarkistus: ${c.key}: näyttönimi "${c.name}" ja avain tunnistetaan`);
    const mv = path.join(ROOT, "docs", "muutosvahti", c.key + ".json");
    if (existsSync(mv)) {
      // Yleisin pysäkkitunnuksen etuliite (Inkoossa mukana myös lauttojen CAR_FERRIES-pysäkkejä)
      const counts = {};
      for (const m of readFileSync(mv, "utf8").matchAll(/"id":"([A-Za-z0-9_]+):/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
      const pref = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      check(pref === feed, `ristiintarkistus: ${c.key}: feed ${feed} = muutosvahdin pysäkkien yleisin etuliite ${pref}`);
    }
    // Sovelluksen push- ja sähköpostitilaus juuri sellaisena kuin syncPushSubscription/bindEmailSubSetting sen lähettää
    const ip = "203.0.113." + (cityBlocks.indexOf(c) + 20);
    const ps = await worker.fetch(post("/push/subscribe", { subscription: pushSub("c-" + c.key), routes: ["1", "2"],
      gtfsRoutes: [feed + ":1"], feed, city: c.name, lang: "fi" }, { ip }), env, ctx);
    const em = await worker.fetch(post("/email/subscribe", { email: c.key + "@example.fi", lines: ["1"], gtfsRoutes: [feed + ":1"],
      feed, city: c.name, lang: "sv" }, { ip, origin: "https://henkilosto.reittari.fi" }), env, ctx);
    const rec = kv._m.get([...kv._m.keys()].find(k => k.startsWith("email:" + c.key + ":")) || "");
    check(ps.status === 200 && em.status === 200 && rec && JSON.parse(rec).feed === feed,
      `sovellus: ${c.key}: push- ja sähköpostitilaus sovelluksen muodossa → 200, feed ${feed}`);
  }
  // Näkymät: route():n näkymänimet ovat TRACK_VIEWS-listassa
  const routeSrc = html.slice(html.indexOf("async function route()"), html.indexOf("window.addEventListener(\"hashchange\", route)"));
  const views = [...new Set([...routeSrc.matchAll(/parts\[0\] === "([a-z0-9_-]+)"/g)].map(m => m[1]))];
  const TV = W.TRACK_VIEWS || new Set();
  const missing = views.filter(v => !TV.has(v));
  check(views.length >= 20 && missing.length === 0 && TV.has("home"), `ristiintarkistus: sovelluksen ${views.length} näkymää ovat TRACK_VIEWS-listassa (puuttuu: ${missing.join(",") || "-"})`);
  // STAFF_HOSTS-osoitteet ovat sallittuja originjeja
  const staff = JSON.parse((html.match(/const STAFF_HOSTS = (\[[^\]]*\]);/) || [, "[]"])[1]);
  for (const h of staff) {
    const r = await worker.fetch(post("/feedback", { message: "testi", city: "lahti" }, { origin: "https://" + h, ip: "203.0.113.90" }), env, ctx);
    check(r.status === 200, `ristiintarkistus: henkilöstönäkymän origin https://${h} sallittu`);
  }
}

/* ===== R-02: vahvistusviestit osoitteen tiivisteellä kaupungista riippumatta ===== */
{
  reset();
  const kv = countingKV();
  const env = { PUSH_KV: kv, DIGITRANSIT_KEY: "test", RESEND_API_KEY: "t", EMAIL_FROM: "a@b.fi", EMAIL_LINK_BASE: "https://worker.test" };
  const sub = (email, city, ip, extra = {}) => worker.fetch(post("/email/subscribe",
    { email, lines: ["3"], gtfsRoutes: ["X:3"], city, lang: "fi", ...extra }, { ip: ip || "192.0.2.1" }), env, ctx);
  const mails = to => resendSends.filter(m => m.to[0] === to).length;
  const T = "uhri@example.fi";
  clockOffset = 0;
  await sub(T, "lahti");
  await sub(T, "kuopio");
  await sub(T, "Vaasa");
  check(mails(T) === 1, `R-02: sama osoite kolmella kaupungilla heti → 1 vahvistusviesti (oli ${mails(T)})`);
  const x1 = await sub(T, "x1"), x2 = await sub(T, "abc123");
  check(x1.status === 400 && x2.status === 400 && mails(T) === 1, "R-02: tuntematon kaupunki (x1, abc123) → 400, ei viestiä");
  clockOffset = 11 * MIN; await sub(T, "kuopio");
  clockOffset = 22 * MIN; await sub(T, "salo");
  check(mails(T) === 3, "R-02: 10 min välein eri kaupungeilla → viesti per 10 min");
  clockOffset = 33 * MIN; await sub(T, "kotka");
  clockOffset = 5 * H; await sub(T, "pori");
  check(mails(T) === (W.EMAIL_CONFIRM_PER_ADDR_DAY ?? 3), "R-02: neljäs viesti samaan osoitteeseen 24 h sisällä estetään (3/vrk)");
  clockOffset = 25 * H + 30 * MIN; await sub(T, "pori");
  check(mails(T) === 4, "R-02: 24 h jälkeen osoite saa taas viestin");
  clockOffset = 0;

  // Vahvistamaton tilaus ja sen linkki vanhenevat
  const recKey = [...kv._m.keys()].find(k => k.startsWith("email:lahti:"));
  const tokKey = [...kv._m.keys()].find(k => k.startsWith("email:tok:") && kv._m.get(k).startsWith("lahti:"));
  check(kv._ttl.get(recKey) === (W.EMAIL_PENDING_TTL_S ?? -1) && kv._ttl.get(tokKey) === (W.EMAIL_PENDING_TTL_S ?? -1),
    "R-02: vahvistamaton tilaus ja vahvistuslinkki tallennetaan 7 vrk:n vanhenemisella");

  // Vahvistus poistaa vanhenemisen; toistuva vahvistus ei kirjoita
  const token = tokKey.slice("email:tok:".length);
  const c1 = await worker.fetch(req("/email/confirm?token=" + token), env, ctx);
  check(c1.status === 200 && !kv._ttl.has(recKey) && !kv._ttl.has(tokKey) && JSON.parse(kv._m.get(recKey)).confirmed,
    "R-02: vahvistettu tilaus ja peruutuslinkki eivät vanhene");
  const w0 = writes(kv);
  const c2 = await worker.fetch(req("/email/confirm?token=" + token), env, ctx);
  const c3 = await worker.fetch(req("/email/confirm?token=" + token), env, ctx);
  check(c2.status === 200 && c3.status === 200 && writes(kv) === w0, "R-01: vahvistuslinkin toisto (skanneri, tuplaklikkaus) → 0 KV-kirjoitusta");

  // R-08: vahvistettu tilaaja ei voi vaihtaa kaupungin feediä; muuttumaton päivitys = 0 kirjoitusta
  check(JSON.parse(kv._m.get("email:reg")).lahti === "Lahti", "R-08: rekisterissä lahti → Lahti");
  await sub(T, "lahti", "192.0.2.2", { feed: "OULU" });
  check(JSON.parse(kv._m.get("email:reg")).lahti === "Lahti" && JSON.parse(kv._m.get(recKey)).feed === "Lahti",
    "R-08: vahvistettu tilaaja lähettää feed=OULU → kaupungin rekisteri ja tietue pysyvät Lahti");
  const w1 = writes(kv);
  const upd = await sub(T, "lahti", "192.0.2.2", { feed: "Lahti" });
  check(upd.status === 200 && writes(kv) === w1, "R-01: vahvistetun tilauksen muuttumaton päivitys → 0 KV-kirjoitusta");

  // Cron: vanha, myrkytetty rekisteri (lahti → OULU) ei ohjaa Lahden tilaajille Oulun häiriöitä
  await kv.put("email:reg", JSON.stringify({ lahti: "OULU", "atlantis": "EVILFEED", hmeenlinna: "Hameenlinna" }));
  alertFeedsAsked.length = 0;
  currentAlerts = [{ alertHeaderText: "Linja 3 poikkeaa", alertDescriptionText: "", effectiveStartDate: 0, effectiveEndDate: 0 }];
  await W.runPushCheck(env);
  const asked = [...new Set(alertFeedsAsked)].sort().join(",");
  check(asked === "Hameenlinna,Lahti", `R-08: cron hakee feedit kaupungista eikä rekisterin arvosta (haettu: ${asked})`);
  currentAlerts = [];

  // Ennen korjausta tallennettu vahvistamaton tietue vieraalla feedillä: vahvistus ei vie vierasta feediä rekisteriin
  await kv.put("email:salo:vanhatiiviste", JSON.stringify({ email: "vanha@example.fi", city: "salo", feed: "OULU", lines: ["1"],
    gtfsRoutes: [], lang: "fi", confirmed: false, ts: 1, token: "vanha-tunniste" }));
  await kv.put("email:tok:vanha-tunniste", "salo:vanhatiiviste");
  await worker.fetch(req("/email/confirm?token=vanha-tunniste"), env, ctx);
  check(JSON.parse(kv._m.get("email:reg")).salo === "Salo", "R-08: vanha tietue (feed OULU) vahvistuu rekisteriin kaupungin feedillä Salo");

  // Päiväkatto kaikille osoitteille yhteensä
  reset();
  const cap = W.EMAIL_CONFIRM_DAILY_MAX ?? 50;
  const sentBefore = resendSends.length;
  // eri osoitteet ja IP:t, ettei osoite- tai IP-raja ratkaise; päiväkatto lasketaan tämän päivän lokista
  const dayLog = JSON.parse(kv._m.get("email:sent:" + new Date(realNow()).toISOString().slice(0, 10)) || '{"n":0}');
  let lastStatus = 0;
  for (let i = 0; i < cap - dayLog.n + 1; i++) {
    if (i % 9 === 0) reset();   // isolaatin kaikkien IP:iden raja (all) ei saa ratkaista tätä testiä
    lastStatus = (await sub("massa" + i + "@example.fi", "lahti", "192.0.2." + (100 + (i % 100)))).status;
  }
  check(lastStatus === 429 && resendSends.length - sentBefore === cap - dayLog.n,
    `R-02: päiväkatto ${cap} vahvistusviestiä / vrk kaikille osoitteille → seuraava 429`);
}

/* ===== R-06: Digitransit-proxyn koko- ja käyttöraja ===== */
{
  reset();
  const env = { DIGITRANSIT_KEY: "test-key" };
  const gql = (body, o = {}) => worker.fetch(req("/" + (o.q || ""), { method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": o.ip || "203.0.113.50" }, body }), o.env || env, ctx);
  upstreamCalls.length = 0;
  const okBody = '{"query":"{ feeds { feedId } }","variables":null}';
  const ok = await gql(okBody);
  check(ok.status === 200 && upstreamCalls.length === 1 && upstreamCalls[0].body === okBody, "R-06: tavallinen kysely välitetään sellaisenaan");
  const huge = await gql(JSON.stringify({ query: "{ feeds { feedId } }", pad: "x".repeat(70000) }));
  const batch = await gql("[" + okBody + "," + okBody + "]");
  check(huge.status === 413 && batch.status === 400 && upstreamCalls.length === 1, "R-06: yli 64 kt runko → 413, eräkysely → 400, ei välitetä");
  const rl = await gql(okBody, { env: { ...env, RL_PROXY: { limit: async () => ({ success: false }) } } });
  check(rl.status === 429 && upstreamCalls.length === 1, "R-06: RL_PROXY-sidonnan kielto → 429");
  const geoLong = await worker.fetch(req("/geocoding/search?text=" + "a".repeat(3000), { headers: { Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.51" } }), env, ctx);
  const geoOk = await worker.fetch(req("/geocoding/search?text=kauppatori&size=10", { headers: { Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.51" } }), env, ctx);
  check(geoLong.status === 414 && geoOk.status === 200, "R-06: yli 2 kt geokoodauskysely → 414, tavallinen läpi");
  // Isolaatin katto kaikille IP:ille yhteensä (väärennetty Origin monesta osoitteesta)
  reset();
  const g = ip => W.quotaGate({ headers: { get: k => (k === "CF-Connecting-IP" ? ip : null) } }, ORIGIN);
  const max = W.PROXY_ISOLATE_MAX ?? 6000;
  let lastGate = null;
  for (let i = 0; i <= max; i++) lastGate = g("10." + (i >> 16 & 255) + "." + (i >> 8 & 255) + "." + (i & 255));
  check(lastGate && lastGate.status === 429, `R-06: ${max + 1}. pyyntö minuutissa eri IP:istä samassa isolaatissa → 429`);
  reset();
}

/* ===== R-07: /track ilman kaksoislaskentaa ja tulvaa ===== */
{
  reset();
  const ae = { p: [], writeDataPoint(x) { this.p.push(x); } };
  const env = { AE: ae };
  const tr = (b, ip) => worker.fetch(post("/track", b, { ip: ip || "203.0.113.70", origin: "https://demo.reittari.fi" }), env, ctx);
  await tr({ type: "view", value: "home", city: "lahti" });
  await tr({ type: "view", value: "home", city: "lahti" });
  check(ae.p.length === 1, "R-07: sama näkymä samalta asiakkaalta 30 s sisällä → 1 tapahtuma");
  await tr({ type: "view", value: "home", city: "lahti" }, "203.0.113.71");
  check(ae.p.length === 2, "R-07: toinen asiakas lasketaan erikseen");
  clockOffset = 31 * 1000;
  await tr({ type: "view", value: "home", city: "lahti" });
  clockOffset = 0;
  check(ae.p.length === 3, "R-07: sama näkymä 30 s jälkeen lasketaan uudelleen");
  const n0 = ae.p.length;
  for (let i = 0; i < 200; i++) await tr({ type: "line", value: String(i), city: "lahti" }, "203.0.113.72");
  check(ae.p.length - n0 <= (W.TRACK_IP_MAX ?? 120) && ae.p.length - n0 > 0, `R-07: 200 tapahtumaa yhdeltä asiakkaalta → enintään ${W.TRACK_IP_MAX ?? 120} kirjataan (${ae.p.length - n0})`);
  const n1 = ae.p.length;
  await tr({ type: "view", value: "home", city: "atlantis" }, "203.0.113.73");
  await tr({ type: "line", value: "<img src=x>", city: "lahti" }, "203.0.113.73");
  await tr({ type: "search_fail", value: "matti.meikalainen@example.fi", city: "lahti" }, "203.0.113.73");
  await tr({ type: "search_fail", value: "040 123 4567", city: "lahti" }, "203.0.113.73");
  await tr({ type: "view", value: "home", city: "lahti", pad: "x".repeat(3000) }, "203.0.113.73");
  check(ae.p.length === n1, "R-07: tuntematon kaupunki, vieras linjatunnus, sähköposti, puhelinnumero ja ylisuuri runko → ei kirjata");
  await tr({ type: "view", value: "<script>", city: "lahti" }, "203.0.113.74");
  await tr({ type: "search_fail", value: "Kauppatori", city: "Lahti" }, "203.0.113.74");
  check(ae.p.length === n1 + 2 && ae.p[n1].blobs[1] === "muu" && ae.p[n1 + 1].blobs[1] === "Kauppatori" && ae.p[n1 + 1].blobs[2] === "lahti",
    "R-07: tuntematon näkymä → \"muu\", tavallinen hakusana säilyy");
  check(!JSON.stringify(ae.p).includes("203.0.113"), "R-07: IP-osoitetta ei kirjata tapahtumaan");
}

/* ===== Palautelistan avain Authorization-otsakkeessa (query-avain toimii yhä) ===== */
{
  reset();
  const kv = countingKV();
  await kv.put("fb:1-a", JSON.stringify({ message: "Pysäkki rikki", ts: 1 }));
  const env = { PUSH_KV: kv, FEEDBACK_ADMIN_KEY: "salainen-avain-123" };
  const list = (qs, headers) => worker.fetch(new Request("https://worker.test/feedback/list" + qs, { headers }), env, ctx);
  const okH = await list("", { Authorization: "Bearer salainen-avain-123" });
  check(okH.status === 200 && (await okH.json()).items.length === 1, "palautelista: oikea avain Authorization-otsakkeessa → 200");
  check((await list("", { Authorization: "Bearer vaara" })).status === 403, "palautelista: väärä avain otsakkeessa → 403");
  check((await list("", {})).status === 403, "palautelista: ilman avainta → 403");
  check((await list("?key=salainen-avain-123", {})).status === 200, "palautelista: query-avain toimii yhä");
  check((await list("?key=salainen-avain-123", { Authorization: "Bearer vaara" })).status === 403, "palautelista: väärä otsake ei pelastu query-avaimella");
  const pre = await worker.fetch(new Request("https://worker.test/feedback/list", { method: "OPTIONS", headers: { Origin: "https://demo.reittari.fi" } }), env, ctx);
  check(/Authorization/.test(pre.headers.get("Access-Control-Allow-Headers") || ""), "palautelista: CORS sallii Authorization-otsakkeen");
}

Date.now = realNow;
console.log(fail === 0 ? `\nKAIKKI OK (${total} tarkistusta)` : `\n${fail}/${total} TARKISTUSTA EPÄONNISTUI`);
process.exit(fail ? 1 : 0);

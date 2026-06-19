// Cloudflare Worker: välittää GraphQL- ja geokoodauspyynnöt Digitransitiin ja
// lisää API-avaimen palvelinpäässä, jotta sivun käyttäjät eivät tarvitse omaa avainta.
// Lisäksi: taustapush-ilmoitukset suosikkilinjojen häiriöistä (KV + cron + VAPID).
// Avain asetetaan salaisuutena: npx wrangler secret put DIGITRANSIT_KEY

import { sendPush } from "./webpush.js";
import { ADMIN_HTML } from "./admin-page.js";

const ROUTING_UPSTREAM = "https://api.digitransit.fi/routing/v2/waltti/gtfs/v1";
const GEOCODING_UPSTREAM = "https://api.digitransit.fi/geocoding/v1";

const ALLOWED_ORIGINS = new Set([
  "https://veikkoville.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

// CMS-häiriötiedotteiden lähde (WordPress REST). Vain sallitut hostit, ettei
// workerista tule avointa välityspalvelinta. Lahti: lsl.fi häiriötiedote-kategoria.
const CMS_ALLOWED_HOSTS = new Set(["www.lsl.fi"]);

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://veikkoville.github.io",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function jsonResponse(obj, status, origin) {
  const headers = new Headers(corsHeaders(origin));
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(obj), { status, headers });
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// HTML-escape sähköpostien ja confirm/unsubscribe-sivujen dynaamiselle tekstille.
const escHtml = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ---------- CMS-häiriötiedotteet (lsl.fi WordPress REST) ---------- */

// Riisuu HTML-tagit ja purkaa yleisimmät entiteetit puhtaaksi tekstiksi,
// jotta selain voi näyttää otsikon/tiivistelmän sellaisenaan (esc()).
export function htmlToText(html) {
  if (!html) return "";
  let s = String(html).replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&[a-zA-Z]+;/g, " ")
    .replace(/­/g, ""); // pehmeät tavuviivat pois
  return s.replace(/\s+/g, " ").trim();
}

// Hakee lsl.fi:n (tms. Waltti-kaupungin) häiriötiedotteet WordPressin REST-
// rajapinnasta. Tarvitaan, koska Digitransitin GTFS-RT-alerts on vain osajoukko
// toimituksellisista tiedotteista — osa (esim. tapahtumapoikkeukset) jää pois.
async function handleCmsAlerts(url, origin) {
  const host = url.searchParams.get("host") || "";
  const cat = url.searchParams.get("cat") || "";
  if (!CMS_ALLOWED_HOSTS.has(host) || !/^\d+$/.test(cat))
    return jsonResponse({ error: "bad_request" }, 400, origin);
  const per = Math.min(20, Math.max(1, parseInt(url.searchParams.get("per") || "12", 10)));
  // content mukaan, jotta linjanumerot voidaan poimia rungosta (otsikossa niitä
  // ei aina ole, esim. "Kytölässä poikkeusreitti") → linjasivu osaa täsmätä.
  const api = `https://${host}/wp-json/wp/v2/posts?categories=${cat}&per_page=${per}` +
    `&_fields=id,date,modified,title,link,excerpt,content`;
  let posts;
  try {
    const res = await fetch(api, { headers: { Accept: "application/json" } });
    if (!res.ok) return jsonResponse({ error: "upstream", status: res.status }, 502, origin);
    posts = await res.json();
  } catch (e) {
    return jsonResponse({ error: "fetch_failed" }, 502, origin);
  }
  const items = (Array.isArray(posts) ? posts : []).map(p => {
    const title = htmlToText(p.title && p.title.rendered);
    const body = htmlToText(p.content && p.content.rendered);
    return {
      title,
      excerpt: htmlToText(p.excerpt && p.excerpt.rendered).slice(0, 300),
      link: p.link || "",
      date: p.date || "",
      modified: p.modified || "",
      lines: [...lineTokensFromText(title + " " + body)],   // poimitut linjanumerot rungosta
    };
  }).filter(p => p.title);
  const headers = new Headers(corsHeaders(origin));
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "public, max-age=300");   // 5 min reuna-/selaincache
  return new Response(JSON.stringify({ items }), { status: 200, headers });
}

/* ---------- Palaute / vikailmoitus (KV) ---------- */

// Kokoaa ja validoi palautemerkinnän. Erotettu omaksi funktioksi yksikkötestiä
// varten. Palauttaa { rec } tai { error }.
export function buildFeedbackRecord(body, ua, nowMs) {
  const msg = body && String(body.message || "").trim();
  if (!msg || msg.length < 3) return { error: "bad_request" };
  return {
    rec: {
      category: String((body && body.category) || "other").slice(0, 40),
      message: msg.slice(0, 2000),
      contact: String((body && body.contact) || "").slice(0, 120),
      url: String((body && body.url) || "").slice(0, 300),
      city: String((body && body.city) || "").slice(0, 40),
      ua: String(ua || "").slice(0, 200),
      ts: nowMs,
    },
  };
}

async function handleFeedback(request, env, origin) {
  if (!env.PUSH_KV) return jsonResponse({ error: "unconfigured" }, 503, origin);
  const body = await request.json().catch(() => null);
  const { rec, error } = buildFeedbackRecord(body, request.headers.get("User-Agent"), Date.now());
  if (error) return jsonResponse({ error }, 400, origin);
  const id = rec.ts + "-" + crypto.randomUUID().slice(0, 8);
  // säilytetään 90 vrk, jonka jälkeen KV siivoaa automaattisesti
  await env.PUSH_KV.put("fb:" + id, JSON.stringify(rec), { expirationTtl: 90 * 24 * 3600 });
  return jsonResponse({ ok: true, id }, 200, origin);
}

// Omistajan luettavissa salaisuudella (FEEDBACK_ADMIN_KEY). Ilman avainta 403.
async function handleFeedbackList(url, env, origin) {
  const key = url.searchParams.get("key") || "";
  if (!env.PUSH_KV) return jsonResponse({ error: "unconfigured" }, 503, origin);
  if (!env.FEEDBACK_ADMIN_KEY || key !== env.FEEDBACK_ADMIN_KEY)
    return jsonResponse({ error: "forbidden" }, 403, origin);
  const out = [];
  let cursor;
  do {
    const list = await env.PUSH_KV.list({ prefix: "fb:", cursor });
    for (const k of list.keys) {
      const v = await env.PUSH_KV.get(k.name);
      if (v) { try { out.push(JSON.parse(v)); } catch (e) { /* ohita */ } }
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return jsonResponse({ items: out }, 200, origin);
}

/* ---------- Ylläpito: kirjautuminen + häiriötiedotteiden hallinta (KV) ----------
   Kaupungin henkilöstö julkaisee häiriötiedotteita selaimessa ilman WordPressiä.
   Tarjoillaan workerista (sama origin → istuntoeväste ilman CORS-säätöä).
   Tuotantoon suositus: Cloudflare Access /admin* eteen (env.ADMIN_ACCESS_AUD-koukku
   jätetty isAdminiin); nyt kevyt jaettu salasana + HMAC-allekirjoitettu eväste. */

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get("Cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Vakiomittainen vertailu, ettei vasteaika paljasta salasanaa.
export function constantTimeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const SESSION_TTL = 12 * 3600; // 12 h

// HMAC-allekirjoitettu istunto: base64url(payload).base64url(hmac). Itsenäinen
// (ei KV-istuntovarastoa) → ei list-/get-kuormaa.
export async function signSession(payloadObj, secret) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(payloadObj)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(payload));
  return payload + "." + b64url(sig);
}

export async function verifySession(token, secret, nowMs) {
  if (!token || token.indexOf(".") < 0) return null;
  const [payload, sig] = token.split(".");
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(secret),
      b64urlToBytes(sig), new TextEncoder().encode(payload));
  } catch (e) { return null; }
  if (!ok) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
    if (obj.exp && obj.exp < (nowMs ?? Date.now()) / 1000) return null;
    return obj;
  } catch (e) { return null; }
}

async function isAdmin(request, env) {
  // TODO tuotanto: jos env.ADMIN_ACCESS_AUD asetettu, varmenna Cloudflare Access
  // -JWT (Cf-Access-Jwt-Assertion) salasanaistunnon sijaan.
  if (!env.ADMIN_SESSION_SECRET) return false;
  return !!(await verifySession(parseCookies(request)["admin_session"], env.ADMIN_SESSION_SECRET));
}

function adminJson(obj, status, extraHeaders) {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Response(JSON.stringify(obj), { status, headers });
}

async function handleAdminLogin(request, env) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET)
    return adminJson({ error: "unconfigured" }, 503);
  const body = await request.json().catch(() => null);
  if (!body || !constantTimeEqual(body.password || "", env.ADMIN_PASSWORD))
    return adminJson({ error: "invalid" }, 401);
  const token = await signSession({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL }, env.ADMIN_SESSION_SECRET);
  return adminJson({ ok: true }, 200,
    { "Set-Cookie": `admin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL}` });
}

function handleAdminLogout() {
  return adminJson({ ok: true }, 200,
    { "Set-Cookie": "admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" });
}

const ADMIN_ALERTS_KEY = city => "admin:alerts:" + String(city || "lahti").toLowerCase().slice(0, 30);

// Kokoaa+validoi yhden ylläpitotiedotteen (puhdas, yksikkötestattava). Ei id:tä —
// kutsuja asettaa id:n (uusi tai muokattava), kuten buildFeedbackRecord.
export function buildAdminAlert(body, nowSec) {
  const title = body && String(body.title || "").trim();
  if (!title) return { error: "bad_request" };
  const sev = ["INFO", "WARNING", "SEVERE"].includes(body && body.severity) ? body.severity : "WARNING";
  const num = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; };
  return {
    rec: {
      title: title.slice(0, 200),
      body: String((body && body.body) || "").slice(0, 2000),
      url: String((body && body.url) || "").slice(0, 300),
      severity: sev,
      lines: Array.isArray(body && body.lines)
        ? body.lines.map(x => String(x).toUpperCase().replace(/\s+/g, "").slice(0, 8)).filter(Boolean).slice(0, 40)
        : [],
      startsAt: num(body && body.startsAt),
      endsAt: num(body && body.endsAt),
      updatedAt: nowSec,
    },
  };
}

// Suodattaa voimassa olevat (alku- ja loppuaika huomioiden). Julkista clientille.
export function currentAdminAlerts(list, nowSec) {
  return (Array.isArray(list) ? list : []).filter(a =>
    !(a.startsAt && a.startsAt > nowSec) && !(a.endsAt && a.endsAt < nowSec));
}

async function readAdminAlerts(env, city) {
  if (!env.PUSH_KV) return [];
  const raw = await env.PUSH_KV.get(ADMIN_ALERTS_KEY(city));
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

async function handleAdminAlertsGet(request, env, url) {
  if (!(await isAdmin(request, env))) return adminJson({ error: "forbidden" }, 403);
  return adminJson({ items: await readAdminAlerts(env, url.searchParams.get("city")) }, 200);
}

async function handleAdminAlertsSave(request, env) {
  if (!(await isAdmin(request, env))) return adminJson({ error: "forbidden" }, 403);
  if (!env.PUSH_KV) return adminJson({ error: "unconfigured" }, 503);
  const body = await request.json().catch(() => null);
  const city = (body && body.city) || "lahti";
  const { rec, error } = buildAdminAlert(body, Math.floor(Date.now() / 1000));
  if (error) return adminJson({ error }, 400);
  const list = await readAdminAlerts(env, city);
  const id = body.id && String(body.id).slice(0, 40);
  if (id) {
    const i = list.findIndex(a => a.id === id);
    if (i >= 0) list[i] = { ...rec, id }; else list.push({ ...rec, id });
  } else {
    list.push({ ...rec, id: Date.now() + "-" + crypto.randomUUID().slice(0, 8) });
  }
  // siivoa yli 7 vrk sitten päättyneet
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  const cleaned = list.filter(a => !(a.endsAt && a.endsAt < cutoff));
  await env.PUSH_KV.put(ADMIN_ALERTS_KEY(city), JSON.stringify(cleaned));
  return adminJson({ ok: true, items: cleaned }, 200);
}

async function handleAdminAlertsDelete(request, env) {
  if (!(await isAdmin(request, env))) return adminJson({ error: "forbidden" }, 403);
  if (!env.PUSH_KV) return adminJson({ error: "unconfigured" }, 503);
  const body = await request.json().catch(() => null);
  const city = (body && body.city) || "lahti";
  const id = body && String(body.id || "");
  const list = (await readAdminAlerts(env, city)).filter(a => a.id !== id);
  await env.PUSH_KV.put(ADMIN_ALERTS_KEY(city), JSON.stringify(list));
  return adminJson({ ok: true, items: list }, 200);
}

/* ---------- Ylläpito: lippu- ja hintatiedot ---------- */

const ADMIN_FARES_KEY = city => "admin:fares:" + String(city || "lahti").toLowerCase().slice(0, 30);

// Kokoaa+validoi hintarakenteen samaan muotoon kuin client-CONFIG.fares, jotta
// julkinen viewFares voi renderöidä sen suoraan. Tuottaa AINA täyden rakenteen
// (puuttuvat kentät tyhjiksi), ettei sovellus kaadu vajaaseen dataan.
export function buildAdminFares(body) {
  if (!body || typeof body !== "object") return { error: "bad_request" };
  const s = (v, max = 12) => String(v == null ? "" : v).trim().slice(0, max);
  const grp = o => ({ adult: s(o && o.adult), child: s(o && o.child), reduced: s(o && o.reduced) });
  const sng = body.single || {};
  return {
    rec: {
      checked: s(body.checked, 40),
      url: s(body.url, 300),
      single: { cardApp: grp(sng.cardApp), contactless: s(sng.contactless), salespoint: grp(sng.salespoint) },
      season: Array.isArray(body.season)
        ? body.season.slice(0, 12).map(r => ({ d: s(r && r.d, 4), adult: s(r && r.adult), child: s(r && r.child), reduced: s(r && r.reduced) })).filter(r => r.d)
        : [],
      day: Array.isArray(body.day)
        ? body.day.slice(0, 12).map(r => ({ d: s(r && r.d, 4), adult: s(r && r.adult), child: s(r && r.child) })).filter(r => r.d)
        : [],
      capDay: s(body.capDay), capWeek: s(body.capWeek), cardFee: s(body.cardFee),
    },
  };
}

async function readAdminFares(env, city) {
  if (!env.PUSH_KV) return null;
  const raw = await env.PUSH_KV.get(ADMIN_FARES_KEY(city));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function handleAdminFaresGet(request, env, url) {
  if (!(await isAdmin(request, env))) return adminJson({ error: "forbidden" }, 403);
  return adminJson({ fares: await readAdminFares(env, url.searchParams.get("city")) }, 200);
}

async function handleAdminFaresSave(request, env) {
  if (!(await isAdmin(request, env))) return adminJson({ error: "forbidden" }, 403);
  if (!env.PUSH_KV) return adminJson({ error: "unconfigured" }, 503);
  const body = await request.json().catch(() => null);
  const city = (body && body.city) || "lahti";
  const { rec, error } = buildAdminFares(body);
  if (error) return adminJson({ error }, 400);
  await env.PUSH_KV.put(ADMIN_FARES_KEY(city), JSON.stringify(rec));
  return adminJson({ ok: true, fares: rec }, 200);
}

/* ---------- Ylläpito: saavutettavuusseloste (digipalvelulaki 306/2019) ----------
   Kun kaupunki ottaa palvelun viralliseen käyttöön, seloste on muutettava lain
   edellyttämään muotoon (julkaiseva organisaatio, vaatimustenmukaisuus, puutteet,
   palautekanava, valvontaviranomainen). Tämä editori tuottaa sen; julkaistu
   seloste korvaa sovelluksen oletustekstin. */

const ADMIN_A11Y_KEY = city => "admin:a11y:" + String(city || "lahti").toLowerCase().slice(0, 30);

export function buildAdminA11y(body) {
  if (!body || typeof body !== "object") return { error: "bad_request" };
  const s = (v, m = 200) => String(v == null ? "" : v).trim().slice(0, m);
  const status = ["full", "partial", "none"].includes(body && body.status) ? body.status : "partial";
  return {
    rec: {
      orgName: s(body.orgName, 120),
      date: s(body.date, 40),
      status,
      feedbackEmail: s(body.feedbackEmail, 160),
      feedbackUrl: s(body.feedbackUrl, 300),
      deficiencies: Array.isArray(body.deficiencies)
        ? body.deficiencies.map(x => s(x, 400)).filter(Boolean).slice(0, 30) : [],
      method: s(body.method, 600),
    },
  };
}

async function readAdminA11y(env, city) {
  if (!env.PUSH_KV) return null;
  const raw = await env.PUSH_KV.get(ADMIN_A11Y_KEY(city));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function handleAdminA11yGet(request, env, url) {
  if (!(await isAdmin(request, env))) return adminJson({ error: "forbidden" }, 403);
  return adminJson({ a11y: await readAdminA11y(env, url.searchParams.get("city")) }, 200);
}

async function handleAdminA11ySave(request, env) {
  if (!(await isAdmin(request, env))) return adminJson({ error: "forbidden" }, 403);
  if (!env.PUSH_KV) return adminJson({ error: "unconfigured" }, 503);
  const body = await request.json().catch(() => null);
  const city = (body && body.city) || "lahti";
  const { rec, error } = buildAdminA11y(body);
  if (error) return adminJson({ error }, 400);
  await env.PUSH_KV.put(ADMIN_A11Y_KEY(city), JSON.stringify(rec));
  return adminJson({ ok: true, a11y: rec }, 200);
}

// Julkinen (CORS): voimassa olevat tiedotteet + julkaistut hinnat + saavutettavuusseloste.
async function handlePublished(url, env, origin) {
  const city = url.searchParams.get("city");
  const list = await readAdminAlerts(env, city);
  const items = currentAdminAlerts(list, Math.floor(Date.now() / 1000));
  const fares = await readAdminFares(env, city);
  const a11y = await readAdminA11y(env, city);
  const headers = new Headers(corsHeaders(origin));
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "public, max-age=60");
  return new Response(JSON.stringify({ alerts: items, fares, a11y }), { status: 200, headers });
}

/* ---------- Käyttöanalytiikka (#2): Cloudflare Analytics Engine ----------
   Anonyymi, kevyt tapahtumaseuranta: ei käyttäjätunnuksia, ei evästeitä, ei
   IP-tallennusta → ei vaadi evästesuostumusta. Kirjoitus Analytics Engineen
   (ei kuormita KV:tä). Dashboard lukee aggregaatit CF:n SQL-rajapinnasta
   (vaatii CF_ACCOUNT_ID + CF_API_TOKEN; ilman niitä dashboard ilmoittaa
   "ei konfiguroitu" eikä kaada mitään). */

const TRACK_TYPES = new Set(["view", "line", "stop", "search_fail"]);

// Validoi+siistii yhden tapahtuman (puhdas, testattava). Arvo katkaistaan, eikä
// mitään henkilötietoa talleteta. Tuntematon tyyppi → null (ei kirjoiteta).
export function buildTrackEvent(body) {
  const type = body && String(body.type || "");
  if (!TRACK_TYPES.has(type)) return null;
  const value = String((body && body.value) || "").trim().slice(0, 80);
  const city = String((body && body.city) || "lahti").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30) || "lahti";
  return { type, value, city };
}

function handleTrack(request, env, origin) {
  // fire-and-forget: ei koskaan virhettä clientille
  return request.json().then(body => {
    const ev = buildTrackEvent(body);
    if (ev && env.AE) {
      try {
        env.AE.writeDataPoint({ indexes: [ev.type], blobs: [ev.type, ev.value, ev.city], doubles: [1] });
      } catch (e) { /* ohita */ }
    }
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }).catch(() => new Response(null, { status: 204, headers: corsHeaders(origin) }));
}

// SQL aggregaattikysely 30 vrk ajalta, ryhmiteltynä tyyppi+arvo. AE altistaa
// blobit nimillä blob1.. (blob1=tyyppi, blob2=arvo, blob3=kaupunki).
export function buildStatsSql(city, dataset, days) {
  const c = String(city || "lahti").toLowerCase().replace(/[^a-z0-9]/g, "") || "lahti";
  const d = Math.min(90, Math.max(1, parseInt(days, 10) || 30));
  return `SELECT blob1 AS type, blob2 AS value, sum(_sample_interval) AS n
    FROM ${dataset}
    WHERE timestamp > NOW() - INTERVAL '${d}' DAY AND blob3 = '${c}'
    GROUP BY type, value ORDER BY n DESC LIMIT 500`;
}

async function aeQuery(env, sql) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return { error: "unconfigured" };
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: sql,
  });
  if (!res.ok) return { error: "query_failed", status: res.status };
  const json = await res.json().catch(() => null);
  return { rows: (json && json.data) || [] };
}

async function handleAdminStats(request, env, url) {
  if (!(await isAdmin(request, env))) return adminJson({ error: "forbidden" }, 403);
  const dataset = env.AE_DATASET || "lsl_events";
  const city = url.searchParams.get("city") || "lahti";
  const days = url.searchParams.get("days") || "30";
  const r = await aeQuery(env, buildStatsSql(city, dataset, days));
  if (r.error) return adminJson({ error: r.error }, 200); // dashboard näyttää "ei konfiguroitu"
  const num = v => Number(v) || 0;
  const byType = t => r.rows.filter(x => x.type === t).map(x => ({ value: x.value, n: num(x.n) }));
  const views = byType("view");
  return adminJson({
    days: Math.min(90, Math.max(1, parseInt(days, 10) || 30)),
    totalViews: views.reduce((s, x) => s + x.n, 0),
    views,
    lines: byType("line"),
    stops: byType("stop"),
    failedSearches: byType("search_fail"),
  }, 200);
}

/* ---------- Push: tilausten hallinta (KV) ---------- */

async function handleSubscribe(request, env, origin) {
  if (!env.PUSH_KV) return jsonResponse({ error: "push_unconfigured" }, 503, origin);
  const body = await request.json().catch(() => null);
  const sub = body && body.subscription;
  if (!sub || !sub.endpoint || !sub.keys) return jsonResponse({ error: "bad_request" }, 400, origin);
  const rec = {
    endpoint: sub.endpoint,
    keys: sub.keys,
    routes: (body.routes || []).map(r => String(r).toUpperCase()),
    gtfsRoutes: body.gtfsRoutes || [],
    feed: body.feed || "",
    city: body.city || "",
    lang: body.lang || "fi",
    ts: Date.now(),
  };
  await env.PUSH_KV.put("sub:" + await sha256hex(sub.endpoint), JSON.stringify(rec));
  return jsonResponse({ ok: true }, 200, origin);
}

async function handleUnsubscribe(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body || !body.endpoint) return jsonResponse({ error: "bad_request" }, 400, origin);
  if (env.PUSH_KV) await env.PUSH_KV.delete("sub:" + await sha256hex(body.endpoint));
  return jsonResponse({ ok: true }, 200, origin);
}

// Kaikki odottavat lähtömuistutukset säilytetään YHDESSÄ KV-avaimessa
// ("rem:pending", muotoa { [id]: rec }). Näin minuutticron tarkistaa ne yhdellä
// get-kutsulla EIKÄ kalliilla list-operaatiolla — KV:n ilmaiskiintiö on vain
// 1000 list-operaatiota/vrk, ja minuutticron yksin söi sen (1440/vrk).
async function readPending(env) {
  const raw = await env.PUSH_KV.get("rem:pending");
  if (!raw) return {};
  try { const o = JSON.parse(raw); return o && typeof o === "object" ? o : {}; }
  catch (e) { return {}; }
}

async function writePending(env, pending) {
  const ids = Object.keys(pending);
  if (!ids.length) { await env.PUSH_KV.delete("rem:pending"); return; }
  // TTL-varmuus: säilytä kunnes myöhäisin muistutus + 2 h on ohi, vaikka cron jäisi väliin.
  let maxFire = 0;
  for (const id of ids) maxFire = Math.max(maxFire, Number(pending[id].fireAt) || 0);
  const ttl = Math.max(60, Math.floor(maxFire + 7200 - Date.now() / 1000));
  await env.PUSH_KV.put("rem:pending", JSON.stringify(pending), { expirationTtl: ttl });
}

// Lähtömuistutus: tallenna kertaluonteinen push joka lähetetään fireAt-hetkellä.
async function handleReminder(request, env, origin) {
  if (!env.PUSH_KV) return jsonResponse({ error: "push_unconfigured" }, 503, origin);
  const body = await request.json().catch(() => null);
  const sub = body && body.subscription;
  const fireAt = Number(body && body.fireAt);
  if (!sub || !sub.endpoint || !sub.keys || !Number.isFinite(fireAt))
    return jsonResponse({ error: "bad_request" }, 400, origin);
  const id = crypto.randomUUID();
  const rec = {
    endpoint: sub.endpoint, keys: sub.keys, fireAt,
    title: String((body.title || "Lähtömuistutus")).slice(0, 80),
    body: String((body.body || "")).slice(0, 180),
    tag: body.tag || ("rem-" + id),
    url: body.url || "./",
  };
  const pending = await readPending(env);
  pending[id] = rec;
  await writePending(env, pending);
  return jsonResponse({ ok: true, id }, 200, origin);
}

// Ajetaan minuutin cronista: lähetä erääntyneet muistutukset, poista lähetetyt.
// Lukee odottavat muistutukset yhdellä get-kutsulla (ei list-operaatiota).
export async function runReminderCheck(env, nowMs) {
  if (!env.PUSH_KV || !env.VAPID_PRIVATE_JWK) return;
  const now = (nowMs ?? Date.now()) / 1000;
  const pending = await readPending(env);
  const ids = Object.keys(pending);
  if (!ids.length) return; // tyhjä → ei kirjoituksia, ei list-operaatiota
  let changed = false;
  for (const id of ids) {
    const r = pending[id];
    if (!r || now >= r.fireAt) {
      if (r && now >= r.fireAt && now <= r.fireAt + 1800) { // ei lähetetä yli 30 min myöhässä
        const payload = JSON.stringify({ title: r.title, body: r.body, tag: r.tag, url: r.url || "./" });
        try { await sendPush(r, payload, env); } catch (e) { /* ohita */ }
      }
      delete pending[id];
      changed = true;
    }
  }
  if (changed) await writePending(env, pending);
}

/* ---------- Häiriöiden haku ja täsmäytys (cron) ---------- */

const ALERTS_QUERY = `query ($feeds: [String!]) {
  alerts(feeds: $feeds) {
    alertHeaderText alertDescriptionText alertSeverityLevel alertUrl
    effectiveStartDate effectiveEndDate route { gtfsId } stop { gtfsId }
  }
}`;

async function fetchAlerts(feed, env) {
  const res = await fetch(ROUTING_UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json", "digitransit-subscription-key": env.DIGITRANSIT_KEY },
    body: JSON.stringify({ query: ALERTS_QUERY, variables: { feeds: [feed] } }),
  });
  const data = await res.json();
  const now = Date.now() / 1000;
  return (data.data?.alerts || []).filter(a =>
    !(a.effectiveStartDate && a.effectiveStartDate > now) &&
    !(a.effectiveEndDate && a.effectiveEndDate < now));
}

// Feed → CMS-lähde (lsl.fi häiriötiedotteet) taustapushia varten. Sama lähde
// kuin client-CONFIG.cmsAlerts, mutta workerin cron tarvitsee oman mappauksen.
const CMS_SOURCES = { Lahti: { host: "www.lsl.fi", cat: 4 } };

// Hakee CMS-häiriötiedotteet alert-muodossa pushin täsmäytystä varten. Käyttää
// content.rendered-tekstiä (otsikko ei aina sisällä linjanumeroita, runko sisältää),
// jotta lineTokensFromText osuu seurattuihin linjoihin. Tuoreet, "Tilanne ohi" pois.
async function fetchCmsAlertsForPush(feed) {
  const src = CMS_SOURCES[feed];
  if (!src) return [];
  const api = `https://${src.host}/wp-json/wp/v2/posts?categories=${src.cat}&per_page=12` +
    `&_fields=date,title,link,content`;
  const res = await fetch(api, { headers: { Accept: "application/json" } });
  if (!res.ok) return [];
  const posts = await res.json();
  const now = Date.now();
  const maxAge = 45 * 24 * 3600 * 1000;
  const out = [];
  for (const p of (Array.isArray(posts) ? posts : [])) {
    const title = htmlToText(p.title && p.title.rendered);
    if (!title || /^\s*tilanne ohi/i.test(title)) continue;
    const ts = Date.parse(p.date || "");
    if (Number.isFinite(ts) && now - ts > maxAge) continue;
    out.push({
      alertHeaderText: title,
      alertDescriptionText: htmlToText(p.content && p.content.rendered).slice(0, 1500),
      alertUrl: p.link || "",
      effectiveStartDate: Number.isFinite(ts) ? Math.floor(ts / 1000) : 0,
      _cms: true,
    });
  }
  return out;
}

// LSL ei kiinnitä tiedotteita linjaobjekteihin, joten linjat poimitaan myös
// tiedotetekstin maininnoista: "linjoja 3, 6, 8(K)" -> 3, 6, 8, 8K
// (sama logiikka kuin index.html:n lineTokensFromText)
export function lineTokensFromText(text) {
  const out = new Set();
  for (const seg of text.matchAll(/linj\w*\s+([0-9][0-9A-ZÅÄÖ()\s,.ja-]*)/gi)) {
    for (const tok of seg[1].matchAll(/(\d+)\s*(?:\(([A-ZÅÄÖ,\s]+)\))?([A-ZÅÄÖ]?)/g)) {
      out.add(tok[1]);
      if (tok[3]) out.add(tok[1] + tok[3]);
      if (tok[2]) for (const l of tok[2].split(/[,\s]+/)) if (l) out.add(tok[1] + l);
    }
  }
  return out;
}

// CMS-tiedotteen runko voi muuttua (modified) → avainnetaan pysyvästi URL:lla,
// ettei pieni editointi laukaise uusintailmoitusta. GTFS-RT: sisältöavain.
const alertKey = a =>
  a._cms && a.alertUrl
    ? "cms:" + a.alertUrl
    : (a.alertHeaderText || "") + "|" + (a.alertDescriptionText || "") + "|" + (a.effectiveStartDate || "");

export function alertAffects(a, sub) {
  if (a.route && sub.gtfsRoutes.includes(a.route.gtfsId)) return true;
  const tokens = lineTokensFromText((a.alertHeaderText || "") + " " + (a.alertDescriptionText || ""));
  return sub.routes.some(sn => tokens.has(sn));
}

async function loadSubscriptions(env) {
  const subs = [];
  let cursor;
  do {
    const list = await env.PUSH_KV.list({ prefix: "sub:", cursor });
    for (const k of list.keys) {
      const v = await env.PUSH_KV.get(k.name);
      if (v) { try { subs.push({ kvKey: k.name, ...JSON.parse(v) }); } catch (e) { /* ohita */ } }
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return subs;
}

// Ajetaan cronista: hae häiriöt, vertaa nähtyihin ja lähetä push uusista
// suosikkilinjoja seuraaville tilaajille.
export async function runPushCheck(env) {
  // Alert-haku vaatii DIGITRANSIT_KEYn; web-push vaatii lisäksi VAPIDin, mutta
  // sähköpostikanava toimii myös ilman VAPIDia (vain RESEND_API_KEY + EMAIL_FROM).
  if (!env.PUSH_KV || !env.DIGITRANSIT_KEY) return;
  const pushReady = !!env.VAPID_PRIVATE_JWK;
  const subs = pushReady ? await loadSubscriptions(env) : [];

  // Sähköpostitilausten kaupunki→feed-rekisteri: yksi get-kutsu, EI list-operaatiota
  // (KV:n ilmaisraja 1000 list/vrk säilyy). Kertoo mitkä feedit tarkistetaan, vaikka
  // ko. feedillä ei olisi yhtään web-push-tilaajaa.
  let reg = {};
  try { reg = JSON.parse((await env.PUSH_KV.get(EMAIL_REG_KEY)) || "{}"); } catch (e) { /* tyhjä */ }
  const feedCity = {};
  for (const [city, f] of Object.entries(reg)) if (f) feedCity[f] = city;

  const feeds = [...new Set([
    ...subs.map(s => s.feed).filter(Boolean),
    ...Object.values(reg).filter(Boolean),
  ])];
  if (!feeds.length) return;

  for (const feed of feeds) {
    // GTFS-RT (Digitransit) ja CMS (lsl.fi) erikseen omilla seen-avaimillaan,
    // jotta CMS:n käyttöönotto ei tulvi jo julkaistuja tiedotteita (oma ensiajo).
    let gtfs = [];
    try { gtfs = await fetchAlerts(feed, env); } catch (e) { /* CMS silti jäljellä */ }
    let cms = [];
    try { cms = await fetchCmsAlertsForPush(feed); } catch (e) { /* GTFS silti jäljellä */ }

    // Sama fresh-joukko sekä pushille että sähköpostille → kanavat pysyvät synkassa.
    const fresh = [
      ...await freshAlerts(env, "seen:" + feed, gtfs),
      ...await freshAlerts(env, "seenCms:" + feed, cms),
    ];
    if (!fresh.length) continue;

    // Web-push (ennallaan)
    if (pushReady) {
      const feedSubs = subs.filter(s => s.feed === feed);
      for (const a of fresh) {
        const payload = JSON.stringify({
          title: a.alertHeaderText || "Häiriötiedote",
          body: (a.alertDescriptionText || "").slice(0, 180),
          url: a._cms && a.alertUrl ? a.alertUrl : "./",
          tag: alertKey(a),
        });
        for (const sub of feedSubs) {
          if (!alertAffects(a, sub)) continue;
          try {
            const status = await sendPush(sub, payload, env);
            if (status === 404 || status === 410) await env.PUSH_KV.delete(sub.kvKey);
          } catch (e) { /* jatka muihin tilaajiin */ }
        }
      }
    }

    // Sähköposti (rinnakkainen kanava): vahvistetut, oikean linjan tilaajat
    const city = feedCity[feed];
    if (city) await sendEmailAlertsForFeed(env, city, feed, fresh);
  }
}

// Vertaa annettuja häiriöitä seen-karttaan (KV-avain seenKeyName), palauttaa
// uudet ja päivittää kartan. Ensiajo (ei seen-tietoa) vain seedaa, palauttaa []
// (ei tulvita nykyisiä). Vanhat, poistuneet avaimet siivotaan 30 vrk jälkeen.
async function freshAlerts(env, seenKeyName, alerts) {
  if (!alerts.length) {
    // ei dataa (esim. haku epäonnistui) → ei muuteta seen-tilaa
    return [];
  }
  const seenRaw = await env.PUSH_KV.get(seenKeyName);
  const firstRun = !seenRaw;
  const seenMap = seenRaw ? JSON.parse(seenRaw) : {};
  const now = Date.now();
  const currentKeys = new Set();
  const fresh = [];
  for (const a of alerts) {
    const k = alertKey(a);
    currentKeys.add(k);
    if (!firstRun && !(k in seenMap)) fresh.push(a);
    seenMap[k] = now;
  }
  const cutoff = now - 30 * 24 * 3600 * 1000;
  for (const k of Object.keys(seenMap))
    if (seenMap[k] < cutoff && !currentKeys.has(k)) delete seenMap[k];
  await env.PUSH_KV.put(seenKeyName, JSON.stringify(seenMap));
  return firstRun ? [] : fresh;
}

/* ---------- Sähköpostipohjainen häiriötilaus (KV + Resend) ---------- */
// Rinnakkainen kanava web-pushille: ydinkäyttäjä (ikäihminen) ei lataa appia
// eikä saa web-pushia. GDPR: double opt-in (vahvistuslinkki ennen aktivointia) +
// peruutuslinkki joka viestissä. Lähetys integroitu runPushCheck-croniin.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailCity = c => String(c || "lahti").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30) || "lahti";
const EMAIL_REC_KEY = (city, hash) => "email:" + city + ":" + hash;        // auktoritatiivinen tietue
const EMAIL_TOK_KEY = token => "email:tok:" + token;                       // token → "<city>:<hash>"
const EMAIL_IDX_KEY = city => "email:idx:" + city;                         // vahvistetut, cron lukee 1 get
const EMAIL_REG_KEY = "email:reg";                                         // { city: feed } cronin feed-joukolle
const APP_BASE_DEFAULT = "https://veikkoville.github.io/lsl-aikataulut";

// Kokoaa ja validoi sähköpostitilauksen. Pure-funktio yksikkötestiä varten.
export function buildEmailSubscription(body, nowMs) {
  const email = String((body && body.email) || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 160) return { error: "bad_email" };
  const lines = (Array.isArray(body && body.lines) ? body.lines : [])
    .map(s => String(s).toUpperCase().trim().slice(0, 12)).filter(Boolean).slice(0, 60);
  const gtfsRoutes = (Array.isArray(body && body.gtfsRoutes) ? body.gtfsRoutes : [])
    .map(s => String(s).slice(0, 60)).filter(Boolean).slice(0, 60);
  if (!lines.length && !gtfsRoutes.length) return { error: "no_lines" };
  const lang = ["fi", "en", "sv"].includes(body && body.lang) ? body.lang : "fi";
  return {
    rec: {
      email, city: emailCity(body && body.city), feed: String((body && body.feed) || "").slice(0, 40),
      lines, gtfsRoutes, lang, confirmed: false, ts: nowMs,
    },
  };
}

async function sendResendEmail(env, to, subject, html, text) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { skipped: true };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text }),
  });
  return { status: res.status, ok: res.ok };
}

// Saavutettava, isofonttinen HTML-sivu confirm/unsubscribe-vastauksille
// (linkkiä klikataan sähköpostista → ihmisluettava vastaus, ei JSON).
function emailHtmlPage(title, body) {
  const html = `<!doctype html><html lang="fi"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(title)}</title>` +
    `<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:34rem;` +
    `margin:2rem auto;padding:0 1.2rem;font-size:1.25rem;line-height:1.6;color:#1a1a1a}` +
    `h1{font-size:1.6rem}a{color:#0a4ea3}.card{border:2px solid #0a4ea3;border-radius:12px;padding:1.2rem 1.4rem}</style>` +
    `</head><body><div class="card"><h1>${escHtml(title)}</h1><p>${body}</p>` +
    `<p><a href="${APP_BASE_DEFAULT}/">Avaa aikataulupalvelu</a></p></div></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// Vahvistusviesti (double opt-in). Pure-funktio testiä varten.
export function buildConfirmEmail(rec, confirmUrl, unsubUrl) {
  const lines = escHtml((rec.lines || []).join(", ") || "(ei valittuja linjoja)");
  const subject = "Vahvista häiriötiedotteiden tilaus";
  const html = `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.6;color:#1a1a1a;max-width:560px">` +
    `<h1 style="font-size:22px">Vahvista tilaus</h1>` +
    `<p>Tilasit häiriötiedotteet sähköpostiisi linjoille: <strong>${lines}</strong>.</p>` +
    `<p>Vahvista tilaus klikkaamalla painiketta:</p>` +
    `<p><a href="${confirmUrl}" style="display:inline-block;background:#0a4ea3;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-size:18px">Vahvista tilaus</a></p>` +
    `<p style="font-size:15px;color:#555">Jos et tilannut tätä, voit jättää viestin huomiotta tai <a href="${unsubUrl}">peruuttaa tilauksen</a>.</p></div>`;
  const text = `Vahvista häiriötiedotteiden tilaus linjoille: ${(rec.lines || []).join(", ")}\n\nVahvista: ${confirmUrl}\n\nPeruuta: ${unsubUrl}`;
  return { subject, html, text };
}

// Häiriötiedote-viesti, 3-kenttäinen (Mitä / Milloin ja missä / Tee näin). Pure.
export function buildAlertEmail(alert, entry, serviceUrl, unsubUrl) {
  const what = (alert.alertHeaderText || "Häiriö joukkoliikenteessä").slice(0, 160);
  const whenWhere = (alert.alertDescriptionText || "").slice(0, 1500) || "Tarkemmat tiedot palvelusta.";
  const subject = ("Häiriötiedote: " + what).slice(0, 120);
  const html = `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;font-size:18px;line-height:1.6;color:#1a1a1a;max-width:560px">` +
    `<h1 style="font-size:22px">Häiriötiedote</h1>` +
    `<p><strong>1. Mitä</strong><br>${escHtml(what)}</p>` +
    `<p><strong>2. Milloin ja missä</strong><br>${escHtml(whenWhere)}</p>` +
    `<p><strong>3. Tee näin</strong><br>Katso linjan ajantasaiset lähdöt ja vaihtoehtoinen reitti palvelusta:<br>` +
    `<a href="${serviceUrl}">${escHtml(serviceUrl)}</a></p>` +
    `<hr style="border:none;border-top:1px solid #ddd;margin:20px 0">` +
    `<p style="font-size:15px;color:#555">Et halua enää näitä viestejä? <a href="${unsubUrl}">Peruuta tilaus</a>.</p></div>`;
  const text = `Häiriötiedote\n\n1. Mitä\n${what}\n\n2. Milloin ja missä\n${whenWhere}\n\n3. Tee näin\nKatso ajantasaiset lähdöt: ${serviceUrl}\n\nPeruuta tilaus: ${unsubUrl}`;
  return { subject, html, text };
}

async function emailIndexAdd(env, rec, hash) {
  const idxKey = EMAIL_IDX_KEY(rec.city);
  let idx = {};
  try { idx = JSON.parse((await env.PUSH_KV.get(idxKey)) || "{}"); } catch (e) { /* tyhjä */ }
  idx[hash] = { email: rec.email, lines: rec.lines || [], gtfsRoutes: rec.gtfsRoutes || [], token: rec.token };
  await env.PUSH_KV.put(idxKey, JSON.stringify(idx));
  let reg = {};
  try { reg = JSON.parse((await env.PUSH_KV.get(EMAIL_REG_KEY)) || "{}"); } catch (e) { /* tyhjä */ }
  if (reg[rec.city] !== (rec.feed || "")) { reg[rec.city] = rec.feed || ""; await env.PUSH_KV.put(EMAIL_REG_KEY, JSON.stringify(reg)); }
}

async function emailIndexRemove(env, city, hash) {
  const idxKey = EMAIL_IDX_KEY(city);
  let idx = {};
  try { idx = JSON.parse((await env.PUSH_KV.get(idxKey)) || "{}"); } catch (e) { /* tyhjä */ }
  delete idx[hash];
  if (Object.keys(idx).length) { await env.PUSH_KV.put(idxKey, JSON.stringify(idx)); return; }
  await env.PUSH_KV.delete(idxKey); // viimeinen tilaaja poistui → siivoa idx + rekisterimerkintä
  let reg = {};
  try { reg = JSON.parse((await env.PUSH_KV.get(EMAIL_REG_KEY)) || "{}"); } catch (e) { /* tyhjä */ }
  if (city in reg) {
    delete reg[city];
    if (Object.keys(reg).length) await env.PUSH_KV.put(EMAIL_REG_KEY, JSON.stringify(reg));
    else await env.PUSH_KV.delete(EMAIL_REG_KEY);
  }
}

// Lähettää häiriötiedotteen vahvistetuille, oikean linjan sähköpostitilaajille.
// Lukee email:idx:<city> yhdellä get-kutsulla (ei list-operaatiota).
async function sendEmailAlertsForFeed(env, city, feed, fresh) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return;
  let idx = {};
  try { idx = JSON.parse((await env.PUSH_KV.get(EMAIL_IDX_KEY(city))) || "{}"); } catch (e) { /* tyhjä */ }
  const entries = Object.entries(idx);
  if (!entries.length) return;
  const base = String(env.EMAIL_LINK_BASE || "").replace(/\/$/, "");
  const appBase = String(env.APP_BASE || APP_BASE_DEFAULT).replace(/\/$/, "");
  for (const a of fresh) {
    for (const [hash, e] of entries) {
      if (!alertAffects(a, { gtfsRoutes: e.gtfsRoutes || [], routes: e.lines || [] })) continue;
      const unsubUrl = base + "/email/unsubscribe?token=" + e.token;
      const serviceUrl = appBase + "/?city=" + encodeURIComponent(city);
      const mail = buildAlertEmail(a, e, serviceUrl, unsubUrl);
      try { await sendResendEmail(env, e.email, mail.subject, mail.html, mail.text); } catch (err) { /* jatka muihin */ }
    }
  }
}

async function handleEmailSubscribe(request, env, origin) {
  if (!env.PUSH_KV) return jsonResponse({ error: "unconfigured" }, 503, origin);
  const body = await request.json().catch(() => null);
  const { rec, error } = buildEmailSubscription(body, Date.now());
  if (error) return jsonResponse({ error }, 400, origin);
  const hash = await sha256hex(rec.email);
  const recKey = EMAIL_REC_KEY(rec.city, hash);
  let existing = null;
  try { const r = await env.PUSH_KV.get(recKey); existing = r ? JSON.parse(r) : null; } catch (e) { /* tyhjä */ }
  // Jo vahvistettu → päivitä vain linjat, ei uutta vahvistusta
  if (existing && existing.confirmed) {
    const upd = { ...existing, lines: rec.lines, gtfsRoutes: rec.gtfsRoutes, feed: rec.feed, lang: rec.lang };
    await env.PUSH_KV.put(recKey, JSON.stringify(upd));
    await emailIndexAdd(env, upd, hash);
    return jsonResponse({ ok: true, updated: true }, 200, origin);
  }
  // Vahvistamaton ja vasta luotu (< 10 min) → ei uutta vahvistusviestiä (anti-roska)
  if (existing && !existing.confirmed && (Date.now() - (existing.ts || 0)) < 10 * 60 * 1000)
    return jsonResponse({ ok: true, pending: true }, 200, origin);
  const token = (existing && existing.token) || crypto.randomUUID();
  const full = { ...rec, token };
  await env.PUSH_KV.put(recKey, JSON.stringify(full));
  await env.PUSH_KV.put(EMAIL_TOK_KEY(token), rec.city + ":" + hash);
  const linkBase = (env.EMAIL_LINK_BASE || new URL(request.url).origin).replace(/\/$/, "");
  const confirmUrl = linkBase + "/email/confirm?token=" + token;
  const unsubUrl = linkBase + "/email/unsubscribe?token=" + token;
  const mail = buildConfirmEmail(full, confirmUrl, unsubUrl);
  try { await sendResendEmail(env, rec.email, mail.subject, mail.html, mail.text); } catch (e) { /* ei kaada tilausta */ }
  return jsonResponse({ ok: true }, 200, origin);
}

async function handleEmailConfirm(url, env) {
  const token = url.searchParams.get("token") || "";
  if (!token || !env.PUSH_KV) return emailHtmlPage("Virheellinen linkki", "Vahvistuslinkki ei kelpaa.");
  const ptr = await env.PUSH_KV.get(EMAIL_TOK_KEY(token));
  if (!ptr) return emailHtmlPage("Linkki vanhentunut", "Tätä tilausta ei löytynyt. Voit tilata tiedotteet tarvittaessa uudelleen.");
  const sep = ptr.indexOf(":");
  const city = ptr.slice(0, sep), hash = ptr.slice(sep + 1);
  const recRaw = await env.PUSH_KV.get(EMAIL_REC_KEY(city, hash));
  if (!recRaw) return emailHtmlPage("Tilausta ei löytynyt", "Voit tilata tiedotteet tarvittaessa uudelleen.");
  const rec = JSON.parse(recRaw);
  rec.confirmed = true;
  rec.confirmedTs = Date.now();
  await env.PUSH_KV.put(EMAIL_REC_KEY(city, hash), JSON.stringify(rec));
  await emailIndexAdd(env, rec, hash);
  const lines = escHtml((rec.lines || []).join(", "));
  return emailHtmlPage("Tilaus vahvistettu",
    "Saat nyt häiriötiedotteet sähköpostiisi linjoille " + lines + ". Voit peruuttaa tilauksen milloin tahansa viestin lopussa olevasta linkistä.");
}

async function handleEmailUnsubscribe(url, env) {
  const token = url.searchParams.get("token") || "";
  if (!token || !env.PUSH_KV) return emailHtmlPage("Virheellinen linkki", "Peruutuslinkki ei kelpaa.");
  const ptr = await env.PUSH_KV.get(EMAIL_TOK_KEY(token));
  if (!ptr) return emailHtmlPage("Tilaus jo peruttu", "Tilausta ei löytynyt. Et saa enää häiriötiedotteita.");
  const sep = ptr.indexOf(":");
  const city = ptr.slice(0, sep), hash = ptr.slice(sep + 1);
  await env.PUSH_KV.delete(EMAIL_REC_KEY(city, hash));
  await env.PUSH_KV.delete(EMAIL_TOK_KEY(token));
  await emailIndexRemove(env, city, hash);
  return emailHtmlPage("Tilaus peruttu", "Et saa enää häiriötiedotteita sähköpostiisi. Kiitos!");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    // Ylläpito (sisällönhallinta). Admin-sivu + sen API tarjoillaan samasta
    // originista → istuntoeväste toimii ilman CORS-säätöä.
    if (url.pathname === "/admin" && request.method === "GET")
      return new Response(ADMIN_HTML, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (url.pathname === "/admin/login" && request.method === "POST")
      return handleAdminLogin(request, env);
    if (url.pathname === "/admin/logout" && request.method === "POST")
      return handleAdminLogout();
    if (url.pathname === "/admin/api/session" && request.method === "GET")
      return adminJson({ authed: await isAdmin(request, env) }, 200);
    if (url.pathname === "/admin/api/alerts" && request.method === "GET")
      return handleAdminAlertsGet(request, env, url);
    if (url.pathname === "/admin/api/alerts" && request.method === "POST")
      return handleAdminAlertsSave(request, env);
    if (url.pathname === "/admin/api/alerts/delete" && request.method === "POST")
      return handleAdminAlertsDelete(request, env);
    if (url.pathname === "/admin/api/fares" && request.method === "GET")
      return handleAdminFaresGet(request, env, url);
    if (url.pathname === "/admin/api/fares" && request.method === "POST")
      return handleAdminFaresSave(request, env);
    if (url.pathname === "/admin/api/a11y" && request.method === "GET")
      return handleAdminA11yGet(request, env, url);
    if (url.pathname === "/admin/api/a11y" && request.method === "POST")
      return handleAdminA11ySave(request, env);
    if (url.pathname === "/admin/api/stats" && request.method === "GET")
      return handleAdminStats(request, env, url);
    // Julkaistut tiedotteet sovellukselle (julkinen, CORS)
    if (url.pathname === "/published" && request.method === "GET")
      return handlePublished(url, env, origin);
    // Anonyymi käyttöanalytiikka (julkinen, CORS)
    if (url.pathname === "/track" && request.method === "POST")
      return handleTrack(request, env, origin);

    // Push-tilaukset
    if (url.pathname === "/push/subscribe" && request.method === "POST")
      return handleSubscribe(request, env, origin);
    if (url.pathname === "/push/unsubscribe" && request.method === "POST")
      return handleUnsubscribe(request, env, origin);
    if (url.pathname === "/push/reminder" && request.method === "POST")
      return handleReminder(request, env, origin);
    if (url.pathname === "/push/vapidPublicKey" && request.method === "GET")
      return jsonResponse({ key: env.VAPID_PUBLIC || "" }, 200, origin);

    // Sähköpostipohjainen häiriötilaus (double opt-in)
    if (url.pathname === "/email/subscribe" && request.method === "POST")
      return handleEmailSubscribe(request, env, origin);
    if (url.pathname === "/email/confirm" && request.method === "GET")
      return handleEmailConfirm(url, env);
    if (url.pathname === "/email/unsubscribe" && request.method === "GET")
      return handleEmailUnsubscribe(url, env);

    // CMS-häiriötiedotteet (lsl.fi WordPress REST)
    if (url.pathname === "/cms-alerts" && request.method === "GET")
      return handleCmsAlerts(url, origin);

    // Palaute / vikailmoitus
    if (url.pathname === "/feedback" && request.method === "POST")
      return handleFeedback(request, env, origin);
    if (url.pathname === "/feedback/list" && request.method === "GET")
      return handleFeedbackList(url, env, origin);

    const geo = url.pathname.match(/^\/geocoding\/(search|autocomplete|reverse)$/);
    if (geo) {
      if (request.method !== "GET") {
        return new Response("Only GET is supported for geocoding", { status: 405, headers: corsHeaders(origin) });
      }
      const upstream = await fetch(`${GEOCODING_UPSTREAM}/${geo[1]}${url.search}`, {
        headers: { "digitransit-subscription-key": env.DIGITRANSIT_KEY },
      });
      const headers = new Headers(corsHeaders(origin));
      headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
      headers.set("Cache-Control", "public, max-age=60");
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    if (request.method !== "POST") {
      return new Response("Only POST is supported", { status: 405, headers: corsHeaders(origin) });
    }
    const upstream = await fetch(ROUTING_UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("Content-Type") || "application/json",
        "digitransit-subscription-key": env.DIGITRANSIT_KEY,
      },
      body: request.body,
    });
    const headers = new Headers(corsHeaders(origin));
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    return new Response(upstream.body, { status: upstream.status, headers });
  },

  // Cron-liipaisimet (wrangler.toml [triggers] crons): minuutin cron lähettää
  // erääntyneet lähtömuistutukset, 5 min cron tarkistaa häiriöt.
  async scheduled(event, env, ctx) {
    if (event.cron === "* * * * *") ctx.waitUntil(runReminderCheck(env));
    else ctx.waitUntil(runPushCheck(env));
  },
};

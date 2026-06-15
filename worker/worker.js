// Cloudflare Worker: välittää GraphQL- ja geokoodauspyynnöt Digitransitiin ja
// lisää API-avaimen palvelinpäässä, jotta sivun käyttäjät eivät tarvitse omaa avainta.
// Lisäksi: taustapush-ilmoitukset suosikkilinjojen häiriöistä (KV + cron + VAPID).
// Avain asetetaan salaisuutena: npx wrangler secret put DIGITRANSIT_KEY

import { sendPush } from "./webpush.js";

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
  const api = `https://${host}/wp-json/wp/v2/posts?categories=${cat}&per_page=${per}` +
    `&_fields=id,date,modified,title,link,excerpt`;
  let posts;
  try {
    const res = await fetch(api, { headers: { Accept: "application/json" } });
    if (!res.ok) return jsonResponse({ error: "upstream", status: res.status }, 502, origin);
    posts = await res.json();
  } catch (e) {
    return jsonResponse({ error: "fetch_failed" }, 502, origin);
  }
  const items = (Array.isArray(posts) ? posts : []).map(p => ({
    title: htmlToText(p.title && p.title.rendered),
    excerpt: htmlToText(p.excerpt && p.excerpt.rendered).slice(0, 300),
    link: p.link || "",
    date: p.date || "",
    modified: p.modified || "",
  })).filter(p => p.title);
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

// Lähtömuistutus: tallenna kertaluonteinen push joka lähetetään fireAt-hetkellä.
// KV:n expirationTtl siivoaa merkinnän automaattisesti, vaikka cron jäisi väliin.
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
  const ttl = Math.max(60, Math.floor(fireAt + 7200 - Date.now() / 1000));
  await env.PUSH_KV.put("rem:" + id, JSON.stringify(rec), { expirationTtl: ttl });
  return jsonResponse({ ok: true, id }, 200, origin);
}

// Ajetaan minuutin cronista: lähetä erääntyneet muistutukset, poista lähetetyt.
export async function runReminderCheck(env, nowMs) {
  if (!env.PUSH_KV || !env.VAPID_PRIVATE_JWK) return;
  const now = (nowMs ?? Date.now()) / 1000;
  let cursor;
  do {
    const list = await env.PUSH_KV.list({ prefix: "rem:", cursor });
    for (const k of list.keys) {
      const v = await env.PUSH_KV.get(k.name);
      if (!v) continue;
      let r;
      try { r = JSON.parse(v); } catch (e) { await env.PUSH_KV.delete(k.name); continue; }
      if (now >= r.fireAt) {
        if (now <= r.fireAt + 1800) { // ei lähetetä yli 30 min myöhässä
          const payload = JSON.stringify({ title: r.title, body: r.body, tag: r.tag, url: r.url || "./" });
          try { await sendPush(r, payload, env); } catch (e) { /* ohita */ }
        }
        await env.PUSH_KV.delete(k.name);
      }
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
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
  if (!env.PUSH_KV || !env.DIGITRANSIT_KEY || !env.VAPID_PRIVATE_JWK) return;
  const subs = await loadSubscriptions(env);
  if (!subs.length) return;

  const feeds = [...new Set(subs.map(s => s.feed).filter(Boolean))];
  for (const feed of feeds) {
    // GTFS-RT (Digitransit) ja CMS (lsl.fi) erikseen omilla seen-avaimillaan,
    // jotta CMS:n käyttöönotto ei tulvi jo julkaistuja tiedotteita (oma ensiajo).
    let gtfs = [];
    try { gtfs = await fetchAlerts(feed, env); } catch (e) { /* CMS silti jäljellä */ }
    let cms = [];
    try { cms = await fetchCmsAlertsForPush(feed); } catch (e) { /* GTFS silti jäljellä */ }

    const fresh = [
      ...await freshAlerts(env, "seen:" + feed, gtfs),
      ...await freshAlerts(env, "seenCms:" + feed, cms),
    ];
    if (!fresh.length) continue;

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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    // Push-tilaukset
    if (url.pathname === "/push/subscribe" && request.method === "POST")
      return handleSubscribe(request, env, origin);
    if (url.pathname === "/push/unsubscribe" && request.method === "POST")
      return handleUnsubscribe(request, env, origin);
    if (url.pathname === "/push/reminder" && request.method === "POST")
      return handleReminder(request, env, origin);
    if (url.pathname === "/push/vapidPublicKey" && request.method === "GET")
      return jsonResponse({ key: env.VAPID_PUBLIC || "" }, 200, origin);

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

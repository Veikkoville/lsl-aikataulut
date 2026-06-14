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

const alertKey = a =>
  (a.alertHeaderText || "") + "|" + (a.alertDescriptionText || "") + "|" + (a.effectiveStartDate || "");

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
    let alerts;
    try { alerts = await fetchAlerts(feed, env); } catch (e) { continue; }

    const seenRaw = await env.PUSH_KV.get("seen:" + feed);
    const firstRun = !seenRaw;                 // ei seed-tietoa → merkitään nykyiset ilmoittamatta
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
    await env.PUSH_KV.put("seen:" + feed, JSON.stringify(seenMap));

    if (firstRun || !fresh.length) continue;

    const feedSubs = subs.filter(s => s.feed === feed);
    for (const a of fresh) {
      const payload = JSON.stringify({
        title: a.alertHeaderText || "Häiriötiedote",
        body: (a.alertDescriptionText || "").slice(0, 180),
        url: "./",
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
    if (url.pathname === "/push/vapidPublicKey" && request.method === "GET")
      return jsonResponse({ key: env.VAPID_PUBLIC || "" }, 200, origin);

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

  // Cron-liipaisin (wrangler.toml: [triggers] crons): tarkista häiriöt
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPushCheck(env));
  },
};

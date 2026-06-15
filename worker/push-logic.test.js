// Yksikkötestaa cron-push-putken (runPushCheck) mock-KV:llä ja stub-fetchillä:
// oikea salaus + VAPID, mutta push-endpoint ja Digitransit ovat tynkiä.
// Aja: node push-logic.test.js
import { runPushCheck, runReminderCheck, alertAffects, lineTokensFromText, htmlToText, buildFeedbackRecord } from "./worker.js";

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };

// --- CMS-tiedotteen htmlToText (WordPress-otsikon/tiivistelmän puhdistus) ---
check(htmlToText("<p>Linjat 3 &#8211; 8 poikkeavat &amp; viivästyvät</p>") === "Linjat 3 – 8 poikkeavat & viivästyvät", "htmlToText: tagit + entiteetit puretaan");
const SHY = String.fromCharCode(0xAD); // pehmeä tavuviiva
check(htmlToText("Alek" + SHY + "san" + SHY + "te" + SHY + "rin" + SHY + "katu") === "Aleksanterinkatu", "htmlToText: pehmeät tavuviivat pois");
check(htmlToText("") === "" && htmlToText(null) === "", "htmlToText: tyhjä/null → tyhjä");

// --- Palaute (buildFeedbackRecord) ---
check(buildFeedbackRecord({ message: "x" }, "UA", 5).error === "bad_request", "feedback: liian lyhyt viesti hylätään");
check(!buildFeedbackRecord({ message: "" }, "UA", 5).rec, "feedback: tyhjä viesti ei tuota merkintää");
const fb = buildFeedbackRecord({ message: "Pysäkki rikki", category: "stop", contact: "a@b.fi", url: "x", city: "lahti" }, "UA", 123).rec;
check(fb && fb.message === "Pysäkki rikki" && fb.category === "stop" && fb.ts === 123 && fb.contact === "a@b.fi", "feedback: kelvollinen viesti → merkintä kentittäin");
check(buildFeedbackRecord({ message: "a".repeat(5000) }, "UA", 1).rec.message.length === 2000, "feedback: viesti katkaistaan 2000 merkkiin");

// --- Tekstipoiminta ---
const tok = lineTokensFromText("Linjojen 3, 8(K) ja 12 reitti poikkeaa.");
check(tok.has("3") && tok.has("8") && tok.has("8K") && tok.has("12"), "lineTokensFromText: '3, 8(K) ja 12'");

// --- alertAffects ---
const sub0 = { routes: ["8K"], gtfsRoutes: ["Lahti:8"] };
check(alertAffects({ alertHeaderText: "Linja 8(K) myöhässä", alertDescriptionText: "" }, sub0), "alertAffects: teksti 8(K) ↔ suosikki 8K");
check(alertAffects({ route: { gtfsId: "Lahti:8" } }, sub0), "alertAffects: route.gtfsId ↔ gtfsRoutes");
check(!alertAffects({ alertHeaderText: "Linja 4 poikkeaa" }, sub0), "alertAffects: ei-seurattu linja 4 → ei");

// --- Mock-KV ---
function mockKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix, cursor } = {}) {
      const keys = [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
  };
}

// --- Tilaaja, jolla aito ECDH-julkinen avain (jotta salaus toimii) ---
const uaKp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const uaPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", uaKp.publicKey));
const b64url = b => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const auth = crypto.getRandomValues(new Uint8Array(16));
const subscription = {
  endpoint: "https://push.example/sub-abc",
  keys: { p256dh: b64url(uaPubRaw), auth: b64url(auth) },
  routes: ["8K"],
  gtfsRoutes: ["Lahti:8"],
  feed: "Lahti",
  city: "Lahti",
  lang: "fi",
};

// Kertakäyttöinen VAPID-avainpari testiin (EI tuotantoavain — ei salaisuuksia reposalle)
const dec = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const vapidKp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapidPrivJwk = await crypto.subtle.exportKey("jwk", vapidKp.privateKey);
const vapidPubJwk = await crypto.subtle.exportKey("jwk", vapidKp.publicKey);
const vapidPubPoint = (() => { const x = dec(vapidPubJwk.x), y = dec(vapidPubJwk.y); const p = new Uint8Array(65); p[0] = 4; p.set(x, 1); p.set(y, 33); return p; })();

const env = {
  PUSH_KV: mockKV(),
  DIGITRANSIT_KEY: "test",
  VAPID_PUBLIC: b64url(vapidPubPoint),
  VAPID_PRIVATE_JWK: JSON.stringify(vapidPrivJwk),
  VAPID_SUBJECT: "mailto:test@example.com",
};
await env.PUSH_KV.put("sub:test", JSON.stringify(subscription));

// --- Stub fetch: Digitransit-häiriöt + lsl.fi CMS + push-endpoint ---
let currentAlerts = [];
let currentCmsPosts = [];
const pushSends = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("digitransit.fi/routing")) {
    return { json: async () => ({ data: { alerts: currentAlerts } }) };
  }
  if (String(url).includes("/wp-json/")) {
    return { ok: true, json: async () => currentCmsPosts };
  }
  if (String(url).startsWith("https://push.example")) {
    pushSends.push({ url: String(url), headers: opts.headers });
    return { status: 201 };
  }
  throw new Error("odottamaton fetch: " + url);
};

const alert8 = { alertHeaderText: "Linja 8 poikkeaa", alertDescriptionText: "Työmaa keskustassa", alertSeverityLevel: "WARNING", effectiveStartDate: 0, effectiveEndDate: 0 };
const alert4 = { alertHeaderText: "Linja 4 poikkeaa", alertDescriptionText: "Muu", effectiveStartDate: 0, effectiveEndDate: 0 };

// 1) Ensimmäinen ajo: ei seen-tietoa → seed, ei lähetyksiä
currentAlerts = [alert8];
await runPushCheck(env);
check(pushSends.length === 0, "ensiajo seedaa nykyiset häiriöt ilman push-lähetystä");
check(!!env.PUSH_KV._m.get("seen:Lahti"), "seen:Lahti tallennettu ensiajossa");

// 2) Uusi seurattua linjaa koskeva häiriö → 1 push
currentAlerts = [alert8, { ...alert4 }, { alertHeaderText: "Linja 8(K) peruttu", alertDescriptionText: "Illan vuoro", effectiveStartDate: 0, effectiveEndDate: 0 }];
await runPushCheck(env);
check(pushSends.length === 1, "uusi linjan 8 häiriö → tasan 1 push seuraajalle");
check(/^vapid t=.+ k=.+/.test(pushSends[0]?.headers?.Authorization || ""), "push-lähetyksessä VAPID-Authorization");

// 3) Sama tila uudelleen → ei uusia lähetyksiä
await runPushCheck(env);
check(pushSends.length === 1, "ei uusintailmoitusta jo nähdystä häiriöstä");

// 4) Uusi häiriö linjalle 4 (ei seurattu) → ei pushia
currentAlerts.push({ alertHeaderText: "Linja 4 uusi häiriö", alertDescriptionText: "Ei seurattu", effectiveStartDate: 0, effectiveEndDate: 0 });
await runPushCheck(env);
check(pushSends.length === 1, "ei-seurattu linja 4 ei laukaise pushia");

// --- CMS-tiedotteet (lsl.fi WordPress) taustapushiin ---
const recentIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const cmsPost = (slug, title, body) => ({ date: recentIso, link: "https://www.lsl.fi/hairiotiedotteet/" + slug + "/", title: { rendered: title }, content: { rendered: body } });

// 5) CMS:n oma ensiajo seedaa nykyiset ilman pushia (ei tulvi käyttöönotossa)
currentCmsPosts = [cmsPost("poikkeus", "Poikkeusreitti keskustassa", "<p>Koskee linjoja 8(K) ja 12.</p>")];
const before5 = pushSends.length;
await runPushCheck(env);
check(pushSends.length === before5, "CMS: oma ensiajo seedaa ilman pushia");
check(!!env.PUSH_KV._m.get("seenCms:Lahti"), "CMS: seenCms:Lahti tallennettu ensiajossa");

// 6) Uusi CMS-tiedote seuratusta linjasta (8K) → tasan 1 push, url lsl.fi:hin
currentCmsPosts = [...currentCmsPosts, cmsPost("tapahtuma", "Tapahtuma vaikuttaa liikenteeseen", "<p>Linja 8(K) ajaa poikkeusreittiä.</p>")];
const before6 = pushSends.length;
await runPushCheck(env);
check(pushSends.length === before6 + 1, "CMS: uusi seuratun linjan tiedote → tasan 1 push");
check(pushSends[pushSends.length - 1].url.startsWith("https://push.example"), "CMS: push lähti tilaajan endpointtiin");

// 7) "Tilanne ohi" -CMS-tiedote ei laukaise pushia
currentCmsPosts = [...currentCmsPosts, cmsPost("ohi", "Tilanne ohi: linja 8(K) normaalisti", "<p>Linja 8(K) palasi reitille.</p>")];
const before7 = pushSends.length;
await runPushCheck(env);
check(pushSends.length === before7, "CMS: 'Tilanne ohi' -tiedote ei laukaise pushia");

// 8) Ei-seurattua linjaa koskeva CMS-tiedote → ei pushia
currentCmsPosts = [...currentCmsPosts, cmsPost("nelonen", "Linja 4 poikkeaa", "<p>Linja 4 ajaa poikkeusreittiä.</p>")];
const before8 = pushSends.length;
await runPushCheck(env);
check(pushSends.length === before8, "CMS: ei-seurattu linja 4 ei laukaise pushia");

// --- Lähtömuistutukset (runReminderCheck) ---
const before = pushSends.length;
await env.PUSH_KV.put("rem:past", JSON.stringify({ ...subscription, fireAt: 1000, title: "Lähtömuistutus", body: "Linja 3 lähtee pian", tag: "r1", url: "./" }));
await env.PUSH_KV.put("rem:future", JSON.stringify({ ...subscription, fireAt: 99999999999, title: "Myöhempi", body: "x", tag: "r2" }));
await runReminderCheck(env, 2000 * 1000); // nyt = 2000 s → past (1000) erääntynyt, future ei
check(pushSends.length === before + 1, "muistutus: erääntynyt lähetetään (tasan 1)");
check(!env.PUSH_KV._m.get("rem:past"), "muistutus: lähetetty poistetaan KV:stä");
check(!!env.PUSH_KV._m.get("rem:future"), "muistutus: tuleva jää odottamaan");

console.log(fail ? `\n${fail} TARKISTUS EPÄONNISTUI` : "\nKAIKKI TARKISTUKSET OK");
process.exit(fail ? 1 : 0);

// Yksikkötestaa cron-push-putken (runPushCheck) mock-KV:llä ja stub-fetchillä:
// oikea salaus + VAPID, mutta push-endpoint ja Digitransit ovat tynkiä.
// Aja: node push-logic.test.js
import { runPushCheck, runReminderCheck, alertAffects, lineTokensFromText } from "./worker.js";

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };

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

// --- Stub fetch: Digitransit-häiriöt + push-endpoint ---
let currentAlerts = [];
const pushSends = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("digitransit.fi/routing")) {
    return { json: async () => ({ data: { alerts: currentAlerts } }) };
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

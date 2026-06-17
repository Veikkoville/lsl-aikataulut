// Yksikkötestaa cron-push-putken (runPushCheck) mock-KV:llä ja stub-fetchillä:
// oikea salaus + VAPID, mutta push-endpoint ja Digitransit ovat tynkiä.
// Aja: node push-logic.test.js
import worker, { runPushCheck, runReminderCheck, alertAffects, lineTokensFromText, htmlToText, buildFeedbackRecord,
  constantTimeEqual, signSession, verifySession, buildAdminAlert, currentAdminAlerts, buildAdminFares, buildAdminA11y,
  buildTrackEvent, buildStatsSql } from "./worker.js";

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
// Odottavat muistutukset säilytetään yhdessä avaimessa (rem:pending) → cron ei tee list-operaatiota.
const before = pushSends.length;
await env.PUSH_KV.put("rem:pending", JSON.stringify({
  past: { ...subscription, fireAt: 1000, title: "Lähtömuistutus", body: "Linja 3 lähtee pian", tag: "r1", url: "./" },
  future: { ...subscription, fireAt: 99999999999, title: "Myöhempi", body: "x", tag: "r2" },
}));
await runReminderCheck(env, 2000 * 1000); // nyt = 2000 s → past (1000) erääntynyt, future ei
check(pushSends.length === before + 1, "muistutus: erääntynyt lähetetään (tasan 1)");
const remPending = JSON.parse(env.PUSH_KV._m.get("rem:pending") || "{}");
check(!remPending.past, "muistutus: lähetetty poistetaan rem:pending-avaimesta");
check(!!remPending.future, "muistutus: tuleva jää odottamaan");

// runReminderCheck ei saa kutsua list-operaatiota (KV:n ilmaiskiintiö on niukin listoissa)
let listCalls = 0;
const realList = env.PUSH_KV.list.bind(env.PUSH_KV);
env.PUSH_KV.list = async (...a) => { listCalls++; return realList(...a); };
await runReminderCheck(env, 2000 * 1000);
check(listCalls === 0, "muistutus: cron EI tee KV-list-operaatiota (vältetään ilmaiskiintiön ylitys)");
env.PUSH_KV.list = realList;

// --- Ylläpito: kirjautuminen (constantTimeEqual + HMAC-istunto) ---
check(constantTimeEqual("abc", "abc") && !constantTimeEqual("abc", "abd") && !constantTimeEqual("abc", "ab"), "constantTimeEqual: sama/eri/erimittainen");

const SECRET = "test-session-secret";
const sessTok = await signSession({ exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
check(!!(await verifySession(sessTok, SECRET)), "istunto: kelvollinen token hyväksytään");
check((await verifySession(sessTok, "vaara-secret")) === null, "istunto: väärällä avaimella allekirjoitus hylätään");
check((await verifySession(sessTok.slice(0, -3) + "AAA", SECRET)) === null, "istunto: peukaloitu allekirjoitus hylätään");
const expired = await signSession({ exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
check((await verifySession(expired, SECRET)) === null, "istunto: vanhentunut token hylätään");
check((await verifySession("", SECRET)) === null && (await verifySession("rikki", SECRET)) === null, "istunto: tyhjä/virheellinen token hylätään");

// --- Ylläpito: tiedotteen kokoaminen (buildAdminAlert) ---
check(buildAdminAlert({ title: "" }, 5).error === "bad_request", "adminAlert: tyhjä otsikko hylätään");
const aa = buildAdminAlert({ title: "Työmaa keskustassa", body: "Linjat poikkeavat", severity: "SEVERE", lines: ["3", " 8k ", "12"], startsAt: 1000, endsAt: 2000 }, 50).rec;
check(aa.title === "Työmaa keskustassa" && aa.severity === "SEVERE" && aa.updatedAt === 50, "adminAlert: kentät kootaan");
check(aa.lines.join(",") === "3,8K,12", "adminAlert: linjat siistitään isoiksi ja trimmataan");
check(buildAdminAlert({ title: "x", severity: "OUTO" }, 1).rec.severity === "WARNING", "adminAlert: tuntematon vakavuus → WARNING");
check(buildAdminAlert({ title: "a".repeat(500) }, 1).rec.title.length === 200, "adminAlert: otsikko katkaistaan 200 merkkiin");
check(buildAdminAlert({ title: "x", startsAt: "ei-numero" }, 1).rec.startsAt === null, "adminAlert: virheellinen alkuaika → null");

// --- Ylläpito: voimassaolon suodatus (currentAdminAlerts) ---
const now = 1500;
const list = [
  { id: "a", title: "voimassa", startsAt: 1000, endsAt: 2000 },
  { id: "b", title: "ei viela", startsAt: 1600, endsAt: 2000 },
  { id: "c", title: "paattynyt", startsAt: 1000, endsAt: 1400 },
  { id: "d", title: "toistaiseksi" },
];
const cur = currentAdminAlerts(list, now).map(a => a.id).join(",");
check(cur === "a,d", "currentAdminAlerts: vain voimassa olevat (alku/loppu huomioiden)");

// --- Ylläpito: reitit päästä päähän (worker.fetch + mock-KV) ---
const adminEnv = { ...env, ADMIN_PASSWORD: "salasana123", ADMIN_SESSION_SECRET: "integraatio-secret" };
const req = (path, opts = {}) => new Request("https://proxy.example" + path, opts);
const cookieFrom = res => { const c = res.headers.get("Set-Cookie") || ""; return c.split(";")[0]; };

// admin-sivu tarjoillaan
const pageRes = await worker.fetch(req("/admin"), adminEnv);
const pageHtml = await pageRes.text();
check(pageRes.status === 200 && /Ylläpito/.test(pageHtml), "admin: /admin palauttaa HTML-sivun");

// ilman evästettä API on suojattu
const noAuth = await worker.fetch(req("/admin/api/alerts?city=lahti"), adminEnv);
check(noAuth.status === 403, "admin: ilman istuntoa /admin/api/alerts → 403");

// väärä salasana → 401
const badLogin = await worker.fetch(req("/admin/login", { method: "POST", body: JSON.stringify({ password: "vaara" }) }), adminEnv);
check(badLogin.status === 401, "admin: väärä salasana → 401");

// oikea salasana → 200 + eväste
const okLogin = await worker.fetch(req("/admin/login", { method: "POST", body: JSON.stringify({ password: "salasana123" }) }), adminEnv);
const cookie = cookieFrom(okLogin);
check(okLogin.status === 200 && /^admin_session=/.test(cookie), "admin: oikea salasana → 200 + istuntoeväste");

// istuntotarkistus evästeellä
const sess = await (await worker.fetch(req("/admin/api/session", { headers: { Cookie: cookie } }), adminEnv)).json();
check(sess.authed === true, "admin: /admin/api/session tunnistaa istunnon");

// julkaisu evästeellä
const saveRes = await worker.fetch(req("/admin/api/alerts", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ city: "lahti", title: "Hissi epäkunnossa", body: "Matkakeskus", severity: "WARNING" }) }), adminEnv);
const saved = await saveRes.json();
check(saveRes.status === 200 && saved.items.length === 1 && saved.items[0].id, "admin: tiedote julkaistaan (id syntyy)");

// julkaistu näkyy julkisessa /published-päätepisteessä
const pub = await (await worker.fetch(req("/published?city=lahti"), adminEnv)).json();
check(pub.alerts.length === 1 && pub.alerts[0].title === "Hissi epäkunnossa", "admin: julkaistu tiedote näkyy /published-päätepisteessä");

// muokkaus säilyttää id:n
const editId = saved.items[0].id;
const editRes = await worker.fetch(req("/admin/api/alerts", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ city: "lahti", id: editId, title: "Hissi korjattu", severity: "INFO" }) }), adminEnv);
const edited = await editRes.json();
check(edited.items.length === 1 && edited.items[0].id === editId && edited.items[0].title === "Hissi korjattu", "admin: muokkaus säilyttää id:n (ei tuplaa)");

// poisto
const delRes = await worker.fetch(req("/admin/api/alerts/delete", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ city: "lahti", id: editId }) }), adminEnv);
const del = await delRes.json();
check(delRes.status === 200 && del.items.length === 0, "admin: poisto poistaa tiedotteen");

// peukaloitu eväste ei kelpaa
const tampered = await worker.fetch(req("/admin/api/alerts?city=lahti", { headers: { Cookie: "admin_session=rikki.token" } }), adminEnv);
check(tampered.status === 403, "admin: peukaloitu eväste → 403");

// --- Ylläpito: hintojen kokoaminen (buildAdminFares) ---
check(buildAdminFares(null).error === "bad_request", "fares: ei-objekti hylätään");
const fr = buildAdminFares({
  checked: "1.1.2027", url: "https://x",
  single: { cardApp: { adult: "3,00", child: "1,50", reduced: "2,10" }, contactless: "3,20", salespoint: { adult: "3,80" } },
  season: [{ d: "30", adult: "62", child: "31", reduced: "44" }, { d: "", adult: "x" }],
  day: [{ d: "1", adult: "10", child: "5" }],
  capDay: "10", capWeek: "30", cardFee: "5",
}).rec;
check(fr.single.cardApp.adult === "3,00" && fr.single.contactless === "3,20", "fares: kertaliput kootaan");
check(fr.single.salespoint.child === "" && fr.single.salespoint.reduced === "", "fares: puuttuvat kentät täytetään tyhjiksi (ei kaada sovellusta)");
check(fr.season.length === 1 && fr.season[0].d === "30", "fares: kausilippurivit ilman vrk-arvoa pudotetaan");
check(fr.day.length === 1 && fr.day[0].adult === "10", "fares: vuorokausilippurivit kootaan");

// --- Ylläpito: hinnat reittien läpi (tallenna → /published) ---
const faresSave = await worker.fetch(req("/admin/api/fares", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ city: "lahti", checked: "1.1.2027", single: { cardApp: { adult: "9,99" } }, season: [{ d: "30", adult: "62" }], day: [] }) }), adminEnv);
check(faresSave.status === 200, "admin: hinnat tallennetaan (200)");
const pubFares = await (await worker.fetch(req("/published?city=lahti"), adminEnv)).json();
check(pubFares.fares && pubFares.fares.single.cardApp.adult === "9,99", "admin: julkaistut hinnat näkyvät /published-päätepisteessä");
const faresNoAuth = await worker.fetch(req("/admin/api/fares", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), adminEnv);
check(faresNoAuth.status === 403, "admin: hintojen tallennus ilman istuntoa → 403");

// --- Ylläpito: saavutettavuusseloste (buildAdminA11y) ---
check(buildAdminA11y(null).error === "bad_request", "a11y: ei-objekti hylätään");
const a11 = buildAdminA11y({ orgName: "Lahden kaupunki", date: "17.6.2026", status: "partial",
  feedbackEmail: "saavutettavuus@lahti.fi", deficiencies: ["Kartat visuaalisia", "", "  ", "Häiriötekstit"] }).rec;
check(a11.orgName === "Lahden kaupunki" && a11.status === "partial", "a11y: kentät kootaan");
check(a11.deficiencies.length === 2, "a11y: tyhjät puuterivit pudotetaan");
check(buildAdminA11y({ orgName: "x", status: "OUTO" }).rec.status === "partial", "a11y: tuntematon status → partial");

// reittien läpi: tallenna → /published
const a11ySave = await worker.fetch(req("/admin/api/a11y", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify({ city: "lahti", orgName: "Lahden kaupunki", status: "full", feedbackEmail: "a@lahti.fi" }) }), adminEnv);
check(a11ySave.status === 200, "admin: seloste tallennetaan (200)");
const pubA11y = await (await worker.fetch(req("/published?city=lahti"), adminEnv)).json();
check(pubA11y.a11y && pubA11y.a11y.orgName === "Lahden kaupunki", "admin: julkaistu seloste näkyy /published-päätepisteessä");
const a11yNoAuth = await worker.fetch(req("/admin/api/a11y", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), adminEnv);
check(a11yNoAuth.status === 403, "admin: selosteen tallennus ilman istuntoa → 403");

// --- Käyttöanalytiikka: tapahtuman validointi (buildTrackEvent) ---
check(buildTrackEvent({ type: "outo", value: "x" }) === null, "track: tuntematon tyyppi → null");
const tev = buildTrackEvent({ type: "line", value: "3", city: "Lahti!" });
check(tev.type === "line" && tev.value === "3" && tev.city === "lahti", "track: tyyppi/arvo/kaupunki siistitään");
check(buildTrackEvent({ type: "search_fail", value: "a".repeat(200) }).value.length === 80, "track: arvo katkaistaan 80 merkkiin");
check(buildStatsSql("lahti", "lsl_events", 30).includes("FROM lsl_events") && buildStatsSql("la'hti", "ds", 30).includes("blob3 = 'lahti'"), "statsSql: dataset + kaupunki siivottu (ei injektiota)");

// --- Käyttöanalytiikka: /track kirjoittaa Analytics Engineen (mock) ---
adminEnv.AE = { _p: [], writeDataPoint(p) { this._p.push(p); } };
const trk = await worker.fetch(req("/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "view", value: "linja", city: "lahti" }) }), adminEnv);
check(trk.status === 204 && adminEnv.AE._p.length === 1 && adminEnv.AE._p[0].blobs[0] === "view", "track: /track kirjaa tapahtuman AE:hen (204)");
const trkBad = await worker.fetch(req("/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "outo" }) }), adminEnv);
check(trkBad.status === 204 && adminEnv.AE._p.length === 1, "track: tuntematon tyyppi ei kirjaa mitään (silti 204)");

// --- Käyttöanalytiikka: dashboard ilman lukutokenia → "unconfigured", ilman istuntoa → 403 ---
const statsUnconf = await (await worker.fetch(req("/admin/api/stats?city=lahti", { headers: { Cookie: cookie } }), adminEnv)).json();
check(statsUnconf.error === "unconfigured", "stats: ilman CF-tokenia → unconfigured (ei kaada)");
const statsNoAuth = await worker.fetch(req("/admin/api/stats?city=lahti"), adminEnv);
check(statsNoAuth.status === 403, "stats: ilman istuntoa → 403");

console.log(fail ? `\n${fail} TARKISTUS EPÄONNISTUI` : "\nKAIKKI TARKISTUKSET OK");
process.exit(fail ? 1 : 0);

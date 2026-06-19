// Yksikkötestaa sähköpostipohjaisen häiriötilauksen: subscribe/confirm/unsubscribe
// (worker.fetch + mock-KV) ja että cron-lähetys (runPushCheck) menee VAIN vahvistetuille
// JA vain oikean linjan tilaajille. Resend ja Digitransit ovat tynkiä (stub-fetch).
// Aja: node email-logic.test.js
import worker, { runPushCheck, buildEmailSubscription, buildConfirmEmail, buildAlertEmail } from "./worker.js";

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };

// --- buildEmailSubscription (validointi + normalisointi) ---
check(buildEmailSubscription({ email: "ei-email", lines: ["3"] }, 1).error === "bad_email", "validointi: virheellinen sähköposti hylätään");
check(buildEmailSubscription({ email: "a@b.fi", lines: [], gtfsRoutes: [] }, 1).error === "no_lines", "validointi: ilman linjoja hylätään");
const sub1 = buildEmailSubscription({ email: "  Anna@Example.FI ", lines: ["3", "3a"], gtfsRoutes: ["Lahti:3"], city: "Lahti", feed: "Lahti", lang: "sv" }, 7).rec;
check(sub1 && sub1.email === "anna@example.fi" && sub1.city === "lahti" && sub1.confirmed === false && sub1.lang === "sv", "validointi: email trimmataan/pienennetään, city normalisoidaan, confirmed=false");
check(sub1.lines.join(",") === "3,3A", "validointi: linjat isoiksi kirjaimiksi");

// --- buildConfirmEmail / buildAlertEmail (pure) ---
const cmail = buildConfirmEmail({ lines: ["3", "9"] }, "https://w/email/confirm?token=T", "https://w/email/unsubscribe?token=T");
check(/Vahvista/.test(cmail.subject) && cmail.html.includes("/email/confirm?token=T") && cmail.html.includes("/email/unsubscribe?token=T"), "vahvistusviesti: sisältää confirm- ja unsubscribe-linkit");
const amail = buildAlertEmail({ alertHeaderText: "Linja 3 ei kulje", alertDescriptionText: "Aleksanterinkatu suljettu 20.6." }, { email: "a@b.fi" }, "https://app/?city=lahti", "https://w/email/unsubscribe?token=T");
check(/1\. Mitä/.test(amail.html) && /2\. Milloin ja missä/.test(amail.html) && /3\. Tee näin/.test(amail.html), "häiriöviesti: 3-kenttäinen rakenne");
check(amail.html.includes("/email/unsubscribe?token=T") && amail.html.includes("https://app/?city=lahti"), "häiriöviesti: peruutuslinkki + palvelulinkki");

// --- Mock-KV ---
function mockKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix } = {}) {
      const keys = [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
  };
}

// --- Stub fetch: Digitransit-häiriöt + lsl.fi CMS + Resend (sähköpostit talteen) ---
let currentAlerts = [];
const resendSends = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("digitransit.fi/routing")) return { json: async () => ({ data: { alerts: currentAlerts } }) };
  if (u.includes("/wp-json/")) return { ok: true, json: async () => [] };
  if (u.includes("api.resend.com")) { resendSends.push(JSON.parse(opts.body)); return { status: 200, ok: true }; }
  throw new Error("odottamaton fetch: " + u);
};

// env: TARKOITUKSELLA ilman VAPIDia → todistaa että sähköposti toimii ilman web-pushia
const env = {
  PUSH_KV: mockKV(),
  DIGITRANSIT_KEY: "test",
  RESEND_API_KEY: "test-resend",
  EMAIL_FROM: "hairiotiedote@aikataulut.selkoturva.fi",
  EMAIL_LINK_BASE: "https://worker.test",
  APP_BASE: "https://app.test/lsl",
};

const req = (path, init) => new Request("https://worker.test" + path, init);
const post = (path, obj) => req(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://veikkoville.github.io" }, body: JSON.stringify(obj) });
const tokenOf = email => {
  // löydä tokenin osoitin (email:tok:<token> → "<city>:<hash>") tälle sähköpostille ei suoraan;
  // testissä yksi tilaaja kerrallaan → otetaan tuorein tok-avain. Tarkempi: skannaa idx/rec.
  const ks = [...env.PUSH_KV._m.keys()].filter(k => k.startsWith("email:tok:"));
  return ks.length ? ks[ks.length - 1].slice("email:tok:".length) : null;
};

// 1) Subscribe (Anna, linja 3) → tietue tallennettu vahvistamattomana + vahvistusviesti
let r = await worker.fetch(post("/email/subscribe", { email: "anna@example.fi", lines: ["3"], gtfsRoutes: ["Lahti:3"], feed: "Lahti", city: "lahti", lang: "fi" }), env);
let body = await r.json();
check(r.status === 200 && body.ok, "subscribe: 200 ok");
check(resendSends.length === 1 && /Vahvista/.test(resendSends[0].subject) && resendSends[0].to[0] === "anna@example.fi", "subscribe: vahvistusviesti lähetetään tilaajalle");
const recAnnaRaw = [...env.PUSH_KV._m.entries()].find(([k]) => /^email:lahti:/.test(k))[1];
check(JSON.parse(recAnnaRaw).confirmed === false, "subscribe: tietue tallennetaan vahvistamattomana");
const tokenAnna = tokenOf("anna@example.fi");

// 2) Cron ENNEN vahvistusta → ei sähköpostia (vahvistamaton ei ole indeksissä)
currentAlerts = [{ alertHeaderText: "Linja 3 ei kulje", alertDescriptionText: "Työmaa", effectiveStartDate: 0, effectiveEndDate: 0 }];
const before2 = resendSends.length;
await runPushCheck(env); // reg tyhjä vielä → ei edes feediä; varmistus:
check(resendSends.length === before2, "cron: vahvistamaton tilaaja ei saa häiriöviestiä");

// 3) Confirm → confirmed:true + lisätään indeksiin + rekisteriin
r = await worker.fetch(req("/email/confirm?token=" + tokenAnna, { method: "GET" }), env);
const confHtml = await r.text();
check(r.status === 200 && /vahvistettu/i.test(confHtml), "confirm: palauttaa 'Tilaus vahvistettu' -sivun");
check(!!env.PUSH_KV._m.get("email:idx:lahti") && !!env.PUSH_KV._m.get("email:reg"), "confirm: indeksi + rekisteri luotu");
check(JSON.parse(env.PUSH_KV._m.get("email:reg")).lahti === "Lahti", "confirm: rekisteri lahti→Lahti (cron tietää feedin)");

// 4) Lisätään Carl (linja 9) vahvistettuna + Bea (linja 3) vahvistamattomana
await worker.fetch(post("/email/subscribe", { email: "carl@example.fi", lines: ["9"], gtfsRoutes: ["Lahti:9"], feed: "Lahti", city: "lahti" }), env);
const tokenCarl = tokenOf("carl@example.fi");
await worker.fetch(req("/email/confirm?token=" + tokenCarl, { method: "GET" }), env);
await worker.fetch(post("/email/subscribe", { email: "bea@example.fi", lines: ["3"], gtfsRoutes: ["Lahti:3"], feed: "Lahti", city: "lahti" }), env); // EI vahvisteta

// 5) Cron-ensiajo seedaa nykyiset häiriöt ilman lähetystä (ei tulvi)
const before5 = resendSends.length;
await runPushCheck(env);
check(resendSends.length === before5, "cron: ensiajo seedaa nykyiset häiriöt ilman lähetystä");
check(!!env.PUSH_KV._m.get("seen:Lahti"), "cron: seen:Lahti tallennettu ensiajossa");

// 6) UUSI linjan 3 häiriö → sähköposti VAIN Annalle (vahvistettu + linja 3)
currentAlerts = [...currentAlerts, { alertHeaderText: "Linja 3 poikkeusreitti", alertDescriptionText: "Aleksanterinkatu suljettu", effectiveStartDate: 0, effectiveEndDate: 0 }];
const before6 = resendSends.length;
await runPushCheck(env);
const sent6 = resendSends.slice(before6);
check(sent6.length === 1 && sent6[0].to[0] === "anna@example.fi", "cron: uusi linjan 3 häiriö → tasan 1 sähköposti Annalle");
check(!sent6.some(m => m.to[0] === "carl@example.fi"), "cron: väärän linjan (9) tilaaja Carl EI saa viestiä");
check(!sent6.some(m => m.to[0] === "bea@example.fi"), "cron: vahvistamaton Bea EI saa viestiä");
check(/3\. Tee näin/.test(sent6[0].html) && sent6[0].html.includes("/email/unsubscribe?token="), "cron: viesti 3-kenttäinen + peruutuslinkki");

// 7) Sama tila uudelleen → ei uusintaviestiä
const before7 = resendSends.length;
await runPushCheck(env);
check(resendSends.length === before7, "cron: jo nähdystä häiriöstä ei uusintaviestiä");

// 8) Unsubscribe (Anna) → poistuu indeksistä; uusi linjan 3 häiriö ei enää mene Annalle
r = await worker.fetch(req("/email/unsubscribe?token=" + tokenAnna, { method: "GET" }), env);
check(r.status === 200 && /peruttu/i.test(await r.text()), "unsubscribe: palauttaa 'Tilaus peruttu' -sivun");
const idxAfter = JSON.parse(env.PUSH_KV._m.get("email:idx:lahti") || "{}");
check(!Object.values(idxAfter).some(e => e.email === "anna@example.fi") && Object.values(idxAfter).some(e => e.email === "carl@example.fi"), "unsubscribe: Anna poistui indeksistä, Carl jäi");
currentAlerts = [...currentAlerts, { alertHeaderText: "Linja 3 taas poikki", alertDescriptionText: "x", effectiveStartDate: 0, effectiveEndDate: 0 }];
const before8 = resendSends.length;
await runPushCheck(env);
check(!resendSends.slice(before8).some(m => m.to[0] === "anna@example.fi"), "unsubscribe: peruutuksen jälkeen Anna ei saa viestiä");

console.log(fail === 0 ? "\nKAIKKI OK" : `\n${fail} TARKISTUSTA EPÄONNISTUI`);
if (fail) process.exit(1);

// Savikurki-työtila (3.10.2026): Reittari välitetään kunnan osoitteeseen <kunta>.savikurki.fi/tyotila/reittari/.
// (1) Työtilan Origin kelpaa CORSiin ja kiintiöporttiin, muut eivät.
// (2) Ylläpito hyväksyy työtilan allekirjoittaman identiteettiotsakkeen salasanan ja Accessin rinnalla: vain rooli
//     Reittari.Yllapito, vain moduuli reittari ja vain otsakkeen tuotekunta. Salasana toimii ennallaan.
// Ei verkkoa: KV on muistissa. Aja: node tyotila.test.js
import * as W from "./worker.js";
import { allekirjoitaIdentiteetti, IDENTITEETTI_OTSAKE } from "./savikurki-identiteetti.js";

const worker = W.default;
let fail = 0, total = 0;
const check = (cond, msg) => { total++; console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };

function memKV() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix } = {}) { return { keys: [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
  };
}

const AVAIN = "identiteettiavain-reittari-testi-0123456789";
const nyt = () => Math.floor(Date.now() / 1000);
const otsake = (o = {}, avain = AVAIN) => allekirjoitaIdentiteetti({
  kunta: "demo", tuotekunta: "lahti", moduuli: "reittari", roolit: ["Reittari.Yllapito"], kayttaja: "k1", nyt: nyt(), ...o,
}, avain);
const env = () => ({ IDENTITEETTI_AVAIN: AVAIN, ADMIN_PASSWORD: "paasalasana-testi-123", ADMIN_SESSION_SECRET: "istunto-testi-0123456789",
  ADMIN_CITY_PASSWORDS: JSON.stringify({ toinenkunta: "toisen-kunnan-tunnus-1" }), PUSH_KV: memKV() });
const pyynto = (polku, { method = "GET", id, body, origin } = {}) => {
  const h = new Headers();
  if (id) h.set(IDENTITEETTI_OTSAKE, id);
  if (origin) h.set("Origin", origin);
  if (body) h.set("Content-Type", "application/json");
  return new Request("https://yllapito.reittari.fi" + polku, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
};
const aja = async (req, e) => worker.fetch(req, e, { waitUntil() {} });

// --- (1) Origin
check(W.isAllowedOrigin("https://demo.savikurki.fi"), "demo.savikurki.fi kelpaa");
check(W.isAllowedOrigin("https://lahti.savikurki.fi"), "lahti.savikurki.fi kelpaa");
check(W.isAllowedOrigin("https://demo.reittari.fi"), "vanha sallintalista ennallaan");
check(!W.isAllowedOrigin("https://savikurki.fi"), "juuriosoite ei kelpaa (ei työtilaa)");
check(!W.isAllowedOrigin("http://demo.savikurki.fi"), "http ei kelpaa");
check(!W.isAllowedOrigin("https://demo.savikurki.fi.evil.example"), "jatkettu verkkotunnus ei kelpaa");
check(!W.isAllowedOrigin("https://a.b.savikurki.fi"), "syvempi alidomain ei kelpaa");
check(!W.isAllowedOrigin("https://evilsavikurki.fi"), "samankaltainen verkkotunnus ei kelpaa");
check(!W.isAllowedOrigin(""), "puuttuva Origin ei kelpaa");
const opt = await aja(new Request("https://lsl-aikataulut-proxy.example/", { method: "OPTIONS", headers: { Origin: "https://lahti.savikurki.fi" } }), {});
check(opt.headers.get("Access-Control-Allow-Origin") === "https://lahti.savikurki.fi", "CORS palauttaa työtilan Originin");
check(W.mmlRefererAllowed("https://demo.savikurki.fi/tyotila/reittari/?city=lahti"), "MML-tiilet: työtilan Referer kelpaa");

// --- (2) Identiteetti
const e1 = env();
check(await W.tyotilaScope(pyynto("/admin/api/session?city=lahti", { id: await otsake() }), e1) === "lahti", "Ylläpito-rooli: rajaus otsakkeen tuotekuntaan");
check(await W.tyotilaScope(pyynto("/", { id: await otsake({ roolit: ["Reittari.Asiakaspalvelu"] }) }), e1) === null, "Asiakaspalvelu-rooli ei anna ylläpitoa");
check(await W.tyotilaScope(pyynto("/", { id: await otsake({ moduuli: "luvat" }) }), e1) === null, "toisen moduulin otsake hylätään");
check(await W.tyotilaScope(pyynto("/", { id: await otsake({}, "vaara-avain-0123456789-0123456789-xx") }), e1) === null, "väärällä avaimella allekirjoitettu hylätään");
check(await W.tyotilaScope(pyynto("/", { id: await otsake({ nyt: nyt() - 600 }) }), e1) === null, "vanhentunut otsake hylätään");
check(await W.tyotilaScope(pyynto("/", { id: await otsake() }), { ...e1, IDENTITEETTI_AVAIN: "" }) === null, "ilman avainta otsaketta ei hyväksytä");
check(await W.tyotilaScope(pyynto("/"), e1) === null, "ilman otsaketta ei työtilan rajausta");
const id = await otsake();
const peukaloitu = id.split(".");
peukaloitu[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(peukaloitu[1], "base64url")), tuotekunta: "toinenkunta" })).toString("base64url");
check(await W.tyotilaScope(pyynto("/", { id: peukaloitu.join(".") }), e1) === null, "muutettu tuotekunta hylätään");

const s1 = await (await aja(pyynto("/admin/api/session?city=lahti", { id: await otsake() }), e1)).json();
check(s1.authed === true && s1.tyotila === true, "istunto: työtilasta kirjautunut ilman salasanaa");
const s2 = await (await aja(pyynto("/admin/api/session?city=toinenkunta", { id: await otsake() }), e1)).json();
check(s2.authed === false && s2.tyotila === false, "istunto: toisen kunnan ylläpito ei aukea");
const s3 = await (await aja(pyynto("/admin/api/session?city=lahti"), e1)).json();
check(s3.authed === false && s3.tyotila === false, "istunto: ilman otsaketta ja salasanaa ei kirjautunut");

const tallenna = async (city, idArvo) => aja(pyynto("/admin/api/alerts", { method: "POST", id: idArvo, body: { city, title: "Testitiedote" } }), e1);
check((await tallenna("lahti", await otsake())).status === 200, "tiedotteen tallennus omaan kuntaan onnistuu");
check((await tallenna("toinenkunta", await otsake())).status === 403, "tiedotteen tallennus toiseen kuntaan estetään");
check((await tallenna("lahti", await otsake({ roolit: ["Reittari.Asiakaspalvelu"] }))).status === 403, "asiakaspalvelu ei voi tallentaa");
const lista = await (await aja(pyynto("/admin/api/alerts?city=lahti", { id: await otsake() }), e1)).json();
check(Array.isArray(lista.items) && lista.items.some(a => a.title === "Testitiedote"), "tallennettu tiedote luetaan takaisin");

// Salasana toimii rinnalla (kunnan oma tunnus ja pääsalasana).
const login = await aja(pyynto("/admin/login", { method: "POST", body: { password: "toisen-kunnan-tunnus-1", city: "toinenkunta" } }), e1);
check(login.status === 200 && /admin_session=/.test(login.headers.get("Set-Cookie") || ""), "kunnan oma tunnus (ADMIN_CITY_PASSWORDS) kirjautuu ennallaan");
const evaste = (login.headers.get("Set-Cookie") || "").split(";")[0];
const toinen = await (await aja(new Request("https://yllapito.reittari.fi/admin/api/session?city=toinenkunta", { headers: { Cookie: evaste } }), e1)).json();
check(toinen.authed === true && toinen.tyotila === false, "salasanaistunto: kirjautunut, ei työtilaa");

console.log(fail ? `${fail}/${total} FAIL` : `kaikki OK (${total})`);
process.exit(fail ? 1 : 0);

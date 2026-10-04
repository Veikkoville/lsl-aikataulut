// Tietopankki (D6, 4.10.2026): kunnan omat vastauskortit palvelutiskille.
// (1) Kortin validointi: suomi pakollinen, kokorajat, käännöksen otsikko, lähde vain http(s), tarkistettu-päivä.
// (2) Ylläpidon CRUD samalla tunnistautumisella kuin häiriötiedotteet: oma kunta kyllä, toinen kunta ei,
//     asiakaspalvelu-rooli ei, ilman tunnusta ei. Kokoraja, korttiraja ja nopeusraja. KV-kirjoitus vain muutoksesta.
// (3) Julkinen luku /kb: Origin-sallintalista, kunnat erillään, ei muokkausaikaa. /published kertoo kb-tuen.
// Ei verkkoa: KV on muistissa ja laskee kirjoitukset. Aja: node kb.test.js
// Nimiavaruustuonti tarkoituksella: vanhaa workeria vasten (kontrolli) tarkistukset kaatuvat FAIL-riveinä eivätkä tuontivirheeseen.
import * as W from "./worker.js";
import { allekirjoitaIdentiteetti, IDENTITEETTI_OTSAKE } from "./savikurki-identiteetti.js";

const worker = W.default;
let fail = 0, total = 0;
const check = (cond, msg) => { total++; console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };
const fn = name => typeof W[name] === "function";
const reset = () => { if (fn("resetIsolateLimits")) W.resetIsolateLimits(); };

function countingKV() {
  const m = new Map();
  const kv = {
    _m: m, puts: 0,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { kv.puts++; m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix } = {}) { return { keys: [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
  };
  return kv;
}

const AVAIN = "identiteettiavain-reittari-testi-0123456789";
const nyt = () => Math.floor(Date.now() / 1000);
const otsake = (o = {}) => allekirjoitaIdentiteetti({
  kunta: "demo", tuotekunta: "lahti", moduuli: "reittari", roolit: ["Reittari.Yllapito"], kayttaja: "k1", nyt: nyt(), ...o,
}, AVAIN);
const makeEnv = () => ({ IDENTITEETTI_AVAIN: AVAIN, ADMIN_PASSWORD: "paasalasana-testi-123", ADMIN_SESSION_SECRET: "istunto-testi-0123456789",
  ADMIN_CITY_PASSWORDS: JSON.stringify({ kuopio: "kuopion-oma-tunnus-1" }), PUSH_KV: countingKV() });
const ADMIN = "https://yllapito.reittari.fi";
const req = (polku, { method = "GET", id, body, raw, origin, cookie, ip } = {}) => {
  const h = new Headers();
  if (id) h.set(IDENTITEETTI_OTSAKE, id);
  if (origin) h.set("Origin", origin);
  if (cookie) h.set("Cookie", cookie);
  h.set("CF-Connecting-IP", ip || "203.0.113.5");
  if (body || raw) h.set("Content-Type", "application/json");
  return new Request((polku.startsWith("http") ? "" : ADMIN) + polku, { method, headers: h, body: raw != null ? raw : body ? JSON.stringify(body) : undefined });
};
const run = (r, e) => worker.fetch(r, e, { waitUntil() {} });
const json = async res => { try { return await res.json(); } catch (e) { return {}; } };
// Lista vastauksesta tai tyhjä: vanhaa workeria vasten (kontrolli) tarkistus kaatuu FAIL-riviksi eikä poikkeukseen.
const I = d => (d && Array.isArray(d.items) ? d.items : []);
const card = (o = {}) => ({ city: "lahti", title: "Löytötavarat", body: "Bussiin unohtuneet tavarat toimitetaan palvelupisteeseen.",
  keywords: "löytötavara, unohtunut, kadonnut", url: "https://www.lsl.fi/asiakaspalvelu/", ...o });

/* ===== (1) Validointi ===== */
check(fn("buildKbCard"), "buildKbCard on olemassa");
if (fn("buildKbCard")) {
  const B = (b, today = "2026-10-04") => W.buildKbCard(b, 1000, today);
  const r = B(card({ checked: "", order: "5" }));
  check(r.rec && r.rec.title === "Löytötavarat" && r.rec.checked === "2026-10-04" && r.rec.order === 5,
    "kelvollinen kortti: tarkistettu-päivä oletuksena tänään, järjestys numerona");
  check(JSON.stringify(r.rec.keywords) === JSON.stringify(["löytötavara", "unohtunut", "kadonnut"]), "avainsanat pilkuin eroteltuna listaksi");
  check(B(card({ title: "" })).error === "bad_request", "suomenkielinen otsikko pakollinen");
  check(B(card({ body: "  " })).error === "bad_request", "suomenkielinen teksti pakollinen");
  check(B(card({ body: "x".repeat(2001) })).error === "too_long", "teksti yli 2000 merkkiä hylätään (ei katkaista)");
  check(!!B(card({ body: "x".repeat(2000) })).rec, "teksti tasan 2000 merkkiä kelpaa");
  check(B(card({ title: "x".repeat(201) })).error === "too_long", "otsikko yli 200 merkkiä hylätään");
  check(B(card({ bodySv: "Text på svenska" })).error === "translation_title", "ruotsinkielinen teksti ilman otsikkoa hylätään");
  check(B(card({ bodyEn: "x".repeat(2001), titleEn: "Lost" })).error === "too_long", "englanninkielisen tekstin kokoraja");
  const sv = B(card({ titleSv: "Hittegods", bodySv: "Glömda saker lämnas till servicepunkten." })).rec;
  check(sv && sv.titleSv === "Hittegods" && sv.titleEn === "" && sv.bodyEn === "", "ruotsi valinnainen, englanti tyhjä");
  check(B(card({ url: "javascript:alert(1)" })).error === "bad_url", "javascript:-lähde hylätään");
  check(B(card({ url: "ftp://lsl.fi/x" })).error === "bad_url", "ftp-lähde hylätään");
  check(B(card({ url: "https://lsl.fi/a b" })).error === "bad_url", "välilyönnillinen osoite hylätään");
  check(!!B(card({ url: "http://lsl.fi/x" })).rec && !!B(card({ url: "" })).rec, "http(s) ja tyhjä lähde kelpaavat");
  check(B(card({ checked: "2026-02-30" })).error === "bad_date", "olematon päivä hylätään");
  check(B(card({ checked: "2026-10-05" })).error === "bad_date", "tuleva tarkistuspäivä hylätään");
  check(B(card({ checked: "2026-03-01" })).rec.checked === "2026-03-01", "mennyt tarkistuspäivä säilyy");
  const kw = B(card({ keywords: Array.from({ length: 30 }, (_, i) => "sana" + i + "x".repeat(50)) })).rec.keywords;
  check(kw.length === 20 && kw.every(k => k.length <= 40), "avainsanoja enintään 20, kukin enintään 40 merkkiä");
  check(B(card({ order: "-5" })).rec.order === 0 && B(card({ order: 123456 })).rec.order === 9999, "järjestys rajataan 0-9999");
}
check(fn("kbToday") && /^\d{4}-\d{2}-\d{2}$/.test(W.kbToday()) && W.kbToday(Date.UTC(2026, 9, 3, 22, 30)) === "2026-10-04",
  "tänään Suomen ajassa (UTC 22.30 = seuraava päivä)");

/* ===== (2) Ylläpidon CRUD ja oikeudet ===== */
reset();
const env = makeEnv();
const kv = env.PUSH_KV;
const save = async (b, o = {}) => run(req("/admin/api/kb", { method: "POST", body: b, id: o.id === undefined ? await otsake() : o.id, cookie: o.cookie, ip: o.ip }), env);

let res = await save(card());
let d = await json(res);
check(res.status === 200 && d.ok && Array.isArray(d.items) && I(d).length === 1 && I(d)[0].id, "ylläpito-rooli tallentaa oman kunnan kortin");
const id1 = d.items && I(d)[0] && I(d)[0].id;
check(!!kv._m.get("admin:kb:lahti"), "kortti tallentuu avaimella admin:kb:lahti");

res = await save(card({ city: "kuopio" }));
check(res.status === 403 && !kv._m.has("admin:kb:kuopio"), "toisen kunnan tietopankkiin ei voi kirjoittaa (403, ei KV-avainta)");
res = await save(card(), { id: await otsake({ roolit: ["Reittari.Asiakaspalvelu"] }) });
check(res.status === 403, "asiakaspalvelu-rooli ei tallenna");
res = await save(card(), { id: null });
check(res.status === 403, "ilman tunnistautumista ei tallenneta");

const asp = await otsake({ roolit: ["Reittari.Asiakaspalvelu"] });
const putsBefore = kv.puts;
res = await run(req("/admin/api/kb/delete", { method: "POST", body: { city: "lahti", id: id1 }, id: asp }), env);
const res2 = await run(req("/admin/api/kb/checked", { method: "POST", body: { city: "lahti", id: id1 }, id: asp }), env);
const res3 = await run(req("/admin/api/kb?city=lahti", { id: asp }), env);
check(res.status === 403 && res2.status === 403 && res3.status === 403 && kv.puts === putsBefore,
  "asiakaspalvelu-rooli ei poista, merkitse eikä lue ylläpidon listaa");

// Kunnan oma salasanatunnus: oma kunta kyllä, Lahti ei.
const login = await run(req("/admin/login", { method: "POST", body: { password: "kuopion-oma-tunnus-1", city: "kuopio" } }), env);
const cookie = (login.headers.get("Set-Cookie") || "").split(";")[0];
check(login.status === 200 && /admin_session=/.test(cookie), "kunnan oma tunnus kirjautuu");
res = await save(card({ city: "kuopio", title: "Kuopion kortti" }), { id: null, cookie });
check(res.status === 200, "kunnan oma tunnus tallentaa oman kunnan korttiin");
res = await save(card({ title: "Kuopion yritys Lahteen" }), { id: null, cookie });
check(res.status === 403, "kunnan oma tunnus ei kirjoita toisen kunnan tietopankkiin");

// Muokkaus samalla id:llä ei monista korttia.
res = await save(card({ id: id1, title: "Löytötavarat ja kadonneet", order: 3 }));
d = await json(res);
check(res.status === 200 && I(d).length === 1 && I(d)[0].title === "Löytötavarat ja kadonneet" && I(d)[0].order === 3,
  "muokkaus päivittää kortin eikä luo uutta");
res = await save(card({ title: "Kortin lataus", order: 1 }));
d = await json(res);
check(I(d).map(c => c.title).join("|") === "Kortin lataus|Löytötavarat ja kadonneet", "lista järjestyy järjestysnumeron mukaan");
const id2 = d.id;

// Validointivirhe näkyy ylläpidolle eikä kirjoita.
let p0 = kv.puts;
res = await save(card({ url: "javascript:alert(1)" }));
check(res.status === 400 && (await json(res)).error === "bad_url" && kv.puts === p0, "virheellinen lähde: 400 bad_url, ei kirjoitusta");

// Tarkistettu tänään: ensimmäinen kirjoittaa, toinen ei.
const old = JSON.parse(kv._m.get("admin:kb:lahti") || "[]");
old.forEach(c => { c.checked = "2025-01-15"; });
kv._m.set("admin:kb:lahti", JSON.stringify(old));
p0 = kv.puts;
res = await run(req("/admin/api/kb/checked", { method: "POST", body: { city: "lahti", id: id2 }, id: await otsake() }), env);
d = await json(res);
const today = fn("kbToday") ? W.kbToday() : "";
check(res.status === 200 && (I(d).find(c => c.id === id2) || {}).checked === today && (I(d).find(c => c.id === id1) || {}).checked === "2025-01-15" && kv.puts === p0 + 1,
  "merkitse tarkistetuksi: vain valittu kortti saa tämän päivän (1 kirjoitus)");
res = await run(req("/admin/api/kb/checked", { method: "POST", body: { city: "lahti", id: id2 }, id: await otsake() }), env);
check(res.status === 200 && kv.puts === p0 + 1, "jo tänään tarkistettu ei kirjoita uudelleen");
res = await run(req("/admin/api/kb/checked", { method: "POST", body: { city: "lahti", id: "olematon" }, id: await otsake() }), env);
check(res.status === 404, "tuntematon kortti: 404");

// Poisto: tuntematon id ei kirjoita, oikea poistaa.
p0 = kv.puts;
res = await run(req("/admin/api/kb/delete", { method: "POST", body: { city: "lahti", id: "olematon" }, id: await otsake() }), env);
check(res.status === 200 && kv.puts === p0, "tuntemattoman kortin poisto ei kirjoita KV:hen");
res = await run(req("/admin/api/kb/delete", { method: "POST", body: { city: "lahti", id: id2 }, id: await otsake() }), env);
d = await json(res);
check(res.status === 200 && I(d).length === 1 && I(d)[0].id === id1 && kv.puts === p0 + 1, "poisto poistaa vain valitun kortin");

// Kokoraja ennen jäsennystä.
p0 = kv.puts;
res = await run(req("/admin/api/kb", { method: "POST", raw: JSON.stringify(card({ body: "x".repeat(70000) })), id: await otsake() }), env);
check(res.status === 413 && kv.puts === p0, "yli 64 kt runko hylätään (413)");

// Korttiraja: 100 korttia, 101. hylätään.
reset();
{
  const e2 = makeEnv();
  const many = Array.from({ length: 100 }, (_, i) => ({ id: "k" + i, title: "Kortti " + i, body: "Teksti", keywords: [], url: "", checked: "2026-10-01", order: 0 }));
  e2.PUSH_KV._m.set("admin:kb:lahti", JSON.stringify(many));
  const r101 = await run(req("/admin/api/kb", { method: "POST", body: card(), id: await otsake() }), e2);
  check(r101.status === 409 && (await json(r101)).error === "too_many_cards" && e2.PUSH_KV.puts === 0, "101. kortti hylätään (409), ei kirjoitusta");
  const edit = await run(req("/admin/api/kb", { method: "POST", body: card({ id: "k5", title: "Muokattu" }), id: await otsake() }), e2);
  check(edit.status === 200, "täydessä tietopankissa olemassa olevan kortin muokkaus onnistuu");
}

// Nopeusraja: saman IP:n kirjoitukset katkeavat rajalla.
reset();
{
  const e3 = makeEnv();
  const max = (W.KB_RATE && W.KB_RATE.adminIp) || 120;
  let last = null;
  for (let i = 0; i <= max; i++) last = await run(req("/admin/api/kb/delete", { method: "POST", body: { city: "lahti", id: "x" }, id: await otsake(), ip: "198.51.100.9" }), e3);
  check(last && last.status === 429, `ylläpidon kirjoitusten nopeusraja: ${max + 1}. pyyntö samasta IP:stä = 429`);
  const other = await run(req("/admin/api/kb/delete", { method: "POST", body: { city: "lahti", id: "x" }, id: await otsake(), ip: "198.51.100.10" }), e3);
  check(other.status === 200, "toinen IP ei osu rajaan");
}

/* ===== (3) Julkinen luku ===== */
reset();
const pub = (city, origin, ip) => run(req("https://lsl-aikataulut-proxy.example/kb?city=" + city, { origin, ip }), env);
res = await pub("lahti", "https://demo.reittari.fi");
d = await json(res);
check(res.status === 200 && Array.isArray(d.items) && I(d).length === 1 && I(d)[0].title === "Löytötavarat ja kadonneet",
  "julkinen /kb palauttaa kunnan kortit sallitulle Originille");
check(res.headers.get("Access-Control-Allow-Origin") === "https://demo.reittari.fi", "CORS-otsake sallitulle Originille");
check(d.items && I(d)[0] && !("updatedAt" in I(d)[0]) && Array.isArray(I(d)[0].keywords) && "checked" in I(d)[0],
  "julkinen kortti: sisältö, avainsanat ja tarkistettu-päivä, ei muokkausaikaa");
res = await pub("kuopio", "https://lahti.savikurki.fi");
d = await json(res);
check(res.status === 200 && I(d).length === 1 && I(d)[0].title === "Kuopion kortti", "kunnat erillään, työtilan Origin kelpaa");
res = await pub("lahti", "https://evil.example");
check(res.status === 403, "vieras Origin: 403");
res = await pub("lahti", "");
check(res.status === 403, "puuttuva Origin: 403");
res = await pub("joensuu", "https://demo.reittari.fi");
d = await json(res);
check(res.status === 200 && Array.isArray(d.items) && I(d).length === 0, "kunta ilman kortteja: tyhjä lista");
{
  const max = (W.KB_RATE && W.KB_RATE.readIp) || 300;
  let last = null;
  for (let i = 0; i <= max; i++) last = await pub("lahti", "https://demo.reittari.fi", "192.0.2.77");
  check(last.status === 429, `julkisen luvun nopeusraja: ${max + 1}. pyyntö samasta IP:stä = 429`);
}
res = await run(req("https://lsl-aikataulut-proxy.example/published?city=lahti", { origin: "https://demo.reittari.fi" }), env);
d = await json(res);
check(res.status === 200 && d.kb === true && Array.isArray(d.alerts), "/published kertoo tietopankin tuen (kb: true), muut kentät ennallaan");

console.log(fail ? `${fail}/${total} FAIL` : `kaikki OK (${total})`);
process.exit(fail ? 1 : 0);

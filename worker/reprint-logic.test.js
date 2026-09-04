// Yksikkötestaa uusintapainatusvahdin palvelinkerroksen: perustason tallennus ja luku
// kaupungin omalla avaimella, avaimen myöntäminen ylläpidosta, ja se että väärä avain
// torjutaan. Mock-KV, ei verkkoa.
// Aja: node reprint-logic.test.js
import worker, { buildReprintBaseline, mergeReprintUnits, reprintCityName, REPRINT_MAX_UNITS }
  from "./worker.js";

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };

function mockKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix } = {}) {
      return { keys: [...m.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })),
        list_complete: true, cursor: "" };
    },
  };
}

const sig = { v: 1, kind: "line", label: "1", dirs: [{ label: "A > B",
  groups: [{ label: "Ma-Pe", n: 37, first: "05:10", last: "23:18", h: "abc" }] }] };

/* --- Rungon validointi (puhdas funktio) --- */

check(reprintCityName("Lahti") === "lahti" && reprintCityName("../etc") === "etc" && reprintCityName("") === "",
  "reprintCityName: pienaakkoset, vain sallitut merkit");
check(buildReprintBaseline(null).error === "bad_city", "baseline: tyhjä runko → bad_city");
check(buildReprintBaseline({ city: "lahti" }).error === "bad_units", "baseline: ilman yksiköitä → bad_units");
check(buildReprintBaseline({ city: "lahti", units: [] }).error === "bad_units",
  "baseline: taulukko ei kelpaa yksiköiksi");
check(buildReprintBaseline({ city: "lahti", units: { "Lahti:010": { printed: "2026-08-23T10:00:00Z" } } }).error === "bad_units",
  "baseline: yksikkö ilman sormenjälkeä hylätään");
check(buildReprintBaseline({ city: "lahti", units: { "Lahti:010": { sig } } }).error === "bad_units",
  "baseline: yksikkö ilman painopäivää hylätään");

const iso = "2026-08-23T10:00:00.000Z";
const hyva = buildReprintBaseline({ city: "Lahti", units: { "Lahti:010": { label: "1 Keskusta", printed: iso, sig } } });
check(hyva.city === "lahti" && hyva.units["Lahti:010"].printed === iso && hyva.units["Lahti:010"].sig.dirs.length === 1,
  "baseline: kelvollinen runko siistiytyy kaupungiksi + yksiköiksi");
check(!("email" in hyva.units["Lahti:010"]) && Object.keys(hyva.units["Lahti:010"]).sort().join(",") === "label,printed,sig",
  "baseline: vain label/printed/sig tallennetaan (ei henkilötietokenttiä)");

const liikaa = {};
for (let i = 0; i <= REPRINT_MAX_UNITS; i++) liikaa["u" + i] = { printed: iso, sig };
check(buildReprintBaseline({ city: "lahti", units: liikaa }).error === "too_many_units",
  "baseline: yli " + REPRINT_MAX_UNITS + " yksikköä torjutaan");
const iso_sig = { ...sig, iso: "x".repeat(600000) };
check(buildReprintBaseline({ city: "lahti", units: { a: { printed: iso, sig: iso_sig } } }).error === "too_large",
  "baseline: liian iso perustaso torjutaan");

/* --- Yhdistäminen: uudempi painomerkintä voittaa, mitään ei hukata --- */

const paikallinen = { a: { label: "a", printed: "2026-08-23T10:00:00Z", sig }, b: { label: "b", printed: "2026-08-23T10:00:00Z", sig } };
const palvelin = { a: { label: "a", printed: "2026-09-01T10:00:00Z", sig }, c: { label: "c", printed: "2026-08-01T10:00:00Z", sig } };
const yhdistetty = mergeReprintUnits(palvelin, paikallinen);
check(Object.keys(yhdistetty).sort().join(",") === "a,b,c", "merge: molempien puolten yksiköt säilyvät");
check(yhdistetty.a.printed === "2026-09-01T10:00:00Z", "merge: uudempi painomerkintä voittaa");
check(mergeReprintUnits(null, paikallinen).b.label === "b", "merge: tyhjä palvelinpuoli ei kaada siirtymää");

/* --- Päästä päähän worker.fetch + mock-KV --- */

const env = { PUSH_KV: mockKV(), ADMIN_PASSWORD: "salasana123", ADMIN_SESSION_SECRET: "reprint-secret" };
const ORIGIN = "https://demo.reittari.fi";
const req = (path, opts = {}) => new Request("https://proxy.example" + path, opts);
const jreq = (path, body, opts = {}) => req(path, {
  method: "POST", body: JSON.stringify(body),
  headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(opts.headers || {}) },
});

// Avainta ei saa myöntää ilman ylläpitoistuntoa
const noAuth = await worker.fetch(jreq("/admin/api/reprint/key", { city: "lahti" }), env);
check(noAuth.status === 403, "avain: ilman ylläpitoistuntoa myöntäminen → 403");

const login = await worker.fetch(req("/admin/login", { method: "POST", body: JSON.stringify({ password: "salasana123" }) }), env);
const cookie = (login.headers.get("Set-Cookie") || "").split(";")[0];
check(login.status === 200 && /^admin_session=/.test(cookie), "avain: ylläpitoon kirjautuminen onnistuu");

const ennen = await (await worker.fetch(req("/admin/api/reprint/key?city=lahti", { headers: { Cookie: cookie } }), env)).json();
check(ennen.exists === false && ennen.units === 0, "avain: ennen myöntämistä kaupungilla ei ole avainta eikä perustasoa");

const luotu = await (await worker.fetch(jreq("/admin/api/reprint/key", { city: "lahti" }, { headers: { Cookie: cookie } }), env)).json();
check(luotu.ok === true && typeof luotu.key === "string" && luotu.key.length >= 32, "avain: myöntäminen palauttaa avaimen kerran");
const KEY = luotu.key;

const talletettu = env.PUSH_KV._m.get("rpkey:lahti");
check(!talletettu.includes(KEY), "avain: KV:hen ei tallennu avain itse (vain tiiviste)");

const jalkeen = await (await worker.fetch(req("/admin/api/reprint/key?city=lahti", { headers: { Cookie: cookie } }), env)).json();
check(jalkeen.exists === true && !("key" in jalkeen), "avain: ylläpito näkee että avain on, muttei avainta");

// Väärä avain torjutaan sekä kirjoituksessa että luvussa
const vaara = await worker.fetch(jreq("/reprint/baseline", { city: "lahti", key: "x".repeat(40), units: { "Lahti:010": { printed: iso, sig } } }), env);
check(vaara.status === 403, "perustaso: väärä avain → 403");
const eiAvainta = await worker.fetch(jreq("/reprint/baseline", { city: "lahti", units: { "Lahti:010": { printed: iso, sig } } }), env);
check(eiAvainta.status === 403, "perustaso: puuttuva avain → 403");
const toinenKaupunki = await worker.fetch(jreq("/reprint/baseline", { city: "vaasa", key: KEY, units: { "Vaasa:1": { printed: iso, sig } } }), env);
check(toinenKaupunki.status === 403, "perustaso: Lahden avain ei kelpaa Vaasaan");

// Oikea avain: tallennus ja luku
const tallennus = await worker.fetch(jreq("/reprint/baseline", { city: "lahti", key: KEY,
  units: { "Lahti:010": { label: "1 Keskusta", printed: iso, sig } } }), env);
const tallennusJson = await tallennus.json();
check(tallennus.status === 200 && tallennusJson.ok === true && Object.keys(tallennusJson.units).length === 1,
  "perustaso: oikealla avaimella tallennus onnistuu");

const luku = await worker.fetch(req("/reprint/status?city=lahti&key=" + KEY, { headers: { Origin: ORIGIN } }), env);
const lukuJson = await luku.json();
check(luku.status === 200 && lukuJson.units["Lahti:010"].sig.dirs[0].groups[0].n === 37,
  "perustaso: luku palauttaa saman sormenjäljen");
const lukuVaara = await worker.fetch(req("/reprint/status?city=lahti&key=" + "y".repeat(40), { headers: { Origin: ORIGIN } }), env);
check(lukuVaara.status === 403, "perustaso: luku väärällä avaimella → 403");

// Toinen kone: eri yksikkö, uudempi merkintä samasta yksiköstä. Kumpaakaan ei saa hukata.
const uudempi = "2026-09-04T06:00:00.000Z";
await worker.fetch(jreq("/reprint/baseline", { city: "lahti", key: KEY, units: {
  "Lahti:010": { label: "1 Keskusta", printed: uudempi, sig },
  "corr:keskusta": { label: "Keskustan käytävä", printed: iso, sig } } }), env);
const yhdessa = await (await worker.fetch(req("/reprint/status?city=lahti&key=" + KEY, { headers: { Origin: ORIGIN } }), env)).json();
check(Object.keys(yhdessa.units).sort().join(",") === "Lahti:010,corr:keskusta",
  "perustaso: toisen koneen merkinnät yhdistyvät, vanhoja ei hukata");
check(yhdessa.units["Lahti:010"].printed === uudempi, "perustaso: uudempi painomerkintä voittaa palvelimella");

// Kaupunkiluettelo pysyy yhtenä blobina (ajastettu vertailu ei tarvitse KV.list-kutsua)
check(env.PUSH_KV._m.get("rp:cities") === JSON.stringify(["lahti"]), "perustaso: seuratut kaupungit yhdessä avaimessa");

// Ilman KV-sidontaa päätepiste ei kaadu vaan kertoo tilan
const eiKv = await worker.fetch(jreq("/reprint/baseline", { city: "lahti", key: KEY, units: { a: { printed: iso, sig } } }), { ...env, PUSH_KV: null });
check(eiKv.status === 503, "perustaso: ilman KV-sidontaa → 503 eikä poikkeusta");

console.log(fail ? `\n${fail} TARKISTUSTA EPÄONNISTUI` : "\nKAIKKI TARKISTUKSET OK");
process.exit(fail ? 1 : 0);

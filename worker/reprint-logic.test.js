// Yksikkötestaa uusintapainatusvahdin palvelinkerroksen: perustason tallennus ja luku
// kaupungin omalla avaimella, avaimen myöntäminen ylläpidosta, ja se että väärä avain
// torjutaan. Mock-KV, ei verkkoa.
// Aja: node reprint-logic.test.js
import worker, { buildReprintBaseline, mergeReprintUnits, reprintCityName, REPRINT_MAX_UNITS,
  reprintStateChanged, cleanReprintStale, buildReprintNotify, buildReprintAlertEmail }
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


/* ---------- Vaihe 2: ajastettu vertailu ja ilmoitus ---------- */

// Resend-tynkä: kerää lähtevät viestit, ei verkkoa.
const resendSends = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("api.resend.com")) { resendSends.push(JSON.parse(opts.body)); return { status: 200, ok: true }; }
  throw new Error("odottamaton fetch: " + u);
};

const env2 = {
  PUSH_KV: mockKV(),
  ADMIN_PASSWORD: "salasana123",
  ADMIN_SESSION_SECRET: "reprint-secret-2",
  RESEND_API_KEY: "test-resend",
  EMAIL_FROM: "vahti@example.fi",
  EMAIL_LINK_BASE: "https://proxy.example",
  REPRINT_SERVICE_TOKEN: "huoltoavain-1234567890",
};
const req2 = (path, opts = {}) => new Request("https://proxy.example" + path, opts);
const jreq2 = (path, body, opts = {}) => req2(path, {
  method: "POST", body: JSON.stringify(body),
  headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(opts.headers || {}) },
});

// --- Puhtaat funktiot ---
check(reprintStateChanged(null, []) === false, "tilamuutos: tyhjästä tyhjään ei ole muutos");
check(reprintStateChanged({ stale: [] }, ["a"]) === true, "tilamuutos: uusi vanhentunut on muutos");
check(reprintStateChanged({ stale: ["a", "b"] }, ["b", "a"]) === false,
  "tilamuutos: sama joukko eri järjestyksessä EI ole muutos (ei päivittäistä spämmiä)");
check(reprintStateChanged({ stale: ["a"] }, []) === true, "tilamuutos: vanhentuneen korjaus on muutos");
check(cleanReprintStale(["a", "x", "a"], { a: {}, b: {} }).join(",") === "a",
  "vertailun tulos: tuntemattomat tunnukset putoavat, duplikaatit poistuvat");

// --- Päästä päähän ---
const login2 = await worker.fetch(req2("/admin/login", { method: "POST", body: JSON.stringify({ password: "salasana123" }) }), env2);
const cookie2 = (login2.headers.get("Set-Cookie") || "").split(";")[0];
const luotu2 = await (await worker.fetch(jreq2("/admin/api/reprint/key", { city: "lahti" }, { headers: { Cookie: cookie2 } }), env2)).json();
const KEY2 = luotu2.key;
await worker.fetch(jreq2("/reprint/baseline", { city: "lahti", key: KEY2, units: {
  "Lahti:010": { label: "1 Keskusta", printed: iso, sig },
  "corr:kesk": { label: "Keskustan käytävä", printed: iso, sig } } }), env2);

// Huoltoavain: väärä token ei pääse lukemaan eikä kirjoittamaan
check((await worker.fetch(req2("/reprint/service?token=vaara"), env2)).status === 403,
  "huoltoajo: väärä huoltoavain ei saa seurattuja tulosteita");
check((await worker.fetch(jreq2("/reprint/service", { token: "vaara", city: "lahti", stale: [] }), env2)).status === 403,
  "huoltoajo: väärä huoltoavain ei voi kirjata tulosta");
check((await worker.fetch(req2("/reprint/service?token=" + KEY2), env2)).status === 403,
  "huoltoajo: kaupungin avain EI kelpaa huoltoavaimeksi");

const lista = await (await worker.fetch(req2("/reprint/service?token=" + env2.REPRINT_SERVICE_TOKEN), env2)).json();
check(lista.cities.length === 1 && Object.keys(lista.cities[0].units).length === 2,
  "huoltoajo: huoltoavaimella saa seuratut tulosteet kaikista kaupungeista");
check(JSON.stringify(lista).indexOf("@") < 0, "huoltoajo: listaus ei sisällä ilmoitusosoitetta");

// Ilman vahvistettua osoitetta ei lähde viestiä, vaikka tila muuttuu
resendSends.length = 0;
const eka = await (await worker.fetch(jreq2("/reprint/service", { token: env2.REPRINT_SERVICE_TOKEN, city: "lahti", stale: ["Lahti:010"] }), env2)).json();
check(eka.changed === true && eka.stale === 1 && eka.notified === false && resendSends.length === 0,
  "ilmoitus: ilman osoitetta tila tallentuu mutta viestiä ei lähde");

// Osoite ylläpidosta: vahvistusviesti lähtee, mutta ilmoituksia ei ennen vahvistusta
resendSends.length = 0;
const notify = await (await worker.fetch(jreq2("/admin/api/reprint/notify", { city: "lahti", email: "kaupunki@example.fi" }, { headers: { Cookie: cookie2 } }), env2)).json();
check(notify.ok === true && notify.notify.confirmed === false && resendSends.length === 1 &&
  resendSends[0].to[0] === "kaupunki@example.fi" && /Vahvista/.test(resendSends[0].subject),
  "ilmoitus: osoitteen tallennus lähettää vahvistusviestin");
check((await worker.fetch(jreq2("/admin/api/reprint/notify", { city: "lahti", email: "x@y.fi" }), env2)).status === 403,
  "ilmoitus: osoitetta ei voi asettaa ilman ylläpitoistuntoa");

resendSends.length = 0;
const toka = await (await worker.fetch(jreq2("/reprint/service", { token: env2.REPRINT_SERVICE_TOKEN, city: "lahti", stale: ["Lahti:010", "corr:kesk"] }), env2)).json();
check(toka.changed === true && toka.notified === false && resendSends.length === 0,
  "ilmoitus: vahvistamattomaan osoitteeseen EI lähetetä");

// Vahvistus linkistä
const tok = JSON.parse(env2.PUSH_KV._m.get("rp:lahti")).notify.token;
const vahv = await worker.fetch(req2("/reprint/notify/confirm?token=" + tok), env2);
check(vahv.status === 200 && /vahvistettu/i.test(await vahv.text()), "ilmoitus: vahvistuslinkki vahvistaa osoitteen");
check((await worker.fetch(req2("/reprint/notify/confirm?token=vaara"), env2)).status === 200,
  "ilmoitus: väärä vahvistuslinkki ei kaada workeria");

// Nyt ilmoitus lähtee, mutta VAIN kun tila muuttuu
resendSends.length = 0;
const kolmas = await (await worker.fetch(jreq2("/reprint/service", { token: env2.REPRINT_SERVICE_TOKEN, city: "lahti", stale: ["Lahti:010"] }), env2)).json();
check(kolmas.changed === true && kolmas.notified === true && resendSends.length === 1,
  "ilmoitus: muuttunut tila lähettää viestin vahvistettuun osoitteeseen");
check(/1 tuloste on vanhentunut/.test(resendSends[0].subject) &&
  resendSends[0].html.includes("1 Keskusta") && resendSends[0].html.includes("notify/unsubscribe"),
  "ilmoitus: viestissä on tulosteen nimi ja peruutuslinkki");

resendSends.length = 0;
const nelja = await (await worker.fetch(jreq2("/reprint/service", { token: env2.REPRINT_SERVICE_TOKEN, city: "lahti", stale: ["Lahti:010"] }), env2)).json();
check(nelja.changed === false && nelja.notified === false && resendSends.length === 0,
  "ilmoitus: sama tilanne seuraavana päivänä EI lähetä uutta viestiä");

// Peruutus
const peru = await worker.fetch(req2("/reprint/notify/unsubscribe?token=" + tok), env2);
check(peru.status === 200 && /peruttu/i.test(await peru.text()), "ilmoitus: peruutuslinkki lopettaa ilmoitukset");
resendSends.length = 0;
const viides = await (await worker.fetch(jreq2("/reprint/service", { token: env2.REPRINT_SERVICE_TOKEN, city: "lahti", stale: [] }), env2)).json();
check(viides.changed === true && resendSends.length === 0, "ilmoitus: peruutuksen jälkeen ei lähde viestejä");

// Perustason päivitys ei saa pyyhkiä vertailun tulosta
await worker.fetch(jreq2("/reprint/baseline", { city: "lahti", key: KEY2, units: {
  "Lahti:010": { label: "1 Keskusta", printed: "2026-09-05T00:00:00.000Z", sig } } }), env2);
const yha = JSON.parse(env2.PUSH_KV._m.get("rp:lahti"));
check(yha.state && yha.state.checkedAt, "perustaso: päivitys ei tyhjennä vahdin tulosta");

console.log(fail ? `\n${fail} TARKISTUSTA EPÄONNISTUI` : "\nKAIKKI TARKISTUKSET OK");
process.exit(fail ? 1 : 0);

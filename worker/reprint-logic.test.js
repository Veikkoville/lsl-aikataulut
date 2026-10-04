// Yksikkötestaa uusintapainatusvahdin palvelinkerroksen: perustason tallennus ja luku
// kaupungin omalla avaimella, avaimen myöntäminen ylläpidosta, ja se että väärä avain
// torjutaan. Mock-KV, ei verkkoa.
// Aja: node reprint-logic.test.js
import worker, { buildReprintBaseline, mergeReprintUnits, reprintCityName, REPRINT_MAX_UNITS,
  reprintStateChanged, cleanReprintStale, buildReprintNotify, buildReprintAlertEmail,
  reprintUnitTs, reprintMetric, reprintHistPut, reprintStateAfterMark, reprintDay, REPRINT_HIST_MONTHS }
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


/* ---------- Vaihtolista: vaihdon kuittaus ja ajantasaisuusmittari (4.10.2026) ---------- */

const ssig = { v: 1, kind: "stop", label: "Mukkulan kirkko P", code: "103849", lat: 61.0178, lon: 25.6659,
  dirs: [{ label: "", groups: [{ k: "01234|4|Keskusta", n: 30, h: "abc" }] }] };
const P1 = "2026-10-01T08:00:00.000Z", I1 = "2026-10-02T09:00:00.000Z";

// Painettu ja asennettu ovat eri kenttiä, ja kuittaus säilyy siivouksessa (vain sallitut kentät).
const kuitattu = buildReprintBaseline({ city: "lahti", units: {
  "stop:Lahti:103849": { label: "Mukkulan kirkko P", printed: P1, installed: I1, sig: ssig, email: "x@y.fi" } } });
check(kuitattu.units["stop:Lahti:103849"].installed === I1 &&
  Object.keys(kuitattu.units["stop:Lahti:103849"]).sort().join(",") === "installed,label,printed,sig",
  "kuittaus: asennusaika tallentuu, muut kuin sallitut kentät putoavat");

// Pelkkä kuittaus (painopäivä ennallaan) voittaa yhdistämisen, vanhempi kuittaus ei.
check(reprintUnitTs({ printed: P1, installed: I1 }) === I1 && reprintUnitTs({ printed: P1 }) === P1,
  "kuittaus: yksikön aikaleima on uusin merkintä (painettu tai vaihdettu)");
const ennenKuittausta = { s: { printed: P1, sig: ssig } };
const kuittaus = { s: { printed: P1, installed: I1, sig: ssig } };
check(mergeReprintUnits(ennenKuittausta, kuittaus).s.installed === I1,
  "kuittaus: saman painomerkinnän kuittaus voittaa yhdistämisen");
check(mergeReprintUnits(kuittaus, ennenKuittausta).s.installed === I1,
  "kuittaus: kuittaamaton kopio toiselta koneelta ei pyyhi kuittausta");
check(mergeReprintUnits(kuittaus, { s: { printed: "2026-10-03T07:00:00.000Z", sig: ssig } }).s.installed === undefined,
  "kuittaus: uudempi painomerkintä korvaa vanhan kuittauksen (uusi arkki odottaa vaihtoa)");

// Mittari: vain pysäkkijulisteet, kuitattu painamisen jälkeen eikä vanhentunut.
const mitattavat = {
  "stop:a": { printed: P1, installed: I1 },                      // ajan tasalla
  "stop:b": { printed: P1, installed: I1 },                      // vahti: vanhentunut
  "stop:c": { printed: P1 },                                     // painettu, ei kuitattu
  "stop:d": { printed: "2026-10-03T00:00:00.000Z", installed: I1 }, // uudempi painos odottaa vaihtoa
  "Lahti:010": { printed: P1, installed: I1 },                   // linjatuloste: ei mittarissa
};
const mm = reprintMetric(mitattavat, ["stop:b"]);
check(mm.n === 4 && mm.ok === 1, `mittari: 4 pysäkkijulistetta, 1 ajan tasalla (sai ${mm.ok}/${mm.n})`);
check(reprintMetric({}, null).n === 0 && reprintMetric(null, null).ok === 0, "mittari: tyhjä seuranta ei kaada");

// Kuukausihistoria: kuukauden viimeisin mittaus voittaa, enintään 24 kuukautta, ei tyhjiä rivejä.
let hh = reprintHistPut({}, "2026-10-04", { n: 4, ok: 1 });
hh = reprintHistPut(hh, "2026-10-05", { n: 4, ok: 3 });
check(Object.keys(hh).join(",") === "2026-10" && hh["2026-10"].d === "2026-10-05" && hh["2026-10"].ok === 3,
  "historia: sama kuukausi päivittyy viimeisimpään mittaukseen");
check(Object.keys(reprintHistPut(hh, "2026-11-01", { n: 0, ok: 0 })).length === 1,
  "historia: kaupunki ilman pysäkkijulisteita ei saa riviä");
let pitka = {};
for (let i = 0; i < 30; i++) {
  const d = new Date(Date.UTC(2024, i, 15)).toISOString().slice(0, 10);
  pitka = reprintHistPut(pitka, d, { n: 10, ok: i % 10 });
}
check(Object.keys(pitka).length === REPRINT_HIST_MONTHS && !pitka["2024-01"] && !!pitka["2026-06"],
  `historia: enintään ${REPRINT_HIST_MONTHS} kuukautta, vanhimmat putoavat`);
check(JSON.stringify(pitka).length < 1500, `historia: 24 kuukautta mahtuu alle 1,5 kt:hen (${JSON.stringify(pitka).length} t)`);
check(/^\d{4}-\d{2}-\d{2}$/.test(reprintDay(new Date("2026-10-04T22:30:00Z"))) &&
  reprintDay(new Date("2026-10-04T22:30:00Z")) === "2026-10-05",
  "historia: päivä lasketaan Suomen ajassa (klo 01.30 on jo seuraava päivä)");
check(reprintStateAfterMark({ stale: ["a", "b"], checkedAt: "x" }, ["a"]).stale.join(",") === "b" &&
  reprintStateAfterMark(null, ["a"]) === null,
  "kuittaus: merkitty yksikkö putoaa vahdin vanhentuneista, muut säilyvät");

// --- Päästä päähän: kuittaus kaupungin avaimella, tila ja historia palvelimella ---
const env3 = { ...env2, PUSH_KV: mockKV(), ADMIN_SESSION_SECRET: "reprint-secret-3" };
const login3 = await worker.fetch(req2("/admin/login", { method: "POST", body: JSON.stringify({ password: "salasana123" }) }), env3);
const cookie3 = (login3.headers.get("Set-Cookie") || "").split(";")[0];
const KEY3 = (await (await worker.fetch(jreq2("/admin/api/reprint/key", { city: "lahti" }, { headers: { Cookie: cookie3 } }), env3)).json()).key;
const SID = "stop:Lahti:103849", SID2 = "stop:Lahti:103850";
await worker.fetch(jreq2("/reprint/baseline", { city: "lahti", key: KEY3, units: {
  [SID]: { label: "Mukkulan kirkko P", printed: P1, installed: P1, sig: ssig },
  [SID2]: { label: "Mukkulan kirkko E", printed: P1, installed: P1, sig: ssig } } }), env3);

// Ilmoitusosoite vahvistettuna: perustason päivitys EI saa pudottaa sitä (korjattu 4.10.2026).
resendSends.length = 0;
await worker.fetch(jreq2("/admin/api/reprint/notify", { city: "lahti", email: "kaupunki@example.fi" }, { headers: { Cookie: cookie3 } }), env3);
const tok3 = JSON.parse(env3.PUSH_KV._m.get("rp:lahti")).notify.token;
await worker.fetch(req2("/reprint/notify/confirm?city=lahti&token=" + tok3), env3);

// Vahti toteaa toisen julisteen vanhentuneeksi.
const vahti3 = await (await worker.fetch(jreq2("/reprint/service", { token: env3.REPRINT_SERVICE_TOKEN, city: "lahti", stale: [SID] }), env3)).json();
const tila3 = JSON.parse(env3.PUSH_KV._m.get("rp:lahti"));
const kk = reprintDay().slice(0, 7);
check(vahti3.stale === 1 && tila3.hist && tila3.hist[kk] && tila3.hist[kk].n === 2 && tila3.hist[kk].ok === 1,
  "mittari: vahdin ajo kirjaa kuluvan kuukauden rivin (1/2 ajan tasalla)");

// Kuittaus väärällä avaimella torjutaan (sama tunnistautuminen kuin perustasolla).
const vaaraKuittaus = await worker.fetch(jreq2("/reprint/baseline", { city: "lahti", key: "z".repeat(40), units: {
  [SID]: { label: "Mukkulan kirkko P", printed: I1, installed: I1, sig: ssig } } }), env3);
check(vaaraKuittaus.status === 403, "kuittaus: väärällä avaimella → 403");

// Vaihdettu: uusi sormenjälki, painettu ja asennettu nyt.
const kuittausVastaus = await (await worker.fetch(jreq2("/reprint/baseline", { city: "lahti", key: KEY3, units: {
  [SID]: { label: "Mukkulan kirkko P", printed: I1, installed: I1, sig: ssig } } }), env3)).json();
const tila4 = JSON.parse(env3.PUSH_KV._m.get("rp:lahti"));
check(kuittausVastaus.ok && kuittausVastaus.ack === true && !tila4.state.stale.includes(SID) && tila4.state.checkedAt,
  "kuittaus: vaihdettu juliste putoaa palvelimen vanhentuneista heti, vahdin ajoaika säilyy");
check(tila4.hist[kk].ok === 2 && tila4.hist[kk].n === 2, "kuittaus: kuukausirivi päivittyy kuittauksesta (2/2)");
check(tila4.notify && tila4.notify.confirmed === true && tila4.notify.email === "kaupunki@example.fi",
  "perustaso: merkintä ei pudota vahvistettua ilmoitusosoitetta");
check(!JSON.stringify(tila4.units).includes("@") && !JSON.stringify(tila4.hist).includes("@"),
  "kuittaus: yksiköissä ja historiassa ei ole henkilötietoa");

// Sovellus tunnistaa kuittauksen tukevan palvelimen ja saa historian.
const status3 = await (await worker.fetch(req2("/reprint/status?city=lahti&key=" + KEY3, { headers: { Origin: ORIGIN } }), env3)).json();
check(status3.ack === true && status3.hist[kk].ok === 2 && status3.units[SID].installed === I1,
  "kuittaus: tilakysely kertoo tuen (ack), kuittauksen ja kuukausirivit");

// Ylläpito: sama luku istunnolla, ei ilman.
const yp = await (await worker.fetch(req2("/admin/api/reprint/key?city=lahti", { headers: { Cookie: cookie3 } }), env3)).json();
check(yp.metric && yp.metric.n === 2 && yp.metric.ok === 2 && yp.hist[kk] && !("key" in yp),
  "ylläpito: avainkysely palauttaa mittarin ja kuukausirivit");
check((await worker.fetch(req2("/admin/api/reprint/key?city=lahti"), env3)).status === 403,
  "ylläpito: mittaria ei saa ilman istuntoa");

console.log(fail ? `\n${fail} TARKISTUSTA EPÄONNISTUI` : "\nKAIKKI TARKISTUKSET OK");
process.exit(fail ? 1 : 0);

// Tilasivun päätökset (tools/tila.js). Aja: node --test tools/tila.test.js
const test = require("node:test");
const assert = require("node:assert");
const { PALVELUT, SYKE_RAJA_H, DATAVAHTI_RAJA_H, sivunTila, reittarinTila, luvatTila, datavahtiTila, haeDatavahti, kokoa } = require("./tila.js");

const [REITTARI, LUVAT, JATE] = PALVELUT;
const OK = { ok: true };
const NYT = new Date("2026-10-06T06:00:00Z");

test("sivu ei vastaa: häiriö ja syy näkyy", () => {
  const t = sivunTila(JATE, { ok: false, syy: "HTTP 503" });
  assert.strictEqual(t.tila, "hairio");
  assert.match(t.kuvaus, /HTTP 503/);
});

test("sivun puuttuva mittaus ei ole koskaan toimii", () => {
  assert.strictEqual(sivunTila(JATE, null).tila, "hairio");
  assert.strictEqual(reittarinTila(REITTARI, null, { conclusion: "success", run_started_at: NYT.toISOString() }, []).tila, "hairio");
  assert.strictEqual(luvatTila(LUVAT, null, NYT.toISOString(), NYT).tila, "hairio");
});

test("reittari: sivu vastaa ja smoke läpi", () => {
  const t = reittarinTila(REITTARI, OK, { conclusion: "success", run_started_at: "2026-10-05T11:01:57Z" }, []);
  assert.strictEqual(t.tila, "toimii");
  assert.match(t.kuvaus, /5\.10\.2026 klo 14\.01 meni läpi/);
});

test("reittari: punainen smoke ilman triagen issueta (kuorma) ei ole häiriö", () => {
  const smoke = { conclusion: "failure", run_started_at: "2026-10-05T11:00:00Z" };
  const vanha = [{ created_at: "2026-09-27T10:52:57Z" }]; // pitkään auki ollut, vanhempi kuin ajo
  const t = reittarinTila(REITTARI, OK, smoke, vanha);
  assert.strictEqual(t.tila, "toimii");
  assert.match(t.kuvaus, /ei mennyt läpi/);
});

test("reittari: punainen smoke ja triagen uusi issue on häiriö", () => {
  const smoke = { conclusion: "failure", run_started_at: "2026-10-05T11:00:00Z" };
  const t = reittarinTila(REITTARI, OK, smoke, [{ created_at: "2026-10-05T11:40:00Z" }]);
  assert.strictEqual(t.tila, "hairio");
});

test("reittari: smoken lukuvirhe ei kaada sivun mittausta", () => {
  const t = reittarinTila(REITTARI, OK, null, []);
  assert.strictEqual(t.tila, "toimii");
  assert.match(t.kuvaus, /ei saatu luettua/);
});

test("luvat: tuore syke toimii, raja ylittyy häiriöksi", () => {
  const tuore = new Date(NYT.getTime() - (SYKE_RAJA_H - 1) * 3600000).toISOString();
  const vanha = new Date(NYT.getTime() - (SYKE_RAJA_H + 1) * 3600000).toISOString();
  assert.strictEqual(luvatTila(LUVAT, OK, tuore, NYT).tila, "toimii");
  const t = luvatTila(LUVAT, OK, vanha, NYT);
  assert.strictEqual(t.tila, "hairio");
  assert.match(t.kuvaus, /yli 36 tuntiin/);
});

test("luvat: lukematon tai virheellinen syke on häiriö", () => {
  assert.strictEqual(luvatTila(LUVAT, OK, null, NYT).tila, "hairio");
  assert.strictEqual(luvatTila(LUVAT, OK, "ei aika", NYT).tila, "hairio");
});

const palvelu = (id, tila) => ({ id, nimi: id, tila, kuvaus: "k", lahde: "l" });

test("kokoa: ensimmäinen ajo ei keksi tapahtumia", () => {
  const d = kokoa(null, [palvelu("reittari", "hairio")], NYT);
  assert.deepStrictEqual(d.tapahtumat, []);
  assert.strictEqual(d.paivitetty, NYT.toISOString());
  assert.strictEqual(d.palvelut[0].viimeisin_tarkistus, NYT.toISOString());
  assert.ok(d.vanhenee_tuntia > 0);
  assert.strictEqual(d.esimerkki, undefined);
});

test("kokoa: tilan muutos kirjaa tapahtuman, sama tila ei", () => {
  const ed = kokoa(null, [palvelu("reittari", "toimii"), palvelu("jate", "toimii")], new Date("2026-10-06T05:00:00Z"));
  const d = kokoa(ed, [palvelu("reittari", "hairio"), palvelu("jate", "toimii")], NYT);
  assert.strictEqual(d.tapahtumat.length, 1);
  assert.strictEqual(d.tapahtumat[0].palvelu, "reittari");
  assert.match(d.tapahtumat[0].teksti, /häiriö \(aiemmin toimii\)/);
  const palautui = kokoa(d, [palvelu("reittari", "toimii"), palvelu("jate", "toimii")], new Date("2026-10-06T07:00:00Z"));
  assert.strictEqual(palautui.tapahtumat.length, 2);
  assert.match(palautui.tapahtumat[0].teksti, /toimii \(aiemmin häiriö\)/);
});

test("kokoa: vanhat tapahtumat karsitaan ja määrä rajataan", () => {
  const vanha = { aika: "2026-06-01T00:00:00Z", palvelu: "x", teksti: "vanha" };
  const tuoreet = Array.from({ length: 12 }, (_, i) => ({ aika: "2026-10-0" + (1 + (i % 5)) + "T00:00:00Z", palvelu: "x", teksti: "t" + i }));
  const d = kokoa({ palvelut: [], tapahtumat: tuoreet.concat([vanha]) }, [palvelu("reittari", "toimii")], NYT);
  assert.strictEqual(d.tapahtumat.length, 10);
  assert.ok(!d.tapahtumat.some(t => t.teksti === "vanha"));
});

// ── Datavahdin palvelut (10.10.2026) ─────────────────────────────────────────

const DATAVAHDIT = PALVELUT.filter(p => p.datavahti);
const DM = DATAVAHDIT[0];
const ajo = (conclusion, tuntiaSitten = 3) => ({ conclusion, run_started_at: new Date(NYT.getTime() - tuntiaSitten * 3600000).toISOString() });

test("datavahti: viisi palvelua, yksilöivät tunnukset ja repot, ei julkista sivua", () => {
  assert.deepStrictEqual(DATAVAHDIT.map(p => p.id), ["de-minimis-rekisteri", "tapahtumaluvat", "uimavesitiedotus", "kulttuurivierailut", "elinvoimapaketti"]);
  assert.strictEqual(new Set(PALVELUT.map(p => p.id)).size, PALVELUT.length);
  for (const p of DATAVAHDIT) {
    assert.match(p.datavahti, /^Veikkoville\/[a-z-]+$/);
    assert.strictEqual(p.url, null);
    assert.match(p.nimi, /^Savikurki /);
  }
});

test("datavahti: tuore vihreä ajo toimii, punainen on häiriö", () => {
  const ok = datavahtiTila(DM, null, ajo("success"), NYT);
  assert.strictEqual(ok.tila, "toimii");
  assert.match(ok.kuvaus, /esitellään pyynnöstä/);
  assert.match(ok.kuvaus, /kunnossa/);
  assert.strictEqual(datavahtiTila(DM, null, ajo("failure"), NYT).tila, "hairio");
  assert.strictEqual(datavahtiTila(DM, null, ajo("timed_out"), NYT).tila, "hairio");
});

test("datavahti: lukematon, puuttuva, vanha tai keskeytynyt ajo ei ole koskaan toimii ilman julkista sivua", () => {
  assert.strictEqual(datavahtiTila(DM, null, null, NYT).tila, "ei_tietoa");
  assert.strictEqual(datavahtiTila(DM, null, { puuttuu: true }, NYT).tila, "ei_tietoa");
  const vanha = datavahtiTila(DM, null, ajo("success", DATAVAHTI_RAJA_H + 1), NYT);
  assert.strictEqual(vanha.tila, "ei_tietoa");
  assert.match(vanha.kuvaus, /yli 50 tuntia/);
  assert.strictEqual(datavahtiTila(DM, null, ajo("success", DATAVAHTI_RAJA_H - 1), NYT).tila, "toimii");
  assert.strictEqual(datavahtiTila(DM, null, ajo("cancelled"), NYT).tila, "ei_tietoa");
  assert.strictEqual(datavahtiTila(DM, null, { conclusion: "success", run_started_at: "ei aika" }, NYT).tila, "ei_tietoa");
});

test("datavahti: julkaistun demon sivu on perusehto", () => {
  const julkaistu = { ...DM, url: "https://demo.test/", otsikko: "De minimis", esittely: "demo.test" };
  assert.strictEqual(datavahtiTila(julkaistu, { ok: false, syy: "HTTP 500" }, ajo("success"), NYT).tila, "hairio");
  const lukematon = datavahtiTila(julkaistu, OK, null, NYT);
  assert.strictEqual(lukematon.tila, "toimii");
  assert.match(lukematon.kuvaus, /ei saatu luettua/);
  assert.strictEqual(datavahtiTila(julkaistu, OK, ajo("failure"), NYT).tila, "hairio");
});

test("datavahti: GitHubin vastaus luetaan oikein (404 = ei näkyvyyttä, tyhjä = ei ajoja)", async () => {
  const alkup = global.fetch;
  const kutsut = [];
  const vastaa = (status, body) => async (url, valinnat) => { kutsut.push({ url, auth: valinnat.headers.authorization }); return new Response(JSON.stringify(body), { status }); };
  const ymp = { DATAVAHTI_TOKEN: process.env.DATAVAHTI_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  try {
    process.env.GH_TOKEN = "oma";
    delete process.env.DATAVAHTI_TOKEN;
    global.fetch = vastaa(404, { message: "Not Found" });
    const virhe = console.error;
    console.error = () => {};
    try { assert.strictEqual(await haeDatavahti("Veikkoville/uimavesi"), null); } finally { console.error = virhe; }
    assert.match(kutsut[0].url, /\/repos\/Veikkoville\/uimavesi\/actions\/workflows\/datavahti\.yml\/runs\?status=completed&branch=master/);
    assert.strictEqual(kutsut[0].auth, "Bearer oma", "ilman lukutokenia käytetään GITHUB_TOKENia");
    process.env.DATAVAHTI_TOKEN = "luku";
    global.fetch = vastaa(200, { total_count: 0, workflow_runs: [] });
    assert.deepStrictEqual(await haeDatavahti("Veikkoville/uimavesi"), { puuttuu: true });
    assert.strictEqual(kutsut[1].auth, "Bearer luku");
    global.fetch = vastaa(200, { workflow_runs: [{ conclusion: "failure", run_started_at: "2026-10-06T09:41:00Z", html_url: "https://github.com/x" }] });
    assert.deepStrictEqual(await haeDatavahti("Veikkoville/uimavesi"), { conclusion: "failure", run_started_at: "2026-10-06T09:41:00Z" });
  } finally {
    global.fetch = alkup;
    for (const [k, v] of Object.entries(ymp)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

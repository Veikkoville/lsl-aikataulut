// Tilasivun päätökset (tools/tila.js). Aja: node --test tools/tila.test.js
const test = require("node:test");
const assert = require("node:assert");
const { PALVELUT, SYKE_RAJA_H, sivunTila, reittarinTila, luvatTila, kokoa } = require("./tila.js");

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

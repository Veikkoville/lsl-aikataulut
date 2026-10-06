// Tilasivun tiedosto tila.json (savikurki.fi/tila).
//
// .github/workflows/tila.yml ajaa tämän tunnin välein ja jokaisen Tuotanto-smoken jälkeen ja vie
// tuloksen orpohaaraan `tila`. savikurki.fi/tila/tila.php hakee tiedoston palvelimelta käsin, jotta
// kävijän selain ei ota yhteyttä GitHubiin (savikurki.fi:n tietosuojaseloste: ei kolmansia osapuolia).
//
// Tila johdetaan vain mitatusta. Palvelun julkinen sivu vastaa (HTTP 200 ja odotettu otsikko),
// Reittarilla lisäksi viimeisin Tuotanto-smoke ja Luvat ja kuulutukset -palvelulla aineiston haun
// syke. Mittaamaton on ei_tietoa, ei koskaan oletuksena toimii.
//
// Aja:  GH_TOKEN=... GITHUB_REPOSITORY=Veikkoville/lsl-aikataulut node tools/tila.js --ulos tila.json [--edellinen vanha.json]
const fs = require("fs");

const SYKE_RAJA_H = 36;        // sama raja kuin kuulutusvahdin workerin valvonnassa (wrangler.toml)
const VANHENEE_TUNTIA = 12;    // sivu näyttää tätä vanhemman tiedoston vanhentuneena (GitHubin ajastus voi viivästyä)
const TAPAHTUMIA_ENINTAAN = 10;
const TAPAHTUMA_IKA_PV = 90;

const PALVELUT = [
  {
    id: "reittari",
    nimi: "Reittari",
    url: "https://demo.reittari.fi/",
    otsikko: "Reittari",
    esittely: "demo.reittari.fi",
  },
  {
    id: "luvat-ja-kuulutukset",
    nimi: "Savikurki Luvat ja kuulutukset",
    url: "https://demo.savikurki.fi/luvat/?city=lahti",
    otsikko: "Luvat ja kuulutukset",
    esittely: "demo.savikurki.fi/luvat",
    syke: "https://demo.savikurki.fi/luvat/data/haku.json",
  },
  {
    id: "jatehuollon-asiointi",
    nimi: "Savikurki Jätehuollon asiointi",
    url: "https://jatehuolto-osoitteessa.pages.dev/",
    otsikko: "Jätehuollon asiointi",
    esittely: "jatehuolto-osoitteessa.pages.dev",
  },
];

const TILATEKSTI = { toimii: "toimii", hairio: "häiriö", ei_tietoa: "ei tietoa" };

function aika(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "tuntematon aika";
  const pvm = d.toLocaleDateString("fi-FI", { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", year: "numeric" });
  const klo = d.toLocaleTimeString("fi-FI", { timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit" });
  return pvm + " klo " + klo;
}

// ── Puhtaat päätökset (tools/tila.test.js) ────────────────────────────────────

// sivu = { ok, syy }. Sivun vastaus on jokaisen palvelun perusehto.
function sivunTila(p, sivu) {
  if (!sivu || !sivu.ok) {
    return { tila: "hairio", kuvaus: "Esittelysivu " + p.esittely + " ei vastannut (" + ((sivu && sivu.syy) || "tuntematon syy") + ")." };
  }
  return { tila: "toimii", kuvaus: "Esittelysivu " + p.esittely + " vastasi." };
}

// smoke = viimeisin valmis Tuotanto-smoke { conclusion, run_started_at } tai null, jos sitä ei saatu luettua.
// smokeIssuet = avoimet "smoke:"-issuet { created_at }. Punainen ajo on häiriö vain, jos smoke-triage
// avasi siitä issuen (se ei avaa issueta rajapinnan kuormasta). Vanha avoin issue ei koske uutta ajoa.
function reittarinTila(p, sivu, smoke, smokeIssuet) {
  const perus = sivunTila(p, sivu);
  if (perus.tila !== "toimii") return perus;
  if (!smoke) return { tila: "toimii", kuvaus: perus.kuvaus + " Tuotanto-smoken tulosta ei saatu luettua." };
  const milloin = aika(smoke.run_started_at);
  if (smoke.conclusion === "success") return { tila: "toimii", kuvaus: perus.kuvaus + " Viimeisin tuotanto-smoke " + milloin + " meni läpi." };
  if (smoke.conclusion === "failure" || smoke.conclusion === "timed_out") {
    const alku = new Date(smoke.run_started_at).getTime();
    const vika = (smokeIssuet || []).some(i => new Date(i.created_at).getTime() >= alku);
    if (vika) return { tila: "hairio", kuvaus: perus.kuvaus + " Viimeisin tuotanto-smoke " + milloin + " löysi vian, ja sen selvitys on kesken." };
    return { tila: "toimii", kuvaus: perus.kuvaus + " Viimeisin tuotanto-smoke " + milloin + " ei mennyt läpi, mutta vikailmoitusta siitä ei ole avattu." };
  }
  return { tila: "toimii", kuvaus: perus.kuvaus + " Viimeisin tuotanto-smoke " + milloin + " keskeytyi." };
}

// syke = aineiston haun aikaleima (data/haku.json "haettu") tai null, jos sykettä ei saatu luettua.
// Sovellus lukee aineistonsa samasta kansiosta, joten lukematon syke on häiriö eikä tuntematon.
function luvatTila(p, sivu, syke, nyt) {
  const perus = sivunTila(p, sivu);
  if (perus.tila !== "toimii") return perus;
  if (!syke) return { tila: "hairio", kuvaus: perus.kuvaus + " Aineiston haun tietoa ei saatu luettua." };
  const ika = (nyt.getTime() - new Date(syke).getTime()) / 3600000;
  if (!(ika >= -1)) return { tila: "hairio", kuvaus: perus.kuvaus + " Aineiston haun aikaleima on virheellinen." };
  if (ika > SYKE_RAJA_H) {
    return { tila: "hairio", kuvaus: perus.kuvaus + " Aineistoa ei ole saatu haettua yli " + SYKE_RAJA_H + " tuntiin (viimeksi " + aika(syke) + "). Sivu näyttää viimeksi haetut tiedot." };
  }
  return { tila: "toimii", kuvaus: perus.kuvaus + " Aineisto haettu viimeksi " + aika(syke) + "." };
}

// Kokoaa tiedoston. Tapahtuma syntyy vain, kun palvelun tila muuttuu edelliseen ajoon verrattuna.
// Ilman edellistä tiedostoa tapahtumia ei keksitä.
function kokoa(edellinen, palvelut, nyt) {
  const iso = nyt.toISOString();
  const vanhat = new Map(((edellinen && edellinen.palvelut) || []).map(p => [p.id, p.tila]));
  const uudet = [];
  for (const p of palvelut) {
    const ennen = vanhat.get(p.id);
    if (!ennen || ennen === p.tila) continue;
    let teksti = p.nimi + ": " + TILATEKSTI[p.tila] + " (aiemmin " + TILATEKSTI[ennen] + ").";
    if (p.tila === "hairio") teksti += " " + p.kuvaus;
    uudet.push({ aika: iso, palvelu: p.id, teksti });
  }
  const raja = nyt.getTime() - TAPAHTUMA_IKA_PV * 86400000;
  const tapahtumat = uudet
    .concat(((edellinen && edellinen.tapahtumat) || []).filter(t => new Date(t.aika).getTime() >= raja))
    .slice(0, TAPAHTUMIA_ENINTAAN);
  return {
    versio: 1,
    paivitetty: iso,
    vanhenee_tuntia: VANHENEE_TUNTIA,
    palvelut: palvelut.map(p => ({
      id: p.id,
      nimi: p.nimi,
      tila: p.tila,
      viimeisin_tarkistus: iso,
      lahde: p.lahde,
      kuvaus: p.kuvaus,
    })),
    tapahtumat,
  };
}

// ── Mittaukset ────────────────────────────────────────────────────────────────

const UA = "savikurki-tila (+https://savikurki.fi/tila/)";
const odota = ms => new Promise(r => setTimeout(r, ms));

// Kaksi yritystä 15 s välein, jotta yksittäinen verkkokatkos ei näy häiriönä.
async function tarkistaSivu(url, otsikko) {
  let tulos = null;
  for (let yritys = 1; yritys <= 2; yritys++) {
    try {
      const res = await fetch(url, { redirect: "follow", headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
      const html = await res.text();
      const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
      if (res.status === 200 && m && m[1].includes(otsikko)) return { ok: true };
      tulos = { ok: false, syy: res.status !== 200 ? "HTTP " + res.status : "sivun otsikko ei vastannut odotettua" };
    } catch (e) {
      tulos = { ok: false, syy: e && e.name === "TimeoutError" ? "aikakatkaisu" : "yhteysvirhe" };
    }
    if (yritys < 2) await odota(15000);
  }
  return tulos;
}

async function haeSyke(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const d = await res.json();
    return typeof d.haettu === "string" ? d.haettu : null;
  } catch (e) {
    return null;
  }
}

async function github(polku) {
  const res = await fetch("https://api.github.com/repos/" + process.env.GITHUB_REPOSITORY + polku, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + (process.env.GH_TOKEN || "").trim(),
      "user-agent": UA,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("GitHub " + polku + ": HTTP " + res.status);
  return res.json();
}

async function haeSmoke() {
  try {
    const d = await github("/actions/workflows/prod-smoke.yml/runs?status=completed&per_page=1&exclude_pull_requests=true");
    const run = d.workflow_runs && d.workflow_runs[0];
    if (!run) return { smoke: null, issuet: [] };
    const issuet = (await github("/issues?state=open&per_page=100"))
      .filter(i => !i.pull_request && /^smoke:/i.test(i.title));
    return { smoke: run, issuet };
  } catch (e) {
    console.error("smoke: " + e.message);
    return { smoke: null, issuet: [] };
  }
}

async function main() {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const ulos = arg("--ulos");
  if (!ulos) throw new Error("--ulos puuttuu");
  let edellinen = null;
  const edPolku = arg("--edellinen");
  if (edPolku && fs.existsSync(edPolku)) {
    try { edellinen = JSON.parse(fs.readFileSync(edPolku, "utf8")); } catch (e) { console.error("edellinen tila.json on virheellinen, tapahtumat alkavat alusta"); }
  }
  const nyt = new Date();
  const [sivut, smoke, syke] = await Promise.all([
    Promise.all(PALVELUT.map(p => tarkistaSivu(p.url, p.otsikko))),
    haeSmoke(),
    haeSyke(PALVELUT[1].syke),
  ]);
  const tulokset = PALVELUT.map((p, i) => {
    let t, lahde;
    if (p.id === "reittari") { t = reittarinTila(p, sivut[i], smoke.smoke, smoke.issuet); lahde = "Saatavuustarkistus ja Tuotanto-smoke"; }
    else if (p.id === "luvat-ja-kuulutukset") { t = luvatTila(p, sivut[i], syke, nyt); lahde = "Saatavuustarkistus ja aineiston haun syke"; }
    else { t = sivunTila(p, sivut[i]); lahde = "Saatavuustarkistus"; }
    return { id: p.id, nimi: p.nimi, tila: t.tila, kuvaus: t.kuvaus, lahde };
  });
  const tiedosto = kokoa(edellinen, tulokset, nyt);
  fs.writeFileSync(ulos, JSON.stringify(tiedosto, null, 2) + "\n");
  for (const p of tiedosto.palvelut) console.log(p.id + ": " + p.tila + " | " + p.kuvaus);
  for (const t of tiedosto.tapahtumat.filter(t => t.aika === tiedosto.paivitetty)) console.log("TAPAHTUMA " + t.teksti);
}

module.exports = { PALVELUT, SYKE_RAJA_H, sivunTila, reittarinTila, luvatTila, kokoa, tarkistaSivu };

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

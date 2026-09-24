// Yksikkötestaa kausivalidointi.js:n serviceId-luokitinta (classify) ilman verkkokyselyjä.
// Fixtuurit noudattavat 2026-08-25 ajon havaintoa (AUTO-BACKLOG.md): 22 uutta serviceId:tä,
// joista 15 jäi vanhalla luokittimella (vain koul/loma) ilman luokkaa. Uusi luokitin lisää
// "kausi" (talvi/kesä/syksy/kevät) ja "viikonpaiva" (la-su, ma-pe, ma-to, mape, mato, la, su).
// Aja: node kausivalidointi-luokitin.test.js
const { classify } = require("./kausivalidointi.js");

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };

// Ajossa 2026-08-25 uusina tulleet, vanhalla luokittimella luokittelemattomat serviceId:t.
const UUDET_LUOKITTELEMATTOMAT = [
  "Lahti:2026-2027 Jouluaatto",
  "Lahti:2026-2027 Joulupäivä",
  "Kuopio:2026_Kevät_La",
  "Joensuu:Kevätaikataulu_M-P",
  "Raasepori:BOSSE_kevat_la-su",
  "Mikkeli:La kevät27",
  "Lahti:2026-2027 La-Su 20270404 asti",
  "Lahti:2026-2027 MaPe 20270404 asti",
  "Lahti:2026-2027 MaTo 20270404 asti",
  "Kouvola:Kevät La",
  "Kouvola:Kevät Su",
  "Vaasa:Lifti_Kevät_La",
  "Salo:Kevät_2027",
  "OULU:T_K 27 La-Su",
  "Lappeenranta:Sataman valot pe 28.8.2027", // ei osu mihinkään luokkaan — jää yhä WARNiksi
];
check(UUDET_LUOKITTELEMATTOMAT.length === 15, "fixtuuri: 15 aiemmin luokittelematonta serviceId:tä");

// Samalla ajolla jo vanhastaan koul/loma-luokkaan osuneet, täydentävät otannan 22:een.
const UUDET_JO_LUOKITELLUT = [
  "Kajaani:Sotkamo koulupäivä 27.4.2027",
  "Kuopio:2027_Koulup",
  "Raasepori:Koulut_ke",
  "Mikkeli:Koulp Pe 27-28",
  "Lappeenranta:Ma-Pe koulujen loma-ajat 2027-2028",
  "Salo:Syysloma 2027",
  "Joensuu:koulp Joensuu_kevätlk",
];
check(UUDET_LUOKITTELEMATTOMAT.length + UUDET_JO_LUOKITELLUT.length === 22, "fixtuuri: yhteensä 22 uutta serviceId:tä (2026-08-25 ajon määrä)");

// --- Joulun pyhät luokittuvat lomaksi vaikka sana "loma" ei niissä esiinny ---
check(classify("Lahti:2026-2027 Jouluaatto") === "loma", "classify: Jouluaatto → loma");
check(classify("Lahti:2026-2027 Joulupäivä") === "loma", "classify: Joulupäivä → loma");

// --- Kausivariantit (talvi/kesä/syksy/kevät), myös yhteen kirjoitettuna ---
check(classify("Kuopio:2026_Kevät_La") === "kausi", "classify: Kevät_La → kausi");
check(classify("Joensuu:Kevätaikataulu_M-P") === "kausi", "classify: Kevätaikataulu (yhteen kirjoitettu) → kausi");
check(classify("Raasepori:BOSSE_kevat_la-su") === "kausi", "classify: kevat (ilman ä:tä) → kausi");
check(classify("Kotka:2026-2027 TALVI (Perjantai)") === "kausi", "classify: TALVI isoin kirjaimin → kausi");
check(classify("Kajaani:Kesäliikenne 2026 SL") === "kausi", "classify: Kesäliikenne → kausi");
check(classify("Salo:Syksy_2026") === "kausi", "classify: Syksy → kausi");

// --- Viikonpäivävariantit ilman kausisanaa: la-su, ma-pe, ma-to, MaPe, MaTo, La, Su ---
check(classify("Lahti:2026-2027 La-Su 20270404 asti") === "viikonpaiva", "classify: La-Su → viikonpaiva");
check(classify("Lahti:2026-2027 MaPe 20270404 asti") === "viikonpaiva", "classify: MaPe → viikonpaiva");
check(classify("Lahti:2026-2027 MaTo 20270404 asti") === "viikonpaiva", "classify: MaTo → viikonpaiva");
check(classify("Lahti:2026-2027 La 20260831 asti") === "viikonpaiva", "classify: pelkkä La → viikonpaiva");
check(classify("Lahti:2026-2027 Su 20260831 asti") === "viikonpaiva", "classify: pelkkä Su → viikonpaiva");
check(classify("OULU:T_K 27 La-Su") === "viikonpaiva", "classify: La-Su alaviivaeroittimien seassa → viikonpaiva");

// --- Vanha koul/loma-tunnistus säilyy muuttumattomana ---
check(classify("Kajaani:Sotkamo koulupäivä 27.4.2027") === "koul", "classify: koulupäivä → koul (ennallaan)");
check(classify("Lahti:2026-2027 Ma-To KP 20260831 asti") === "koul", "classify: KP-token → koul (ennallaan)");
check(classify("Salo:Syysloma 2027") === "loma", "classify: Syysloma → loma (ennallaan)");
check(classify("Lahti:2026-2027 Ma-To LP 20260831 asti") === "loma", "classify: LP-token → loma (ennallaan)");

// --- Kokonaiskuva 2026-08-25 ajon fixtuureista: tuntemattomien määrä 15:stä korkeintaan kahteen ---
const kaikkiUudet = [...UUDET_LUOKITTELEMATTOMAT, ...UUDET_JO_LUOKITELLUT];
const yhaTuntemattomat = kaikkiUudet.filter(s => !classify(s));
check(yhaTuntemattomat.length <= 2,
  `serviceId-uudet: tuntemattomien määrä ${yhaTuntemattomat.length} (oli 15) — ` + yhaTuntemattomat.map(s => `"${s}"`).join(", "));
// Aidosti uusi, tunnistamaton nimikäytäntö (ei kausi-/koul-/loma-/viikonpäivä-sanaa) jää yhä WARNiksi.
check(classify("Lappeenranta:Sataman valot pe 28.8.2027") === "", "classify: yksittäinen tapahtuma-lisävuoro ilman tunnettua merkintää → yhä tuntematon (WARN säilyy)");

console.log(fail ? `\n${fail} TARKISTUS EPÄONNISTUI` : "\nKAIKKI TARKISTUKSET OK");
process.exit(fail ? 1 : 0);

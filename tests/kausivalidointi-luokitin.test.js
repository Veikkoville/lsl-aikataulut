// Kausivalidoinnin serviceId-luokittimen yksikkötesti (ei verkkoa). Fixtuurit ovat ajon 32812513577
// 22 uutta serviceId:tä sellaisinaan. Ajo: node tests/kausivalidointi-luokitin.test.js
const { classify } = require("./kausivalidointi.js");

let ok = 0, fail = 0;
function tarkista(nimi, saatu, odotettu) {
  const hyva = saatu === odotettu;
  hyva ? ok++ : fail++;
  console.log(`${hyva ? "OK  " : "FAIL"} ${nimi}${hyva ? "" : ` | saatu ${JSON.stringify(saatu)}, odotettu ${JSON.stringify(odotettu)}`}`);
}

const fixtuurit = {
  "Lahti:2026-2027 La Historic Rally": "",
  "Salo:Koulup_2026_lisävuorot_syksy": "koul",
  "Kajaani:Koulu p keskiviikko": "koul",
  "Kajaani:koulup ma,ke,to,pe": "koul",
  "Kotka:2026-2027 TALVI Jouluaatto2026": "loma",
  "Kotka:2026-2027 TALVI Joulupäivä2026": "loma",
  "Raasepori:BOSSE_talvi_ma-to": "viikonpaiva",
  "Raasepori:BOSSE_talvi_pe": "viikonpaiva",
  "Raasepori:ME_kesaAW_la-su": "viikonpaiva",
  "Raasepori:ME_talviAW_la-su": "viikonpaiva",
  "LINKKI:SEUTU L talvi": "kausi",
  "OULU:T_T 26-27 59 La": "viikonpaiva",
  "OULU:T_T 26-27 59 MaPe": "viikonpaiva",
  "OULU:T_T 26-27 59 Su": "viikonpaiva",
  "OULU:T_T 26-27 La alk 14_9": "viikonpaiva",
  "OULU:T_T 26-27 La alk 24_8": "viikonpaiva",
  "OULU:T_T 26-27 MaTo KP alk 14_9": "koul",
  "OULU:T_T 26-27 MaTo KP alk 24_8": "koul",
  "OULU:T_T 26-27 Pe KP alk 14_9": "koul",
  "OULU:T_T 26-27 Pe KP alk 24_8": "koul",
  "OULU:T_T 26-27 Su alk 14_9": "viikonpaiva",
  "OULU:T_T 26-27 Su alk 24_8": "viikonpaiva",
};
for (const [sid, luokka] of Object.entries(fixtuurit)) tarkista(sid, classify(sid), luokka);

const tuntemattomia = Object.keys(fixtuurit).filter(s => !classify(s)).length;
tarkista("tuntemattomia korkeintaan 2 (ennen 15)", tuntemattomia <= 2, true);
// koul/loma-säännöt kuten index.html:n schoolOf
tarkista("Jyväskylä M-P ei koulp on loma", classify("LINKKI:M-P ei koulp"), "loma");
tarkista("Lappeenranta koulujen loma-ajat on loma", classify("Ma-Pe koulujen loma-ajat"), "loma");
tarkista("LP on loma", classify("Lahti LP talvi"), "loma");

// Aluerajaus (areaScoped, Inkoo): linja mukaan vain, jos sillä on kunnan alueella vähintään minStops pysäkkiä.
const { areaRouteIds } = require("./kausivalidointi.js");
const alue = { area: { rect: { minLat: 0, maxLat: 10, minLon: 0, maxLon: 10 },
  polygon: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], minStops: 2 } };
const pys = (lat, lon, ...ids) => ({ lat, lon, routes: ids.map(gtfsId => ({ gtfsId })) });
const laatikko = [pys(1, 1, "MATKA:a", "MATKA:b"), pys(2, 2, "MATKA:a", "HSL:x"), pys(3, 3, "HSL:x"), pys(20, 20, "MATKA:b", "MATKA:c")];
tarkista("Aluerajaus: vain kunnan alueella minStops-ehdon täyttävät oman feedin linjat",
  JSON.stringify(areaRouteIds(laatikko, alue, "MATKA")), JSON.stringify({ ids: ["MATKA:a"], fallback: false }));
tarkista("Aluerajaus: tyhjä tulos palaa suorakaiteeseen kuten sovellus",
  JSON.stringify(areaRouteIds(laatikko, { area: { ...alue.area, minStops: 9 } }, "MATKA")),
  JSON.stringify({ ids: ["MATKA:a", "MATKA:b", "MATKA:c"], fallback: true }));

console.log(`\n${ok} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);

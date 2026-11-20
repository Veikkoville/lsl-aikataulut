// Hinnaston tarkistuspäivän päätöslogiikan yksikkötesti (ei verkkoa). Ajo: node tests/kausivalidointi-hinnasto.test.js
const { hinnastoTulos } = require("./kausivalidointi.js");

let fail = 0;
function tarkista(nimi, saatu, odotettu, sisaltaa) {
  const hyva = saatu.level === odotettu && (!sisaltaa || saatu.syy.includes(sisaltaa));
  if (!hyva) fail++;
  console.log(`${hyva ? "OK  " : "FAIL"} ${nimi}${hyva ? "" : ` | saatu ${JSON.stringify(saatu)}, odotettu ${odotettu}`}`);
}
const pv = (y, m, d) => new Date(y, m - 1, d);

tarkista("tuore pistemuoto: PASS", hinnastoTulos("4.10.2026", pv(2026, 11, 10)), "PASS");
tarkista("vuodenvaihde: WARN", hinnastoTulos("4.10.2026", pv(2027, 1, 5)), "WARN", "vuodenvaihde");
tarkista("ISO-muoto yli 180 vrk: WARN", hinnastoTulos("2026-09-23", pv(2027, 4, 1)), "WARN", "vrk sitten");
tarkista("yli 365 vrk: FAIL", hinnastoTulos("1.1.2025", pv(2026, 3, 1)), "FAIL");
tarkista("ei jäsenny: WARN", hinnastoTulos("syksy 2026", pv(2026, 11, 10)), "WARN", "ei jäsenny");
tarkista("puuttuu: WARN", hinnastoTulos(undefined, pv(2026, 11, 10)), "WARN", "ei jäsenny");
tarkista("mahdoton päivä: WARN", hinnastoTulos("31.2.2026", pv(2026, 11, 10)), "WARN", "ei jäsenny");
tarkista("tänä vuonna tarkistettu tammikuussa: PASS", hinnastoTulos("2.1.2027", pv(2027, 2, 1)), "PASS");

console.log(fail ? `\n${fail} epäonnistui` : "\nkaikki OK");
process.exit(fail ? 1 : 0);

// Solmupysäkin pulssin päätöslogiikan yksikkötesti (ei verkkoa). Ajo: node tests/kausivalidointi-pulssi.test.js
const { pulssiTulos } = require("./kausivalidointi.js");

let fail = 0;
function tarkista(nimi, saatu, odotettu) {
  const hyva = saatu.level === odotettu.level && saatu.lomaviikko === odotettu.lomaviikko;
  if (!hyva) fail++;
  console.log(`${hyva ? "OK  " : "FAIL"} ${nimi}${hyva ? "" : ` | saatu ${JSON.stringify(saatu)}, odotettu ${JSON.stringify(odotettu)}`}`);
}

tarkista("lomaviikko D+7: PASS ja lomaviikko-merkintä", pulssiTulos(48, 110, 114, 112), { level: "PASS", lomaviikko: true });
tarkista("oikea kausivaihto: WARN", pulssiTulos(110, 110, 50, 52), { level: "WARN", lomaviikko: false });
tarkista("kaukopäivät tyhjät: WARN", pulssiTulos(110, 112, 0, 0), { level: "WARN", lomaviikko: false });
tarkista("lähipäivät tyhjät: FAIL", pulssiTulos(0, 0, 5, 5), { level: "FAIL", lomaviikko: false });
tarkista("vakaa: PASS ilman merkintää", pulssiTulos(100, 104, 98, 100), { level: "PASS", lomaviikko: false });

console.log(fail ? `\n${fail} epäonnistui` : "\nkaikki OK");
process.exit(fail ? 1 : 0);

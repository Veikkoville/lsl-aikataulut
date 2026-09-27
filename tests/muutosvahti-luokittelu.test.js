// Muutosvahdin luokittelun yksikkötestit (ei verkkoa): lähiviikkojen tulkinta ja pysäkin muutospäivä.
// Ajo: node tests/muutosvahti-luokittelu.test.js   (osa npm testiä)
const { classifyNear, firstChangeDay, addDays } = require("./muutosvahti.js");

let ok = 0, fail = 0;
function tarkista(nimi, saatu, odotettu) {
  const hyva = JSON.stringify(saatu) === JSON.stringify(odotettu);
  hyva ? ok++ : fail++;
  console.log(`${hyva ? "OK  " : "FAIL"} ${nimi}${hyva ? "" : ` | saatu ${JSON.stringify(saatu)}, odotettu ${JSON.stringify(odotettu)}`}`);
}

// --- Lähiviikkojen tulkinta ---
const s = h => ({ hash: h, n: 1, lines: [] });
const tulkinta = (n1, n2, f1, f2, prev) => { const r = classifyNear(s(n1), s(n2), s(f1), s(f2), prev); return [r.base.hash, r.poikkeus]; };

// Joensuu 27.9.2026: W1 = nykytila (= edellinen ajo), W2 = syysloma, W5 = W6 = uusi aikataulu.
tarkista("Joensuu: W2 syysloma ja muutos myöhemmin -> nykytila W1, poikkeus W2", tulkinta("A", "X", "C", "C", "A"), ["A", "near2"]);
tarkista("Muutos alkaa W2:lla -> nykytila W1, ei poikkeusta", tulkinta("A", "C", "C", "C", "A"), ["A", ""]);
tarkista("W1 syysloma -> nykytila W2, poikkeus W1", tulkinta("X", "A", "A", "A", "A"), ["A", "near"]);
tarkista("W2 poikkeus ilman muutosta -> nykytila W1, poikkeus W2", tulkinta("A", "X", "A", "A", "A"), ["A", "near2"]);
tarkista("W1 = W2 -> nykytila W1", tulkinta("A", "A", "C", "C", "A"), ["A", ""]);
tarkista("Ei edellistä ajoa, W2 = kauko -> W2, poikkeus W1", tulkinta("X", "A", "A", "A", undefined), ["A", "near"]);
tarkista("Ei edellistä ajoa, W1 = kauko -> W1, poikkeus W2", tulkinta("A", "X", "A", "A", undefined), ["A", "near2"]);
tarkista("Ei edellistä ajoa eikä tukea -> W2, poikkeus W1", tulkinta("A", "X", "C", "C", undefined), ["X", "near"]);

// --- Pysäkin muutospäivä viikonpäivittäin ---
// Ajo su 27.9.2026: nykytilan viikko ma 5.10., kaukoviikko ma 2.11., vahvistusviikko ma 9.11.
const VANHA = "2026-10-05", UUSI = "2026-11-02", UUSI2 = "2026-11-09";
const vkp = d => new Date(d + "T12:00:00").getDay(); // 0 su, 6 la
function paivat(f, alku = "2026-10-05", loppu = "2026-11-15") {
  const m = new Map();
  for (let d = alku; d <= loppu; d = addDays(d, 1)) m.set(d, f(d, vkp(d)));
  return m;
}
const laji = w => (w === 0 ? "su" : w === 6 ? "la" : "arki");
const muutos = (d, w) => (d >= "2026-11-02" ? "uusi-" : "vanha-") + laji(w);

tarkista("Lahti: uusi linja 28 alkaa ma 2.11. -> 2026-11-02",
  firstChangeDay(paivat((d, w) => muutos(d, w)), VANHA, UUSI, UUSI2), "2026-11-02");
tarkista("Lahti + syysloma 19.-23.10. ennen muutosta -> 2026-11-02",
  firstChangeDay(paivat((d, w) => (d >= "2026-10-19" && d <= "2026-10-23" ? "loma" : muutos(d, w))), VANHA, UUSI, UUSI2), "2026-11-02");
tarkista("Kuopio: lähdöt minuutin aiemmin ma 12.10. alkaen -> 2026-10-12",
  firstChangeDay(paivat((d, w) => (d >= "2026-10-12" ? "uusi-" : "vanha-") + laji(w)), VANHA, UUSI, UUSI2), "2026-10-12");
tarkista("Joensuu: syysloma 12.-18.10., muutos 19.10., pyhäinpäivä la 31.10. -> 2026-10-19",
  firstChangeDay(paivat((d, w) => (d === "2026-10-31" ? "pyha" : d >= "2026-10-12" && d <= "2026-10-18" ? "loma" : (d >= "2026-10-19" ? "uusi-" : "vanha-") + laji(w))), VANHA, UUSI, UUSI2), "2026-10-19");
tarkista("Oulu: syysloma näytti uudelta tilalta, 26.10. palasi vanhaan, muutos 2.11. -> 2026-11-02",
  firstChangeDay(paivat((d, w) => {
    if (w === 0) return "su";
    if (w === 6) return d === "2026-10-31" ? "la-poikkeus" : "la";
    return (d >= "2026-10-19" && d <= "2026-10-23") || d >= "2026-11-02" ? "arki-ilman-0712" : "arki";
  }), VANHA, UUSI, UUSI2), "2026-11-02");
tarkista("Pelkkä pyhäinpäivä la 31.10., ei muutosta -> null",
  firstChangeDay(paivat((d, w) => (d === "2026-10-31" ? "pyha" : "vanha-" + laji(w))), VANHA, UUSI, UUSI2), null);
tarkista("Viikonloppumuutos la 24.10. alkaen -> 2026-10-24",
  firstChangeDay(paivat((d, w) => (w === 6 && d >= "2026-10-24" ? "uusi-la" : "vanha-" + laji(w))), VANHA, UUSI, UUSI2), "2026-10-24");
tarkista("Viikonloppumuutos la 24.10., pyhäinpäivä la 31.10. välissä -> 2026-10-24",
  firstChangeDay(paivat((d, w) => (d === "2026-10-31" ? "pyha" : w === 6 && d >= "2026-10-24" ? "uusi-la" : "vanha-" + laji(w))), VANHA, UUSI, UUSI2), "2026-10-24");
tarkista("Nykytila W2 (W1 syysloma 5.-11.10.), muutos 26.10. -> 2026-10-26",
  firstChangeDay(paivat((d, w) => (d <= "2026-10-11" ? "loma" : (d >= "2026-10-26" ? "uusi-" : "vanha-") + laji(w))), "2026-10-12", UUSI, UUSI2), "2026-10-26");
tarkista("Kaukoviikko ei vakaa (2.11. eri kuin 9.11.) -> null",
  firstChangeDay(paivat((d, w) => (d >= "2026-11-09" ? "x-" : d >= "2026-11-02" ? "uusi-" : "vanha-") + laji(w)), VANHA, UUSI, UUSI2), null);
tarkista("Ei muutosta -> null",
  firstChangeDay(paivat((d, w) => "vanha-" + laji(w)), VANHA, UUSI, UUSI2), null);

console.log(`\nmuutosvahdin luokittelu: ${ok} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);

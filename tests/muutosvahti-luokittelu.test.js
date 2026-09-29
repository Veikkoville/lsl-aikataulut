// Muutosvahdin luokittelun yksikkötestit (ei verkkoa): lähiviikkojen tulkinta, pysäkin muutospäivä ja
// aluerajatun kaupungin (areaScoped) pysäkkijoukko.
// Ajo: node tests/muutosvahti-luokittelu.test.js   (osa npm testiä)
const { classifyNear, firstChangeDay, addDays, areaSelection, inMunicipality, extractConfigs } = require("./muutosvahti.js");

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

// --- Aluerajaus (areaScoped): kaikki kunnan alueen oman feedin ja lisäfeedin pysäkit (sovelluksen
// inMunicipality), joilla on CONFIG.modes-linja. Linjalistan minStops ei rajaa pysäkkejä (päätös 29.9.2026).
// Kunta = neliö lon 0-10, lat 0-10; suorakaide ulottuu sen yli kuten Inkoossa naapurikuntiin.
const alue = { rect: { minLat: -5, maxLat: 20, minLon: -5, maxLon: 20 },
  polygon: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], minStops: 3 };
const alueCfg = { area: alue, extraFeeds: ["LOSSI"], modes: ["BUS", "FERRY"] };
const pys = (id, lat, lon, ...linjat) => ({ gtfsId: id, name: id, code: "", lat, lon,
  routes: linjat.map(l => ({ gtfsId: l.split("/")[0], mode: l.split("/")[1] || "BUS" })) });
const bbox = [
  pys("F:a", 5, 5, "F:1", "F:9"), pys("F:b", 6, 6, "F:1"), pys("F:c", 7, 7, "F:1", "X:2"),
  pys("F:g", 3, 3, "F:9"),                       // vain läpikulkulinja (2 pysäkkiä kunnassa < minStops): mukana
  pys("F:e", 15, 15, "F:1", "F:9"),              // suorakaiteessa mutta kunnan ulkopuolella
  pys("X:d", 4, 4, "X:2"), pys("X:k", 1, 1, "X:2"), // toisen feedin pysäkit
  pys("LOSSI:f", 8, 8, "LOSSI:1/FERRY"),         // lisäfeedin lossilaituri
  pys("F:h", 2, 2, "F:5/RAIL"), pys("F:i", 2, 3, "F:5/RAIL"), pys("F:j", 2, 4, "F:5/RAIL"), // junapysäkit
  pys("F:m", 2, 6),                              // ei linjoja
  pys("F:n", null, null, "F:1"),                 // ei koordinaatteja
];
const valinta = areaSelection(bbox, alueCfg, "F");
tarkista("Aluerajaus: pysäkit = kunnan alueella, oma feed tai lisäfeed, vähintään yksi bussi- tai lossilinja",
  valinta.stops.map(s => s.id), ["F:a", "F:b", "F:c", "F:g", "LOSSI:f"]);
tarkista("Aluerajaus: läpikulkulinjan pysäkki mukana, minStops ei rajaa (minStops 100 -> sama joukko)",
  areaSelection(bbox, { ...alueCfg, area: { ...alue, minStops: 100 } }, "F").stops.map(s => s.id), ["F:a", "F:b", "F:c", "F:g", "LOSSI:f"]);
tarkista("Aluerajaus: lokin linjat = valittujen pysäkkien bussi- ja lossilinjat",
  valinta.routeIds, ["F:1", "F:9", "LOSSI:1", "X:2"]);
tarkista("Aluerajaus: oletuskulkutapa BUS pudottaa lossilaiturin",
  areaSelection(bbox, { area: alue, extraFeeds: ["LOSSI"] }, "F").stops.map(s => s.id), ["F:a", "F:b", "F:c", "F:g"]);
tarkista("Aluerajaus: ilman polygonia pelkkä suorakaide (pysäkki e mukaan)",
  areaSelection(bbox, { area: { rect: alue.rect } }, "F").stops.map(s => s.id), ["F:a", "F:b", "F:c", "F:e", "F:g"]);

// Inkoon oikea CONFIG index.html:stä: rajaus ei saa kadota hiljaa (vahti laajenisi naapurikuntiin).
const inkoo = extractConfigs().inkoo;
tarkista("Inkoon CONFIG: areaScoped, rect ja polygon",
  [!!inkoo?.areaScoped, !!inkoo?.area?.rect, (inkoo?.area?.polygon || []).length > 100], [true, true, true]);
const r = inkoo.area.rect;
const suorakaiteessa = (lat, lon) => lat >= r.minLat && lat <= r.maxLat && lon >= r.minLon && lon <= r.maxLon;
tarkista("Inkoo: pysäkki Inkoo (MATKA:358159) on kunnassa", inMunicipality(60.042697, 24.006211, inkoo.area), true);
tarkista("Inkoo: Siuntio matkahuolto on suorakaiteessa mutta ei kunnassa",
  [suorakaiteessa(60.1385451, 24.2252726), inMunicipality(60.1385451, 24.2252726, inkoo.area)], [true, false]);
tarkista("Inkoo: Kamppi (Helsinki) ei ole kunnassa", inMunicipality(60.1690, 24.9316, inkoo.area), false);
tarkista("Inkoo: tien 25 pysäkit Svartå vs V ja Salo-Inkoo-liittymä L ovat kunnassa",
  [inMunicipality(60.134422, 23.8682159, inkoo.area), inMunicipality(60.132644, 23.853085, inkoo.area)], [true, true]);

console.log(`\nmuutosvahdin luokittelu: ${ok} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);

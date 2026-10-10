// Datavahdin päätöslogiikan yksikkötesti (ei verkkoa). Jokainen rikottu viittaus fixturessa on kaadettava
// FAILiksi, ja ehjä fixture ei saa FAILata. Ajo: node tests/datavahti.test.js
const { evaluate, lineRefs, smokePins, dayList } = require("./datavahti.js");

let ok = 0, fail = 0;
function tarkista(nimi, ehto, lisa) {
  ehto ? ok++ : fail++;
  console.log(`${ehto ? "OK  " : "FAIL"} ${nimi}${ehto ? "" : " | " + JSON.stringify(lisa)}`);
}

const days = dayList(42, new Date(2026, 9, 12));
const ajaa = (alku = 0) => days.map((_, i) => (i >= alku ? 10 : 0));
const cfg = () => ({
  feedMatch: /^Testi$/,
  corridors: [{ key: "keskusta", lines: ["1", "192V"] }],
  vihko: { sections: [{ key: "a", lines: ["1"] }], combos: [{ key: "c", lines: ["1", "192V"] }] },
  deskHomeStop: { id: "Testi:100", name: "Tori" },
  centerStopNames: ["Tori"],
  hubs: [{ key: "asema", name: "Asema", allow: ["A", "B"] }],
  rail: "TST",
});
const snap = () => ({
  router: "waltti", feeds: ["Testi"], feed: "Testi", days,
  routes: [{ gtfsId: "Testi:1", shortName: "1", mode: "BUS" }, { gtfsId: "Testi:192V", shortName: "192V", mode: "BUS" }],
  service: { "Testi:1": ajaa(), "Testi:192V": ajaa() },
  stops: { "Testi:100": { found: true, name: "Tori A", deps: 120 }, "Testi:200": { found: true, name: "Asema", deps: 50 } },
  names: { Tori: [{ gtfsId: "Testi:100", name: "Tori A", routes: [{ gtfsId: "Testi:1" }] }] },
  hubs: { asema: [{ gtfsId: "Testi:300", name: "Asema", platformCode: "A", routes: [{ gtfsId: "Testi:1" }] },
    { gtfsId: "Testi:301", name: "Asema", platformCode: "B", routes: [{ gtfsId: "Testi:1" }] }] },
});
const ctx = () => ({ pins: { testi: [{ field: "posterStopId", id: "Testi:200" }] },
  stations: new Map([["TST", { stationShortCode: "TST", stationName: "Testilä", passengerTraffic: true }]]) });
const fails = res => res.filter(r => r.level === "FAIL");
const has = (res, level, re) => res.some(r => r.level === level && re.test(r.check + " " + r.msg));

// 0) Ehjä tilanne: ei FAILia eikä WARNia
{
  const r = evaluate("testi", cfg(), snap(), ctx());
  tarkista("ehjä fixture: 0 FAIL, 0 WARN", !fails(r).length && !r.some(x => x.level === "WARN"), r.filter(x => x.level !== "PASS"));
}
// 1) Raaseporin tapaus: syöte muutti "192V" -> "192_V"
{
  const s = snap(); s.routes[1] = { gtfsId: "Testi:192V", shortName: "192_V", mode: "BUS" };
  const r = evaluate("testi", cfg(), s, ctx());
  tarkista("tunnuksen muotomuutos 192V -> 192_V = FAIL ja vihje", has(r, "FAIL", /linja 192V \(käytäväpreset keskusta\).*"192_V"/), fails(r));
  tarkista("sama linja vihkon yhdistelmässä = FAIL", has(r, "FAIL", /linja 192V \(vihkon yhdistelmä c\)/), fails(r));
}
// 2) Linja poistunut kokonaan
{
  const s = snap(); s.routes.pop();
  tarkista("poistunut presetin linja = FAIL", has(evaluate("testi", cfg(), s, ctx()), "FAIL", /linja 192V.*puuttuu syötteestä/));
}
// 3) Linjalla ei vuoroja tulostusjaksolla
{
  const s = snap(); s.service["Testi:192V"] = days.map(() => 0);
  tarkista("presetin linja ilman vuoroja 42 pv = FAIL", has(evaluate("testi", cfg(), s, ctx()), "FAIL", /linja 192V \(käytäväpreset.*ei vuoroja 42/));
}
// 4) Tauko lähimmän viikon aikana (Kajaanin syysloma): WARN, ei FAIL
{
  const s = snap(); s.service["Testi:192V"] = ajaa(7 + 2);
  const r = evaluate("testi", cfg(), s, ctx());
  tarkista("tauko lähipäivinä = WARN eikä FAIL", has(r, "WARN", /linja 192V.*tauko/) && !fails(r).length, r.filter(x => x.level !== "PASS"));
}
// 5) Tiskin oletuspysäkki
{
  const s = snap(); delete s.stops["Testi:100"];
  tarkista("tiskin oletuspysäkki puuttuu = FAIL", has(evaluate("testi", cfg(), s, ctx()), "FAIL", /tiskin oletuspysäkki Testi:100/));
  const s2 = snap(); s2.stops["Testi:100"] = { found: true, name: "Tori A", deps: 0 };
  tarkista("tiskin oletuspysäkillä 0 lähtöä = FAIL", has(evaluate("testi", cfg(), s2, ctx()), "FAIL", /tiskin oletuspysäkki.*0 lähtöä/));
  const c3 = cfg(); c3.deskHomeStop = { ids: ["Testi:100", "Testi:999"], name: "Asema" };
  tarkista("ids-listan puuttuva tunnus = FAIL", has(evaluate("testi", c3, snap(), ctx()), "FAIL", /Testi:999/));
}
// 6) Smoken pinnattu pysäkki
{
  const s = snap(); s.stops["Testi:200"] = { found: false };
  tarkista("prod-smoken posterStopId puuttuu = FAIL", has(evaluate("testi", cfg(), s, ctx()), "FAIL", /prod-smoke posterStopId Testi:200/));
}
// 7) Solmupysäkin nimi
{
  const s = snap(); s.names.Tori = [];
  tarkista("centerStopNames ei osu = FAIL", has(evaluate("testi", cfg(), s, ctx()), "FAIL", /centerStopNames "Tori"/));
}
// 8) Laiturit
{
  const s = snap(); s.hubs.asema = [{ gtfsId: "Testi:300", name: "Asema", platformCode: "X", routes: [{ gtfsId: "Testi:1" }] }];
  tarkista("allow-suodatus jättää 0 laituria = FAIL", has(evaluate("testi", cfg(), s, ctx()), "FAIL", /laiturit asema/));
  const s2 = snap(); s2.hubs.asema.pop();
  tarkista("yksi allow-tunnus puuttuu = WARN", has(evaluate("testi", cfg(), s2, ctx()), "WARN", /laiturit asema.*B/));
}
// 9) Juna-asema
{
  const c = cfg(); c.rail = ["TST", "XXX"];
  tarkista("tuntematon asemakoodi = FAIL", has(evaluate("testi", c, snap(), ctx()), "FAIL", /juna-asema XXX/));
}
// 10) Feed
{
  const s = snap(); s.feed = null;
  tarkista("feedMatch ei osu = FAIL", has(evaluate("testi", cfg(), s, ctx()), "FAIL", /feedMatch/));
}
// 11) Viittausten keruu ja smoken pinnat oikeasta tiedostosta
{
  const refs = lineRefs(cfg()).map(r => r.line + "@" + r.kind);
  tarkista("lineRefs kerää presetin ja vihkon linjat", refs.includes("192V@preset") && refs.includes("1@vihko"), refs);
  const pins = smokePins();
  tarkista("smokePins lukee prod-smoken pinnat", (pins.lahti || []).some(p => p.id === "Lahti:85811")
    && (pins.kouvola || []).some(p => p.field === "posterStopId"), pins);
}

console.log(`\n${ok} OK / ${fail} FAIL`);
process.exit(fail ? 1 : 0);

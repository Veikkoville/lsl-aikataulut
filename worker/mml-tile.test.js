// Yksikkötestaa MML-tiilireitin polun jäsennyksen ja Referer-tarkistuksen (23.9.2026).
// Deterministinen, ei verkkoa. Aja: node mml-tile.test.js
import { parseMmlTilePath, mmlRefererAllowed, mmlFallbackPng, MML_Z_MIN, MML_Z_MAX } from "./worker.js";

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check(eq(parseMmlTilePath("/mml/selkokartta/13/4640/2240.png"), { layer: "selkokartta", z: 13, x: 4640, y: 2240 }),
  "kelvollinen selkokarttatiili jäsentyy");
check(eq(parseMmlTilePath("/mml/taustakartta/12/2320/1120.png"), { layer: "taustakartta", z: 12, x: 2320, y: 1120 }),
  "taustakartta sallittu");
check(parseMmlTilePath("/mml/ortokuva/13/4640/2240.png") === null, "ortokuva ei ole sallittujen tasojen listalla");
check(parseMmlTilePath("/mml/kiinteistojaotus/13/1/1.png") === null, "kiinteistöjaotus hylätään");
check(parseMmlTilePath(`/mml/selkokartta/${MML_Z_MAX + 1}/1/1.png`) === null, "zoom yli rajan hylätään");
check(parseMmlTilePath(`/mml/selkokartta/${MML_Z_MIN - 1}/1/1.png`) === null, "zoom alle rajan hylätään");
check(parseMmlTilePath("/mml/selkokartta/5/32/0.png") === null, "x yli 2^z-1 hylätään");
check(parseMmlTilePath("/mml/selkokartta/5/0/32.png") === null, "y yli 2^z-1 hylätään");
check(parseMmlTilePath("/mml/selkokartta/13/4640/2240.jpg") === null, "vain png");
check(parseMmlTilePath("/mml/selkokartta/13/4640/2240.png?api-key=x") === null, "pathname ei saa sisältää kyselyä");
check(parseMmlTilePath("/mml/../13/1/1.png") === null, "polkuhyppy hylätään");
check(parseMmlTilePath("") === null && parseMmlTilePath(undefined) === null, "tyhjä polku hylätään");

check(mmlRefererAllowed("") === true, "puuttuva Referer sallitaan (IP-raja kantaa)");
check(mmlRefererAllowed("https://demo.reittari.fi/?city=joensuu#/tulosteet/vihko") === true, "oma origin sallitaan");
check(mmlRefererAllowed("https://veikkoville.github.io/lsl-aikataulut/") === true, "github.io sallitaan");
check(mmlRefererAllowed("https://evil.example/kartta") === false, "vieras origin hylätään");
check(mmlRefererAllowed("https://demo.reittari.fi.evil.example/") === false, "etuliiteväärennös hylätään");
check(mmlRefererAllowed("ei-url") === false, "rikkinäinen Referer hylätään");

const png = mmlFallbackPng();
check(png.length > 50 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
  "varatiili on kelvollinen PNG (allekirjoitus 89 50 4E 47)");
check(png[16] === 0 && png[19] === 1 && png[20] === 0 && png[23] === 1, "varatiili on 1×1 pikseliä (IHDR)");

if (fail) { console.log(`\n${fail} FAIL`); process.exit(1); }
console.log("\nKAIKKI OK");

// Yksikkötestaa CMS-tiedotteen päättymispvm-jäsennyksen (parseValidUntil).
// Deterministinen, ei verkkoa. Aja: node cms-dates.test.js
import { parseValidUntil } from "./worker.js";

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };

// Julkaisupäivä-ankkuri (Aleksanterinkatu-tiedote feedissä)
const P = "2026-06-18T12:24:03";

// --- Suunnitelman testitapaukset (oikeasta feedistä) ---
check(parseValidUntil("Päivitetty: Aleksanterinkadun työmaan aikainen poikkeusreitti päättyy la 20.6.", P) === "2026-06-20",
  "päättyy la 20.6. (viikonpäivä-etuliite) → 2026-06-20");
check(parseValidUntil("Bussit poikkeusreiteillä Hollolassa 29.6.-31.7.2026", P) === "2026-07-31",
  "väli 29.6.-31.7.2026 → 2026-07-31");
check(parseValidUntil("Poikkeusreitti ja suljettuja pysäkkejä Mukkulassa 5.-7.6. ja 12.-14.6.", P) === "2026-06-14",
  "kaksi väliä → MAX 2026-06-14");
check(parseValidUntil("Poikkeusreitti Kytölässä koko kesäkauden – vaikuttaa linjoihin 10 ja 11", P) === null,
  "koko kesäkauden (ei pvm) → null");
check(parseValidUntil("Triathlon-tapahtuma vaikuttaa bussireitteihin Myllyojalla ja Vierumäellä la 27.6.2026", P) === null,
  "yksittäinen tapahtumapvm ilman loppuvihjettä → null (ei arvata)");
check(parseValidUntil("Aleksanterinkadun työmaa vaikuttaa bussireitteihin keskustassa 1.6. alkaen", P) === null,
  "DEFENSIIVINEN: 1.6. alkaen → null (alkaen-pvm ei ole loppu)");
check(parseValidUntil("Aleksanterinkadun työmaa vaikuttaa keskustassa 1.6. alkaen, poikkeusreitti päättyy 20.6.", P) === "2026-06-20",
  "alkaen + päättyy samassa → vain loppupvm 2026-06-20");

// --- Vuosi-inferenssi julkaisupäivästä ---
check(parseValidUntil("Poikkeus voimassa 5.1. asti", "2025-12-28T00:00:00") === "2026-01-05",
  "vuosi-inferenssi: 5.1. asti julkaistu 28.12.2025 → 2026-01-05 (seuraava vuosi)");
check(parseValidUntil("Poikkeus 20.6. asti", P) === "2026-06-20",
  "vuosi-inferenssi: 20.6. julkaistu 18.6.2026 → 2026-06-20 (sama vuosi)");

// --- Loppuvihje-muodot ---
check(parseValidUntil("Reitti poikkeaa 1.–20.6.", P) === "2026-06-20", "en-dash väli 1.–20.6. → 2026-06-20");
check(parseValidUntil("Reitti poikkeaa 1.—20.6.", P) === "2026-06-20", "em-dash väli 1.—20.6. → 2026-06-20");
check(parseValidUntil("Pysäkki pois käytöstä 30.9. saakka", P) === "2026-09-30", "saakka 30.9. → 2026-09-30");
check(parseValidUntil("Muutos voimassa 15.7.2026 mennessä", P) === "2026-07-15", "mennessä 15.7.2026 → 2026-07-15");

// --- Reuna- ja virhetilanteet (defensiivinen) ---
check(parseValidUntil("", P) === null && parseValidUntil(null, P) === null, "tyhjä/null teksti → null");
check(parseValidUntil("Linjat 3 ja 8 poikkeavat reitiltään", P) === null, "ei päivämäärää → null");
check(parseValidUntil("Työ päättyy 31.2.", P) === null, "epäpäivä 31.2. → null (hylätään)");
check(parseValidUntil("Poikkeus 5.6. asti", null) === null, "ei vuotta eikä ankkuria → null (ei arvata vuotta)");
check(parseValidUntil("Aikataulut klo 5.-7. välillä", P) === null, "kellonaikaväli ilman kuukautta → ei loppupvm:ää (null)");

console.log(fail ? `\n${fail} FAIL` : "\nKAIKKI OK");
process.exit(fail ? 1 : 0);

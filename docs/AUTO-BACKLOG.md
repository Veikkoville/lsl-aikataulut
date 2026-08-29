# Auto-kehityksen backlog

Tehtävät, jotka `auto-kehitys`-workflow (`.github/workflows/auto-kehitys.yml`) saa tehdä
itsenäisesti: yksi tehtävä per ajo, aina haaralle ja PR:ksi, ei koskaan suoraan masteriin.
Ylin avoin rivi menee ensin. Kirjoita tehtävä niin, että se on rajattu (yksi asia, yksi
tiedosto tai kaksi) ja todennettavissa (mitä pitää näkyä tai mikä testi vihertyy).

Mitä tänne EI laiteta: hinnat, myyntitekstit, CONFIGS-muutokset ilman feedimittausta,
sw.js-cacheversio, mikä tahansa deploy.

## Signaalit

Havainnot asiakkailta, tapaamisista ja vahdeista, joita ei ole vielä muutettu tehtäviksi.
Ylläpitäjä kirjaa ne tänne lyhyesti (kuka-tyyppi, mitä sanottiin, milloin; ei nimiä eikä
hintoja). Agentti muuttaa niistä backlog-rivejä kun Avoimet on tyhjä ja merkitsee käytetyn
signaalin "→ backlog <pvm>".

- 2026-08-26, kaupungin joukkoliikennetiimi tapaamisessa: pysäkkijuliste on heillä A4 ja siihen
  halutaan mahdollisimman paljon tietoa yhdelle arkille; he eivät tarjoa nyt painettavaa lainkaan.
  (Yhden arkin A4 on tehty 27.8.; tiheys ja luettavuus ovat auki.)
- 2026-08-27, kaupunki jossa ei ole reaaliaikadataa: livekartta näytti tyhjää. (→ backlog 28.8.,
  tehty PR #3.)
- 2026-08-24, kaupungin tekninen johto: kysyivät, missä data sijaitsee ja mitä tapahtuu jos
  toimittaja katoaa. Tuotteen on kestettävä tämä kysymys ilman erillistä paperia.
  (→ backlog 2026-08-29.)
- 2026-08-26, kaupungin joukkoliikennetiimi: pyysivät ryhmäkuljetusten tilausten käsittelyä
  (koulut ja päiväkodit varaavat auton, törmäystarkistus) ja palveluliikenteen kuljettajanäkymää
  (kuljettaja näkee päivän tilaukset). Kaupunki lähettää tarkemmat tiedot sähköpostilla.
  **Ei agentin tehtäväksi**: tämä on oma moduuli (ks. TUOTEPERIAATTEET.md), jonka rajaus ja
  tietosuoja päätetään ihmisen kanssa; kun tiedot tulevat, ylläpitäjä kirjoittaa osatehtävät
  Avoimet-listaan ja agentti toteuttaa ne yksi kerrallaan.

## Avoimet

- [ ] README.md: lisää lyhyt kohta joka vastaa suoraan kysymykseen "missä data on ja mitä
      tapahtuu jos toimittaja katoaa" (data luetaan aina suoraan kaupungin omasta
      Digitransit/Waltti-GTFS-syötteestä avoimella standardilla, Reittari ei tallenna omaa
      kopiota aikatauluista mihinkään, syötteen vaihto on `CONFIG`-muutos, ei koodimuutos).
      Todennus: kohta näkyy README.md:ssä Tekniikka-osion yhteydessä.
      (agentin ehdotus 2026-08-29, lähde: signaali 2026-08-24)
- [ ] worker/worker.js: toteuta admin-kirjautumiselle Cloudflare Access -JWT-varmennus
      (`Cf-Access-Jwt-Assertion`) kun `env.ADMIN_ACCESS_AUD` on asetettu, nykyisen
      salasanaistunnon rinnalle (ks. TODO-kommentti `isAdmin`-funktiossa). Todennus: uusi
      yksikkötestirivi worker/*.test.js:ään, joka hyväksyy kelvollisen JWT:n oikealla `aud`:lla
      ja hylkää väärän `aud`:n tai peukaloidun allekirjoituksen.
      (agentin ehdotus 2026-08-29, lähde: koodi/TODO)

## Tehdyt

- [x] Livekartan tyhjätila: kun kaupungin feedissä ei ole reaaliaikaa (esim. `?city=raasepori`),
      kartta näyttää nyt tyhjän ruudun. Näytä kartan päällä lyhyt tila "Tässä kaupungissa ei ole
      ajoneuvojen reaaliaikaseurantaa" ja pidä pysäkit näkyvissä. Todennus: smoke-lisäys joka
      avaa livekartan Raaseporissa ja odottaa tilatekstiä; Lahdessa tekstiä ei saa näkyä. (PR, 2026-08-28)
- [x] Pysäkkimonitori (kioski, `#/monitori`): kun verkkoyhteys katkeaa, jalkatekstin "Päivittyy
      reaaliajassa" jäi näyttöön ja lähtöjen minuuttilaskuri jäätyi hetkeen jolloin yhteys
      katkesi, vaikka data ei enää päivittynyt. Näytä nyt sama "ei yhteyttä, viimeksi päivitetty"
      -tila kuin pysäkkisivulla; lähdöt pysyvät ruudulla mutta tila ei enää väitä olevansa
      reaaliaikainen. Todennus: smoke simuloi yhteyskatkon (`page.setOfflineMode`)
      monitorinäkymässä ja odottaa `#mLive`:n vaihtuvan ei yhteyttä -tilaan lähtörivien
      säilyessä. (agentin ehdotus 2026-08-29, lähde: koodi/käyttäjäpolku) (PR, 2026-08-29)

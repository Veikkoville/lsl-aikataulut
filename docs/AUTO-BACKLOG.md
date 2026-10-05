# Auto-kehityksen backlog

Tehtävät, jotka `auto-kehitys`-workflow (`.github/workflows/auto-kehitys.yml`) saa tehdä
itsenäisesti: yksi tehtävä per ajo, aina haaralle ja PR:ksi, ei koskaan suoraan masteriin.
Ylin avoin rivi menee ensin. Kirjoita tehtävä niin, että se on rajattu (yksi asia, yksi
tiedosto tai kaksi) ja todennettavissa (mitä pitää näkyä tai mikä testi vihertyy).

Mitä tänne EI laiteta: hinnat, myyntitekstit, CONFIGS-muutokset ilman feedimittausta,
sw.js-cacheversio, mikä tahansa deploy.

## Signaalit

Havainnot asiakkailta, tapaamisista ja vahdeista, joita ei ole vielä muutettu tehtäviksi.
Ylläpitäjä kirjaa ne tänne lyhyesti: kuka-tyyppi, mitä tarvittiin ja kuukausi. Repo on julkinen,
joten ei kuntien eikä henkilöiden nimiä, ei tarkkoja päivämääriä, ei sitaatteja eikä hintoja.
Agentti muuttaa niistä backlog-rivejä kun Avoimet on tyhjä ja merkitsee käytetyn signaalin
"→ backlog <pvm>".

- 2026-08, kaupungin joukkoliikennetiimi tapaamisessa: pysäkkijuliste on heillä A4 ja siihen
  halutaan mahdollisimman paljon tietoa yhdelle arkille; he eivät tarjoa nyt painettavaa lainkaan.
  (Yhden arkin A4 tehty 27.8.; 2.9. rakennettu uusiksi tunti × linja -matriisiksi, 8 linjaa 12 pt:llä
  yhdellä arkilla. → tehty 2.9.)
- 2026-09, useampi kaupunki peräkkäin vertasi palvelua omaan reittioppaaseensa ja piti niitä
  pitkälti samanlaisina. Ensimmäinen ruutu oli A→B-haku, ja ostaja luokitteli palvelun sen mukaan.
  (→ tehty 2.9.: layer-kaupungin etusivu avaa julisteet, vihot,
  tiskin ja muutosvahdin; A→B alimpana. Muutosvahti (tests/muutosvahti.js + tulostekeskuksen välilehti)
  vastaa kysymykseen jota reittiopas ei tee: mitkä julisteet pitää tulostaa uudelleen.)
- 2026-08, kaupunki jossa ei ole reaaliaikadataa: livekartta näytti tyhjää. (→ backlog 28.8.,
  tehty PR #3.)
- 2026-08, kaupungin tekninen johto: kysyivät, missä data sijaitsee ja mitä tapahtuu jos
  toimittaja katoaa. Tuotteen on kestettävä tämä kysymys ilman erillistä paperia.
  (→ backlog 2026-08-29.)
- 2026-08, kaupungin joukkoliikennetiimi: pyysivät ryhmäkuljetusten tilausten käsittelyä
  (koulut ja päiväkodit varaavat auton, törmäystarkistus) ja palveluliikenteen kuljettajanäkymää
  (kuljettaja näkee päivän tilaukset). Kaupunki lähettää tarkemmat tiedot sähköpostilla.
  **Ei agentin tehtäväksi**: tämä on oma moduuli (ks. TUOTEPERIAATTEET.md), jonka rajaus ja
  tietosuoja päätetään ihmisen kanssa; kun tiedot tulevat, ylläpitäjä kirjoittaa osatehtävät
  Avoimet-listaan ja agentti toteuttaa ne yksi kerrallaan.

Markkinasignaalit tulevat HILMAn ennakoivista ilmoituksista (tietopyynnöt ja
markkinavuoropuhelut). Agentti käsittelee ne samoin kuin tapaamisista kirjatut signaalit.

- 2026-08-28, markkinasignaali (HILMAn ennakoivat ilmoitukset, 3 eri hankintayksikköä 2022-2026): kuntien tietopyynnöissä ja markkinavuoropuheluissa toistuu aihe: tapahtuma- ja harrastuskalenterit kuntalaisille. Osuu tuotteeseen: Kalenteri (sama moottori, toinen data).
- 2025-05-27, markkinasignaali (HILMAn ennakoivat ilmoitukset, 2 eri hankintayksikköä 2025): kuntien tietopyynnöissä ja markkinavuoropuheluissa toistuu aihe: ulko- ja sisätiloihin sijoitettavat infonäytöt ja niiden sisältö. Osuu tuotteeseen: Reittari, monitorinäkymä.
- 2023-12-20, markkinasignaali (HILMAn ennakoivat ilmoitukset, 2 eri hankintayksikköä 2021-2023): kuntien tietopyynnöissä ja markkinavuoropuheluissa toistuu aihe: aikataulu- ja pysäkkitiedon jakaminen pysäkkinäytöille. Osuu tuotteeseen: Reittari.
- 2026-08-28, markkinasignaali (sama hankintayksikkö kysynyt 2 kertaa, vuosina 2023 ja 2026): aihe ei ole ratkennut ostolla, eli tarjonta ei ole kelvannut. Aihe: tapahtuma- ja harrastuskalenterit kuntalaisille. Osuu tuotteeseen: Kalenteri (sama moottori, toinen data).

## Avoimet

- [x] `tests/kausivalidointi.js`: serviceId-luokitin tuntee vain koulun ja loman
      (`/koul/i`, `KP`, `/loma/i`, `LP`), joten kausi- ja viikonpaivavariantit
      putoavat luokittelemattomiksi ja jokainen kausivaihdos tuottaa WARN-riveja joita ei voi
      erottaa aidosta muutoksesta. Ajossa 2026-08-25 tuli 7 WARNia, 22 uutta serviceId:ta,
      joista 15 ilman luokkaa. Lisaa luokat "kausi" (talvi, kesa, syksy, kevat) ja "viikonpaiva"
      (la-su, ma-pe, ma-to, MaPe, MaTo, La, Su) ja jata WARN vain sille mika jaa yha
      tuntemattomaksi. Todennus: uusi yksikkotesti joka syottaa luokittimelle 2026-08-25 ajon
      oikeat serviceId:t fixtureina ja odottaa, etta jouluaatto ja joulupaiva luokittuvat
      lomaksi, talvi- ja la-su-variantit uusiin luokkiin, ja tuntemattomien maara putoaa
      15:sta korkeintaan kahteen.
      (tutkimuskierros 2026-08-31, lahde: kausivalidointi-ajo 2026-08-25, run 32812513577)
      TARKENNUS 2026-09-25 (PR #21 suljettu, katselmointi): (1) fixtuurit poimitaan ajon 32812513577
      lokin serviceId-uudet-riveilta sellaisinaan, ei keksita; (2) koul/loma kopioidaan index.html:n
      saannosta (ei koulp ja koulujen loma-ajat = loma, 25.9.2026); (3) tapahtumavuorot jaavat
      tuntemattomiksi: "Lahti:2026-2027 La Historic Rally" EI saa luokittua viikonpaivaksi pelkan
      La-sanan takia (rally, fest, lisat, yksittainen paivamaara); (4) WARN muuttuu PASS-riviksi vain
      kun kaikki uudet serviceId:t luokittuvat, muuten WARN kuten ennen.
      FIXTUURIT 2026-10-01 (yllapitaja poimi, vastaus PR #28:n kysymykseen): ajon 32812513577
      22 uutta serviceId:ta sellaisinaan. Lahde: artefakti kausivalidointi-raportti
      (kausivalidointi-tulos.json, baselineEhdotus miinus tests/kausivalidointi-baseline.json
      commitissa 5a7dd9e), tasmaa lokin serviceId-uudet-riveihin (lokissa Oulun lista katkeaa
      kuuden jalkeen). Kopioi merkkijonot tasmalleen, myos aakkoset:
        lahti: "Lahti:2026-2027 La Historic Rally"
        salo: "Salo:Koulup_2026_lisävuorot_syksy"
        kajaani: "Kajaani:Koulu p keskiviikko", "Kajaani:koulup ma,ke,to,pe"
        kotka: "Kotka:2026-2027 TALVI Jouluaatto2026", "Kotka:2026-2027 TALVI Joulupäivä2026"
        raasepori: "Raasepori:BOSSE_talvi_ma-to", "Raasepori:BOSSE_talvi_pe",
          "Raasepori:ME_kesaAW_la-su", "Raasepori:ME_talviAW_la-su"
        jyvaskyla: "LINKKI:SEUTU L talvi"
        oulu: "OULU:T_T 26-27 59 La", "OULU:T_T 26-27 59 MaPe", "OULU:T_T 26-27 59 Su",
          "OULU:T_T 26-27 La alk 14_9", "OULU:T_T 26-27 La alk 24_8",
          "OULU:T_T 26-27 MaTo KP alk 14_9", "OULU:T_T 26-27 MaTo KP alk 24_8",
          "OULU:T_T 26-27 Pe KP alk 14_9", "OULU:T_T 26-27 Pe KP alk 24_8",
          "OULU:T_T 26-27 Su alk 14_9", "OULU:T_T 26-27 Su alk 24_8"
      Nykyinen luokitin: 7 koul (Salo 1, Kajaani 2, Oulun 4 KP-tunnistetta), 15 ilman luokkaa
      (ajon WARN-rivien summa). Tarkennuksen (3) mukaan "La Historic Rally" jaa tuntemattomaksi. (PR, 2026-10-02)

## Tehdyt

- [x] worker/worker.js: toteuta admin-kirjautumiselle Cloudflare Access -JWT-varmennus
      (`Cf-Access-Jwt-Assertion`) kun `env.ADMIN_ACCESS_AUD` on asetettu, nykyisen
      salasanaistunnon rinnalle (ks. TODO-kommentti `isAdmin`-funktiossa). Todennus: uusi
      yksikkötestirivi worker/*.test.js:ään, joka hyväksyy kelvollisen JWT:n oikealla `aud`:lla
      ja hylkää väärän `aud`:n tai peukaloidun allekirjoituksen.
      (agentin ehdotus 2026-08-29, lähde: koodi/TODO) (PR, 2026-09-04)
- [x] README.md: lisää lyhyt kohta joka vastaa suoraan kysymykseen "missä data on ja mitä
      tapahtuu jos toimittaja katoaa" (data luetaan aina suoraan kaupungin omasta
      Digitransit/Waltti-GTFS-syötteestä avoimella standardilla, Reittari ei tallenna omaa
      kopiota aikatauluista mihinkään, syötteen vaihto on `CONFIG`-muutos, ei koodimuutos).
      Todennus: kohta näkyy README.md:ssä Tekniikka-osion yhteydessä.
      (agentin ehdotus 2026-08-29, lähde: signaali 2026-08-24) (PR, 2026-09-03)
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

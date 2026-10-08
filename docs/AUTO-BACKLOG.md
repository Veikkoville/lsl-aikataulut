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

- 2026-08, markkinasignaali (HILMAn ennakoivat ilmoitukset, 3 eri hankintayksikköä 2022-2026): kuntien tietopyynnöissä ja markkinavuoropuheluissa toistuu aihe: tapahtuma- ja harrastuskalenterit kuntalaisille. Osuu tuotteeseen: Kalenteri (sama moottori, toinen data).
- 2025-05, markkinasignaali (HILMAn ennakoivat ilmoitukset, 2 eri hankintayksikköä 2025): kuntien tietopyynnöissä ja markkinavuoropuheluissa toistuu aihe: ulko- ja sisätiloihin sijoitettavat infonäytöt ja niiden sisältö. Osuu tuotteeseen: Reittari, monitorinäkymä.
- 2023-12, markkinasignaali (HILMAn ennakoivat ilmoitukset, 2 eri hankintayksikköä 2021-2023): kuntien tietopyynnöissä ja markkinavuoropuheluissa toistuu aihe: aikataulu- ja pysäkkitiedon jakaminen pysäkkinäytöille. Osuu tuotteeseen: Reittari.
- 2026-08, markkinasignaali (sama hankintayksikkö kysynyt 2 kertaa, vuosina 2023 ja 2026): aihe ei ole ratkennut ostolla, eli tarjonta ei ole kelvannut. Aihe: tapahtuma- ja harrastuskalenterit kuntalaisille. Osuu tuotteeseen: Kalenteri (sama moottori, toinen data).

## Avoimet

- [ ] index.html: rivien noin 12957 ja 12985 merkkijonoissa on oikea NUL-tavu lainausmerkkien välissä
      (`(r.shortName || "") + "<NUL>" + kilpi` ja `(L.route.shortName || "") + "<NUL>" + L.headsign`).
      Korvaa tavu lähdekoodissa escape-merkinnällä `\u0000`, jolloin ajonaikainen avain pysyy samana.
      Tee korvaus node-skriptillä (Edit-työkalu ei välttämättä osu NUL-merkkiin). Syy: NUL-tavun takia
      ripgrep ja Grep-työkalu pitävät index.html:ää binäärinä ja ohittavat sen koko repon haussa
      (`rg -c deskHomeStop .` ei listaa index.html:ää, vaikka osumia on 27). Lisää
      tests/tiedostohygienia.test.js: lukee `git ls-files` -listan (tai argumenttina annetut tiedostot), ohittaa
      png/pdf/woff/woff2/ttf/otf/ico/jpg/mp3, ja kaatuu jos tekstitiedostossa on NUL-tavu; lisää se
      tests/package.json:n test-ketjun alkuun. Todennus: `node tests/tiedostohygienia.test.js` = 0;
      sama testi argumentilla, joka osoittaa NUL-tavun sisältävään väliaikaiseen tiedostoon = 1 (mutaatiotodiste
      PR:n runkoon, tiedosto poistetaan); `git diff --stat` näyttää index.html:ssä 2 muutettua riviä;
      `node --check` pääskriptille. (auditointi 2026-10-08, lähde: koodi)
- [ ] index.html + worker/worker.js: analytiikan `search_fail` ei saa välittää vapaata tekstiä, josta voi
      tunnistaa henkilön. Nyt `bindUnifiedSearch` (rivi noin 11324) lähettää tuloksettoman haun tekstin
      `track("search_fail", q)` 80 merkkiin asti, joten esimerkiksi kotiosoite tallentuu analytiikkaan.
      Lisää index.html:ään puhdas funktio `searchSignal(q)`: trimmaa ja muuttaa pienaakkosiksi, ja palauttaa
      tekstin vain jos se on enintään 40 merkkiä eikä sisällä @-merkkiä eikä numeroa (poikkeus: koko teksti on
      pelkkä linjatunnus, `/^[0-9]{1,3}[a-zåäö]?$/`); muuten luokan `"[sposti]"`, `"[numero]"` tai `"[pitka]"`
      tässä järjestyksessä. Kutsu `track("search_fail", searchSignal(q))`. Worker: `buildTrackEvent` soveltaa
      samaa sääntöä tyyppiin `search_fail` (vaikuttaa vasta worker-deployn jälkeen, ihmisen lupa); päivitä
      worker/push-logic.test.js:n rivi noin 484 (200 merkin arvo -> `"[pitka]"`). Korjaa `track()`-funktion
      yläpuolinen kommentti vastaamaan sääntöä. Todennus: push-logic.test.js:ään rivit: "Kotikatu 12" ->
      "[numero]", "Kauppatori" -> "kauppatori", "22K" -> "22k", 41 merkkiä -> "[pitka]", "a@b.fi" -> "[sposti]";
      `cd worker && npm test` = 0; smokessa `page.evaluate(() => searchSignal("Kotikatu 12"))` = "[numero]" ja
      `searchSignal("Kauppatori")` = "kauppatori"; `node --check` pääskriptille. (auditointi 2026-10-08,
      lähde: koodi; periaate tarkennettu TUOTEPERIAATTEET.md:ssä 2026-10-08)
- [ ] index.html: näkymän vaihto vie sivun alkuun ja siirtää fokuksen näkymän otsikkoon. Nyt `route()`
      (rivi noin 25726) piirtää uuden näkymän, mutta vieritys jää ennalleen (mittaus tuotannosta: scrollY 1367
      ennen ja jälkeen, otsikko -1228 px) ja fokus jää BODYyn; koodissa ei ole yhtään `scrollTo(0`. Kun hash-polun
      ensimmäinen tai toinen osa muuttuu (ei saman näkymän automaattipäivityksessä eikä pelkän query-parametrin
      muutoksessa), kutsu piirron jälkeen `window.scrollTo(0, 0)` ja siirrä fokus `#app`in ensimmäiseen `h1`- tai
      `h2`-otsikkoon (`tabindex="-1"`, `focus({ preventScroll: true })`). Todennus: smoke-lisäys Lahden lohkoon:
      etusivulla `window.scrollTo(0, 1500)`, vaihda hash linjasivulle, odota otsikko, assertoi `scrollY < 50` ja
      `document.activeElement.matches("#app h1, #app h2")`. Assertoi rakennetta, ei UI-tekstiä.
      (auditointi 2026-10-08, lähde: tuotantomittaus + koodi)
- [ ] index.html: `aria-live` pois `<main id="app">`:sta (rivi noin 2717). Nyt ruudunlukija lukee koko sivun
      jokaisessa siirtymässä (linjasivulla 10 769 merkkiä) ja pysäkin lähtötaulukon 30 sekunnin välein. Lisää
      `<main>`in ulkopuolelle `<div id="srStatus" class="sr-only" role="status" aria-live="polite"></div>`
      (`.sr-only` on jo olemassa) ja funktio `announce(teksti)`, joka kirjoittaa siihen. `route()` kutsuu
      `announce`a näkymän otsikolla, kun näkymä vaihtuu; lähtötaulukon automaattipäivitys ei kutsu sitä.
      Todennus: smoke-lisäys: `#app` ei sisällä `aria-live`-attribuuttia, `#srStatus` on olemassa ja sen teksti on
      linjasivulle siirtymisen jälkeen ei-tyhjä; PR:n runkoon maininta, mistä kohdasta automaattipäivitys kulkee ja
      ettei se kutsu `announce`a. (auditointi 2026-10-08, lähde: koodi + tuotantomittaus)
- [ ] index.html: rajapintavirheet selkokielisiksi ja toipuviksi. Nyt `throw new Error(t("errApi") + "HTTP " +
      res.status)` (rivi noin 8108) näkyy käyttäjälle muodossa "Rajapintavirhe: HTTP 429", verkkovirhe
      englanniksi "Failed to fetch", eikä uusintaa ole. Tee: (1) GraphQL-haulle 8 s aikakatkaisu
      `AbortController`illa; (2) yksi automaattinen uusinta 2 s viiveellä tiloille 429, 502, 503, 504 ja
      aikakatkaisulle; (3) käyttäjälle uusi käännösteksti fi/sv/en ("Aikataulutietoja ei juuri nyt saada. Yritä
      hetken päästä uudelleen." tai vastaava) ja painike "Yritä uudelleen" (luokka `err-retry`), joka piirtää
      näkymän uudelleen; tekninen tila vain `console.warn`iin; (4) Asetukset-linkki pois virhenäkymästä.
      Offline-tilan nykyinen toiminta (välimuistin data) ei saa muuttua. Todennus: smoke-lisäys:
      `page.setRequestInterception` vastaa proxyn GraphQL-pyyntöihin 503, avaa pysäkkisivu, odota `.err-retry`,
      assertoi ettei näkyvässä tekstissä ole merkkijonoja "HTTP" eikä "Failed"; poista interceptio, klikkaa
      `.err-retry`, odota lähtötaulukko. Palauta interceptio pois lohkon lopussa (smoke on tilallinen).
      (auditointi 2026-10-08, lähde: tuotanto + koodi)
- [ ] index.html: kuntalaisnäkymän (`APP_MODE === "resident"`) etusivulla ei näytetä henkilöstön reittejä.
      Nyt `homeToolGroupsHtml` (rivi noin 11751) näyttää linkit "Tulosteet ja näytöt" (`#/tulosteet/...`) ja
      `#/uusintapainatus`, mutta `route()` (rivi noin 25737) ohjaa `STAFF_ROUTES`-reitit kuntalaistilassa
      etusivulle, joten linkit ovat kuolleita. Suodata `homeToolGroupsHtml`:ssä pois linkit, joiden reitin
      ensimmäinen osa on `STAFF_ROUTES`issa, kun `APP_MODE === "resident"`. Henkilöstötila ei muutu. Todennus:
      smoke-lisäys kuntalaistilassa: etusivun `a[href^="#/"]`-linkeistä yhdenkään ensimmäinen polkuosa ei ole
      `STAFF_ROUTES`issa (lue joukko sivulta `page.evaluate`illa); henkilöstötilassa linkit ovat yhä mukana.
      (auditointi 2026-10-08, lähde: tuotantoklikkaus + koodi)
- [ ] tests/smoke.test.js: saavutettavuuden perustarkistus ilman uusia riippuvuuksia. Uusi apufunktio
      `a11yPerus(page, label)` laskee näkyvästä DOMista: (1) `input`, `select` ja `textarea` ilman saavutettavaa
      nimeä (label[for], ympäröivä label, aria-label, aria-labelledby), (2) `button` ja `a[href]` ilman tekstiä tai
      aria-labelia, (3) `img` ilman `alt`-attribuuttia, (4) toistuvat `id`:t, (5) `<html lang>` vastaa
      käyttöliittymän kieltä. Aja Lahden etusivulle, pysäkkisivulle, linjasivulle, palvelutiskille ja
      tulostekeskukseen; FAIL listaa enintään 5 rikkojaa selektoreineen. Assertoi rakennetta, ei UI-tekstiä.
      Jos nykyinen sivu rikkoo jotain ja korjaus on alle 30 riviä, korjaa index.html:ssä samassa PR:ssä; muuten
      kirjaa rikkojat PR:n runkoon ja jätä kyseinen kohta INFO-tasolle. Todennus: `node --check
      tests/smoke.test.js`; CI:n smoke näyttää viisi uutta OK-riviä tai INFO-rivit rikkojineen.
      (auditointi 2026-10-08, lähde: TUOTEPERIAATTEET "Saavutettavuus on osa määritelmää"; smokessa 0 axe-ajoa)
- [x] tests/prod-smoke.test.js: mikkelin `posterStopId` "Mikkeli:310514" -> "Mikkeli:310523" (Hallitustori 1T)
      ja kommenttiin syy. 310514 (Hallitustori Raatihuone I) antaa pysäkkijulisteeseen vain 1 lähdön,
      koska muut sen vuorot päättyvät viereiselle laiturille, ja julistetarkistus hyväksyy sen
      (`poster.days >= 1`), joten vahti ei huomaisi julisteen tyhjenemistä. Mitattu ylläpitäjän
      ajossa 2026-10-08 tuotannosta (demo.reittari.fi, sama klikkaussekvenssi kuin kohdassa 5):
      310514 = 1 lähtö, 310523 = 34/14/11 lähtöä (Ma-Pe/La/Su). Älä muuta index.html:n
      `deskHomeStop`ia. Todennus: `node --check tests/prod-smoke.test.js` ja kausivaihtovahdin
      (kohta 4b) logiikalla 310523:lla on lähtöjä seuraavana arkipäivänä (proxyn
      `stoptimesWithoutPatterns`, Origin https://demo.reittari.fi). (ylläpitäjä 2026-10-08) (PR, 2026-10-08)
- [x] worker/worker.js: `/feedback/list` ottaa avaimen vastaan myös `Authorization: Bearer <avain>`
      -otsakkeesta (query-parametri `key` jää toistaiseksi toimimaan), ja CORS sallii
      `Authorization`-otsakkeen. Syy: query-parametrina avain päätyy lokeihin, selainhistoriaan ja
      Refereriin (ks. HUOM `handleFeedbackList`issa). Todennus: uusi rivi worker/write-guard.test.js:ään:
      oikea avain otsakkeessa 200, väärä 403, ilman avainta 403, query-avain toimii yhä.
      (agentin ehdotus 2026-10-06, lähde: koodi/HUOM worker.js) (PR, 2026-10-06)
- [ ] README.md: lisää Ominaisuudet-osioon lyhyt kohta pysäkkimonitorista (`#/monitori/<pysäkkiId>`):
      koko ruudun live-lähtötaulu, jonka kaupunki voi avata infonäytölle tai kioskiselaimeen ilman
      ylläpitoa. Todennus: kohta näkyy README.md:ssä, URL-muoto täsmää index.html:n reittiin ja
      kohdassa ei ole hintoja. (agentin ehdotus 2026-10-06, lähde: signaalit 2025-05-27 ja 2023-12-20,
      markkinasignaalit infonäytöistä ja pysäkkinäytöistä)
- [ ] README.md: lisää Tekniikka-osioon testien ajo-ohje (worker-yksikkötestit, `node --check
      tests/smoke.test.js`, kausivalidoinnin luokitintesti `node tests/kausivalidointi-luokitin.test.js`),
      koska README ei mainitse testejä lainkaan. Todennus: jokainen mainittu komento ajettuna
      repon juuressa tai worker-kansiossa päättyy koodiin 0. (agentin ehdotus 2026-10-06, lähde: koodi/testit)

- [x] `tests/kausivalidointi.js`: serviceId-luokitin tuntee vain koulun ja loman
      (`/koul/i`, `\bKP\b`, `/loma/i`, `\bLP\b`), joten kausi- ja viikonpaivavariantit
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

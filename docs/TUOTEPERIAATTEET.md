# Reittarin tuoteperiaatteet (auto-kehityksen ideointia varten)

Tämä tiedosto kertoo auto-kehitysagentille, mikä tuote on ja mikä ei, jotta sen itse
ehdottamat backlog-rivit osuvat oikeaan. Ei hintoja eikä myyntistrategiaa: ne eivät kuulu
tähän repoon.

## Mikä Reittari on

Kaupungin joukkoliikenteen aikataulupalvelu, joka lukee kaiken suoraan kaupungin omasta
GTFS-syötteestä (Digitransit) eikä vaadi ylläpitoa. Kolme käyttäjää, tässä järjestyksessä:

1. **Palvelutiski** (kaupungin asiakaspalvelija): hakee asiakkaalle lähdöt, tulostaa
   aikataulun paperille, neuvoo reitin. Tiski on tuotteen kärki.
2. **Matkustaja** kotona tai pysäkillä: pysäkkihaku, linjan aikataulu, lähdöt nyt,
   puhe (mikrofoni ja lue ääneen), FI/SV/EN, PWA offline.
3. **Joukkoliikennepäällikkö**: tulosteet kausivaihdoksiin (käytävätuloste, pysäkkijuliste,
   vihko A5, lehtiteline, yhden arkin A4), häiriötiedotteet admin-sivulta.

Monikaupunkinen: `CONFIGS` + `?city=`; sama koodi toimii kaikissa kaupungeissa. Live-data,
ei käsin ylläpidettävää aikataulua missään.

## Periaatteet, joita ehdotusten on noudatettava

- **Printti ja tiski ennen näyttöä.** Parannus, joka tekee tulosteesta luettavamman tai
  tiskistä nopeamman, on arvokkaampi kuin uusi ruutuominaisuus.
- **Virhe ja luettavuus ennen uutta ominaisuutta.** Jos jokin nykyinen näkymä hämmentää,
  näyttää tyhjää tai valehtelee (esim. vanha data, väärä kausi), se korjataan ensin.
- **Data tulee aina feedistä.** Ei kovakoodattuja aikatauluja, pysäkkilistoja tai linjoja.
  Kaupunkikohtainen `CONFIG` saa sisältää vain sen, mitä feedi ei kerro (presetit, värit,
  lippujen hinnat viittauksineen, linkit).
- **Yksi tiedosto, vanilla JS, ei build-vaihetta, ei uusia riippuvuuksia.** Vendoroidut
  kirjastot (Leaflet, qrcode) ovat poikkeus, eikä niitä lisätä.
- **Saavutettavuus on osa määritelmää**: kontrasti, näppäimistö, ruudunlukija, selkeä
  suomi. Ei em dashia (—) missään tekstissä.
- **Jokainen muutos toimii kaikissa kaupungeissa.** Jos ehdotus koskee yhtä kaupunkia, sen
  on mentävä `CONFIG`-lipun taakse, kuten `vehicleRealtime: false`.
- **Smoke on sopimus.** Uusi käyttäytyminen saa smoke-tarkistuksen; smoke ei saa hyväksyä
  virhetilan varajärjestelyä ("ei lähtöjä") onnistumisena.

## Mitä agentti ei ehdota itse

Kaksi luokkaa. Ensimmäinen on asioita, joita ei rakenneta lainkaan:

- Reittiopasta: reittihaku ohjataan kaupungin omaan tai Digitransitin reittioppaaseen.
- Lippujen myyntiä, maksamista, matkakortteja.
- Reaaliaikaista ajojärjestelyä tai reittioptimointia (kutsuohjausjärjestelmien scope).
- Natiivisovellusta tai sovelluskauppajakelua (PWA riittää).
- Mainoksia, käyttäjäkohtaista seurantaa, evästeitä tai evästebannereita. Sallittu on anonyymi,
  koostettu käyttötilasto (`track()`: ei tunnisteita, ei evästeitä, ei IP-osoitteita, Do Not Track
  kunnioitetaan), kunhan se ei välitä vapaata tekstiä, josta voi tunnistaa henkilön (2026-10-08).

Toinen on asioita, jotka **rakennetaan, mutta erikseen päätettynä hankkeena**, ei yöllisen
agentin omana ehdotuksena, koska niiden rajaus, tietosuoja ja hinnoittelu päätetään ihmisen
kanssa ennen ensimmäistä riviä:

- **Tilausmoduuli ja kuljettajanäkymä** (ryhmäkuljetusten varaukset törmäystarkistuksella,
  kuljettajan päivälista): kaupungin pyytämä, oma moduuli samalla alustalla. Kun se on
  päätetty ja rajattu, sen osatehtävät tulevat backlogiin ylläpitäjän kirjoittamina, ja
  agentti toteuttaa ne kuten muutkin rivit.

Lisäksi agentti ei koskaan muuta hintoja, myyntitekstejä tai esitteitä, eikä sw.js:n
cache-versiota (tehdään käsin julkaisun yhteydessä).

## Tuotekehityksen suunta (2026-10-08)

Ylläpitäjän linjaus: tuote paranee jatkuvasti, ja tuotekehitys on itsekin automaatiota. Kun agentti ideoi,
vähintään yksi kolmesta rivistä osuu näihin teemoihin. Järjestys: ensin se, mitä yleinen julistegeneraattori tai
kopio ei pysty tekemään, eli oikeellisuus ja muutokset.

1. **Poikkeukset ennen kuin matkustaja huomaa ne:** loma-ajat, pyhät ja perutut vuorot feedistä ruudulle,
   monitoriin ja tulosteisiin.
2. **Muutokset näkyviksi:** muutosvahti kertoo, mitä muuttui, ja tulosteet tarkistetaan automaattisesti ennen painoa.
3. **Datan laatu kunnalle:** feedin virheet ja puutteet koottuna ennen kuin matkustaja kohtaa ne.
4. **Tulosteiden tuotanto valmiiksi:** koot, määrät, painojärjestys ja vain muuttuneiden uusintapainatus.
5. **Todistettu saavutettavuus:** ruudunlukija, näppäimistö ja 320 px suurimmalla tekstikoolla jokaisessa näkymässä.
6. **Kunnalle näkyvä tieto käytöstä:** mitä kuntalaiset etsivät löytämättä, anonyymisti periaatteen mukaan.
7. **Monikielisyys ilman lisätyötä:** tiedotteet ja tekstit ruotsiksi ja englanniksi ihmisen hyväksymänä.
8. **Tiski vastaa kysymykseen:** suorat yhteydet ja lähdöt feedin datasta, lähde näkyvissä, tulostettava.
9. **Näytöt ja ensimmäinen ruutu:** monitori valmiina infonäytölle, kuntalaisen etusivu alkaa lähimmistä lähdöistä.

Tekoälyä käytetään ilman maksullista kielimallirajapintaa (selaimen omat rajapinnat ja deterministinen logiikka
feedin datasta), kunnes ylläpitäjä toisin päättää.

## Mistä ideat haetaan, tässä järjestyksessä

Teemat tulevat luvusta Tuotekehityksen suunta. Lähteet tässä järjestyksessä:

1. `docs/AUTO-BACKLOG.md` lohko **Signaalit**: asiakkailta ja tapaamisista tulleet havainnot,
   jotka ylläpitäjä on kirjannut. Nämä ovat arvokkaimpia.
2. Testien ja vahtien löydökset: `tests/kausivalidointi.js` (kausivaihdokset), smoke-raportit,
   `tests/prod-smoke-report.txt` jos se on repossa.
3. Koodin omat `TODO`- ja `HUOM`-kommentit `index.html`:ssä ja `worker/`-kansiossa.
4. Käyttäjäpolun läpikäynti: mitä tiski tekee ensimmäisen 30 sekunnin aikana, missä se
   takkuaa.

## Hyvän backlog-rivin muoto

Yksi asia, yksi tai kaksi tiedostoa, alle 300 riviä, ja todennus sanottuna: mikä testi
vihertyy tai mitä pitää näkyä ja missä kaupungissa. Jos et osaa sanoa todennusta, ehdotus
ei ole valmis.

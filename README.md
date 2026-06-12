# Lahden bussiaikataulut (epävirallinen prototyyppi)

Kevyt aikataulupalvelu Lahden seudun liikenteen (LSL) busseille. Yksi staattinen
HTML-sivu ilman backendia ja build-vaihetta — kaikki data haetaan suoraan
Digitransitin avoimesta Waltti-rajapinnasta, joten aikataulut pysyvät ajan
tasalla ilman ylläpitoa.

**Tämä ei ole LSL:n virallinen palvelu.**

## Ominaisuudet

- **Reittihaku A→B** (planConnection): osoite-, paikka- tai pysäkkihaku
  (Digitransit Geocoding / Pelias), lähtö- tai saapumisaika, reittiehdotukset
  legeineen ja karttoineen; suodattimet "esteetön reitti" ja "vähemmän kävelyä"
- **Etusivulla lähimmät lähdöt heti**: paikannuksen salliessa 5 lähimmän
  pysäkin seuraavat lähdöt reaaliajassa ilman yhtään hakua
- **Suosikit**: tähtää pysäkki tai linja, niin se nousee etusivun kärkeen
  (pysäkeille reaaliaikaiset lähdöt)
- Kaikki LSL:n bussilinjat suodatettavana listana
- Linjakohtainen aikataulu valitulle päivälle suunnittain — tänään-näkymässä
  reaaliaikainen countdown ja ●-merkityt reaaliaika-arviot
- Pysäkkikohtaiset seuraavat lähdöt **reaaliajassa** (GTFS-RT), päivittyy 30 s välein
- Pysäkkihaku nimellä ja lähimmät pysäkit selaimen paikannuksella
- Voimassa olevat häiriötiedotteet etusivulla ja linjakohtaisesti linjasivulla
- Esteettömyys: esteettömän kaluston (♿) ja pysäkin esteettömyyden näyttö,
  kun syöte sisältää tiedon; Lighthouse-saavutettavuus 100/100
- Täyttöaste (🟢🟡🟠🔴) lähtöriveillä ja reittiehdotuksissa, *jos* liikennöitsijä
  julkaisee sen — LSL:n syöte antaa toistaiseksi `NO_DATA_AVAILABLE`, jolloin
  ikonia ei näytetä lainkaan (degrade gracefully)
- Reittikartta linjasivulla (reittiviiva + klikattavat pysäkit) ja sijaintikartta
  pysäkkisivulla (Leaflet + OpenStreetMap, ladataan vasta tarvittaessa)
- Linjan bussit liikkuvat kartalla reaaliajassa (Waltti GTFS-RT,
  mqtt.digitransit.fi)
- Tulostettava / PDF:ksi tallennettava linja-aikataulu
- Asennettavissa puhelimen kotinäytölle (PWA)

## Käyttöönotto

1. Rekisteröi ilmainen API-avain: <https://portal-api.digitransit.fi/>
   (luo tili → tilaa "Digitransit developer API" -tuote → kopioi subscription key).
2. Avaa sivu paikallisesti:

   ```powershell
   cd lsl-aikataulut
   python -m http.server 8000
   # tai: npx serve
   ```

   ja mene osoitteeseen <http://localhost:8000>. Pelkkä `index.html`-tiedoston
   avaaminen selaimeen toimii useimmiten myös sellaisenaan.
3. Sivu pyytää API-avaimen ensimmäisellä kerralla ja tallentaa sen selaimen
   localStorageen — avain ei lähde mihinkään muualle kuin Digitransitin rajapintaan.

## Tekniikka

- Rajapinta: Digitransit routing v2, Waltti-reititin
  (`https://api.digitransit.fi/routing/v2/waltti/gtfs/v1`, GraphQL)
- Lahden GTFS-syöte tunnistetaan automaattisesti rajapinnan feed-listasta
- Ei riippuvuuksia, ei buildia: yksi HTML-tiedosto

## Käyttö toisessa Waltti-kaupungissa

Sovellus ei ole sidottu Lahteen: kaikki kaupunkikohtainen on koottu
`index.html`-tiedoston alun `CONFIG`-objektiin. Toiselle Waltti-kaupungille
(esim. Kuopio, Jyväskylä, Joensuu) riittää:

1. Muokkaa `CONFIG`: kaupungin nimi ja suomen genetiivi, liikennöitsijän nimi,
   `feedMatch`-regex (esim. `/kuopio/i`), seudun `area`-rajaus (focus-piste ja
   bounding box osoitehaulle) sekä `proxyUrl`.
2. Muokkaa `manifest.webmanifest`-tiedoston `name`/`short_name` (PWA-nimi ei
   tule CONFIG:sta).
3. Välityspalvelin: ota worker käyttöön omalla originillasi (lisää se
   `worker/worker.js`-tiedoston `ALLOWED_ORIGINS`-listaan) **tai** jätä
   `proxyUrl` tyhjäksi, jolloin sivu kysyy käyttäjän oman Digitransit-avaimen.

Huomio: häiriötiedotteiden linjapoiminta tiedoteteksteistä
(`lineTokensFromText`) on suomenkielinen ("linjoja 3, 8K"), joten se toimii
suomalaisissa Waltti-kaupungeissa sellaisenaan.

## Jatkokehitysideoita

- Oikeat taustapush-ilmoitukset (vaatisi tilauksia säilövän palvelimen,
  esim. workerin laajennuksen KV:llä ja cron-triggerillä)

## Data ja lisenssit

Aikataulu- ja reaaliaikadata: Lahden seudun liikenne / Waltti avoin data,
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fi), Digitransit-
rajapinnan kautta. Koodi: MIT-lisenssi, ks. [LICENSE](LICENSE).

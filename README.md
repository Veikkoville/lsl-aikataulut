# Lahden bussiaikataulut (epävirallinen prototyyppi)

Kevyt aikataulupalvelu Lahden seudun liikenteen (LSL) busseille. Yksi staattinen
HTML-sivu ilman backendia ja build-vaihetta — kaikki data haetaan suoraan
Digitransitin avoimesta Waltti-rajapinnasta, joten aikataulut pysyvät ajan
tasalla ilman ylläpitoa.

**Tämä ei ole LSL:n virallinen palvelu.**

## Ominaisuudet

- Kaikki LSL:n bussilinjat suodatettavana listana
- Linjakohtainen aikataulu (lähdöt lähtöpysäkiltä) valitulle päivälle, suunnittain
- Pysäkkikohtaiset seuraavat lähdöt **reaaliajassa** (GTFS-RT), päivittyy 30 s välein
- Pysäkkihaku nimellä
- Voimassa olevat häiriötiedotteet etusivulla (GTFS-RT service alerts)

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

## Jatkokehitysideoita

- Pysäkkihaku sijainnin perusteella (lähimmät pysäkit)
- Tulostettava PDF-aikataulu linjalle
- Saavutettavuusauditointi (tavoite WCAG 2.1 AA)
- Sama sovellus muille Waltti-kaupungeille pelkällä feed-konfiguraatiolla

## Data ja lisenssit

Aikataulu- ja reaaliaikadata: Lahden seudun liikenne / Waltti avoin data,
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fi), Digitransit-
rajapinnan kautta. Koodi: MIT-lisenssi, ks. [LICENSE](LICENSE).

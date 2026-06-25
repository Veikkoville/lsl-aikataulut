# Lahden bussiaikataulut

Kevyt aikataulupalvelu Lahden seudun liikenteen (LSL) busseille. Yksi staattinen
HTML-sivu ilman backendia ja build-vaihetta — kaikki data haetaan suoraan
Digitransitin avoimesta Waltti-rajapinnasta, joten aikataulut pysyvät ajan
tasalla ilman ylläpitoa.

**Tämä ei ole LSL:n virallinen palvelu.**

## Ominaisuudet

- **Reittihaku A→B** (planConnection): osoite-, paikka- tai pysäkkihaku
  (Digitransit Geocoding / Pelias), lähtö- tai saapumisaika, suodattimet
  "esteetön reitti" ja "vähemmän kävelyä", aikaisempien ja myöhempien
  lähtöjen selaus
- **Reittiohjeet aikajanana**: kävely → pysäkki (koodi + laituri) → linja
  brändiväreissä → avattavat välipysäkit → vaihtoajat → perille; yhteenvedossa
  suhteellinen osuuspalkki ja lähtölaskenta seuraavaan bussiin
- **Kävellen/Pyörällä-vaihtoehdot** reittiehdotusten rinnalla karttoineen
- **Jaettavat reittilinkit**: hakuehdot tallentuvat URL-osoitteeseen, Jaa-nappi
  (Web Share / leikepöytä); suunnanvaihto- ja Nyt-pikanapit, viimeksi haetut
  paikat ehdotuksina, nuolinäppäinnavigointi
- **Live-bussit kartoilla**: linjasivun lisäksi avatun reittiehdotuksen
  kartalla (reitin linjat) ja pysäkkisivun kartalla (pysäkin kaikki linjat);
  bussin klikkaus näyttää määränpään, myöhästymän ja seuraavat pysäkit
- **Etusivulla lähimmät lähdöt heti**: paikannuksen salliessa 5 lähimmän
  pysäkin seuraavat lähdöt reaaliajassa ilman yhtään hakua
- **Suosikit**: tähtää pysäkki tai linja, niin se nousee etusivun kärkeen
  (pysäkeille reaaliaikaiset lähdöt)
- Kaikki LSL:n bussilinjat suodatettavana listana
- Linjakohtainen aikataulu valitulle päivälle suunnittain — tänään-näkymässä
  reaaliaikainen countdown ja ●-merkityt reaaliaika-arviot
- Pysäkkikohtaiset seuraavat lähdöt **reaaliajassa** (GTFS-RT), päivittyy 30 s
  välein; pysäkkiä liikennöivät linjat suodatinnappeina
- Pysäkkihaku nimellä ja lähimmät pysäkit selaimen paikannuksella
- Linjojen viralliset värit (GTFS `route.color`) badgeissa ja karttaviivoissa —
  tekstiväri valitaan automaattisesti niin, että WCAG-kontrasti 4.5:1 täyttyy
- Tumma tila (automaattinen/vaalea/tumma), monikielisyys FI/EN/SV ja
  offline-välimuisti ("viimeksi päivitetty HH:MM")
- Häiriöilmoitukset suosikkilinjoista sovelluksen ollessa auki
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

## Jatkokehitysideoita

- Oikeat taustapush-ilmoitukset (vaatisi tilauksia säilövän palvelimen,
  esim. workerin laajennuksen KV:llä ja cron-triggerillä)

## Data ja lisenssit

Aikataulu- ja reaaliaikadata: Lahden seudun liikenne / Waltti avoin data,
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.fi), Digitransit-
rajapinnan kautta. Koodi: omistusoikeudellinen (proprietary), kaikki oikeudet
pidätetään, ks. [LICENSE](LICENSE). Ei käyttö-/levitysoikeutta ilman kirjallista
lupaa.

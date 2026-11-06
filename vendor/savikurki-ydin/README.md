# Savikurki-ydin (kopio)

Kaupungin näkymän (`#/kaupunki`, `kaupunki.js`) yhteinen ydin: työjono, mittaristo, johtoraportti,
viennit ja sääntökirjasto. Tiedostot ovat muuttamattomia kopioita Savikurki-ytimen versiosta 1.0.0
(`SavikurkiYdin.VERSIO`). Korjaukset tehdään ytimeen, ei tänne. Päivitys on uusi kopio ja uudet
tarkisteet tähän tiedostoon.

| Tiedosto | SHA-256 |
|---|---|
| `ydin.js` | `38ba686396f2c2650d895556be356a5934cbb0cb1969c950503a7fd296da43f2` |
| `ydin.css` | `43dcb352ab44a19c73466a64627ba96d6bc2cbee68a9fc627804e502e24e66fd` |

Kopioitu 27.9.2026, päivitetty 1.11.2026 ytimen masteriin 42137bf (Säännöt-haku ja tilasuodatin, esittelytila vain
sivun merkinnällä, työjonon puutteellinen myös erääntyessään ja myöhässä, laatikoista paksu sivureuna pois). Päivitetty 5.11.2026 ytimen masteriin 62fa673 (ydin.css: ilme, muste ja paperi esittelytilassa, ei versaaleja eikä harvennusta, paino 700, tabular-nums). Päivitetty 6.11.2026 ytimen masteriin 8334ef2 (ydin.css, 7575d5c: esittelytilan avauskaista ja leveä näyttö; vaikuttaa vain esittelytilassa, jota Reittarin Kaupungin näkymä ei käytä oletuksena). Ytimen valinnainen `xlsx-kevyt.js` jätettiin pois: CSV-vienti (UTF-8 BOM,
puolipiste, desimaalipilkku) aukeaa suomenkieliseen Exceliin sellaisenaan.

Tiedostot ladataan vasta Kaupungin näkymän reitillä, eivätkä ne ole käytössä muissa näkymissä.
Reittarin oma sovitus (värit, piilotetut hakemusmallin kortit ja sarakkeet, tekstit) on
tiedostoissa `kaupunki.js` ja `kaupunki.css` repon juuressa.

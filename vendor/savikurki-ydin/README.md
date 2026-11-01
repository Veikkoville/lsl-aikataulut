# Savikurki-ydin (kopio)

Kaupungin näkymän (`#/kaupunki`, `kaupunki.js`) yhteinen ydin: työjono, mittaristo, johtoraportti,
viennit ja sääntökirjasto. Tiedostot ovat muuttamattomia kopioita Savikurki-ytimen versiosta 1.0.0
(`SavikurkiYdin.VERSIO`). Korjaukset tehdään ytimeen, ei tänne. Päivitys on uusi kopio ja uudet
tarkisteet tähän tiedostoon.

| Tiedosto | SHA-256 |
|---|---|
| `ydin.js` | `38ba686396f2c2650d895556be356a5934cbb0cb1969c950503a7fd296da43f2` |
| `ydin.css` | `e14cbc11c6ea76f72b3d1294d07fd4663dbd0aab822a84610b9f9aaef3a988ea` |

Kopioitu 27.9.2026, päivitetty 1.11.2026 ytimen masteriin 42137bf (Säännöt-haku ja tilasuodatin, esittelytila vain
sivun merkinnällä, työjonon puutteellinen myös erääntyessään ja myöhässä, laatikoista paksu sivureuna pois). Ytimen valinnainen `xlsx-kevyt.js` jätettiin pois: CSV-vienti (UTF-8 BOM,
puolipiste, desimaalipilkku) aukeaa suomenkieliseen Exceliin sellaisenaan.

Tiedostot ladataan vasta Kaupungin näkymän reitillä, eivätkä ne ole käytössä muissa näkymissä.
Reittarin oma sovitus (värit, piilotetut hakemusmallin kortit ja sarakkeet, tekstit) on
tiedostoissa `kaupunki.js` ja `kaupunki.css` repon juuressa.

# Savikurki-ydin (kopio)

Kaupungin näkymän (`#/kaupunki`, `kaupunki.js`) yhteinen ydin: työjono, mittaristo, johtoraportti,
viennit ja sääntökirjasto. Tiedostot ovat muuttamattomia kopioita Savikurki-ytimen versiosta 1.0.0
(`SavikurkiYdin.VERSIO`). Korjaukset tehdään ytimeen, ei tänne. Päivitys on uusi kopio ja uudet
tarkisteet tähän tiedostoon.

| Tiedosto | SHA-256 |
|---|---|
| `ydin.js` | `50f74d01c656a68a1e883132d132dc0f2dd927b0048baa8bf62e41a2cb0d1ef5` |
| `ydin.css` | `d062a9a46461cb7d5121a24d65ccf8d555c3d793f9c807e821ad53e8e3c84d90` |

Kopioitu 27.9.2026. Ytimen valinnainen `xlsx-kevyt.js` jätettiin pois: CSV-vienti (UTF-8 BOM,
puolipiste, desimaalipilkku) aukeaa suomenkieliseen Exceliin sellaisenaan.

Tiedostot ladataan vasta Kaupungin näkymän reitillä, eivätkä ne ole käytössä muissa näkymissä.
Reittarin oma sovitus (värit, piilotetut hakemusmallin kortit ja sarakkeet, tekstit) on
tiedostoissa `kaupunki.js` ja `kaupunki.css` repon juuressa.

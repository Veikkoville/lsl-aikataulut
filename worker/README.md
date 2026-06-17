# API-avaimen välityspalvelin (Cloudflare Worker)

Tämä Worker lisää Digitransit-API-avaimen pyyntöihin palvelinpäässä, jolloin
sivu toimii kaikille käyttäjille ilman omaa avainta eikä avain näy selaimessa.
Cloudflaren ilmainen taso (100 000 pyyntöä/päivä) riittää tähän hyvin.

## Käyttöönotto (kerran)

1. Luo ilmainen tili: <https://dash.cloudflare.com/sign-up>
2. Tässä hakemistossa (`worker/`):

   ```powershell
   npx wrangler login          # avaa selaimen, hyväksy
   npx wrangler secret put DIGITRANSIT_KEY   # liitä Digitransit-avain kysyttäessä
   npx wrangler deploy
   ```

3. `deploy` tulostaa Workerin osoitteen, esim.
   `https://lsl-aikataulut-proxy.<tili>.workers.dev`.
   Laita se `index.html`-tiedoston `PROXY_URL`-vakioon ja julkaise (`git push`).

Sallitut alkuperät (CORS) on rajattu `worker.js`-tiedostossa GitHub Pages
-sivuun ja localhostiin — muokkaa listaa, jos sivu muuttaa osoitetta.

## Ylläpitonäkymä (kaupungin sisällönhallinta)

Osoitteessa `…/admin` on selainpohjainen ylläpito, jossa kaupungin henkilöstö
julkaisee häiriötiedotteita ilman koodia/WordPressiä. Julkaistut tiedotteet
näkyvät heti sovelluksen etusivun häiriöbannerissa (haetaan `/published`-päätepisteestä).

Käyttöönotto vaatii kaksi salaisuutta:

```powershell
npx wrangler secret put ADMIN_PASSWORD          # jaettu ylläpitosalasana
npx wrangler secret put ADMIN_SESSION_SECRET    # satunnainen pitkä merkkijono (istunnon allekirjoitus)
```

Kirjautuminen luo HMAC-allekirjoitetun istuntoevästeen (12 h). Admin-sivu ja sen
API tarjoillaan samasta originista, joten eväste toimii ilman CORS-säätöä.

**Tuotantoon (suositus): Cloudflare Access.** Laita `/admin*`-reitin eteen
Cloudflare Access (Zero Trust) -sovellus, jolloin kaupungin henkilöstö kirjautuu
omilla Google-/Microsoft-/sähköpostitunnuksillaan (SSO), eikä salasanoja käsitellä
itse. `isAdmin()`-funktioon on jätetty koukku Access-JWT:n varmennukselle
(`ADMIN_ACCESS_AUD`). Ilmainen ≤50 käyttäjälle.

Hallittava sisältö on Workers KV:ssä yhdessä avaimessa per tyyppi/kaupunki
(`admin:alerts:<kaupunki>`, `admin:fares:<kaupunki>`) → ei kuormita KV:n
list-kiintiötä. Julkinen sovellus lukee ne `/published?city=<kaupunki>`
-päätepisteestä (sisältää sekä voimassa olevat tiedotteet että julkaistut hinnat).

Hallittavat sisältötyypit nyt: **häiriötiedotteet** (näkyvät etusivun bannerissa)
ja **lippu-/hintatiedot** (näkyvät "Liput ja hinnat" -sivulla, korvaavat
CONFIG-oletushinnat).

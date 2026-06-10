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

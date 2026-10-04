// Ylläpitonäkymä (#1): kaupungin henkilöstö julkaisee häiriötiedotteita selaimessa
// ilman WordPressiä/koodia. Tarjoillaan workerista (sama origin → istuntoeväste
// toimii ilman CORS-säätöä, ja Cloudflare Access voidaan kytkeä /admin* eteen).
// Sivu on yksi tiedosto, ei buildia — sama linja kuin julkinen index.html.
// Ilme 30.9.2026: Reittarin tokenit (Hanken Grotesk, valkoinen yläpalkki aksenttiraidalla),
// osiot sivunavigaatiolla ja yleiskatsaus. Fontti ladataan demo.reittari.fi:stä (oma origin,
// GitHub Pages sallii CORSin), ei Googlen CDN:stä. Kenttien id:t ja API-kutsut ennallaan.
export const ADMIN_HTML = `<!doctype html>
<html lang="fi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="https://demo.reittari.fi/icon.svg" type="image/svg+xml">
<title>Ylläpito · Reittari</title>
<style>
  @font-face { font-family:'Hanken Grotesk'; font-style:normal; font-weight:100 900; font-display:swap;
    src:url('https://demo.reittari.fi/fonts/hanken-grotesk-latin.woff2') format('woff2');
    unicode-range:U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
  @font-face { font-family:'Hanken Grotesk'; font-style:normal; font-weight:100 900; font-display:swap;
    src:url('https://demo.reittari.fi/fonts/hanken-grotesk-latin-ext.woff2') format('woff2');
    unicode-range:U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F; }
  :root {
    /* Reittarin tokenit (index.html): yksi aksentti + neutraalit. Tekstivärit mitattu AA:ksi pinnoillaan. */
    --accent:#0a4ea3; --accent-dark:#083d80; --accent-soft:#e7eef8;
    --page:#f1f4f3; --surface:#ffffff; --ink:#16201c; --muted:#5c6b66;
    --line:#e3e8e5; --line-strong:#c9d3cf;
    --ok:#146c3f; --ok-soft:#e2f3e9; --warn:#8a5300; --warn-soft:#fdf1dc; --danger:#b3261e; --danger-soft:#fdecec;
    --font:'Hanken Grotesk', system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --fs-xs:.8125rem; --fs-sm:.875rem; --fs-md:1rem; --fs-lg:1.25rem; --fs-xl:1.625rem;
    --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px; --s7:48px;
    --r-card:14px; --r-ctl:10px;
    --shadow:0 1px 2px rgba(16,32,28,.06);
  }
  * { box-sizing:border-box; }
  body { margin:0; font:var(--fs-md)/1.5 var(--font); color:var(--ink); background:var(--page); -webkit-font-smoothing:antialiased; }
  a { color:var(--accent); }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .hide { display:none !important; }
  .muted { color:var(--muted); }
  code { font-size:.92em; }

  /* Yläpalkki: sama rakenne kuin sovelluksessa (valkoinen pinta, aksenttiraita ylhäällä). */
  .top { background:var(--surface); border-top:4px solid var(--accent); border-bottom:1px solid var(--line); }
  .top-in { max-width:1180px; margin:0 auto; padding:var(--s3) var(--s4); display:flex; align-items:center; gap:var(--s3) var(--s4); flex-wrap:wrap; }
  .brand { display:flex; align-items:center; gap:var(--s3); flex:1 1 auto; min-width:0; }
  .glyph { width:36px; height:36px; border-radius:9px; background:var(--accent); color:#fff; display:grid; place-items:center; flex:none; }
  .glyph svg { width:100%; height:100%; display:block; }
  .eyebrow { margin:0; font-size:var(--fs-xs); font-weight:700; color:var(--muted); line-height:1.2; }
  h1 { margin:0; font-size:var(--fs-lg); font-weight:800; line-height:1.2; display:flex; align-items:center; gap:var(--s2); flex-wrap:wrap; }
  .city-chip { font-size:var(--fs-sm); font-weight:700; color:var(--accent); background:var(--accent-soft); border-radius:999px; padding:2px 10px; }
  .top-acts { display:flex; gap:var(--s2); flex-wrap:wrap; }

  /* Painikkeet */
  .btn { font:inherit; font-size:var(--fs-sm); font-weight:700; min-height:40px; padding:0 var(--s4); border-radius:var(--r-ctl);
    border:1px solid transparent; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:var(--s2);
    text-decoration:none; transition:background-color .15s ease-out, border-color .15s ease-out; }
  .btn-primary { background:var(--accent); color:#fff; }
  .btn-primary:hover { background:var(--accent-dark); }
  .btn-ghost { background:var(--surface); color:var(--ink); border-color:var(--line-strong); }
  .btn-ghost:hover { background:var(--page); }
  .btn-danger { background:var(--surface); color:var(--danger); border-color:#e8b4b0; }
  .btn-danger:hover { background:var(--danger-soft); }
  .btn-sm { min-height:34px; padding:0 var(--s3); }

  /* Runko: sivunavigaatio + sisältö */
  main { max-width:1180px; margin:0 auto; padding:var(--s5) var(--s4) var(--s7); }
  .shell { display:grid; gap:var(--s5); }
  .side { display:flex; gap:var(--s1); overflow-x:auto; border-bottom:1px solid var(--line); padding-bottom:var(--s2); }
  .side a { display:flex; align-items:center; justify-content:space-between; gap:var(--s2); padding:var(--s2) var(--s3); border-radius:var(--r-ctl);
    color:var(--ink); font-size:var(--fs-sm); font-weight:700; text-decoration:none; white-space:nowrap; }
  .side a:hover { background:var(--surface); }
  .side a[aria-current="page"] { background:var(--surface); color:var(--accent); box-shadow:inset 0 -2px 0 var(--accent); }
  .count { font-size:var(--fs-xs); font-weight:700; background:var(--accent-soft); color:var(--accent); border-radius:999px; padding:0 7px; min-width:22px; text-align:center; }
  @media (min-width:900px) {
    .shell { grid-template-columns:220px minmax(0,1fr); align-items:start; }
    .side { flex-direction:column; border-bottom:0; padding:0; position:sticky; top:var(--s4); overflow:visible; }
    .side a[aria-current="page"] { box-shadow:inset 3px 0 0 var(--accent); }
  }

  .sec-head { margin:0 0 var(--s4); }
  .sec-head h2 { margin:0 0 var(--s1); font-size:var(--fs-xl); font-weight:800; line-height:1.2; }
  .sec-head h2:focus { outline:none; }
  .lead { margin:0; color:var(--muted); max-width:68ch; }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:var(--r-card); padding:var(--s5); box-shadow:var(--shadow); margin:0 0 var(--s4); }
  .card > h3 { margin:0 0 var(--s3); font-size:var(--fs-md); font-weight:700; }
  .card > h3 + .muted { margin-top:0; }
  .card h4 { margin:var(--s5) 0 var(--s3); font-size:var(--fs-sm); font-weight:700; }
  @media (max-width:600px) { .card { padding:var(--s4); } main { padding-top:var(--s4); } }

  /* Lomakkeet */
  .field { margin:0 0 var(--s4); min-width:0; }
  label { display:block; font-size:var(--fs-sm); font-weight:700; margin:0 0 var(--s1); }
  .req { color:var(--danger); margin-left:2px; }
  .hint { font-size:var(--fs-xs); color:var(--muted); margin:var(--s1) 0 0; }
  input[type=text], input[type=url], input[type=email], input[type=password], input[type=datetime-local], textarea, select {
    width:100%; min-height:42px; padding:var(--s2) var(--s3); font:inherit; color:var(--ink); background:var(--surface);
    border:1px solid var(--line-strong); border-radius:var(--r-ctl); }
  input:focus, textarea:focus, select:focus { outline:2px solid var(--accent); outline-offset:0; border-color:var(--accent); }
  textarea { min-height:6rem; resize:vertical; }
  .grid2 { display:grid; gap:0 var(--s4); grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); }
  .grid4 { display:grid; gap:0 var(--s4); grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); }
  .form-acts { display:flex; gap:var(--s2); flex-wrap:wrap; align-items:center; margin-top:var(--s2); }
  .money { position:relative; display:block; }
  .money input { padding-right:28px; }
  .money::after { content:"€"; position:absolute; right:12px; top:50%; transform:translateY(-50%); color:var(--muted); font-size:var(--fs-sm); pointer-events:none; }
  details.sv { margin-top:var(--s5); border-top:1px solid var(--line); padding-top:var(--s4); }
  details.sv summary { cursor:pointer; font-weight:700; font-size:var(--fs-sm); }
  details.sv[open] summary { margin-bottom:var(--s3); }

  .msg { padding:var(--s2) var(--s3); border-radius:var(--r-ctl); margin:var(--s3) 0 0; display:none; font-size:var(--fs-sm); }
  .msg.show { display:block; }
  .msg.ok { background:var(--ok-soft); color:var(--ok); }
  .msg.err { background:var(--danger-soft); color:var(--danger); }

  /* Taulukot (kausi- ja vuorokausiliput, tilastot) */
  table.ftable { width:100%; border-collapse:collapse; }
  table.ftable th { font-size:var(--fs-xs); font-weight:700; text-align:left; color:var(--muted); padding:0 var(--s2) var(--s1) 0; }
  table.ftable td { padding:0 var(--s2) var(--s2) 0; vertical-align:middle; }
  table.ftable th.d, table.ftable td.d { width:90px; }
  table.ftable td.rm { width:44px; padding-right:0; }

  /* Tiedotteet */
  .alert-item { border:1px solid var(--line); border-radius:var(--r-ctl); padding:var(--s3) var(--s4); }
  .alert-item + .alert-item { margin-top:var(--s2); }
  .alert-item.past { background:var(--page); }
  .alert-item.past h4 { color:var(--muted); }
  .alert-head { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s2); }
  .alert-item h4 { margin:0; font-size:var(--fs-md); font-weight:700; flex:1 1 220px; }
  .alert-body { margin:var(--s1) 0 0; max-width:75ch; white-space:pre-line; }
  .alert-meta { margin:var(--s1) 0 0; font-size:var(--fs-sm); color:var(--muted); }
  .alert-acts { display:flex; gap:var(--s2); margin-top:var(--s3); }
  .badge { display:inline-block; font-size:var(--fs-xs); font-weight:700; padding:1px 9px; border-radius:999px; white-space:nowrap; }
  .b-now { background:var(--ok-soft); color:var(--ok); }
  .b-future { background:var(--accent-soft); color:var(--accent); }
  .b-past { background:var(--line); color:var(--muted); }
  .sev-INFO { background:var(--accent-soft); color:var(--accent); }
  .sev-WARNING { background:var(--warn-soft); color:var(--warn); }
  .sev-SEVERE { background:var(--danger-soft); color:var(--danger); }
  .empty { margin:0; color:var(--muted); }

  /* Yleiskatsaus */
  .tiles { display:grid; gap:var(--s4); grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); }
  a.tile { display:flex; flex-direction:column; gap:var(--s1); background:var(--surface); border:1px solid var(--line); border-radius:var(--r-card);
    padding:var(--s4) var(--s5); box-shadow:var(--shadow); color:var(--ink); text-decoration:none; transition:border-color .15s ease-out; }
  a.tile:hover { border-color:var(--accent); }
  .tile-label { display:flex; align-items:center; gap:var(--s2); font-size:var(--fs-sm); font-weight:700; color:var(--muted); }
  .tile-value { font-size:var(--fs-lg); font-weight:800; line-height:1.25; }
  .tile-sub { font-size:var(--fs-sm); color:var(--muted); }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--line-strong); flex:none; }
  .dot.st-ok { background:#1a7f4b; }
  .dot.st-attn { background:#c07a12; }
  .dot.st-on { background:var(--accent); }

  /* Tilastot */
  .stat-grid { display:grid; gap:var(--s5) var(--s6); grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); margin-top:var(--s4); }
  .stat-grid h4 { margin:0 0 var(--s2); }
  table.stable { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
  table.stable td { padding:6px 0; border-bottom:1px solid var(--line); }
  table.stable td.n { text-align:right; font-weight:700; width:4.5em; }
  table.stable td.bar { width:30%; padding:0 var(--s3); }
  .bar span { display:block; height:6px; border-radius:3px; background:var(--accent); min-width:2px; }
  .big { font-size:var(--fs-xl); font-weight:800; }

  .login { max-width:440px; margin:var(--s7) auto 0; }
  .login h2 { margin:0 0 var(--s2); font-size:var(--fs-lg); font-weight:800; }
  .foot { max-width:1180px; margin:0 auto; padding:var(--s4) var(--s4) var(--s6); border-top:1px solid var(--line); color:var(--muted); font-size:var(--fs-xs); display:flex; flex-wrap:wrap; gap:var(--s2) var(--s4); align-items:center; }
  .foot a { color:var(--muted); }
  .foot-sk { font-weight:700; color:var(--ink) !important; text-decoration:none; white-space:nowrap; }
  .foot-sk:hover { text-decoration:underline; }
  .foot-sk-mark { vertical-align:-4px; margin-right:6px; border-radius:4px; }

  @media (prefers-reduced-motion:reduce) { * { transition:none !important; } }
</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <div class="brand">
      <span class="glyph" id="glyph" aria-hidden="true"><svg viewBox="0 0 120 120" aria-hidden="true" focusable="false"><g transform="translate(-1 -2.5)"><path d="M40 92V30H62C86 30 86 62 62 62H52L80 90" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/><circle cx="40" cy="92" r="9" fill="currentColor"/><circle cx="82" cy="92" r="9" fill="currentColor"/></g></svg></span>
      <div>
        <p class="eyebrow">Reittari</p>
        <h1>Ylläpito <span class="city-chip" id="cityName"></span></h1>
      </div>
    </div>
    <div class="top-acts">
      <a id="openApp" class="btn btn-ghost btn-sm" href="#" target="_blank" rel="noopener">Avaa palvelu <span aria-hidden="true">↗</span></a>
      <button id="logoutBtn" type="button" class="btn btn-ghost btn-sm hide">Kirjaudu ulos</button>
    </div>
  </div>
</header>
<main>
  <!-- Kirjautuminen -->
  <section id="loginView" class="login hide" aria-labelledby="loginTitle">
    <div class="card">
      <h2 id="loginTitle">Kirjaudu ylläpitoon</h2>
      <p class="muted">Ylläpidossa julkaiset häiriötiedotteet, hinnat ja saavutettavuusselosteen ja seuraat palvelun käyttöä. Tunnus on kuntakohtainen.</p>
      <form id="loginForm">
        <div class="field">
          <label for="pw">Salasana</label>
          <input type="password" id="pw" autocomplete="current-password" required>
        </div>
        <div class="msg err" id="loginMsg" role="alert"></div>
        <div class="form-acts"><button type="submit" class="btn btn-primary">Kirjaudu</button></div>
      </form>
    </div>
  </section>

  <!-- Hallinta -->
  <div id="adminView" class="shell hide">
    <nav class="side" aria-label="Ylläpidon osiot">
      <a href="#yleiskatsaus" data-sec="yleiskatsaus">Yleiskatsaus</a>
      <a href="#tiedotteet" data-sec="tiedotteet">Häiriötiedotteet <span class="count hide" id="navAlertCount"></span></a>
      <a href="#hinnat" data-sec="hinnat">Liput ja hinnat</a>
      <a href="#seloste" data-sec="seloste">Saavutettavuusseloste</a>
      <a href="#vahti" data-sec="vahti">Uusintapainatusvahti</a>
      <a href="#tilastot" data-sec="tilastot">Käyttötilastot</a>
    </nav>
    <div class="content">

      <section id="sec-yleiskatsaus" class="sec" aria-labelledby="h-yleis">
        <div class="sec-head">
          <h2 id="h-yleis" tabindex="-1">Yleiskatsaus</h2>
          <p class="lead">Mitä palvelussa on nyt julkaistuna. Avaa osio napsauttamalla ruutua.</p>
        </div>
        <div class="tiles" id="tiles"></div>
      </section>

      <section id="sec-tiedotteet" class="sec hide" aria-labelledby="h-tied">
        <div class="sec-head">
          <h2 id="h-tied" tabindex="-1">Häiriötiedotteet</h2>
          <p class="lead">Julkaistu tiedote näkyy heti sovelluksen etusivun häiriöbannerissa ja valittujen linjojen sivuilla. Voimassaolon voi rajata aikavälille.</p>
        </div>
        <div class="card">
          <h3 id="formTitle">Uusi tiedote</h3>
          <form id="alertForm">
            <input type="hidden" id="alertId">
            <div class="field">
              <label for="title">Otsikko<span class="req" aria-hidden="true">*</span></label>
              <input type="text" id="title" maxlength="200" required>
            </div>
            <div class="field">
              <label for="body">Kuvaus</label>
              <textarea id="body" maxlength="2000"></textarea>
            </div>
            <details class="sv" id="alertLangDetails">
              <summary>Ruotsin- ja englanninkielinen versio</summary>
              <p class="hint" style="margin:0 0 var(--s3)">Valinnaisia. Sovellus näyttää tiedotteen käyttäjän kielellä. Jos käännös puuttuu, näkyy suomenkielinen teksti.</p>
              <div class="field"><label for="titleSv">Otsikko ruotsiksi</label><input type="text" id="titleSv" maxlength="200" lang="sv"></div>
              <div class="field"><label for="bodySv">Kuvaus ruotsiksi</label><textarea id="bodySv" maxlength="2000" lang="sv"></textarea></div>
              <div class="field"><label for="titleEn">Otsikko englanniksi</label><input type="text" id="titleEn" maxlength="200" lang="en"></div>
              <div class="field"><label for="bodyEn">Kuvaus englanniksi</label><textarea id="bodyEn" maxlength="2000" lang="en"></textarea></div>
            </details>
            <div class="grid2">
              <div class="field">
                <label for="severity">Vakavuus</label>
                <select id="severity">
                  <option value="INFO">Tiedoksi</option>
                  <option value="WARNING" selected>Varoitus</option>
                  <option value="SEVERE">Vakava</option>
                </select>
              </div>
              <div class="field">
                <label for="lines">Linjat</label>
                <input type="text" id="lines" placeholder="3, 8K, 12" aria-describedby="linesHint">
                <p class="hint" id="linesHint">Pilkulla erotettuna. Tiedote näkyy myös näiden linjojen sivuilla.</p>
              </div>
            </div>
            <div class="grid2">
              <div class="field">
                <label for="startsAt">Alkaa</label>
                <input type="datetime-local" id="startsAt" aria-describedby="rangeHint">
              </div>
              <div class="field">
                <label for="endsAt">Päättyy</label>
                <input type="datetime-local" id="endsAt" aria-describedby="rangeHint">
              </div>
            </div>
            <p class="hint" id="rangeHint" style="margin-top:calc(-1 * var(--s3));margin-bottom:var(--s4)">Valinnaisia. Ilman aikoja tiedote on voimassa heti ja toistaiseksi.</p>
            <div class="field">
              <label for="url">Lisätietolinkki</label>
              <input type="url" id="url" placeholder="https://">
            </div>
            <div class="msg" id="formMsg" role="status"></div>
            <div class="form-acts">
              <button type="submit" id="saveBtn" class="btn btn-primary">Julkaise</button>
              <button type="button" id="cancelBtn" class="btn btn-ghost hide">Peruuta muokkaus</button>
            </div>
          </form>
        </div>
        <div class="card">
          <h3>Julkaistut tiedotteet</h3>
          <div id="list"><p class="empty">Ladataan…</p></div>
        </div>
      </section>

      <section id="sec-hinnat" class="sec hide" aria-labelledby="h-hinnat">
        <div class="sec-head">
          <h2 id="h-hinnat" tabindex="-1">Liput ja hinnat</h2>
          <p class="lead">Julkaistut hinnat näkyvät sovelluksen Liput ja hinnat -sivulla ja korvaavat oletushinnat. Hinnat euroina pilkulla, esimerkiksi 2,95.</p>
        </div>
        <form id="faresForm" class="card">
          <div class="grid2">
            <div class="field"><label for="fChecked">Tarkistettu</label><input type="text" id="fChecked" placeholder="14.6.2026"></div>
            <div class="field"><label for="fUrl">Virallinen hinnasto (linkki)</label><input type="url" id="fUrl" placeholder="https://"></div>
          </div>
          <h4>Kertaliput kortilla tai sovelluksella</h4>
          <div class="grid4">
            <div class="field"><label for="fSaAdult">Aikuinen</label><span class="money"><input type="text" id="fSaAdult" inputmode="decimal"></span></div>
            <div class="field"><label for="fSaChild">Lapsi</label><span class="money"><input type="text" id="fSaChild" inputmode="decimal"></span></div>
            <div class="field"><label for="fSaReduced">Nuoriso, opiskelija, seniori</label><span class="money"><input type="text" id="fSaReduced" inputmode="decimal"></span></div>
            <div class="field"><label for="fContactless">Lähimaksu (kaikki)</label><span class="money"><input type="text" id="fContactless" inputmode="decimal"></span></div>
          </div>
          <h4>Kertaliput palvelupisteestä</h4>
          <div class="grid4">
            <div class="field"><label for="fSpAdult">Aikuinen</label><span class="money"><input type="text" id="fSpAdult" inputmode="decimal"></span></div>
            <div class="field"><label for="fSpChild">Lapsi</label><span class="money"><input type="text" id="fSpChild" inputmode="decimal"></span></div>
            <div class="field"><label for="fSpReduced">Alennus</label><span class="money"><input type="text" id="fSpReduced" inputmode="decimal"></span></div>
          </div>
          <h4>Kausiliput</h4>
          <table class="ftable"><thead><tr><th class="d" scope="col">Vrk</th><th scope="col">Aikuinen</th><th scope="col">Lapsi</th><th scope="col">Alennus</th><th scope="col"><span class="hide">Poista</span></th></tr></thead>
            <tbody id="seasonBody"></tbody></table>
          <button type="button" class="btn btn-ghost btn-sm" id="addSeason">Lisää rivi</button>
          <h4>Vuorokausiliput</h4>
          <table class="ftable"><thead><tr><th class="d" scope="col">Vrk</th><th scope="col">Aikuinen</th><th scope="col">Lapsi</th><th scope="col"><span class="hide">Poista</span></th></tr></thead>
            <tbody id="dayBody"></tbody></table>
          <button type="button" class="btn btn-ghost btn-sm" id="addDay">Lisää rivi</button>
          <h4>Muut</h4>
          <div class="grid4">
            <div class="field"><label for="fCapDay">Lähimaksun katto / vrk</label><span class="money"><input type="text" id="fCapDay" inputmode="decimal"></span></div>
            <div class="field"><label for="fCapWeek">Lähimaksun katto / viikko</label><span class="money"><input type="text" id="fCapWeek" inputmode="decimal"></span></div>
            <div class="field"><label for="fCardFee">Waltti-kortti</label><span class="money"><input type="text" id="fCardFee" inputmode="decimal"></span></div>
          </div>
          <div class="msg" id="faresMsg" role="status"></div>
          <div class="form-acts"><button type="submit" class="btn btn-primary">Julkaise hinnat</button></div>
        </form>
      </section>

      <section id="sec-seloste" class="sec hide" aria-labelledby="h-seloste">
        <div class="sec-head">
          <h2 id="h-seloste" tabindex="-1">Saavutettavuusseloste</h2>
          <p class="lead">Digipalvelulaki (306/2019) edellyttää selosteen. Kun julkaiset sen, sovellus näyttää kunnan virallisen selosteen oletustekstin sijaan. Valvontaviranomaisen yhteystiedot lisätään automaattisesti.</p>
        </div>
        <form id="a11yForm" class="card">
          <div class="grid2">
            <div class="field"><label for="aOrg">Julkaiseva organisaatio<span class="req" aria-hidden="true">*</span></label><input type="text" id="aOrg" placeholder="Kunnan tai kaupungin nimi"></div>
            <div class="field"><label for="aDate">Laadittu tai päivitetty</label><input type="text" id="aDate" placeholder="17.6.2026"></div>
          </div>
          <div class="field">
            <label for="aStatus">Vaatimustenmukaisuus</label>
            <select id="aStatus">
              <option value="full">Täyttää vaatimukset</option>
              <option value="partial" selected>Täyttää osittain</option>
              <option value="none">Ei täytä</option>
            </select>
          </div>
          <div class="grid2">
            <div class="field"><label for="aEmail">Palautteen sähköposti</label><input type="text" id="aEmail" placeholder="saavutettavuus@kunta.fi"></div>
            <div class="field"><label for="aUrl">Palautelomakkeen linkki</label><input type="url" id="aUrl" placeholder="https://"></div>
          </div>
          <div class="field">
            <label for="aMethod">Arviointitapa</label>
            <textarea id="aMethod" maxlength="600" placeholder="Esim. itsearvio automaattisilla työkaluilla (axe-core, Lighthouse) sekä näppäimistö- ja ruudunlukijatarkistuksin."></textarea>
          </div>
          <div class="field">
            <label for="aDefs">Tunnetut puutteet</label>
            <textarea id="aDefs" aria-describedby="defsHint" placeholder="Kartat ovat luonteeltaan visuaalisia; sama tieto on tekstimuodossa.&#10;Liikennöitsijän häiriötiedotteiden tekstisisältöön ei voida vaikuttaa."></textarea>
            <p class="hint" id="defsHint">Yksi puute riville.</p>
          </div>
          <details class="sv" id="svDetails">
            <summary>Ruotsinkielinen seloste (kaksikielinen kunta)</summary>
            <p class="hint" style="margin:0 0 var(--s3)">Tyhjä kenttä näyttää ruotsinkielisessä näkymässä suomenkielisen tekstin.</p>
            <div class="field"><label for="aOrgSv">Julkaiseva organisaatio ruotsiksi</label><input type="text" id="aOrgSv" placeholder="Esim. Ingå kommun"></div>
            <div class="field"><label for="aMethodSv">Arviointitapa ruotsiksi</label><textarea id="aMethodSv" maxlength="600"></textarea></div>
            <div class="field"><label for="aDefsSv">Tunnetut puutteet ruotsiksi</label><textarea id="aDefsSv"></textarea></div>
          </details>
          <div class="msg" id="a11yMsg" role="status"></div>
          <div class="form-acts"><button type="submit" class="btn btn-primary">Julkaise seloste</button></div>
        </form>
      </section>

      <section id="sec-vahti" class="sec hide" aria-labelledby="h-vahti">
        <div class="sec-head">
          <h2 id="h-vahti" tabindex="-1">Uusintapainatusvahti</h2>
          <p class="lead">Vahti kertoo, mitkä painetut aikataulut ovat vanhentuneet. Kunnan avaimella tieto painetuista tulosteista tallentuu palvelimelle, jolloin se ei ole yhden selaimen varassa. Tallennettava tieto on tuloste ja sen sormenjälki, ei henkilötietoa.</p>
        </div>
        <div class="card">
          <h3>Kunnan avain</h3>
          <div id="rpKeyBox"><p class="empty">Ladataan…</p></div>
          <div class="form-acts"><button type="button" id="rpKeyBtn" class="btn btn-ghost">Luo uusi avain</button></div>
          <div class="msg" id="rpKeyMsg" role="status"></div>
        </div>
        <div class="card">
          <h3>Ilmoitukset sähköpostiin</h3>
          <p class="muted">Vahti vertaa painettuja tulosteita nykydataan kerran vuorokaudessa ja lähettää viestin vain, kun tilanne muuttuu. Osoite saa ilmoituksia vasta, kun vahvistuslinkkiä on napsautettu. Tyhjä kenttä lopettaa ilmoitukset.</p>
          <div class="field"><label for="rpMail">Ilmoitusosoite</label>
            <input type="email" id="rpMail" placeholder="joukkoliikenne@kaupunki.fi" autocomplete="off"></div>
          <div class="form-acts"><button type="button" id="rpMailBtn" class="btn btn-primary">Tallenna osoite</button> <span class="muted" id="rpMailState"></span></div>
          <div class="msg" id="rpMailMsg" role="status"></div>
        </div>
      </section>

      <section id="sec-tilastot" class="sec hide" aria-labelledby="h-tilastot">
        <div class="sec-head">
          <h2 id="h-tilastot" tabindex="-1">Käyttötilastot</h2>
          <p class="lead">Anonyymi ja evästeetön: mitä kuntalaiset etsivät ja katsovat viimeisen 30 vuorokauden aikana. Epäonnistuneet haut kertovat yhteyksistä, joita ei löydy.</p>
        </div>
        <div class="card"><div id="statsBox"><p class="empty">Ladataan…</p></div></div>
      </section>

    </div>
  </div>
</main>
<footer class="foot">
  <span>Reittari</span>
  <span>Palvelun tarjoaa <a class="foot-sk" href="https://savikurki.fi" target="_blank" rel="noopener"><svg class="foot-sk-mark" viewBox="0 0 120 120" width="18" height="18" aria-hidden="true" focusable="false"><rect width="120" height="120" rx="24" fill="#b8764f"/><path d="M32 92 C 58 97, 88 92, 88 71 C 88 52, 36 62, 36 41 C 36 28, 50 22, 64 27" fill="none" stroke="#fbfaf7" stroke-width="15" stroke-linecap="round"/><path d="M66 28 L 96 37" fill="none" stroke="#fbfaf7" stroke-width="9" stroke-linecap="round"/></svg>Savikurki Digital Oy</a></span>
  <span>Tuki: <a href="mailto:ville@reittari.fi">ville@reittari.fi</a></span>
</footer>

<script>
const $ = id => document.getElementById(id);
// Kaupunki osoitteesta (/admin?city=inkoo). Kunnan oma tunnus toimii vain oman kaupungin sivulla.
const CITY = (() => {
  const c = (new URLSearchParams(location.search).get("city") || "lahti").toLowerCase();
  return /^[a-z][a-z0-9_-]{1,29}$/.test(c) ? c : "lahti";
})();
// Näyttönimet (index.html CONFIGS.city); avain ei kelpaa sellaisenaan (jyvaskyla, hameenlinna).
const CITY_NAMES = { lahti:"Lahti", kuopio:"Kuopio", salo:"Salo", kajaani:"Kajaani", vaasa:"Vaasa", kotka:"Kotka",
  raasepori:"Raasepori", kouvola:"Kouvola", mikkeli:"Mikkeli", hameenlinna:"Hämeenlinna", joensuu:"Joensuu",
  jyvaskyla:"Jyväskylä", lappeenranta:"Lappeenranta", oulu:"Oulu", pori:"Pori", rovaniemi:"Rovaniemi", turku:"Turku", inkoo:"Inkoo" };
const CITY_NAME = CITY_NAMES[CITY] || (CITY.charAt(0).toUpperCase() + CITY.slice(1));
const SECTIONS = ["yleiskatsaus", "tiedotteet", "hinnat", "seloste", "vahti", "tilastot"];
// Yleiskatsauksen tila: undefined = latautuu.
const S = {};
let editing = null;

function show(el, on){ el.classList.toggle("hide", !on); }
function msg(el, text, ok){ el.textContent = text; el.className = "msg " + (ok ? "ok" : "err") + (text ? " show" : ""); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function fmtNum(n){ return Number(n || 0).toLocaleString("fi-FI"); }
function fmtDay(iso){ const d = new Date(String(iso || "").slice(0,10)); return isNaN(d) ? "" : d.getDate() + "." + (d.getMonth()+1) + "." + d.getFullYear(); }

function fmtRange(a){
  const f = s => s ? new Date(s*1000).toLocaleString("fi-FI",{day:"numeric",month:"numeric",hour:"2-digit",minute:"2-digit"}) : null;
  const s=f(a.startsAt), e=f(a.endsAt);
  if (s && e) return "Voimassa " + s + " – " + e;
  if (e) return "Voimassa " + e + " asti";
  if (s) return "Alkaen " + s;
  return "Voimassa toistaiseksi";
}
function toEpoch(v){ if(!v) return null; const t=new Date(v).getTime(); return Number.isFinite(t)?Math.floor(t/1000):null; }
function toLocalInput(sec){ if(!sec) return ""; const d=new Date(sec*1000); const p=n=>String(n).padStart(2,"0");
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+"T"+p(d.getHours())+":"+p(d.getMinutes()); }
// Tiedotteen tila nyt: voimassa, tulossa tai päättynyt (sama sääntö kuin workerin currentAdminAlerts).
function alertState(a){
  const now = Date.now() / 1000;
  if (a.endsAt && a.endsAt < now) return "past";
  if (a.startsAt && a.startsAt > now) return "future";
  return "now";
}

// Polut ovat suhteellisia (admin/api/...): sivu toimii omassa osoitteessaan (/admin) ja Savikurki-työtilan
// välittämänä (/tyotila/reittari/yllapito/admin), jossa työtila hoitaa kirjautumisen.
async function api(path, opts){
  const r = await fetch(path, Object.assign({ headers:{ "Content-Type":"application/json" } }, opts));
  let data = {}; try { data = await r.json(); } catch(e){}
  return { ok:r.ok, status:r.status, data };
}

/* ---------- Osiot (hash-reititys, sivunavigaatio) ---------- */
function showSection(focus){
  let id = location.hash.replace("#", "");
  if (SECTIONS.indexOf(id) < 0) id = "yleiskatsaus";
  SECTIONS.forEach(s => show($("sec-" + s), s === id));
  document.querySelectorAll(".side a").forEach(a => {
    if (a.dataset.sec === id) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  if (focus) { const h = $("sec-" + id).querySelector("h2"); if (h) h.focus({ preventScroll:true }); window.scrollTo(0, 0); }
}
window.addEventListener("hashchange", () => showSection(true));

let TYOTILA = false;
async function init(){
  $("openApp").href = "https://demo.reittari.fi/?city=" + CITY;
  $("cityName").textContent = CITY_NAME;
  document.title = "Ylläpito · " + CITY_NAME + " · Reittari";
  const s = await api("admin/api/session?city=" + CITY, { method:"GET" });
  // Työtilassa kirjautuminen ja uloskirjautuminen ovat työtilan palkissa, ja palvelu avautuu työtilan polulta.
  TYOTILA = !!(s.data && s.data.tyotila);
  if (TYOTILA) $("openApp").href = "../?city=" + CITY + "#/tilanne";
  if (s.data && s.data.authed) enterAdmin(); else { show($("loginView"), true); $("pw").focus(); }
}

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const r = await api("admin/login", { method:"POST", body: JSON.stringify({ password: $("pw").value, city: CITY }) });
  if (r.ok) { $("pw").value=""; msg($("loginMsg"),"",true); enterAdmin(); }
  else msg($("loginMsg"), r.status===503 ? "Ylläpitoa ei ole vielä otettu käyttöön tälle kunnalle." : "Väärä salasana.", false);
});

$("logoutBtn").addEventListener("click", async () => {
  await api("admin/logout", { method:"POST" });
  show($("adminView"), false); show($("logoutBtn"), false); show($("loginView"), true);
});

function enterAdmin(){
  show($("loginView"), false); show($("adminView"), true); show($("logoutBtn"), !TYOTILA);
  showSection(false);
  renderOverview();
  loadList();
  loadFares();
  loadA11y();
  loadReprintKey();
  loadStats();
}

/* ---------- Yleiskatsaus ---------- */
function tile(sec, state, label, value, sub){
  return "<a class='tile' href='#" + sec + "'><span class='tile-label'><span class='dot " + state + "' aria-hidden='true'></span>" + esc(label) + "</span>"
    + "<span class='tile-value'>" + esc(value) + "</span><span class='tile-sub'>" + esc(sub) + "</span></a>";
}
function renderOverview(){
  const L = "Ladataan…";
  const t = [];
  const a = S.alerts;
  if (!a) t.push(tile("tiedotteet", "", "Häiriötiedotteet", L, ""));
  else if (a.err) t.push(tile("tiedotteet", "st-attn", "Häiriötiedotteet", "Ei saatavilla", "Lista ei latautunut."));
  else {
    const extra = [a.future ? a.future + " tulossa" : "", a.past ? a.past + " päättynyt" : ""].filter(Boolean).join(", ");
    t.push(tile("tiedotteet", a.now ? "st-on" : "", "Häiriötiedotteet", a.now ? a.now + " voimassa" : "Ei voimassa olevia",
      extra || "Julkaise tiedote, kun liikenteessä on poikkeus."));
  }
  const f = S.fares;
  if (!f) t.push(tile("hinnat", "", "Liput ja hinnat", L, ""));
  else if (f.published) t.push(tile("hinnat", "st-ok", "Liput ja hinnat", "Julkaistu", f.checked ? "Tarkistettu " + f.checked : "Tarkistuspäivä puuttuu."));
  else t.push(tile("hinnat", "st-attn", "Liput ja hinnat", "Ei julkaistu", "Hintoja ei ole julkaistu ylläpidosta."));
  const s = S.a11y;
  if (!s) t.push(tile("seloste", "", "Saavutettavuusseloste", L, ""));
  else if (s.published) t.push(tile("seloste", "st-ok", "Saavutettavuusseloste", "Julkaistu", s.date ? "Päivitetty " + s.date : "Päivityspäivä puuttuu."));
  else t.push(tile("seloste", "st-attn", "Saavutettavuusseloste", "Ei julkaistu", "Sovellus näyttää oletustekstin."));
  const k = S.key;
  if (!k) t.push(tile("vahti", "", "Uusintapainatusvahti", L, ""));
  else if (k.err) t.push(tile("vahti", "st-attn", "Uusintapainatusvahti", "Ei saatavilla", "Avaintietoa ei saatu."));
  else if (k.on) t.push(tile("vahti", "st-ok", "Uusintapainatusvahti", "Käytössä", fmtNum(k.units) + " tulostetta seurannassa"));
  else t.push(tile("vahti", "", "Uusintapainatusvahti", "Ei käytössä", "Seuranta toimii vain yhdessä selaimessa."));
  const st = S.stats;
  if (!st) t.push(tile("tilastot", "", "Käyttö, 30 vrk", L, ""));
  else if (st.off) t.push(tile("tilastot", "", "Käyttö, 30 vrk", "Ei käytössä", "Tilastojen luku otetaan käyttöön erikseen."));
  else if (st.err) t.push(tile("tilastot", "st-attn", "Käyttö, 30 vrk", "Ei saatavilla", "Tilastot eivät latautuneet."));
  else t.push(tile("tilastot", "st-on", "Käyttö, " + st.days + " vrk", fmtNum(st.views), "sivunäyttöä"));
  $("tiles").innerHTML = t.join("");
}

/* ---------- Häiriötiedotteet ---------- */
async function loadList(){
  const r = await api("admin/api/alerts?city="+CITY, { method:"GET" });
  if (!r.ok){ $("list").innerHTML = "<p class='empty'>Lista ei latautunut.</p>"; S.alerts = { err:true }; renderOverview(); return; }
  const items = (r.data && r.data.items) || [];
  const order = { now:0, future:1, past:2 };
  const rows = items.map(a => ({ a, st: alertState(a) })).sort((x, y) => order[x.st] - order[y.st]);
  const cnt = { now:0, future:0, past:0 };
  rows.forEach(x => cnt[x.st]++);
  S.alerts = cnt; renderOverview();
  $("navAlertCount").textContent = cnt.now; show($("navAlertCount"), cnt.now > 0);
  if (!rows.length){ $("list").innerHTML = "<p class='empty'>Ei julkaistuja tiedotteita.</p>"; return; }
  const stLabel = { now:"Voimassa", future:"Tulossa", past:"Päättynyt" };
  const stClass = { now:"b-now", future:"b-future", past:"b-past" };
  $("list").innerHTML = rows.map(({ a, st }) => {
    const sev = a.severity || "WARNING";
    const sevLabel = { INFO:"Tiedoksi", WARNING:"Varoitus", SEVERE:"Vakava" }[sev] || sev;
    return "<article class='alert-item" + (st === "past" ? " past" : "") + "'>"
      + "<div class='alert-head'><h4>" + esc(a.title) + "</h4>"
      + "<span class='badge " + stClass[st] + "'>" + stLabel[st] + "</span>"
      + "<span class='badge sev-" + esc(sev) + "'>" + esc(sevLabel) + "</span>"
      + (a.titleSv ? "<span class='badge b-past' title='Ruotsinkielinen versio'>SV</span>" : "")
      + (a.titleEn ? "<span class='badge b-past' title='Englanninkielinen versio'>EN</span>" : "") + "</div>"
      + (a.body ? "<p class='alert-body'>" + esc(a.body) + "</p>" : "")
      + "<p class='alert-meta'>" + esc(fmtRange(a)) + (a.lines && a.lines.length ? " · Linjat " + esc(a.lines.join(", ")) : "") + "</p>"
      + "<div class='alert-acts'><button type='button' class='btn btn-ghost btn-sm' data-edit='" + esc(a.id) + "'>Muokkaa</button>"
      + "<button type='button' class='btn btn-danger btn-sm' data-del='" + esc(a.id) + "'>Poista</button></div></article>";
  }).join("");
  $("list").querySelectorAll("[data-edit]").forEach(b => b.onclick = () => startEdit(items.find(x=>x.id===b.dataset.edit)));
  $("list").querySelectorAll("[data-del]").forEach(b => b.onclick = () => del(b.dataset.del));
  window._items = items;
}

function startEdit(a){
  if (!a) return;
  editing = a.id;
  $("alertId").value = a.id;
  $("title").value = a.title || "";
  $("body").value = a.body || "";
  $("titleSv").value = a.titleSv || ""; $("bodySv").value = a.bodySv || "";
  $("titleEn").value = a.titleEn || ""; $("bodyEn").value = a.bodyEn || "";
  $("alertLangDetails").open = !!(a.titleSv || a.bodySv || a.titleEn || a.bodyEn);
  $("severity").value = a.severity || "WARNING";
  $("lines").value = (a.lines||[]).join(", ");
  $("startsAt").value = toLocalInput(a.startsAt);
  $("endsAt").value = toLocalInput(a.endsAt);
  $("url").value = a.url || "";
  $("formTitle").textContent = "Muokkaa tiedotetta";
  $("saveBtn").textContent = "Tallenna muutokset";
  show($("cancelBtn"), true);
  $("formTitle").scrollIntoView({ behavior:"smooth", block:"start" });
  $("title").focus({ preventScroll:true });
}

$("cancelBtn").addEventListener("click", resetForm);
function resetForm(){
  editing = null;
  $("alertForm").reset();
  $("alertId").value = "";
  $("alertLangDetails").open = false;
  $("severity").value = "WARNING";
  $("formTitle").textContent = "Uusi tiedote";
  $("saveBtn").textContent = "Julkaise";
  show($("cancelBtn"), false);
  msg($("formMsg"), "", true);
}

$("alertForm").addEventListener("submit", async e => {
  e.preventDefault();
  const payload = {
    city: CITY,
    id: $("alertId").value || undefined,
    title: $("title").value.trim(),
    body: $("body").value.trim(),
    titleSv: $("titleSv").value.trim(),
    bodySv: $("bodySv").value.trim(),
    titleEn: $("titleEn").value.trim(),
    bodyEn: $("bodyEn").value.trim(),
    severity: $("severity").value,
    lines: $("lines").value.split(",").map(s=>s.trim()).filter(Boolean),
    startsAt: toEpoch($("startsAt").value),
    endsAt: toEpoch($("endsAt").value),
    url: $("url").value.trim(),
  };
  if (!payload.title){ msg($("formMsg"),"Otsikko on pakollinen.",false); return; }
  // Sama sääntö kuin workerissa: käännetty kuvaus tarvitsee saman kielen otsikon.
  const trMissing = payload.bodySv && !payload.titleSv ? "ruotsiksi" : payload.bodyEn && !payload.titleEn ? "englanniksi" : "";
  if (trMissing){ $("alertLangDetails").open = true; msg($("formMsg"),"Kirjoita myös otsikko " + trMissing + ", kun kuvaus on " + trMissing + ".",false); return; }
  const r = await api("admin/api/alerts", { method:"POST", body: JSON.stringify(payload) });
  if (r.ok){ resetForm(); msg($("formMsg"),"Tallennettu ja julkaistu.",true); setTimeout(()=>msg($("formMsg"),"",true),2500); loadList(); }
  else if (r.status===403){ msg($("formMsg"),"Istunto vanheni. Kirjaudu uudelleen.",false); }
  else if (r.data && r.data.error==="translation_title"){ msg($("formMsg"),"Käännetty kuvaus tarvitsee saman kielen otsikon.",false); }
  else msg($("formMsg"),"Tallennus epäonnistui.",false);
});

async function del(id){
  if (!confirm("Poistetaanko tiedote?")) return;
  const r = await api("admin/api/alerts/delete", { method:"POST", body: JSON.stringify({ city:CITY, id }) });
  if (r.ok) loadList();
}

/* ---------- Liput ja hinnat ----------
   Oletuspohja (Lahti) esitäyttää lomakkeen, kun mitään ei ole vielä julkaistu;
   tallennuksen jälkeen KV on lähde. Sama rakenne kuin client-CONFIG.fares. */
const DEFAULT_FARES = {
  checked:"14.6.2026", url:"https://www.lsl.fi/liput-ja-hinnat/hinnasto/",
  single:{ cardApp:{adult:"2,95",child:"1,50",reduced:"2,10"}, contactless:"3,10", salespoint:{adult:"3,80",child:"1,90",reduced:"3,80"} },
  season:[{d:"30",adult:"62",child:"31",reduced:"44"},{d:"90",adult:"180",child:"85",reduced:"125"},{d:"180",adult:"330",child:"165",reduced:"230"},{d:"270",adult:"465",child:"230",reduced:"315"},{d:"365",adult:"590",child:"255",reduced:"420"}],
  day:[{d:"1",adult:"10",child:"5"},{d:"3",adult:"20",child:"10"},{d:"7",adult:"30",child:"15"}],
  capDay:"10", capWeek:"30", cardFee:"5",
};
const COL_LABELS = { d:"Vrk", adult:"Aikuinen", child:"Lapsi", reduced:"Alennus" };

function fareCell(k, val){
  const td=document.createElement("td"); if (k === "d") td.className = "d";
  const i=document.createElement("input"); i.type="text"; i.value=val||""; i.inputMode = "decimal";
  i.setAttribute("aria-label", COL_LABELS[k]);
  if (k === "d") td.appendChild(i);
  else { const w=document.createElement("span"); w.className="money"; w.appendChild(i); td.appendChild(w); }
  return td;
}
function rowEl(cols, r){
  const tr=document.createElement("tr"); r=r||{};
  cols.forEach(k=>tr.appendChild(fareCell(k, r[k])));
  const td=document.createElement("td"); td.className="rm";
  const b=document.createElement("button"); b.type="button"; b.className="btn btn-danger btn-sm"; b.textContent="✕";
  b.setAttribute("aria-label", "Poista rivi"); b.onclick=()=>tr.remove();
  td.appendChild(b); tr.appendChild(td); return tr;
}
function seasonRowEl(r){ return rowEl(["d","adult","child","reduced"], r); }
function dayRowEl(r){ return rowEl(["d","adult","child"], r); }
function rowsFrom(tbody, cols){
  return [...tbody.querySelectorAll("tr")].map(tr=>{
    const ins=tr.querySelectorAll("input"); const o={};
    cols.forEach((c,i)=>o[c]=ins[i]?ins[i].value.trim():""); return o;
  }).filter(o=>o.d);
}
function fillFares(f){
  f = f || DEFAULT_FARES;
  const sa=(f.single&&f.single.cardApp)||{}, sp=(f.single&&f.single.salespoint)||{};
  $("fChecked").value=f.checked||""; $("fUrl").value=f.url||"";
  $("fSaAdult").value=sa.adult||""; $("fSaChild").value=sa.child||""; $("fSaReduced").value=sa.reduced||"";
  $("fContactless").value=(f.single&&f.single.contactless)||"";
  $("fSpAdult").value=sp.adult||""; $("fSpChild").value=sp.child||""; $("fSpReduced").value=sp.reduced||"";
  $("fCapDay").value=f.capDay||""; $("fCapWeek").value=f.capWeek||""; $("fCardFee").value=f.cardFee||"";
  $("seasonBody").innerHTML=""; (f.season||[]).forEach(r=>$("seasonBody").appendChild(seasonRowEl(r)));
  $("dayBody").innerHTML=""; (f.day||[]).forEach(r=>$("dayBody").appendChild(dayRowEl(r)));
}
function gatherFares(){
  return {
    city: CITY,
    checked: $("fChecked").value.trim(), url: $("fUrl").value.trim(),
    single:{ cardApp:{adult:$("fSaAdult").value.trim(),child:$("fSaChild").value.trim(),reduced:$("fSaReduced").value.trim()},
      contactless:$("fContactless").value.trim(),
      salespoint:{adult:$("fSpAdult").value.trim(),child:$("fSpChild").value.trim(),reduced:$("fSpReduced").value.trim()} },
    season: rowsFrom($("seasonBody"), ["d","adult","child","reduced"]),
    day: rowsFrom($("dayBody"), ["d","adult","child"]),
    capDay:$("fCapDay").value.trim(), capWeek:$("fCapWeek").value.trim(), cardFee:$("fCardFee").value.trim(),
  };
}
async function loadFares(){
  const r = await api("admin/api/fares?city="+CITY, { method:"GET" });
  const pub = r.ok && r.data && r.data.fares;
  S.fares = pub ? { published:true, checked:pub.checked || "" } : { published:false }; renderOverview();
  // Lahden oletushinnat vain Lahdelle: muualla tyhjä lomake, ettei Lahden hintoja julkaista vahingossa.
  fillFares(pub ? pub : (CITY === "lahti" ? DEFAULT_FARES : {}));
}
$("addSeason").addEventListener("click", ()=>$("seasonBody").appendChild(seasonRowEl()));
$("addDay").addEventListener("click", ()=>$("dayBody").appendChild(dayRowEl()));
$("faresForm").addEventListener("submit", async e => {
  e.preventDefault();
  const r = await api("admin/api/fares", { method:"POST", body: JSON.stringify(gatherFares()) });
  if (r.ok){ msg($("faresMsg"),"Hinnat julkaistu.",true); setTimeout(()=>msg($("faresMsg"),"",true),2500);
    S.fares = { published:true, checked:$("fChecked").value.trim() }; renderOverview(); }
  else if (r.status===403){ msg($("faresMsg"),"Istunto vanheni. Kirjaudu uudelleen.",false); }
  else msg($("faresMsg"),"Tallennus epäonnistui.",false);
});

/* ---------- Saavutettavuusseloste ---------- */
async function loadA11y(){
  const r = await api("admin/api/a11y?city="+CITY, { method:"GET" });
  const a = (r.ok && r.data && r.data.a11y) || {};
  S.a11y = a.orgName ? { published:true, date:a.date || "" } : { published:false }; renderOverview();
  $("aOrg").value=a.orgName||""; $("aDate").value=a.date||""; $("aStatus").value=a.status||"partial";
  $("aEmail").value=a.feedbackEmail||""; $("aUrl").value=a.feedbackUrl||""; $("aMethod").value=a.method||"";
  $("aDefs").value=(a.deficiencies||[]).join("\\n");
  $("aOrgSv").value=a.orgNameSv||""; $("aMethodSv").value=a.methodSv||""; $("aDefsSv").value=(a.deficienciesSv||[]).join("\\n");
  // Ruotsinkielinen osa auki, jos siinä on jo sisältöä.
  $("svDetails").open = !!(a.orgNameSv || a.methodSv || (a.deficienciesSv && a.deficienciesSv.length));
}
$("a11yForm").addEventListener("submit", async e => {
  e.preventDefault();
  const payload = {
    city: CITY,
    orgName: $("aOrg").value.trim(), date: $("aDate").value.trim(), status: $("aStatus").value,
    feedbackEmail: $("aEmail").value.trim(), feedbackUrl: $("aUrl").value.trim(), method: $("aMethod").value.trim(),
    deficiencies: $("aDefs").value.split("\\n").map(s=>s.trim()).filter(Boolean),
    orgNameSv: $("aOrgSv").value.trim(), methodSv: $("aMethodSv").value.trim(),
    deficienciesSv: $("aDefsSv").value.split("\\n").map(s=>s.trim()).filter(Boolean),
  };
  if (!payload.orgName){ msg($("a11yMsg"),"Julkaiseva organisaatio on pakollinen.",false); return; }
  const r = await api("admin/api/a11y", { method:"POST", body: JSON.stringify(payload) });
  if (r.ok){ msg($("a11yMsg"),"Seloste julkaistu.",true); setTimeout(()=>msg($("a11yMsg"),"",true),2500);
    S.a11y = { published:true, date:payload.date }; renderOverview(); }
  else if (r.status===403){ msg($("a11yMsg"),"Istunto vanheni. Kirjaudu uudelleen.",false); }
  else msg($("a11yMsg"),"Tallennus epäonnistui.",false);
});

/* ---------- Uusintapainatusvahti: kaupungin avain ---------- */
async function loadReprintKey(){
  const r = await api("admin/api/reprint/key?city="+CITY, { method:"GET" });
  const box = $("rpKeyBox");
  if (!r.ok || !r.data || r.data.error){ box.innerHTML="<p class='empty'>Avaintietoa ei saatu.</p>"; S.key = { err:true }; renderOverview(); return; }
  const d = r.data;
  S.key = d.exists ? { on:true, units:d.units } : { on:false }; renderOverview();
  box.innerHTML = d.exists
    ? "<p style='margin-top:0'>Avain on myönnetty " + esc(fmtDay(d.created)) + ". Palvelimella on <strong>" + esc(fmtNum(d.units)) + "</strong> seurattua tulostetta"
      + (d.updated ? " (päivitetty " + esc(fmtDay(d.updated)) + ")" : "") + ".</p>"
    : "<p class='empty'>Avainta ei ole vielä myönnetty. Seuranta toimii toistaiseksi vain kunnan omassa selaimessa.</p>";
}
$("rpMailBtn").addEventListener("click", async () => {
  // Tyhjä kenttä = lopeta ilmoitukset. Osoite on henkilötieto, joten se kysytään vain täällä,
  // ei julkisessa sovelluksessa.
  const email = $("rpMail").value.trim();
  const r = await api("admin/api/reprint/notify", { method:"POST", body: JSON.stringify({ city: CITY, email }) });
  if (!r.ok || !r.data || r.data.error){ msg($("rpMailMsg"), "Tallennus epäonnistui" + (r.data && r.data.error ? " (" + r.data.error + ")" : "") + ".", false); return; }
  msg($("rpMailMsg"), email ? "Vahvistusviesti lähetetty osoitteeseen " + email + ". Ilmoitukset alkavat vasta vahvistuksen jälkeen." : "Ilmoitukset lopetettu.", true);
  $("rpMailState").textContent = email ? "Odottaa vahvistusta" : "";
});

$("rpKeyBtn").addEventListener("click", async () => {
  // Uusi avain ei pyyhi perustasoa, mutta vanha avain lakkaa toimimasta.
  if (!confirm("Luodaanko uusi avain? Vanha avain lakkaa toimimasta ja se on syötettävä sovellukseen uudelleen.")) return;
  const r = await api("admin/api/reprint/key", { method:"POST", body: JSON.stringify({ city: CITY }) });
  if (!r.ok || !r.data || !r.data.key){ msg($("rpKeyMsg"), "Avaimen luonti epäonnistui.", false); return; }
  $("rpKeyBox").innerHTML = "<p style='margin-top:0'><strong>Uusi avain (näytetään vain nyt):</strong></p><p><code style='word-break:break-all;font-size:1.1em'>"+esc(r.data.key)+"</code></p><p class='muted'>Syötä tämä sovelluksen Uusintapainatus-näkymään.</p>";
  msg($("rpKeyMsg"), "Avain luotu.", true);
});

/* ---------- Käyttöanalytiikka ---------- */
const PAGE_LABELS = { home:"Etusivu", linja:"Linja", pysakki:"Pysäkki", reitti:"Reittihaku", liput:"Liput ja hinnat", kartta:"Bussit kartalla", linjasto:"Linjasto", laiturit:"Keskustan pysäkit", tulosta:"Tulostus", poikkeukset:"Poikkeuspäivät", palaute:"Palaute", asetukset:"Asetukset", saavutettavuus:"Saavutettavuus", monitori:"Monitori" };
function statList(title, rows, labelFn){
  if (!rows || !rows.length) return "<div><h4>" + esc(title) + "</h4><p class='empty'>Ei tietoja vielä.</p></div>";
  const top = rows.slice(0,10);
  const max = Math.max.apply(null, top.map(r => Number(r.n) || 0)) || 1;
  const items = top.map(r => "<tr><td>" + esc(labelFn ? labelFn(r) : r.value) + "</td>"
    + "<td class='bar' aria-hidden='true'><span style='width:" + Math.round((Number(r.n) || 0) / max * 100) + "%'></span></td>"
    + "<td class='n'>" + esc(fmtNum(r.n)) + "</td></tr>").join("");
  return "<div><h4>" + esc(title) + "</h4><table class='stable'><tbody>" + items + "</tbody></table></div>";
}
async function loadStats(){
  const r = await api("admin/api/stats?city="+CITY, { method:"GET" });
  const box = $("statsBox");
  if (!r.ok){ box.innerHTML="<p class='empty'>Tilastot eivät latautuneet.</p>"; S.stats = { err:true }; renderOverview(); return; }
  if (r.data && r.data.error === "unconfigured"){
    // Tekninen ohje (secretit CF_ACCOUNT_ID ja CF_API_TOKEN) on PLAYBOOKissa, ei kunnan henkilöstölle näkyvässä tekstissä.
    box.innerHTML="<p class='empty'>Tilastojen luku otetaan käyttöön erikseen. Tapahtumia kerätään jo, joten tilastot näkyvät tässä heti käyttöönoton jälkeen.</p>";
    S.stats = { off:true }; renderOverview();
    return;
  }
  if (r.data && r.data.error){ box.innerHTML="<p class='empty'>Tilastokysely epäonnistui (" + esc(r.data.error) + ").</p>"; S.stats = { err:true }; renderOverview(); return; }
  const d = r.data || {};
  S.stats = { views:d.totalViews || 0, days:d.days || 30 }; renderOverview();
  box.innerHTML =
    "<p style='margin:0'><span class='big'>" + esc(fmtNum(d.totalViews)) + "</span> sivunäyttöä viimeisen " + esc(String(d.days||30)) + " vuorokauden aikana.</p>"
    + "<div class='stat-grid'>"
    + statList("Suosituimmat sivut", d.views, r=>PAGE_LABELS[r.value]||r.value)
    + statList("Katsotuimmat linjat", d.lines, r=>"Linja "+(r.name||r.value))
    + statList("Katsotuimmat pysäkit", d.stops, r=>r.name||r.value)
    + statList("Epäonnistuneet haut", d.failedSearches)
    + "</div>";
}

init();
</script>
</body>
</html>`;

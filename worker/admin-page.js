// Ylläpitonäkymä (#1): kaupungin henkilöstö julkaisee häiriötiedotteita selaimessa
// ilman WordPressiä/koodia. Tarjoillaan workerista (sama origin → istuntoeväste
// toimii ilman CORS-säätöä, ja Cloudflare Access voidaan kytkeä /admin* eteen).
// Sivu on yksi tiedosto, ei buildia — sama linja kuin julkinen index.html.
export const ADMIN_HTML = `<!doctype html>
<html lang="fi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Ylläpito · Aikataulupalvelu</title>
<style>
  :root { --c:#0a4ea3; --bg:#f4f6f9; --line:#dde3ea; --warn:#a35a00; --sev:#b00020; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui,Segoe UI,Roboto,Arial,sans-serif; color:#16202b; background:var(--bg); }
  header { background:var(--c); color:#fff; padding:.8rem 1rem; display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
  header h1 { font-size:1.05rem; margin:0; flex:1; }
  header a, header button { color:#fff; }
  main { max-width:780px; margin:0 auto; padding:1rem; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:1rem; margin:0 0 1rem; }
  h2 { font-size:1.1rem; margin:.2rem 0 .8rem; }
  label { display:block; font-weight:600; font-size:.86rem; margin:.6rem 0 .2rem; }
  input, textarea, select, button { font:inherit; }
  input[type=text], input[type=url], input[type=datetime-local], textarea, select {
    width:100%; padding:.55rem .6rem; border:1px solid var(--line); border-radius:8px; background:#fff; }
  textarea { min-height:5rem; resize:vertical; }
  .row { display:flex; gap:.8rem; flex-wrap:wrap; }
  .row > div { flex:1; min-width:180px; }
  button { cursor:pointer; border:0; border-radius:8px; padding:.55rem .9rem; background:var(--c); color:#fff; font-weight:600; }
  button.secondary { background:transparent; color:var(--c); border:1px solid var(--c); }
  button.danger { background:transparent; color:var(--sev); border:1px solid var(--sev); padding:.3rem .6rem; font-size:.85rem; }
  button.small { padding:.3rem .6rem; font-size:.85rem; }
  .muted { color:#5a6573; font-size:.88rem; }
  .item { border:1px solid var(--line); border-radius:8px; padding:.6rem .7rem; margin:.5rem 0; }
  .item h3 { margin:0 0 .2rem; font-size:1rem; }
  .tag { display:inline-block; font-size:.72rem; font-weight:700; padding:.1rem .45rem; border-radius:999px; vertical-align:middle; }
  .tag.INFO { background:#e6f0fb; color:var(--c); }
  .tag.WARNING { background:#fdeede; color:var(--warn); }
  .tag.SEVERE { background:#fde7ea; color:var(--sev); }
  .item .acts { margin-top:.4rem; display:flex; gap:.5rem; }
  .msg { padding:.6rem .8rem; border-radius:8px; margin:.5rem 0; display:none; }
  .msg.show { display:block; }
  .msg.ok { background:#e6f4ea; color:#155724; }
  .msg.err { background:#fde7ea; color:#7a1020; }
  .hide { display:none !important; }
  .login { max-width:360px; margin:3rem auto; }
  h3.sub { font-size:1rem; margin:.9rem 0 .2rem; }
  table.fedit { width:100%; border-collapse:collapse; }
  table.fedit th { font-size:.78rem; text-align:left; color:#5a6573; padding:.1rem .3rem; font-weight:600; }
  table.fedit td { padding:.15rem .3rem; }
  table.fedit input { padding:.4rem .45rem; }
  table.fedit td.rm { width:2.2rem; text-align:center; }
</style>
</head>
<body>
<header>
  <h1>Aikataulupalvelu · Ylläpito</h1>
  <a id="openApp" href="#" target="_blank" rel="noopener" class="small" style="text-decoration:underline">Avaa julkinen sovellus ↗</a>
  <button id="logoutBtn" class="small secondary hide" style="color:#fff;border-color:#fff">Kirjaudu ulos</button>
</header>
<main>
  <!-- Kirjautuminen -->
  <section id="loginView" class="card login hide">
    <h2>Kirjaudu</h2>
    <p class="muted">Syötä ylläpitosalasana. Tuotannossa kirjautuminen hoidetaan kaupungin omilla tunnuksilla (Cloudflare Access).</p>
    <form id="loginForm">
      <label for="pw">Salasana</label>
      <input type="password" id="pw" autocomplete="current-password" required style="width:100%;padding:.55rem .6rem;border:1px solid var(--line);border-radius:8px">
      <div class="msg err" id="loginMsg"></div>
      <p><button type="submit">Kirjaudu</button></p>
    </form>
  </section>

  <!-- Hallinta -->
  <section id="adminView" class="hide">
    <div class="card">
      <h2>Häiriötiedote</h2>
      <p class="muted">Julkaistu tiedote näkyy heti sovelluksen etusivun häiriöbannerissa. Voimassaolon voi rajata aikavälille.</p>
      <form id="alertForm">
        <input type="hidden" id="alertId">
        <label for="title">Otsikko *</label>
        <input type="text" id="title" maxlength="200" required>
        <label for="body">Kuvaus</label>
        <textarea id="body" maxlength="2000"></textarea>
        <div class="row">
          <div>
            <label for="severity">Vakavuus</label>
            <select id="severity">
              <option value="INFO">Tiedoksi</option>
              <option value="WARNING" selected>Varoitus</option>
              <option value="SEVERE">Vakava</option>
            </select>
          </div>
          <div>
            <label for="lines">Linjat (pilkulla, valinn.)</label>
            <input type="text" id="lines" placeholder="3, 8K, 12">
          </div>
        </div>
        <div class="row">
          <div>
            <label for="startsAt">Alkaa (valinn.)</label>
            <input type="datetime-local" id="startsAt">
          </div>
          <div>
            <label for="endsAt">Päättyy (valinn.)</label>
            <input type="datetime-local" id="endsAt">
          </div>
        </div>
        <label for="url">Lisätietolinkki (valinn.)</label>
        <input type="url" id="url" placeholder="https://...">
        <div class="msg" id="formMsg"></div>
        <p>
          <button type="submit" id="saveBtn">Julkaise</button>
          <button type="button" id="cancelBtn" class="secondary hide">Peruuta muokkaus</button>
        </p>
      </form>
    </div>

    <div class="card">
      <h2>Julkaistut tiedotteet</h2>
      <div id="list"><p class="muted">Ladataan…</p></div>
    </div>

    <div class="card">
      <h2>Liput ja hinnat</h2>
      <p class="muted">Julkaistut hinnat näkyvät sovelluksen "Liput ja hinnat" -sivulla ja korvaavat oletushinnat. Tarkista luvut huolella. Hinnat eurolla, pilkulla (esim. 2,95).</p>
      <form id="faresForm">
        <div class="row">
          <div><label for="fChecked">Tarkistettu (pvm)</label><input type="text" id="fChecked" placeholder="14.6.2026"></div>
          <div><label for="fUrl">Virallinen hinnasto (linkki)</label><input type="url" id="fUrl"></div>
        </div>
        <h3 class="sub">Kertaliput</h3>
        <div class="row">
          <div><label for="fSaAdult">Kortti/sov. – aikuinen</label><input type="text" id="fSaAdult"></div>
          <div><label for="fSaChild">– lapsi</label><input type="text" id="fSaChild"></div>
          <div><label for="fSaReduced">– nuoriso/op./sen.</label><input type="text" id="fSaReduced"></div>
        </div>
        <div class="row">
          <div><label for="fContactless">Lähimaksu (kaikki)</label><input type="text" id="fContactless"></div>
          <div><label for="fSpAdult">Palvelupiste – aikuinen</label><input type="text" id="fSpAdult"></div>
          <div><label for="fSpChild">– lapsi</label><input type="text" id="fSpChild"></div>
          <div><label for="fSpReduced">– alennus</label><input type="text" id="fSpReduced"></div>
        </div>
        <h3 class="sub">Kausiliput</h3>
        <table class="fedit"><thead><tr><th>Vrk</th><th>Aikuinen</th><th>Lapsi</th><th>Alennus</th><th></th></tr></thead>
          <tbody id="seasonBody"></tbody></table>
        <p><button type="button" class="small secondary" id="addSeason">+ Lisää rivi</button></p>
        <h3 class="sub">Vuorokausiliput</h3>
        <table class="fedit"><thead><tr><th>Vrk</th><th>Aikuinen</th><th>Lapsi</th><th></th></tr></thead>
          <tbody id="dayBody"></tbody></table>
        <p><button type="button" class="small secondary" id="addDay">+ Lisää rivi</button></p>
        <h3 class="sub">Muut</h3>
        <div class="row">
          <div><label for="fCapDay">Lähimaksun katto / vrk</label><input type="text" id="fCapDay"></div>
          <div><label for="fCapWeek">/ viikko</label><input type="text" id="fCapWeek"></div>
          <div><label for="fCardFee">Waltti-kortti (€)</label><input type="text" id="fCardFee"></div>
        </div>
        <div class="msg" id="faresMsg"></div>
        <p><button type="submit">Julkaise hinnat</button></p>
      </form>
    </div>

    <div class="card">
      <h2>Saavutettavuusseloste</h2>
      <p class="muted">Digipalvelulaki (306/2019) edellyttää selosteen. Kun julkaiset tämän, sovellus näyttää virallisen, lain mukaisen selosteen oletustekstin sijaan. Valvontaviranomaisen yhteystiedot lisätään automaattisesti.</p>
      <form id="a11yForm">
        <div class="row">
          <div><label for="aOrg">Julkaiseva organisaatio *</label><input type="text" id="aOrg" placeholder="Lahden kaupunki"></div>
          <div><label for="aDate">Laadittu/päivitetty (pvm)</label><input type="text" id="aDate" placeholder="17.6.2026"></div>
        </div>
        <label for="aStatus">Vaatimustenmukaisuus</label>
        <select id="aStatus">
          <option value="full">Täyttää vaatimukset</option>
          <option value="partial" selected>Täyttää osittain</option>
          <option value="none">Ei täytä</option>
        </select>
        <div class="row">
          <div><label for="aEmail">Palaute: sähköposti</label><input type="text" id="aEmail" placeholder="saavutettavuus@lahti.fi"></div>
          <div><label for="aUrl">Palaute: lomakkeen linkki (valinn.)</label><input type="url" id="aUrl"></div>
        </div>
        <label for="aMethod">Arviointitapa (valinn.)</label>
        <textarea id="aMethod" maxlength="600" placeholder="Esim. itsearvio automaattisilla työkaluilla (axe-core, Lighthouse) sekä näppäimistö- ja ruudunlukijatarkistuksin."></textarea>
        <label for="aDefs">Tunnetut puutteet (yksi per rivi)</label>
        <textarea id="aDefs" placeholder="Kartat ovat luonteeltaan visuaalisia; sama tieto on tekstimuodossa.&#10;Liikennöitsijän häiriötiedotteiden tekstisisältöön ei voida vaikuttaa."></textarea>
        <div class="msg" id="a11yMsg"></div>
        <p><button type="submit">Julkaise seloste</button></p>
      </form>
    </div>

    <div class="card">
      <h2>Uusintapainatusvahti</h2>
      <p class="muted">Kaupungin oma avain, jolla sovellus tallentaa palvelimelle tiedon siitä mistä datasta tulosteet on painettu. Ilman avainta seuranta elää vain yhdessä selaimessa. Avain näytetään vain kerran: kopioi se talteen. Tallennettava tieto on tuloste ja sen sormenjälki, ei henkilötietoa.</p>
      <div id="rpKeyBox"><p class="muted">Ladataan…</p></div>
      <p><button type="button" id="rpKeyBtn">Luo uusi avain</button></p>
      <div class="msg" id="rpKeyMsg"></div>
      <h3 class="sub">Ilmoitukset sähköpostiin</h3>
      <p class="muted">Vahti vertaa painettuja tulosteita nykydataan kerran vuorokaudessa ja lähettää viestin vain kun tilanne muuttuu. Osoite saa ilmoituksia vasta kun vahvistuslinkki on klikattu.</p>
      <div class="field"><label for="rpMail">Ilmoitusosoite</label>
        <input type="email" id="rpMail" placeholder="joukkoliikenne@kaupunki.fi" autocomplete="off"></div>
      <p><button type="button" id="rpMailBtn">Tallenna osoite</button> <span class="muted" id="rpMailState"></span></p>
      <div class="msg" id="rpMailMsg"></div>
    </div>

    <div class="card">
      <h2>Käyttöanalytiikka</h2>
      <p class="muted">Anonyymi ja evästeetön: mitä kuntalaiset etsivät ja katsovat viimeisen 30 vrk aikana. Erityisen arvokasta: epäonnistuneet haut (yhteyksiä joita ei löydy).</p>
      <div id="statsBox"><p class="muted">Ladataan…</p></div>
    </div>
  </section>
</main>

<script>
const $ = id => document.getElementById(id);
const CITY = "lahti";
let editing = null;

function show(el, on){ el.classList.toggle("hide", !on); }
function msg(el, text, ok){ el.textContent = text; el.className = "msg " + (ok ? "ok" : "err") + (text ? " show" : ""); }

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

async function api(path, opts){
  const r = await fetch(path, Object.assign({ headers:{ "Content-Type":"application/json" } }, opts));
  let data = {}; try { data = await r.json(); } catch(e){}
  return { ok:r.ok, status:r.status, data };
}

async function init(){
  $("openApp").href = "https://veikkoville.github.io/lsl-aikataulut/?city=" + CITY;
  const s = await api("/admin/api/session", { method:"GET" });
  if (s.data && s.data.authed) enterAdmin(); else show($("loginView"), true);
}

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const r = await api("/admin/login", { method:"POST", body: JSON.stringify({ password: $("pw").value }) });
  if (r.ok) { $("pw").value=""; msg($("loginMsg"),"",true); enterAdmin(); }
  else msg($("loginMsg"), r.status===503 ? "Ylläpitoa ei ole vielä konfiguroitu (salaisuudet puuttuvat)." : "Väärä salasana.", false);
});

$("logoutBtn").addEventListener("click", async () => {
  await api("/admin/logout", { method:"POST" });
  show($("adminView"), false); show($("logoutBtn"), false); show($("loginView"), true);
});

function enterAdmin(){
  show($("loginView"), false); show($("adminView"), true); show($("logoutBtn"), true);
  loadList();
  loadFares();
  loadA11y();
  loadReprintKey();
  loadStats();
}

async function loadList(){
  const r = await api("/admin/api/alerts?city="+CITY, { method:"GET" });
  if (!r.ok){ $("list").innerHTML = "<p class='muted'>Lista ei latautunut.</p>"; return; }
  const items = (r.data && r.data.items) || [];
  if (!items.length){ $("list").innerHTML = "<p class='muted'>Ei julkaistuja tiedotteita.</p>"; return; }
  $("list").innerHTML = items.map(a => {
    const sev = a.severity || "WARNING";
    const sevLabel = { INFO:"Tiedoksi", WARNING:"Varoitus", SEVERE:"Vakava" }[sev] || sev;
    return "<div class='item'>"
      + "<h3>"+esc(a.title)+" <span class='tag "+sev+"'>"+sevLabel+"</span></h3>"
      + (a.body ? "<div>"+esc(a.body)+"</div>" : "")
      + "<div class='muted'>"+esc(fmtRange(a))+(a.lines&&a.lines.length?" · Linjat: "+esc(a.lines.join(", ")):"")+"</div>"
      + "<div class='acts'><button class='small secondary' data-edit='"+esc(a.id)+"'>Muokkaa</button>"
      + "<button class='danger' data-del='"+esc(a.id)+"'>Poista</button></div></div>";
  }).join("");
  $("list").querySelectorAll("[data-edit]").forEach(b => b.onclick = () => startEdit(items.find(x=>x.id===b.dataset.edit)));
  $("list").querySelectorAll("[data-del]").forEach(b => b.onclick = () => del(b.dataset.del));
  window._items = items;
}

function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

function startEdit(a){
  if (!a) return;
  editing = a.id;
  $("alertId").value = a.id;
  $("title").value = a.title || "";
  $("body").value = a.body || "";
  $("severity").value = a.severity || "WARNING";
  $("lines").value = (a.lines||[]).join(", ");
  $("startsAt").value = toLocalInput(a.startsAt);
  $("endsAt").value = toLocalInput(a.endsAt);
  $("url").value = a.url || "";
  $("saveBtn").textContent = "Tallenna muutokset";
  show($("cancelBtn"), true);
  window.scrollTo({ top:0, behavior:"smooth" });
}

$("cancelBtn").addEventListener("click", resetForm);
function resetForm(){
  editing = null;
  $("alertForm").reset();
  $("alertId").value = "";
  $("severity").value = "WARNING";
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
    severity: $("severity").value,
    lines: $("lines").value.split(",").map(s=>s.trim()).filter(Boolean),
    startsAt: toEpoch($("startsAt").value),
    endsAt: toEpoch($("endsAt").value),
    url: $("url").value.trim(),
  };
  if (!payload.title){ msg($("formMsg"),"Otsikko on pakollinen.",false); return; }
  const r = await api("/admin/api/alerts", { method:"POST", body: JSON.stringify(payload) });
  if (r.ok){ resetForm(); msg($("formMsg"),"Tallennettu ja julkaistu.",true); setTimeout(()=>msg($("formMsg"),"",true),2500); loadList(); }
  else if (r.status===403){ msg($("formMsg"),"Istunto vanheni. Kirjaudu uudelleen.",false); }
  else msg($("formMsg"),"Tallennus epäonnistui.",false);
});

async function del(id){
  if (!confirm("Poistetaanko tiedote?")) return;
  const r = await api("/admin/api/alerts/delete", { method:"POST", body: JSON.stringify({ city:CITY, id }) });
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

function fareInput(val){ const i=document.createElement("input"); i.type="text"; i.value=val||""; return i; }
function seasonRowEl(r){
  const tr=document.createElement("tr"); r=r||{};
  ["d","adult","child","reduced"].forEach(k=>{ const td=document.createElement("td"); td.appendChild(fareInput(r[k])); tr.appendChild(td); });
  const td=document.createElement("td"); td.className="rm";
  const b=document.createElement("button"); b.type="button"; b.className="danger small"; b.textContent="✕"; b.onclick=()=>tr.remove();
  td.appendChild(b); tr.appendChild(td); return tr;
}
function dayRowEl(r){
  const tr=document.createElement("tr"); r=r||{};
  ["d","adult","child"].forEach(k=>{ const td=document.createElement("td"); td.appendChild(fareInput(r[k])); tr.appendChild(td); });
  const td=document.createElement("td"); td.className="rm";
  const b=document.createElement("button"); b.type="button"; b.className="danger small"; b.textContent="✕"; b.onclick=()=>tr.remove();
  td.appendChild(b); tr.appendChild(td); return tr;
}
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
  const r = await api("/admin/api/fares?city="+CITY, { method:"GET" });
  fillFares(r.ok && r.data && r.data.fares ? r.data.fares : DEFAULT_FARES);
}
$("addSeason").addEventListener("click", ()=>$("seasonBody").appendChild(seasonRowEl()));
$("addDay").addEventListener("click", ()=>$("dayBody").appendChild(dayRowEl()));
$("faresForm").addEventListener("submit", async e => {
  e.preventDefault();
  const r = await api("/admin/api/fares", { method:"POST", body: JSON.stringify(gatherFares()) });
  if (r.ok){ msg($("faresMsg"),"Hinnat julkaistu.",true); setTimeout(()=>msg($("faresMsg"),"",true),2500); }
  else if (r.status===403){ msg($("faresMsg"),"Istunto vanheni. Kirjaudu uudelleen.",false); }
  else msg($("faresMsg"),"Tallennus epäonnistui.",false);
});

/* ---------- Saavutettavuusseloste ---------- */
async function loadA11y(){
  const r = await api("/admin/api/a11y?city="+CITY, { method:"GET" });
  const a = (r.ok && r.data && r.data.a11y) || {};
  $("aOrg").value=a.orgName||""; $("aDate").value=a.date||""; $("aStatus").value=a.status||"partial";
  $("aEmail").value=a.feedbackEmail||""; $("aUrl").value=a.feedbackUrl||""; $("aMethod").value=a.method||"";
  $("aDefs").value=(a.deficiencies||[]).join("\\n");
}
$("a11yForm").addEventListener("submit", async e => {
  e.preventDefault();
  const payload = {
    city: CITY,
    orgName: $("aOrg").value.trim(), date: $("aDate").value.trim(), status: $("aStatus").value,
    feedbackEmail: $("aEmail").value.trim(), feedbackUrl: $("aUrl").value.trim(), method: $("aMethod").value.trim(),
    deficiencies: $("aDefs").value.split("\\n").map(s=>s.trim()).filter(Boolean),
  };
  if (!payload.orgName){ msg($("a11yMsg"),"Julkaiseva organisaatio on pakollinen.",false); return; }
  const r = await api("/admin/api/a11y", { method:"POST", body: JSON.stringify(payload) });
  if (r.ok){ msg($("a11yMsg"),"Seloste julkaistu.",true); setTimeout(()=>msg($("a11yMsg"),"",true),2500); }
  else if (r.status===403){ msg($("a11yMsg"),"Istunto vanheni. Kirjaudu uudelleen.",false); }
  else msg($("a11yMsg"),"Tallennus epäonnistui.",false);
});

/* ---------- Uusintapainatusvahti: kaupungin avain ---------- */
async function loadReprintKey(){
  const r = await api("/admin/api/reprint/key?city="+CITY, { method:"GET" });
  const box = $("rpKeyBox");
  if (!r.ok || !r.data || r.data.error){ box.innerHTML="<p class='muted'>Avaintietoa ei saatu.</p>"; return; }
  const d = r.data;
  box.innerHTML = d.exists
    ? "<p>Avain on myönnetty "+esc(String(d.created||"").slice(0,10))+". Palvelimella on <strong>"+esc(String(d.units))+"</strong> seurattua tulostetta"+(d.updated?" (päivitetty "+esc(String(d.updated).slice(0,10))+")":"")+".</p>"
    : "<p class='muted'>Avainta ei ole vielä myönnetty. Seuranta elää toistaiseksi vain kaupungin omassa selaimessa.</p>";
}
$("rpMailBtn").addEventListener("click", async () => {
  // Tyhjä kenttä = lopeta ilmoitukset. Osoite on henkilötieto, joten se kysytään vain täällä,
  // ei julkisessa sovelluksessa.
  const email = $("rpMail").value.trim();
  const r = await api("/admin/api/reprint/notify", { method:"POST", body: JSON.stringify({ city: CITY, email }) });
  if (!r.ok || !r.data || r.data.error){ msg($("rpMailMsg"), "Tallennus epäonnistui" + (r.data && r.data.error ? " (" + r.data.error + ")" : "") + ".", false); return; }
  msg($("rpMailMsg"), email ? "Vahvistusviesti lähetetty osoitteeseen " + email + ". Ilmoitukset alkavat vasta vahvistuksen jälkeen." : "Ilmoitukset lopetettu.", true);
  $("rpMailState").textContent = email ? "odottaa vahvistusta" : "";
});

$("rpKeyBtn").addEventListener("click", async () => {
  // Uusi avain ei pyyhi perustasoa, mutta vanha avain lakkaa toimimasta.
  if (!confirm("Luodaanko uusi avain? Vanha avain lakkaa toimimasta ja se on syötettävä sovellukseen uudelleen.")) return;
  const r = await api("/admin/api/reprint/key", { method:"POST", body: JSON.stringify({ city: CITY }) });
  if (!r.ok || !r.data || !r.data.key){ msg($("rpKeyMsg"), "Avaimen luonti epäonnistui.", false); return; }
  $("rpKeyBox").innerHTML = "<p><strong>Uusi avain (näytetään vain nyt):</strong></p><p><code style='word-break:break-all;font-size:1.1em'>"+esc(r.data.key)+"</code></p><p class='muted'>Syötä tämä sovelluksen Uusintapainatus-näkymään.</p>";
  msg($("rpKeyMsg"), "Avain luotu.", true);
});

/* ---------- Käyttöanalytiikka ---------- */
const PAGE_LABELS = { home:"Etusivu", linja:"Linja", pysakki:"Pysäkki", reitti:"Reittihaku", liput:"Liput ja hinnat", kartta:"Bussit kartalla", linjasto:"Linjasto", laiturit:"Keskustan pysäkit", tulosta:"Tulostus", poikkeukset:"Poikkeuspäivät", palaute:"Palaute", asetukset:"Asetukset", saavutettavuus:"Saavutettavuus", monitori:"Monitori" };
function statList(title, rows, labelFn){
  if (!rows || !rows.length) return "<div style='flex:1;min-width:220px'><h3 class='sub'>"+esc(title)+"</h3><p class='muted'>Ei tietoja vielä.</p></div>";
  const items = rows.slice(0,10).map(r=>"<tr><td>"+esc(labelFn?labelFn(r):r.value)+"</td><td style='text-align:right'>"+esc(String(r.n))+"</td></tr>").join("");
  return "<div style='flex:1;min-width:220px'><h3 class='sub'>"+esc(title)+"</h3><table class='fedit'><tbody>"+items+"</tbody></table></div>";
}
async function loadStats(){
  const r = await api("/admin/api/stats?city="+CITY, { method:"GET" });
  const box = $("statsBox");
  if (!r.ok){ box.innerHTML="<p class='muted'>Tilastot eivät latautuneet.</p>"; return; }
  if (r.data && r.data.error === "unconfigured"){
    box.innerHTML="<p class='muted'>Analytiikan luku ei ole vielä käytössä. Aseta workeriin secretit <code>CF_ACCOUNT_ID</code> ja <code>CF_API_TOKEN</code> (Account Analytics -lukuoikeus), niin tilastot ilmestyvät tähän. Tapahtumien keräys on jo päällä.</p>";
    return;
  }
  if (r.data && r.data.error){ box.innerHTML="<p class='muted'>Tilastokysely epäonnistui ("+esc(r.data.error)+").</p>"; return; }
  const d = r.data || {};
  box.innerHTML =
    "<p><strong>"+esc(String(d.totalViews||0))+"</strong> sivunäyttöä viimeisen "+esc(String(d.days||30))+" vrk aikana.</p>"
    + "<div class='row'>"
    + statList("Suosituimmat sivut", d.views, r=>PAGE_LABELS[r.value]||r.value)
    + statList("Katsotuimmat linjat", d.lines, r=>"Linja "+(r.name||r.value))
    + "</div><div class='row'>"
    + statList("Katsotuimmat pysäkit", d.stops, r=>r.name||r.value)
    + statList("Epäonnistuneet haut", d.failedSearches)
    + "</div>";
}

init();
</script>
</body>
</html>`;

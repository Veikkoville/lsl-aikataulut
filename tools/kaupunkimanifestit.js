// Kaupunkikohtaiset PWA-manifestit: manifests/<kaupunki>.webmanifest
//
// Juurimanifestin (manifest.webmanifest) start_url on ".", jossa ei ole kaupunkia, joten muun kuin
// oletuskaupungin sivulta asennettu sovellus avautui Lahtena (Inkoon auditointi 29.9.2026).
// index.html vaihtaa manifestilinkin tähän tiedostoon, jos se on olemassa. Chrome ei hyväksy
// blob-manifestia, joten tiedostot ovat staattisia. Polut ovat suhteellisia manifests/-kansioon,
// joten sama tiedosto toimii sekä demo.reittari.fi:ssä että veikkoville.github.io/lsl-aikataulut/:ssa.
//
// Aja kun kaupunki lisätään tai juurimanifesti muuttuu:  node tools/kaupunkimanifestit.js
// Tarkistus ilman kirjoitusta (CI/smoke):                node tools/kaupunkimanifestit.js --check
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "manifests");

// CONFIGS luetaan index.html:stä samalla tavalla kuin tests/muutosvahti.js ja kausivalidointi.js.
function extractConfigs() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const start = html.indexOf("const CONFIGS = {");
  if (start < 0) throw new Error("CONFIGS-lohkoa ei löytynyt index.html:stä");
  const open = html.indexOf("{", start);
  let depth = 0, i = open, mode = null;
  for (; i < html.length; i++) {
    const c = html[i], n = html[i + 1];
    if (mode === "line") { if (c === "\n") mode = null; continue; }
    if (mode === "block") { if (c === "*" && n === "/") { mode = null; i++; } continue; }
    if (mode) { if (c === "\\") { i++; continue; } if (c === mode) mode = null; continue; }
    if (c === "/" && n === "/") { mode = "line"; i++; continue; }
    if (c === "/" && n === "*") { mode = "block"; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { mode = c; continue; }
    if (c === "{") depth++;
    if (c === "}") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error("CONFIGS-lohkon sulut eivät täsmää");
  const configs = new Function("return (" + html.slice(open, i + 1) + ")")();
  if (Object.keys(configs).length < 10 || !configs.lahti) throw new Error("CONFIGS-poiminta epäilyttävä");
  return configs;
}

const up = u => "../" + String(u).replace(/^\.\//, "");

function cityManifest(base, key, cfg) {
  const oma = "../?city=" + key;
  const m = JSON.parse(JSON.stringify(base));
  m.id = oma;
  m.start_url = oma;
  m.scope = "../";
  m.name = "Reittari " + (cfg.city || key);
  // Ei lähtöjen reaaliaikaa (CONFIG.departureRealtime === false): kuvaus ei lupaa sitä.
  if (cfg.departureRealtime === false) m.description = String(m.description || "").replace("reaaliaika, ", "");
  (m.icons || []).forEach(i => { i.src = up(i.src); });
  (m.screenshots || []).forEach(i => { i.src = up(i.src); });
  m.shortcuts = (m.shortcuts || [])
    // Livekartta on tyhjä kaupungeissa ilman ajoneuvopositioita (CONFIG.vehicleRealtime === false).
    .filter(sc => !(cfg.vehicleRealtime === false && String(sc.url).includes("#/kartta")))
    .map(sc => ({
      ...sc,
      url: oma + "#" + String(sc.url).split("#")[1],
      icons: (sc.icons || []).map(i => ({ ...i, src: up(i.src) })),
    }));
  return JSON.stringify(m, null, 2) + "\n";
}

const check = process.argv.includes("--check");
const configs = extractConfigs();
const base = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.webmanifest"), "utf8"));
if (!check && !fs.existsSync(OUT)) fs.mkdirSync(OUT);
let changed = 0, wrong = [];
for (const [key, cfg] of Object.entries(configs)) {
  if (key === "lahti") continue;   // oletuskaupunki käyttää juurimanifestia
  const file = path.join(OUT, key + ".webmanifest");
  const want = cityManifest(base, key, cfg);
  // Windowsin autocrlf-checkout tuo tiedostot CRLF:nä: vertailu rivinvaihdoista riippumatta.
  const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
  if (have === want) continue;
  if (check) { wrong.push(key); continue; }
  fs.writeFileSync(file, want);
  changed++;
}
if (check) {
  if (wrong.length) { console.error("Kaupunkimanifesti puuttuu tai on vanhentunut: " + wrong.join(", ") + ". Aja node tools/kaupunkimanifestit.js"); process.exit(1); }
  console.log("Kaupunkimanifestit ajan tasalla (" + (Object.keys(configs).length - 1) + " kaupunkia).");
} else {
  console.log("Kaupunkimanifestit: " + changed + " kirjoitettu, " + (Object.keys(configs).length - 1) + " kaupunkia.");
}

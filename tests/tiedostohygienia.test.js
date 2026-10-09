// Tiedostohygienia: tekstitiedostossa ei saa olla NUL-tavua. NUL saa ripgrepin ja Grep-työkalun
// pitämään tiedostoa binäärinä, jolloin se ohitetaan koko repon haussa.
// Käyttö: node tests/tiedostohygienia.test.js [tiedosto ...]  (ilman argumentteja: git ls-files)
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BINAARI = /\.(png|pdf|woff2?|ttf|otf|ico|jpe?g|mp3|webp)$/i;
const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const files = args.length
  ? args
  : execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((f) => path.join(root, f));

let bad = 0;
let checked = 0;
for (const f of files) {
  if (BINAARI.test(f) || !fs.existsSync(f)) continue;
  checked++;
  const idx = fs.readFileSync(f).indexOf(0);
  if (idx >= 0) {
    bad++;
    console.error("FAIL " + f + ": NUL-tavu kohdassa " + idx);
  }
}
if (bad) process.exit(1);
console.log("OK tiedostohygienia: " + checked + " tekstitiedostoa ilman NUL-tavuja");

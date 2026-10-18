// Testaa henkilötietojen EU-varaston (personalKv) oikeaa SQLiteä vasten: sama skeema kuin D1:ssä
// (migrations/0001_henkilotiedot.sql) ja D1:n prepare/bind/first/all/run-rajapinta ohuena kuorena.
// Lisäksi päästä päähän: palaute tallentuu EU-kantaan eikä KV:hen, ja ilman kantaa reitti vastaa 503.
// Aja: node personal-store.test.js
import worker, { personalKv, purgeExpiredPersonal, withPersonalStore, PERSONAL_LIST_LIMIT } from "./worker.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

let fail = 0, total = 0;
const check = (cond, msg) => { total++; console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };

// D1:n rajapinta node:sqliten päällä (?1, ?2 ... sidotaan järjestyksessä kuten D1:ssä).
function d1(db) {
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() { return st.get(...args) ?? null; },
        async all() { return { results: st.all(...args) }; },
        async run() { st.run(...args); return { success: true }; },
      };
      return api;
    },
  };
}
function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./migrations/0001_henkilotiedot.sql", import.meta.url), "utf8"));
  return db;
}
const mockKV = () => {
  const m = new Map();
  return { _m: m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }) };
};
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

// --- get / put / delete ---
{
  const db = freshDb();
  const kv = personalKv(d1(db));
  check((await kv.get("ei-ole")) === null, "get: puuttuva avain → null");
  await kv.put("sub:a", JSON.stringify({ x: 1 }));
  check((await kv.get("sub:a")) === "{\"x\":1}", "put + get: arvo palautuu merkkijonona");
  await kv.put("sub:a", "toinen");
  check((await kv.get("sub:a")) === "toinen" && db.prepare("SELECT count(*) AS n FROM kv").get().n === 1, "put: sama avain korvataan, ei tuplariviä");
  await kv.delete("sub:a");
  check((await kv.get("sub:a")) === null, "delete: rivi poistuu");
  await kv.delete("ei-ole");
  check(true, "delete: puuttuvan avaimen poisto ei kaadu");
}

// --- vanheneminen (expirationTtl) ---
{
  const db = freshDb();
  const kv = personalKv(d1(db));
  clock = realNow();
  await kv.put("fb:1", "palaute", { expirationTtl: 90 * 24 * 3600 });
  const row = db.prepare("SELECT expires_at FROM kv WHERE key = 'fb:1'").get();
  check(row.expires_at === Math.floor(clock / 1000) + 90 * 24 * 3600, "TTL: expires_at = nyt + 90 vrk");
  await kv.put("email:lahti:h", "vahvistamaton", { expirationTtl: 7 * 24 * 3600 });
  await kv.put("email:lahti:h", "vahvistettu");
  check(db.prepare("SELECT expires_at FROM kv WHERE key = 'email:lahti:h'").get().expires_at === null,
    "TTL: put ilman TTL:ää poistaa vanhenemisen (vahvistettu tilaus ei vanhene, kuten KV:ssä)");
  clock += 91 * 24 * 3600 * 1000;
  check((await kv.get("fb:1")) === null, "TTL: vanhentunut rivi ei näy get-haussa");
  check((await kv.list({ prefix: "fb:" })).keys.length === 0, "TTL: vanhentunut rivi ei näy listauksessa");
  check(db.prepare("SELECT count(*) AS n FROM kv WHERE key = 'fb:1'").get().n === 1, "TTL: rivi on kannassa kunnes siivous ajetaan");
  await purgeExpiredPersonal({ PERSONAL_DB: d1(db) });
  check(db.prepare("SELECT count(*) AS n FROM kv WHERE key = 'fb:1'").get().n === 0, "siivous: vanhentunut rivi poistetaan kannasta");
  check((await kv.get("email:lahti:h")) === "vahvistettu", "siivous: vanhenematon rivi jää");
  await purgeExpiredPersonal({});
  check(true, "siivous ilman kantaa ei kaadu");
  clock = realNow();
}

// --- list: etuliite ja sivutus ---
{
  const db = freshDb();
  const kv = personalKv(d1(db));
  const N = PERSONAL_LIST_LIMIT + 7;
  const ins = db.prepare("INSERT INTO kv (key, value, expires_at) VALUES (?1, ?2, NULL)");
  for (let i = 0; i < N; i++) ins.run("sub:" + String(i).padStart(5, "0"), "v");
  ins.run("subx:1", "v");
  ins.run("fb:1", "v");
  const seen = [];
  let cursor, pages = 0;
  do {
    const r = await kv.list({ prefix: "sub:", cursor });
    seen.push(...r.keys.map(k => k.name));
    cursor = r.list_complete ? null : r.cursor;
    pages++;
  } while (cursor && pages < 10);
  check(pages === 2 && seen.length === N && new Set(seen).size === N, `list: ${N} avainta kahdella sivulla, jokainen kerran`);
  check(seen.every(k => k.startsWith("sub:")), "list: etuliite rajaa (subx: ja fb: eivät tule mukaan)");
  const all1 = await kv.list();
  check((await kv.list({ prefix: "fb:" })).keys.length === 1 && all1.keys.length === PERSONAL_LIST_LIMIT && !all1.list_complete,
    "list: toinen etuliite, ja tyhjä etuliite palauttaa täyden sivun kursorilla");
}

// --- withPersonalStore ---
{
  const db = freshDb();
  const base = { PUSH_KV: mockKV(), PERSONAL_DB: d1(db), DIGITRANSIT_KEY: "k" };
  const e = withPersonalStore(base);
  check(!!e.PERSONAL_KV && e.PUSH_KV === base.PUSH_KV && e.DIGITRANSIT_KEY === "k", "withPersonalStore: lisää PERSONAL_KV:n ja säilyttää muut sidonnat");
  const noDb = { PUSH_KV: mockKV() };
  check(withPersonalStore(noDb) === noDb && !noDb.PERSONAL_KV, "withPersonalStore: ilman kantaa env ennallaan (ei varalla KV:tä)");
  const given = { PERSONAL_KV: mockKV(), PERSONAL_DB: d1(db) };
  check(withPersonalStore(given) === given, "withPersonalStore: valmis PERSONAL_KV säilyy (testit)");
}

// --- Päästä päähän: palaute ---
{
  const db = freshDb();
  const kv = mockKV();
  const ctx = { waitUntil() {} };
  const post = ip => new Request("https://worker.test/feedback", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://demo.reittari.fi", "CF-Connecting-IP": ip, "User-Agent": "Mozilla/5.0 Chrome/120" },
    body: JSON.stringify({ category: "other", message: "Pysäkki rikki", contact: "a@b.fi", city: "lahti" }) });
  const r = await worker.fetch(post("198.51.100.50"), { PUSH_KV: kv, PERSONAL_DB: d1(db) }, ctx);
  const rows = db.prepare("SELECT key, value, expires_at FROM kv").all();
  check(r.status === 200 && rows.length === 1 && rows[0].key.startsWith("fb:") && JSON.parse(rows[0].value).contact === "a@b.fi",
    "palaute: tallentuu EU-kantaan");
  check(rows.length === 1 && rows[0].expires_at > Math.floor(Date.now() / 1000) + 89 * 24 * 3600, "palaute: 90 vrk säilytysaika kannassa");
  check(kv._m.size === 0, "palaute: KV:hen ei kirjoiteta mitään");
  const r503 = await worker.fetch(post("198.51.100.51"), { PUSH_KV: kv }, ctx);
  check(r503.status === 503 && kv._m.size === 0, "palaute ilman EU-kantaa: 503, ei varatallennusta KV:hen");
}

Date.now = realNow;
console.log(fail === 0 ? `\nKAIKKI OK (${total} tarkistusta)` : `\n${fail}/${total} TARKISTUSTA EPÄONNISTUI`);
process.exit(fail ? 1 : 0);

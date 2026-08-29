// Reititysrajapinnan valinta: ?router=finland ohjaa valtakunnalliseen routeriin, tuntematon
// arvo ja puuttuva parametri putoavat Walttiin (ei avointa välityspalvelinta).
// Aja: node router.test.js
import worker, { routingUpstream } from "./worker.js";

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };

check(routingUpstream() === "https://api.digitransit.fi/routing/v2/waltti/gtfs/v1", "oletus on waltti");
check(routingUpstream("finland") === "https://api.digitransit.fi/routing/v2/finland/gtfs/v1", "finland valitaan");
check(routingUpstream("FINLAND") === routingUpstream("finland"), "kirjainkoko ei vaikuta");
check(routingUpstream("hsl") === routingUpstream("waltti"), "tuntematon router putoaa Walttiin");
check(routingUpstream("https://evil.example/") === routingUpstream("waltti"), "URL parametrina ei avaa proxya");

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), key: init && init.headers && init.headers["digitransit-subscription-key"] });
  return new Response('{"data":{}}', { status: 200, headers: { "Content-Type": "application/json" } });
};
const env = { DIGITRANSIT_KEY: "test-key" };
const post = (path) => worker.fetch(new Request("https://proxy.example" + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Origin": "https://demo.reittari.fi" },
  body: '{"query":"{ feeds { feedId } }"}',
}), env, { waitUntil() {} });

const r1 = await post("/");
check(r1.status === 200 && calls[0].url.includes("/waltti/"), "POST / menee Waltti-routeriin");
const r2 = await post("/?router=finland");
check(r2.status === 200 && calls[1].url.includes("/finland/"), "POST /?router=finland menee finland-routeriin");
check(calls[1].key === "test-key", "avain lisätään myös finland-kutsuun");
const r3 = await post("/?router=../../admin");
check(r3.status === 200 && calls[2].url.includes("/waltti/"), "polkuinjektio parametrissa putoaa Walttiin");
globalThis.fetch = realFetch;

console.log(fail ? `${fail} FAIL` : "kaikki OK");
process.exit(fail ? 1 : 0);

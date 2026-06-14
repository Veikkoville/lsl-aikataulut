// Todentaa aes128gcm-salauksen RFC 8291 Appendix A -testivektoreita vasten.
// Aja: node webpush.test.js  (Node 18+, jossa globaali crypto.subtle)
import { encryptPayload, bytesToB64url, b64urlToBytes, vapidHeaders } from "./webpush.js";

const V = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  expected: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

let fail = 0;
const check = (cond, msg) => { console.log((cond ? "OK   " : "FAIL ") + msg); if (!cond) fail++; };

// Rakenna palvelimen ECDH-yksityisavain JWK:na (d + julkisen pisteen x,y)
const asPub = b64urlToBytes(V.asPublic);              // 0x04 | x(32) | y(32)
const asJwk = {
  kty: "EC", crv: "P-256",
  x: bytesToB64url(asPub.slice(1, 33)),
  y: bytesToB64url(asPub.slice(33, 65)),
  d: V.asPrivate,
  ext: true, key_ops: ["deriveBits"],
};

const asPrivateKey = await crypto.subtle.importKey(
  "jwk", asJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);

const { body } = await encryptPayload(
  b64urlToBytes(V.plaintext),                          // "When I grow up, I want to be a watermelon"
  b64urlToBytes(V.uaPublic),
  b64urlToBytes(V.auth),
  { asPrivateKey, asPublicBytes: asPub, salt: b64urlToBytes(V.salt) });

const got = bytesToB64url(body);
check(got === V.expected, "RFC 8291 Appendix A -testivektori (aes128gcm)");
if (got !== V.expected) {
  console.log("  odotettu: " + V.expected);
  console.log("  saatu:    " + got);
}

// VAPID JWT: rakentuu ja allekirjoitus verifioituu julkisella avaimella
const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapidPrivJwk = await crypto.subtle.exportKey("jwk", vapid.privateKey);
const vapidPubJwk = await crypto.subtle.exportKey("jwk", vapid.publicKey);
const vapidPubBytes = (() => {
  const x = b64urlToBytes(vapidPubJwk.x), y = b64urlToBytes(vapidPubJwk.y);
  const p = new Uint8Array(65); p[0] = 4; p.set(x, 1); p.set(y, 33); return p;
})();
const { Authorization } = await vapidHeaders(
  "https://fcm.googleapis.com/fcm/send/abc", vapidPrivJwk, bytesToB64url(vapidPubBytes), "mailto:test@example.com", 1000000000);
const m = Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
check(!!m, "VAPID-otsake muodostuu (vapid t=…, k=…)");
if (m) {
  const [h, p, s] = m[1].split(".");
  const data = new TextEncoder().encode(h + "." + p);
  const sig = b64urlToBytes(s);
  const verifyKey = await crypto.subtle.importKey("jwk", vapidPubJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, sig, data);
  check(valid, "VAPID JWT -allekirjoitus verifioituu");
  const payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  check(payload.aud === "https://fcm.googleapis.com", "VAPID aud = endpointin origin");
  check(payload.sub === "mailto:test@example.com", "VAPID sub = subject");
}

console.log(fail ? `\n${fail} TARKISTUS EPÄONNISTUI` : "\nKAIKKI TARKISTUKSET OK");
process.exit(fail ? 1 : 0);

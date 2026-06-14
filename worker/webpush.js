// Web Push -salaus (RFC 8291, aes128gcm) + VAPID-todennus (RFC 8292) pelkällä
// WebCryptolla — toimii Cloudflare Workerissa ilman npm-riippuvuuksia.
// Salaus on todennettu RFC 8291:n Appendix A -testivektoreita vasten
// (worker/webpush.test.js).

const enc = new TextEncoder();
const utf8 = s => enc.encode(s);

export function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(b) {
  const arr = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

// Salaa hyötykuorman tilaajalle (aes128gcm, yksi tietue). opts mahdollistaa
// kiinteän palvelinavainparin ja suolan testausta varten (muuten satunnaiset).
export async function encryptPayload(plaintext, uaPublicBytes, authSecretBytes, opts = {}) {
  let asPriv, asPub;
  if (opts.asPrivateKey) {
    asPriv = opts.asPrivateKey;
    asPub = opts.asPublicBytes;
  } else {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPriv = kp.privateKey;
    asPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  }
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));

  // ECDH-jaettu salaisuus vastaanottajan julkisen avaimen kanssa
  const uaKey = await crypto.subtle.importKey(
    "raw", uaPublicBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaKey }, asPriv, 256));

  // IKM = HKDF(auth_secret, ecdh, "WebPush: info"\0 ua_public as_public)
  const keyInfo = concat(utf8("WebPush: info"), new Uint8Array([0]), uaPublicBytes, asPub);
  const ikm = await hkdf(authSecretBytes, ecdh, keyInfo, 32);

  // CEK ja NONCE (RFC 8188)
  const cek = await hkdf(salt, ikm, concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(utf8("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  // Yksi tietue: data + 0x02 (viimeisen tietueen erotin), AES-128-GCM
  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, cekKey, padded));

  // Otsake: salt(16) | record_size(4 = 4096) | idlen(1=65) | keyid(as_public)
  const rs = new Uint8Array([0, 0, 0x10, 0x00]);
  const header = concat(salt, rs, new Uint8Array([asPub.length]), asPub);
  return { body: concat(header, ct), asPublicBytes: asPub, salt };
}

// VAPID-Authorization-otsake yhdelle push-endpointille (ES256-allekirjoitettu JWT)
export async function vapidHeaders(endpoint, vapidPrivateJwk, vapidPublicB64url, subject, nowSec) {
  const aud = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud, exp: (nowSec ?? Math.floor(Date.now() / 1000)) + 12 * 3600, sub: subject };
  const part = o => bytesToB64url(utf8(JSON.stringify(o)));
  const signingInput = part(header) + "." + part(payload);
  const key = await crypto.subtle.importKey(
    "jwk", vapidPrivateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput)));
  const jwt = signingInput + "." + bytesToB64url(sig);
  return { Authorization: `vapid t=${jwt}, k=${vapidPublicB64url}` };
}

// Lähettää salatun push-viestin. Palauttaa HTTP-statuksen (404/410 = poistunut tilaus).
export async function sendPush(subscription, payloadString, env) {
  const ua = b64urlToBytes(subscription.keys.p256dh);
  const auth = b64urlToBytes(subscription.keys.auth);
  const { body } = await encryptPayload(utf8(payloadString), ua, auth);
  const vapidPrivateJwk = typeof env.VAPID_PRIVATE_JWK === "string"
    ? JSON.parse(env.VAPID_PRIVATE_JWK) : env.VAPID_PRIVATE_JWK;
  const vh = await vapidHeaders(
    subscription.endpoint, vapidPrivateJwk, env.VAPID_PUBLIC,
    env.VAPID_SUBJECT || "mailto:vvsaarinen@gmail.com");
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      ...vh,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
    },
    body,
  });
  return res.status;
}

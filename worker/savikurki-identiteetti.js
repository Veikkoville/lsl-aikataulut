// Kopio Savikurki-työtilan tiedostosta src/identiteetti.js (sellaisenaan, ei riippuvuuksia). Työtila allekirjoittaa
// otsakkeen moduulikohtaisella avaimella; tämä worker varmentaa sen ylläpidon kirjautumisena (worker.js adminScope).
// Päivitä vain kopioimalla työtilan versio, jotta molemmat päät pysyvät samassa muodossa.

// Identiteettiotsake, jonka työtila lisää moduulin alkuperäosoitteeseen välitettyyn pyyntöön.
//
//   Savikurki-Identiteetti: v1.<runko>.<allekirjoitus>
//   runko = base64url(JSON { v, kunta, tuotekunta, moduuli, roolit, kayttaja, iat, exp })
//   kunta = työtilan kunta (alidomain), tuotekunta = kunta, jonka dataa käyttäjä saa tuotteessa nähdä
//   allekirjoitus = base64url(HMAC-SHA256(avain, "savikurki-identiteetti.v1." + runko))
//
// Avain on moduulikohtainen (esim. IDENTITEETTI_AVAIN_LUVAT), joten yhden tuotteen avaimella ei voi väärentää
// toisen tuotteen identiteettiä. Tiedosto on tarkoituksella itsenäinen (ei importteja): tuote voi kopioida sen
// sellaisenaan ja käyttää funktiota varmennaIdentiteetti, ks. docs/MODUULIN-KYTKENTA.md.

export const IDENTITEETTI_OTSAKE = 'Savikurki-Identiteetti';
export const IDENTITEETTI_KESTO = 120;
const ETULIITE = 'savikurki-identiteetti.v1.';

const te = new TextEncoder();
const b64url = (u) => {
  let s = '';
  for (const t of new Uint8Array(u)) s += String.fromCharCode(t);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlPura = (str) => {
  if (!/^[A-Za-z0-9_-]+$/.test(str) || str.length % 4 === 1) throw new Error('base64url');
  let b = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
};
const avain = (salaisuus) => {
  if (typeof salaisuus !== 'string' || salaisuus.length < 32) throw new Error('identiteettiavain puuttuu tai on liian lyhyt');
  return crypto.subtle.importKey('raw', te.encode(salaisuus), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
};

export async function allekirjoitaIdentiteetti({ kunta, tuotekunta, moduuli, roolit, kayttaja, nyt, kesto = IDENTITEETTI_KESTO }, salaisuus) {
  const sisalto = { v: 1, kunta, tuotekunta: tuotekunta || kunta, moduuli, roolit: roolit || [], kayttaja, iat: nyt, exp: nyt + kesto };
  const runko = b64url(te.encode(JSON.stringify(sisalto)));
  const sig = await crypto.subtle.sign('HMAC', await avain(salaisuus), te.encode(ETULIITE + runko));
  return 'v1.' + runko + '.' + b64url(sig);
}

/**
 * Tuotteen puolen varmennus. Palauttaa { kunta, tuotekunta, moduuli, roolit, kayttaja, iat, exp } tai null.
 * Tuote vertaa pyydetyn datan kuntaa kenttään tuotekunta.
 * @param {string} arvo  otsakkeen arvo
 * @param {string} salaisuus  tuotteen oma identiteettiavain
 * @param {{ moduuli: string, nyt?: number, viive?: number }} o  moduuli = tuotteen oma moduulitunniste
 */
export async function varmennaIdentiteetti(arvo, salaisuus, o) {
  const nyt = o?.nyt ?? Math.floor(Date.now() / 1000);
  const viive = o?.viive ?? 30;
  if (typeof arvo !== 'string' || arvo.length > 4096) return null;
  const osat = arvo.split('.');
  if (osat.length !== 3 || osat[0] !== 'v1') return null;
  let sig, sisalto;
  try {
    sig = b64urlPura(osat[2]);
    const ok = await crypto.subtle.verify('HMAC', await avain(salaisuus), sig, te.encode(ETULIITE + osat[1]));
    if (!ok) return null;
    sisalto = JSON.parse(new TextDecoder().decode(b64urlPura(osat[1])));
  } catch {
    return null;
  }
  if (!sisalto || sisalto.v !== 1 || typeof sisalto.exp !== 'number' || typeof sisalto.iat !== 'number') return null;
  if (nyt > sisalto.exp || sisalto.iat > nyt + viive) return null;
  if (sisalto.exp - sisalto.iat > 600) return null;
  if (!o?.moduuli || sisalto.moduuli !== o.moduuli) return null;
  if (typeof sisalto.kunta !== 'string' || typeof sisalto.tuotekunta !== 'string' || !Array.isArray(sisalto.roolit)) return null;
  return sisalto;
}

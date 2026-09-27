/* Savikurki-ydin 1.0: kaupungin kerros kuntapalveluille. Savikurki Digital Oy.
   Yksi tiedosto, ei riippuvuuksia eikä verkkopyyntöjä. Nimiavaruus window.SavikurkiYdin.
   Osat: 1 päivämäärät, 2 määräaikamoottori ja kalenteritiedosto, 3 laskenta (työjono, mittarit, estetyt
   virheet, säästöarvio, säännöt, seutu), 4 viennit, 5 käyttöliittymä. Osat 1-4 toimivat myös Nodessa.
   Päivämäärät ovat merkkijonoja 'VVVV-KK-PP', ja ne lasketaan UTC:ssä, jotta kesäaika ei siirrä päiviä.
   Demon ja ytimen välinen sopimus: ADAPTERI.md. */
(function (root) {
  'use strict';
  const VERSIO = '1.0.0';

  /* ================= 1. Päivämäärät ================= */
  const PAIVA = 86400000;
  const utc = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const fmt = t => new Date(t).toISOString().slice(0, 10);
  const onPvm = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fmt(utc(s)) === s;
  function vaadiPvm(s, mika) {
    if (!onPvm(s)) throw new Error(`${mika} pitää antaa muodossa VVVV-KK-PP, saatiin ${JSON.stringify(s)}.`);
    return s;
  }
  const lisaaPaivia = (s, n) => fmt(utc(s) + n * PAIVA);
  const viikonpaiva = s => (new Date(utc(s)).getUTCDay() + 6) % 7 + 1; // 1 = ma ... 7 = su
  const erotusPaivina = (a, b) => Math.round((utc(b) - utc(a)) / PAIVA);
  // Laki 150/1930 3 §: sama järjestysnumero, tai kuukauden viimeinen päivä, jos sitä ei ole.
  function lisaaKuukausia(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    const k = y * 12 + (m - 1) + n, ny = Math.floor(k / 12), nm = k - ny * 12;
    const viimeinen = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return fmt(Date.UTC(ny, nm, Math.min(d, viimeinen)));
  }
  const VK = ['ma', 'ti', 'ke', 'to', 'pe', 'la', 'su'];
  const KK = ['tammikuu', 'helmikuu', 'maaliskuu', 'huhtikuu', 'toukokuu', 'kesäkuu', 'heinäkuu', 'elokuu', 'syyskuu', 'lokakuu', 'marraskuu', 'joulukuu'];
  const fi = s => (s ? s.split('-').map(Number).reverse().join('.') : '');
  const fiLyhyt = s => { const [, m, d] = s.split('-').map(Number); return `${d}.${m}.`; };
  const fiVk = s => (s ? `${VK[viikonpaiva(s) - 1]} ${fi(s)}` : '');
  const kuukaudenNimi = kk => `${KK[Number(kk.slice(5, 7)) - 1]} ${kk.slice(0, 4)}`;
  const iso = s => s.charAt(0).toUpperCase() + s.slice(1);
  // Kuukausijakso 'VVVV-KK'. Kesken olevan kuukauden jakso päättyy tarkastelupäivään.
  function jakso(kk, tanaan) {
    const alku = `${kk}-01`, kuunLoppu = lisaaPaivia(lisaaKuukausia(alku, 1), -1);
    const kesken = !!tanaan && tanaan < kuunLoppu;
    return { kk, alku, loppu: kesken ? tanaan : kuunLoppu, kuunLoppu, kesken, nimi: kuukaudenNimi(kk) };
  }
  function paikallinenTanaan() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /* ================= 2. Määräaikamoottori ================= */
  const TUETUT_VUODET = { alku: 2024, loppu: 2035 };

  // Pääsiäispäivä gregoriaanisella algoritmilla (Meeus/Jones/Butcher).
  function paasiainen(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const kk = Math.floor((h + l - 7 * m + 114) / 31), pv = ((h + l - 7 * m + 114) % 31) + 1;
    return fmt(Date.UTC(y, kk - 1, pv));
  }
  const lauantaiAlkaen = (y, kk, pv) => {
    for (let n = 0; n < 7; n++) { const s = fmt(Date.UTC(y, kk - 1, pv + n)); if (viikonpaiva(s) === 6) return s; }
    return null;
  };

  // Päivät, joina määräaika ei pääty (laki 150/1930 5 §) ja jotka eivät ole työpäiviä, lauantaiden ja sunnuntaiden lisäksi.
  // laji: kirkollinen = kirkkolaki 652/2023 1 luku 6 §, valtiollinen = itsenäisyys- ja vapunpäivä, aatto = joulu- ja juhannusaatto.
  const pyhaMuisti = new Map();
  function pyhat(y) {
    if (!pyhaMuisti.has(y)) {
      const p = paasiainen(y), juhannus = lauantaiAlkaen(y, 6, 20);
      const lista = [
        [`${y}-01-01`, 'uudenvuodenpäivä', 'kirkollinen'], [`${y}-01-06`, 'loppiainen', 'kirkollinen'],
        [lisaaPaivia(p, -2), 'pitkäperjantai', 'kirkollinen'], [p, 'pääsiäispäivä', 'kirkollinen'],
        [lisaaPaivia(p, 1), 'toinen pääsiäispäivä', 'kirkollinen'], [`${y}-05-01`, 'vapunpäivä', 'valtiollinen'],
        [lisaaPaivia(p, 39), 'helatorstai', 'kirkollinen'], [lisaaPaivia(p, 49), 'helluntai', 'kirkollinen'],
        [lisaaPaivia(juhannus, -1), 'juhannusaatto', 'aatto'], [juhannus, 'juhannuspäivä', 'kirkollinen'],
        [lauantaiAlkaen(y, 10, 31), 'pyhäinpäivä', 'kirkollinen'], [`${y}-12-06`, 'itsenäisyyspäivä', 'valtiollinen'],
        [`${y}-12-24`, 'jouluaatto', 'aatto'], [`${y}-12-25`, 'joulupäivä', 'kirkollinen'], [`${y}-12-26`, 'tapaninpäivä', 'kirkollinen'],
      ].map(([pvm, nimi, laji]) => ({ pvm, nimi, laji })).sort((a, b) => a.pvm.localeCompare(b.pvm));
      pyhaMuisti.set(y, { lista, kartta: new Map(lista.map(x => [x.pvm, x])) });
    }
    return pyhaMuisti.get(y).lista;
  }
  function pyhapaiva(s) { const y = Number(s.slice(0, 4)); pyhat(y); return pyhaMuisti.get(y).kartta.get(s) || null; }
  function vapaanSyy(s) {
    const p = pyhapaiva(s);
    if (p) return p.nimi;
    const w = viikonpaiva(s);
    return w === 7 ? 'sunnuntai' : w === 6 ? 'lauantai' : null;
  }
  const onTyopaiva = s => vapaanSyy(s) === null;

  // Työpäivät d, joille a < d <= b. Jos b < a, tulos on negatiivinen.
  function tyopaiviaValilla(a, b) {
    if (a === b) return 0;
    if (b < a) return -tyopaiviaValilla(b, a);
    let n = 0;
    for (let d = lisaaPaivia(a, 1); d <= b; d = lisaaPaivia(d, 1)) if (onTyopaiva(d)) n++;
    return n;
  }
  // n työpäivää eteen (n > 0) tai taakse (n < 0). Alkupäivää ei lueta (laki 150/1930 2 §).
  function lisaaTyopaivia(alku, n) {
    const askel = n < 0 ? -1 : 1, ohitetut = [];
    let jaljella = Math.abs(n), d = alku;
    while (jaljella > 0) {
      d = lisaaPaivia(d, askel);
      const syy = vapaanSyy(d);
      if (syy) ohitetut.push({ pvm: d, syy }); else jaljella--;
    }
    return { pvm: d, ohitetut };
  }
  // Siirtää vapaapäivältä seuraavaan (suunta 1) tai edelliseen (suunta -1) työpäivään.
  function siirra(s, suunta) {
    const ohitetut = [];
    let d = s, syy;
    while ((syy = vapaanSyy(d))) { ohitetut.push({ pvm: d, syy }); d = lisaaPaivia(d, suunta); }
    return { pvm: d, ohitetut };
  }

  const YKSIKOT = {
    kalenteripaiva: { yksi: 'päivä', monta: 'päivää', nimi: 'kalenteripäivää' },
    tyopaiva: { yksi: 'työpäivä', monta: 'työpäivää', nimi: 'työpäivää' },
    viikko: { yksi: 'viikko', monta: 'viikkoa', nimi: 'viikkoa' },
    kuukausi: { yksi: 'kuukausi', monta: 'kuukautta', nimi: 'kuukautta' },
    vuosi: { yksi: 'vuosi', monta: 'vuotta', nimi: 'vuotta' },
  };

  /* Laskee määräpäivän ja selittää sen vaiheittain.
     o = { alku, maara, yksikko: kalenteripaiva|tyopaiva|viikko|kuukausi|vuosi, suunta: eteen|taakse,
           siirto: seuraava|edellinen|ei (oletus: eteen = seuraava, laki 150/1930 5 §; taakse = edellinen, varovainen),
           alkuNimi: esim. 'myöntö' } */
  function laske(o) {
    const alku = vaadiPvm(o && o.alku, 'Alkupäivä');
    const maara = Number(o.maara);
    if (!Number.isInteger(maara) || maara < 0 || maara > 36500) throw new Error('Määrän pitää olla kokonaisluku väliltä 0-36500.');
    const yksikko = o.yksikko || 'kalenteripaiva';
    if (!YKSIKOT[yksikko]) throw new Error(`Tuntematon yksikkö ${yksikko}. Sallitut: ${Object.keys(YKSIKOT).join(', ')}.`);
    const taakse = o.suunta === 'taakse', s = taakse ? -1 : 1;
    const siirto = o.siirto || (taakse ? 'edellinen' : 'seuraava');
    if (!['seuraava', 'edellinen', 'ei'].includes(siirto)) throw new Error(`Tuntematon siirto ${siirto}. Sallitut: seuraava, edellinen, ei.`);
    const nimi = o.alkuNimi ? iso(String(o.alkuNimi)) : taakse ? 'Tapahtuma' : 'Alkupäivä';
    const maaraTxt = `${maara} ${maara === 1 ? YKSIKOT[yksikko].yksi : YKSIKOT[yksikko].monta}`;
    const merkki = taakse ? '−' : '+';
    const vaiheet = [taakse
      ? `${nimi} ${fiVk(alku)}. Aika luetaan taaksepäin tästä päivästä samoin perustein kuin eteenpäin (laki 150/1930 4 §).`
      : `${nimi} ${fiVk(alku)}. Päivää, josta aika lasketaan, ei lueta määräaikaan (laki 150/1930 2 §).`];
    let laskettu, pyhatValissa = [];
    if (yksikko === 'tyopaiva') {
      const r = lisaaTyopaivia(alku, s * maara);
      laskettu = r.pvm;
      pyhatValissa = r.ohitetut.filter(x => pyhapaiva(x.pvm) && viikonpaiva(x.pvm) <= 5).map(x => ({ pvm: x.pvm, nimi: x.syy }));
      vaiheet.push(`Lasketaan ${maaraTxt} ${taakse ? 'taaksepäin' : 'eteenpäin'}. Työpäiviä ovat maanantai-perjantai paitsi arkipyhät sekä joulu- ja juhannusaatto.`);
      vaiheet.push(pyhatValissa.length
        ? `Välissä on vapaapäiviä, joita ei lasketa: ${pyhatValissa.map(x => `${x.nimi} ${fiVk(x.pvm)}`).join(', ')}.`
        : 'Välissä ei ole arkipäivälle osuvia pyhiä.');
      vaiheet.push(`${maara}. työpäivä on ${fiVk(laskettu)}.`);
    } else if (yksikko === 'kalenteripaiva') {
      laskettu = lisaaPaivia(alku, s * maara);
      vaiheet.push(`${fi(alku)} ${merkki} ${maaraTxt} = ${fiVk(laskettu)}.`);
    } else if (yksikko === 'viikko') {
      laskettu = lisaaPaivia(alku, s * 7 * maara);
      vaiheet.push(`${fi(alku)} ${merkki} ${maaraTxt} = ${fiVk(laskettu)}. Viikkoina laskettu aika päättyy samana viikonpäivänä (laki 150/1930 3 §).`);
    } else {
      laskettu = lisaaKuukausia(alku, s * maara * (yksikko === 'vuosi' ? 12 : 1));
      vaiheet.push(`${fi(alku)} ${merkki} ${maaraTxt} = ${fiVk(laskettu)}. Aika päättyy samana päivänumerona, tai kuukauden viimeisenä päivänä, jos sitä ei ole (laki 150/1930 3 §).`);
    }
    let maarapaiva = laskettu, ohitetut = [];
    const syy = vapaanSyy(laskettu);
    if (syy && siirto !== 'ei') {
      const r = siirra(laskettu, siirto === 'seuraava' ? 1 : -1);
      maarapaiva = r.pvm; ohitetut = r.ohitetut;
      vaiheet.push(siirto === 'seuraava'
        ? `${iso(fiVk(laskettu))} on ${syy}, joten aika jatkuu ensimmäiseen arkipäivään sen jälkeen (laki 150/1930 5 §).`
        : `${iso(fiVk(laskettu))} on ${syy}. Varovainen valinta: määräpäiväksi otetaan edellinen arkipäivä, koska aika lasketaan taaksepäin tapahtumasta.`);
    } else if (syy) vaiheet.push(`${iso(fiVk(laskettu))} on ${syy}, mutta päivää ei siirretä (valinta: ei siirtoa).`);
    vaiheet.push(`Määräpäivä on ${fiVk(maarapaiva)}.`);
    const varoitukset = [];
    for (const y of new Set([alku, laskettu, maarapaiva].map(x => Number(x.slice(0, 4))))) {
      if (y < TUETUT_VUODET.alku || y > TUETUT_VUODET.loppu) varoitukset.push(`Vuoden ${y} pyhäpäiviä ei ole tarkistettu (tuettu ${TUETUT_VUODET.alku}-${TUETUT_VUODET.loppu}). Tarkista määräpäivä käsin.`);
    }
    let selitys = maarapaiva === laskettu
      ? `${nimi} ${fi(alku)} ${merkki} ${maaraTxt} = ${fiVk(maarapaiva)}.`
      : `${nimi} ${fi(alku)} ${merkki} ${maaraTxt} = ${fiVk(laskettu)}, joka on ${syy}, joten ${siirto} arkipäivä ${fiVk(maarapaiva)}.`;
    if (yksikko === 'tyopaiva') selitys += pyhatValissa.length ? ` Pyhät välissä: ${pyhatValissa.map(x => `${x.nimi} ${fiLyhyt(x.pvm)}`).join(', ')}` : ' Välissä ei arkipyhiä.'; // fiLyhyt päättyy pisteeseen
    return { alku, maara, yksikko, suunta: taakse ? 'taakse' : 'eteen', siirto, laskettu, maarapaiva, siirretty: maarapaiva !== laskettu, ohitetut, pyhatValissa, vaiheet, selitys, varoitukset };
  }

  // Kalenteritiedosto (RFC 5545): koko päivän tapahtumat, CRLF-rivinvaihdot, rivit taitetaan 75 oktettiin.
  const icsTeksti = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const oktetit = ch => { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; };
  function taita(rivi) {
    const osat = []; let nyk = '', koko = 0;
    for (const ch of rivi) {
      const b = oktetit(ch), raja = osat.length ? 74 : 75; // jatkorivin välilyönti vie yhden oktetin
      if (koko + b > raja) { osat.push(nyk); nyk = ch; koko = b; } else { nyk += ch; koko += b; }
    }
    osat.push(nyk);
    return osat.join('\r\n ');
  }
  /* o = { nimi, tapahtumat: [{ uid, pvm, otsikko, kuvaus, url, muistutukset: [päivää ennen, ...] }], leima: Date } */
  function ics(o) {
    const leima = (o.leima || new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const r = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Savikurki Digital Oy//Savikurki-ydin//FI', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    if (o.nimi) r.push(`X-WR-CALNAME:${icsTeksti(o.nimi)}`);
    for (const t of o.tapahtumat || []) {
      vaadiPvm(t.pvm, 'Kalenteritapahtuman päivä');
      r.push('BEGIN:VEVENT', `UID:${t.uid}`, `DTSTAMP:${leima}`, `DTSTART;VALUE=DATE:${t.pvm.replace(/-/g, '')}`,
        `DTEND;VALUE=DATE:${lisaaPaivia(t.pvm, 1).replace(/-/g, '')}`, `SUMMARY:${icsTeksti(t.otsikko)}`);
      if (t.kuvaus) r.push(`DESCRIPTION:${icsTeksti(t.kuvaus)}`);
      if (t.url && /^https?:\/\//.test(t.url)) r.push(`URL:${t.url}`);
      r.push('TRANSP:TRANSPARENT');
      for (const p of t.muistutukset || []) {
        r.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsTeksti(p ? `${p} pv määräpäivään: ${t.otsikko}` : `Tänään: ${t.otsikko}`)}`,
          p ? `TRIGGER:-P${p}D` : 'TRIGGER:PT8H', 'END:VALARM');
      }
      r.push('END:VEVENT');
    }
    r.push('END:VCALENDAR');
    return r.map(taita).join('\r\n') + '\r\n';
  }

  /* ================= 3. Laskenta (ei DOMia) ================= */
  const TILAT = [
    { id: 'uusi', nimi: 'Uusi' }, { id: 'puutteellinen', nimi: 'Puutteellinen' }, { id: 'kasittelyssa', nimi: 'Käsittelyssä' },
    { id: 'eraantyy', nimi: 'Erääntyy' }, { id: 'myohassa', nimi: 'Myöhässä' }, { id: 'valmis', nimi: 'Valmis' },
  ];
  const TILA_NIMI = Object.fromEntries(TILAT.map(t => [t.id, t.nimi]));
  const PERUSTILAT = ['uusi', 'puutteellinen', 'kasittelyssa', 'valmis'];
  const summa = xs => xs.reduce((s, x) => s + x, 0);

  // Näytettävä tila tarkastelupäivänä T. Valmis voittaa, sitten määräaika, sitten adapterin antama perustila.
  function laskeTila(k, T, N) {
    const l = { tila: k.tila, jaljellaTp: null, myohassaTp: null, kasittelyaikaTp: null, ajassa: null };
    if (k.tila === 'valmis') {
      if (k.valmistui && k.saapui) l.kasittelyaikaTp = tyopaiviaValilla(k.saapui, k.valmistui);
      if (k.valmistui && k.maarapaiva) {
        l.ajassa = k.valmistui <= k.maarapaiva;
        if (!l.ajassa) l.myohassaTp = tyopaiviaValilla(k.maarapaiva, k.valmistui);
      }
    } else if (k.maarapaiva && !k.keskeytetty) {
      if (k.maarapaiva < T) { l.tila = 'myohassa'; l.myohassaTp = tyopaiviaValilla(k.maarapaiva, T); }
      else { l.jaljellaTp = tyopaiviaValilla(T, k.maarapaiva); if (l.jaljellaTp <= N) l.tila = 'eraantyy'; }
    }
    l.tilaNimi = TILA_NIMI[l.tila];
    return l;
  }
  const rikasta = (kohteet, T, N, oletusKunta) => kohteet.map(k => ({ ...k, kunta: k.kunta || oletusKunta, laskettu: laskeTila(k, T, N) }));

  function laskeLaskurit(rik) {
    const c = { avoimet: 0 };
    TILAT.forEach(t => { c[t.id] = 0; });
    for (const k of rik) { c[k.laskettu.tila]++; if (k.laskettu.tila !== 'valmis') c.avoimet++; }
    return c;
  }
  const jarjestys = (a, b) => (a.laskettu.tila === 'valmis') - (b.laskettu.tila === 'valmis')
    || (a.laskettu.tila === 'valmis' ? (b.valmistui || '').localeCompare(a.valmistui || '') : 0)
    || (a.maarapaiva || '9999').localeCompare(b.maarapaiva || '9999') || (a.saapui || '').localeCompare(b.saapui || '') || String(a.id).localeCompare(String(b.id));

  function laskeJaksonLuvut(rik, j) {
    const sis = p => !!p && p >= j.alku && p <= j.loppu;
    const saapuneet = rik.filter(k => sis(k.saapui));
    const ratkaistut = rik.filter(k => k.tila === 'valmis' && sis(k.valmistui));
    const mp = ratkaistut.filter(k => k.maarapaiva);
    const ajassa = mp.filter(k => k.valmistui <= k.maarapaiva).length;
    const ajat = ratkaistut.map(k => k.laskettu.kasittelyaikaTp).filter(x => x != null);
    return {
      saapuneet: saapuneet.length, ratkaistut: ratkaistut.length, maaraajallisia: mp.length, ajassa,
      ajassaOsuus: mp.length ? ajassa / mp.length : null,
      myohassaRatkaistut: mp.filter(k => k.valmistui > k.maarapaiva).sort(jarjestys),
      kasittelyaikaSumma: summa(ajat), kasittelyaikaN: ajat.length, kasittelyaikaKa: ajat.length ? summa(ajat) / ajat.length : null,
      taydennyspyynnot: summa(saapuneet.map(k => Number(k.taydennyspyynnot) || 0)),
      taydennettavia: saapuneet.filter(k => (Number(k.taydennyspyynnot) || 0) > 0).length,
    };
  }

  function ryhmitaEstetyt(estetyt, syyt, j) {
    const m = new Map();
    for (const e of estetyt || []) if (e.pvm >= j.alku && e.pvm <= j.loppu) m.set(e.syy, (m.get(e.syy) || 0) + 1);
    const ryhmat = [...m].map(([syy, maara]) => ({ syy, maara, nimi: (syyt && syyt[syy] && syyt[syy].nimi) || syy, selite: (syyt && syyt[syy] && syyt[syy].selite) || '' }))
      .sort((a, b) => b.maara - a.maara || a.nimi.localeCompare(b.nimi, 'fi'));
    return { yhteensa: summa(ryhmat.map(r => r.maara)), ryhmat };
  }

  // Säästöarvion määrät. Funktiona annetun määrän pitää olla kunnittain summautuva (seutunäkymä laskee summan riveistä).
  const MAARAT = {
    estetyt: { nimi: 'estettyä virhettä', arvo: c => c.estetyt.yhteensa },
    saapuneet: { nimi: 'saapunutta', arvo: c => c.luvut.saapuneet },
    ratkaistut: { nimi: 'ratkaistua', arvo: c => c.luvut.ratkaistut },
    taydennyspyynnot: { nimi: 'täydennyspyyntöä', arvo: c => c.luvut.taydennyspyynnot },
  };
  function laskeVertailu(rivit, ol, c, tuntiId) {
    const tulos = (rivit || []).map(r => {
      const maara = typeof r.maara === 'function' ? Number(r.maara(c)) || 0 : MAARAT[r.maara] ? MAARAT[r.maara].arvo(c) : 0;
      const e = Number(ol[r.ennen]) || 0, j = Number(ol[r.jalkeen]) || 0;
      return { id: r.id, nimi: r.nimi, selite: r.selite || '', maara, maaraNimi: r.maaraNimi || (MAARAT[r.maara] && MAARAT[r.maara].nimi) || 'kpl',
        ennen: r.ennen, jalkeen: r.jalkeen, ennenMin: e, jalkeenMin: j, ennenYht: maara * e, jalkeenYht: maara * j, saastoMin: maara * (e - j) };
    });
    const ennenMin = summa(tulos.map(r => r.ennenYht)), jalkeenMin = summa(tulos.map(r => r.jalkeenYht)), saastoMin = ennenMin - jalkeenMin;
    const tunti = tuntiId ? Number(ol[tuntiId]) : 0;
    return { rivit: tulos, ennenMin, jalkeenMin, saastoMin, saastoH: saastoMin / 60, tuntikustannus: tunti > 0 ? tunti : null, euroa: tunti > 0 ? saastoMin / 60 * tunti : null };
  }

  const SAANTOTILAT = { kuittaamatta: 'Kuittaamatta', kuitattu: 'Kuitattu', tarkistettava: 'Tarkistettava' };
  // Kuittaus = viranhaltija on lukenut säännön lähteestä ja todennut sen ajantasaiseksi. Se on voimassa kuittausKk kuukautta.
  function saannonTila(s, kuittaukset, T, o) {
    const lahdeRajaKk = (o && o.lahdeRajaKk) || 12, kuittausKk = (o && o.kuittausKk) || 12;
    const omat = (kuittaukset || []).filter(k => k.tunnus === s.tunnus).sort((a, b) => a.pvm.localeCompare(b.pvm));
    const viim = omat[omat.length - 1] || null;
    const seuraava = viim ? lisaaKuukausia(viim.pvm, kuittausKk) : null;
    const tarkistettu = [s.haettu, viim && viim.pvm].filter(Boolean).sort().pop() || null;
    const raja = lisaaKuukausia(T, -lahdeRajaKk);
    let tila, syy;
    if (viim && s.muutettu && s.muutettu > viim.pvm) { tila = 'tarkistettava'; syy = `Sääntöä muutettu ${fi(s.muutettu)}, kuittauksen jälkeen.`; }
    else if (viim && T >= seuraava) { tila = 'tarkistettava'; syy = `Vuosikuittaus erääntyi ${fi(seuraava)}.`; }
    else if (!tarkistettu) { tila = 'tarkistettava'; syy = 'Lähteen hakupäivä puuttuu.'; }
    else if (tarkistettu < raja) { tila = 'tarkistettava'; syy = `Lähde haettu ${fi(s.haettu)}, yli ${lahdeRajaKk} kuukautta sitten.`; }
    else if (!viim) { tila = 'kuittaamatta'; syy = 'Kunnan viranhaltija ei ole vielä kuitannut sääntöä.'; }
    else { tila = 'kuitattu'; syy = `Seuraava tarkistus viimeistään ${fi(seuraava)}.`; }
    return { tila, tilaNimi: SAANTOTILAT[tila], syy, kuittaus: viim, seuraava };
  }

  /* ================= 4. Viennit ================= */
  // CSV: UTF-8 BOM, puolipiste erottimena, desimaalipilkku, CRLF. Näin suomenkielinen Excel avaa tiedoston oikein.
  function csvArvo(v, tyyppi, pvmMuoto) {
    if (v === null || v === undefined || v === '') return '';
    if (tyyppi === 'luku') { const n = Number(v); return Number.isFinite(n) ? String(n).replace('.', ',') : ''; }
    if (tyyppi === 'pvm') return pvmMuoto === 'iso' ? String(v) : fi(String(v));
    const s = String(v);
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // estää taulukkolaskennan kaavat tekstikentissä
  }
  const csvLainaus = s => (/[";\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  function csv(sarakkeet, rivit, o) {
    o = o || {};
    const r = [sarakkeet.map(s => csvLainaus(csvArvo(s.otsikko))).join(';')];
    for (const k of rivit) r.push(sarakkeet.map(s => csvLainaus(csvArvo(s.arvo(k, o.apu), s.tyyppi, o.pvmMuoto))).join(';'));
    return '\uFEFF' + r.join('\r\n') + '\r\n';
  }
  function xlsxRivit(sarakkeet, rivit, o) {
    o = o || {};
    return [sarakkeet.map(s => s.otsikko), ...rivit.map(k => sarakkeet.map(s => {
      const v = s.arvo(k, o.apu);
      if (v === null || v === undefined || v === '') return '';
      if (s.tyyppi === 'luku') { const n = Number(v); return Number.isFinite(n) ? n : ''; }
      return s.tyyppi === 'pvm' && o.pvmMuoto !== 'iso' ? fi(String(v)) : String(v);
    }))];
  }
  function lataa(nimi, sisalto, mime) {
    const blob = sisalto instanceof Blob ? sisalto : new Blob([sisalto], { type: mime });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = nimi; a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  const OLETUSSARAKKEET = [
    { otsikko: 'Tunnus', arvo: k => k.id },
    { otsikko: 'Otsikko', arvo: k => k.otsikko },
    { otsikko: 'Kunta', arvo: (k, apu) => apu.kunnanNimi(k.kunta) },
    { otsikko: 'Yksikkö', arvo: (k, apu) => apu.yksikonNimi(k.yksikko) },
    { otsikko: 'Käsittelijä', arvo: k => k.kasittelija || '' },
    { otsikko: 'Tila', arvo: k => k.laskettu.tilaNimi },
    { otsikko: 'Saapui', arvo: k => k.saapui, tyyppi: 'pvm' },
    { otsikko: 'Määräpäivä', arvo: k => k.maarapaiva, tyyppi: 'pvm' },
    { otsikko: 'Valmistui', arvo: k => k.valmistui, tyyppi: 'pvm' },
    { otsikko: 'Käsittelyaika (työpäivää)', arvo: k => k.laskettu.kasittelyaikaTp, tyyppi: 'luku' },
  ];

  function tarkistaAdapteri(a) {
    const v = [];
    if (!a || typeof a !== 'object') return ['Adapteri puuttuu.'];
    if (!a.juuri) v.push('juuri puuttuu (elementti tai CSS-valitsin).');
    if (!a.palvelu || !a.palvelu.id || !a.palvelu.nimi) v.push('palvelu.id ja palvelu.nimi ovat pakollisia.');
    const kunnat = Array.isArray(a.kunnat) ? a.kunnat : [];
    if (!kunnat.length || kunnat.some(k => !k || !k.id || !k.nimi)) v.push('kunnat: anna vähintään yksi kunta muodossa { id, nimi }.');
    if (a.tanaan && !onPvm(a.tanaan)) v.push('tanaan pitää antaa muodossa VVVV-KK-PP.');
    if (!Array.isArray(a.kohteet)) v.push('kohteet puuttuu (taulukko).');
    else a.kohteet.forEach((k, i) => {
      const t = `kohteet[${i}]${k && k.id ? ` (${k.id})` : ''}`;
      if (!k || !k.id) { v.push(`${t}: id puuttuu.`); return; }
      if (!PERUSTILAT.includes(k.tila)) v.push(`${t}: tila "${k.tila}" ei kelpaa. Sallitut: ${PERUSTILAT.join(', ')}.`);
      for (const f of ['saapui', 'maarapaiva', 'valmistui']) if (k[f] != null && k[f] !== '' && !onPvm(k[f])) v.push(`${t}: ${f} ei ole muotoa VVVV-KK-PP.`);
      if (k.tila === 'valmis' && !k.valmistui) v.push(`${t}: valmiilta kohteelta puuttuu valmistui.`);
      if (kunnat.length > 1 && !kunnat.some(x => x.id === k.kunta)) v.push(`${t}: kunta "${k.kunta}" puuttuu kunnat-listasta.`);
    });
    const olIdt = new Set((a.oletukset || []).map(o => o.id));
    (a.oletukset || []).forEach(o => { if (!o.id || !Number.isFinite(Number(o.arvo))) v.push(`oletukset: ${o.id || '?'} tarvitsee id:n ja numeerisen arvon.`); });
    (a.vertailu || []).forEach(r => {
      if (!olIdt.has(r.ennen) || !olIdt.has(r.jalkeen)) v.push(`vertailu ${r.id}: ennen ja jalkeen pitää viitata oletusten id:hin.`);
      if (typeof r.maara !== 'function' && !MAARAT[r.maara]) v.push(`vertailu ${r.id}: maara on funktio tai ${Object.keys(MAARAT).join(', ')}.`);
    });
    if (a.tuntikustannus && !olIdt.has(a.tuntikustannus)) v.push('tuntikustannus pitää viitata oletuksen id:hen.');
    (a.estetyt || []).forEach((e, i) => { if (!onPvm(e.pvm) || !e.syy) v.push(`estetyt[${i}]: pvm (VVVV-KK-PP) ja syy ovat pakollisia.`); });
    (a.saannot || []).forEach(s => {
      if (!s.tunnus || !s.kuvaus) v.push('saannot: jokaisella säännöllä on tunnus ja kuvaus.');
      for (const f of ['haettu', 'voimassaAlkaen', 'muutettu']) if (s[f] && !onPvm(s[f])) v.push(`sääntö ${s.tunnus}: ${f} ei ole muotoa VVVV-KK-PP.`);
    });
    (a.kuittaukset || []).forEach(k => { if (!k.tunnus || !onPvm(k.pvm) || !k.nimi) v.push('kuittaukset: jokaisella kuittauksella on tunnus, nimi ja pvm.'); });
    return v;
  }

  /* ================= 5. Käyttöliittymä ================= */
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lukuFi = (n, des) => Number(n).toLocaleString('fi-FI', { minimumFractionDigits: des || 0, maximumFractionDigits: des || 0 });
  const pros = x => (x == null ? 'ei ratkaisuja' : `${Math.round(x * 100)}\u00a0%`);
  const tunnit = min => `${lukuFi(min / 60, 1)}\u00a0h`;
  const NAKYMAT = {
    yleiskuva: 'Yleiskuva', tyojono: 'Työjono', estetyt: 'Mitä palvelu esti', raportti: 'Johtoraportti',
    seutu: 'Kunnittain', saannot: 'Säännöt', laskuri: 'Määräaikalaskuri',
  };
  const ROOLIT = {
    esihenkilo: { nimi: 'Esihenkilö', nakymat: ['yleiskuva', 'tyojono', 'estetyt', 'raportti', 'seutu', 'saannot'] },
    kasittelija: { nimi: 'Käsittelijä', nakymat: ['tyojono', 'laskuri', 'saannot'] },
  };

  function kaynnista(a) {
    const ongelmat = tarkistaAdapteri(a);
    if (ongelmat.length) throw new Error('Savikurki-ydin: adapterissa on virheitä:\n- ' + ongelmat.join('\n- '));
    const juuri = typeof a.juuri === 'string' ? document.querySelector(a.juuri) : a.juuri;
    if (!juuri) throw new Error(`Savikurki-ydin: elementtiä ${a.juuri} ei löydy.`);
    const T = a.tanaan || paikallinenTanaan();
    const N = a.eraantyyTyopaivina ?? 5;
    const taso = a.otsikkotaso || 1;
    const H = n => `h${Math.min(6, taso + n)}`;
    const AV = a.tallennusAvain || `sy-${a.palvelu.id}`;
    const etuliite = (a.reititys && a.reititys.etuliite) || '#/kaupunki/';
    const omaReititys = !(a.reititys && a.reititys.oma === false);
    const sanat = { yksi: 'kohde', partitiivi: 'kohdetta', monikko: 'kohteet', otsikko: 'Kohde', ...(a.palvelu.kohde || {}) };
    const kpl = n => `${lukuFi(n)} ${n === 1 ? sanat.yksi : sanat.partitiivi}`;
    const monta = a.kunnat.length > 1;
    const kunnanNimi = id => (a.kunnat.find(k => k.id === id) || {}).nimi || id || '';
    const yksikot = a.yksikot || [...new Set(a.kohteet.map(k => k.yksikko).filter(Boolean))].map(id => ({ id, nimi: id }));
    const yksikonNimi = id => (yksikot.find(y => y.id === id) || {}).nimi || id || '';
    const apu = { kunnanNimi, yksikonNimi, fi, fiVk, tanaan: T };
    const kohdeUrl = k => (a.kohdeUrl ? a.kohdeUrl(k) : null);
    const saantoAsetukset = { lahdeRajaKk: a.lahdeRajaKk, kuittausKk: a.kuittausKk };
    let RIK = rikasta(a.kohteet, T, N, a.kunnat[0].id);

    // ---------- tallennus (sessionStorage, vain tämä välilehti) ----------
    const lue = k => { try { return JSON.parse(root.sessionStorage.getItem(`${AV}:${k}`)); } catch (e) { return null; } };
    const tallenna = (k, v) => { try { root.sessionStorage.setItem(`${AV}:${k}`, JSON.stringify(v)); } catch (e) { /* ei tallennusta */ } };
    const oletusArvot = Object.fromEntries((a.oletukset || []).map(o => [o.id, Number(o.arvo)]));
    const tallennetut = lue('oletukset') || {};
    const kuukaudet = (() => {
      const eka = [...a.kohteet.map(k => k.saapui), ...(a.estetyt || []).map(e => e.pvm)].filter(Boolean).sort()[0] || T;
      const l = []; for (let d = `${eka.slice(0, 7)}-01`; d <= T; d = lisaaKuukausia(d, 1)) l.push(d.slice(0, 7));
      return l.reverse();
    })();
    const oletusJakso = a.jakso || (kuukaudet[1] || kuukaudet[0]);
    const S = {
      rooli: ROOLIT[lue('rooli')] ? lue('rooli') : (a.rooli && ROOLIT[a.rooli.oletus] ? a.rooli.oletus : 'esihenkilo'),
      ulkoinenRooli: false, nakyma: null, jakso: oletusJakso, kunta: '',
      suodatin: { tila: 'avoimet', kunta: '', yksikko: '', kasittelija: '' },
      oletukset: { ...oletusArvot, ...Object.fromEntries(Object.entries(tallennetut).filter(([k, v]) => k in oletusArvot && Number.isFinite(v) && v >= 0)) },
      kuittaukset: Array.isArray(lue('kuittaukset')) ? lue('kuittaukset') : [],
      kuittaaja: lue('kuittaaja') || '', jonoRivit: [],
    };
    const kaikkiKuittaukset = () => [...(a.kuittaukset || []), ...S.kuittaukset];
    const $ = s => juuri.querySelector(s);
    const ilmoita = teksti => { const el = $('#sy-ilmoitus'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = teksti; }, 30); } };

    // ---------- konteksti: kaikki valitun jakson ja kunnan luvut yhdestä paikasta ----------
    function konteksti(kuntaId) {
      const kid = kuntaId === undefined ? S.kunta : kuntaId;
      const j = jakso(S.jakso, T);
      const kohteet = kid ? RIK.filter(k => k.kunta === kid) : RIK;
      const estetyt = (a.estetyt || []).filter(e => !kid || (e.kunta || a.kunnat[0].id) === kid);
      const c = { tanaan: T, jakso: j, kunta: kid, kohteet, oletukset: S.oletukset, maaraaika: api.maaraaika, laskurit: laskeLaskurit(kohteet),
        luvut: laskeJaksonLuvut(kohteet, j), estetyt: ryhmitaEstetyt(estetyt, a.estoSyyt, j) };
      c.vertailu = laskeVertailu(a.vertailu, S.oletukset, c, a.tuntikustannus);
      return c;
    }
    function seutu() {
      const rivit = a.kunnat.map(ku => {
        const c = konteksti(ku.id);
        return { kunta: ku, saapuneet: c.luvut.saapuneet, ratkaistut: c.luvut.ratkaistut, maaraajallisia: c.luvut.maaraajallisia, ajassa: c.luvut.ajassa,
          ajassaOsuus: c.luvut.ajassaOsuus, avoimet: c.laskurit.avoimet, eraantyy: c.laskurit.eraantyy, myohassa: c.laskurit.myohassa,
          estetyt: c.estetyt.yhteensa, saastoMin: c.vertailu.saastoMin };
      });
      const y = {};
      for (const f of ['saapuneet', 'ratkaistut', 'maaraajallisia', 'ajassa', 'avoimet', 'eraantyy', 'myohassa', 'estetyt', 'saastoMin']) y[f] = summa(rivit.map(r => r[f]));
      y.ajassaOsuus = y.maaraajallisia ? y.ajassa / y.maaraajallisia : null;
      return { rivit, yhteensa: y };
    }

    function mittarit(c) {
      const L = c.luvut, j = c.jakso, V = c.vertailu, jv = `${fi(j.alku)}-${fi(j.loppu)}`;
      const lista = [
        { id: 'saapuneet', nimi: 'Saapuneet', arvo: L.saapuneet, naytto: kpl(L.saapuneet), selite: j.nimi + (j.kesken ? ' (kesken)' : ''),
          kaava: `Mukana ne, joiden saapumispäivä on välillä ${jv}. Tulos: ${L.saapuneet}.` },
        { id: 'ratkaistut', nimi: 'Ratkaistu', arvo: L.ratkaistut, naytto: kpl(L.ratkaistut), selite: j.nimi + (j.kesken ? ' (kesken)' : ''),
          kaava: `Tilassa Valmis olevat, joiden valmistumispäivä on välillä ${jv}. Tulos: ${L.ratkaistut}.` },
        { id: 'maaraajassa', nimi: 'Määräajassa', arvo: L.ajassaOsuus, naytto: pros(L.ajassaOsuus), selite: `${L.ajassa}/${L.maaraajallisia} ratkaistua määräpäivään mennessä`,
          kaava: `Jakson ratkaisut, joilla on määräpäivä (${L.maaraajallisia}). Niistä ratkaistu viimeistään määräpäivänä ${L.ajassa}. ${L.ajassa} / ${L.maaraajallisia} = ${pros(L.ajassaOsuus)}.` },
        { id: 'kasittelyaika', nimi: 'Käsittelyaika', arvo: L.kasittelyaikaKa, naytto: L.kasittelyaikaKa == null ? 'ei ratkaisuja' : `${lukuFi(L.kasittelyaikaKa, 1)} työpäivää`, selite: 'keskiarvo jakson ratkaisuista',
          kaava: `Työpäivät saapumista seuraavasta päivästä valmistumispäivään (ma-pe ilman arkipyhiä ja aattoja). Summa ${L.kasittelyaikaSumma} työpäivää / ${L.kasittelyaikaN} ratkaisua${L.kasittelyaikaN ? ` = ${lukuFi(L.kasittelyaikaKa, 1)}` : ''}.` },
        { id: 'myohassa', nimi: 'Myöhässä nyt', arvo: c.laskurit.myohassa, naytto: kpl(c.laskurit.myohassa), selite: `ja ${c.laskurit.eraantyy} erääntyy ${N} työpäivän sisällä`,
          kaava: `Tilanne ${fiVk(T)}. Avoimet, joiden määräpäivä on ennen tätä päivää. Erääntyvissä määräpäivään on enintään ${N} työpäivää. Keskeytettyjä ei lasketa.` },
        { id: 'estetyt', nimi: 'Estetyt virheet', arvo: c.estetyt.yhteensa, naytto: `${lukuFi(c.estetyt.yhteensa)} kpl`, selite: 'pysähtyi lomakkeeseen ennen käsittelijää',
          kaava: `Lomakkeen tarkistus pysäytti virheen, ja hakija korjasi sen ennen lähettämistä. Välillä ${jv}: ${c.estetyt.yhteensa}. Sama ${sanat.yksi} voi olla mukana useamman syyn kohdalla.` },
      ];
      if ((a.vertailu || []).length) {
        lista.push({ id: 'saasto', nimi: 'Säästöarvio', arvio: true, arvo: V.saastoH, naytto: tunnit(V.saastoMin),
          selite: V.euroa != null ? `noin ${lukuFi(V.euroa)} € henkilöstökuluina (${lukuFi(V.tuntikustannus)} €/h)` : 'käsittelijän työaikaa jaksolla',
          kaava: `Ilman palvelua ${lukuFi(V.ennenMin)} min, palvelun kanssa ${lukuFi(V.jalkeenMin)} min. Erotus ${lukuFi(V.saastoMin)} min = ${tunnit(V.saastoMin)}. Rivit ja oletukset ovat alla, ja oletuksia voi muuttaa.` });
      }
      for (const m of a.mittarit || []) {
        const arvo = m.arvo(c), f = x => (typeof x === 'function' ? x(c) : x || '');
        const naytto = arvo == null ? 'ei tietoa' : m.muoto === 'prosentti' ? pros(arvo) : m.muoto === 'tunnit' ? `${lukuFi(arvo, 1)} h` : `${lukuFi(arvo, m.desimaalit || 0)}${m.yksikko ? ' ' + m.yksikko : ''}`;
        lista.push({ id: m.id, nimi: m.nimi, arvo, naytto, selite: f(m.selite), kaava: f(m.kaava), arvio: !!m.arvio });
      }
      return lista;
    }

    // ---------- yhteiset palat ----------
    const merkki = (teksti, laji) => `<span class="sy-merkki${laji ? ' sy-merkki--' + laji : ''}">${esc(teksti)}</span>`;
    const tilaMerkki = t => `<span class="sy-tila sy-tila--${t}">${esc(TILA_NIMI[t])}</span>`;
    function paa(id, johdanto) {
      return `<header class="sy-nakymapaa"><p class="sy-ylaotsikko">Kaupungin näkymä: ${esc(a.palvelu.nimi)}</p>
        <${H(0)} id="sy-otsikko" tabindex="-1">${esc(NAKYMAT[id])}</${H(0)}>${johdanto ? `<p class="sy-johdanto">${johdanto}</p>` : ''}</header>`;
    }
    function tyokalut(kuntaValinta) {
      return `<div class="sy-tyokalut">
        <div class="sy-kentta"><label for="sy-jakso">Jakso</label><select id="sy-jakso">${kuukaudet.map(kk => `<option value="${kk}"${kk === S.jakso ? ' selected' : ''}>${esc(kuukaudenNimi(kk))}${jakso(kk, T).kesken ? ' (kesken)' : ''}</option>`).join('')}</select></div>
        ${monta && kuntaValinta ? `<div class="sy-kentta"><label for="sy-kunta">Kunta</label><select id="sy-kunta"><option value="">Kaikki kunnat</option>${a.kunnat.map(k => `<option value="${esc(k.id)}"${k.id === S.kunta ? ' selected' : ''}>${esc(k.nimi)}</option>`).join('')}</select></div>` : ''}
      </div>`;
    }
    const kaavaLohko = (otsikko, teksti) => `<details class="sy-kaava"><summary>${esc(otsikko)}</summary><p>${esc(teksti)}</p></details>`;
    // Taulukko, joka pinoutuu kapealla näytöllä: roolit säilyttävät taulukon rakenteen ruudunlukijalle.
    function lisaaRoolit(el) {
      el.querySelectorAll('table.sy-taulu--pino').forEach(t => {
        t.setAttribute('role', 'table');
        t.querySelectorAll('thead, tbody, tfoot').forEach(x => x.setAttribute('role', 'rowgroup'));
        t.querySelectorAll('tr').forEach(x => x.setAttribute('role', 'row'));
        t.querySelectorAll('th[scope="col"]').forEach(x => x.setAttribute('role', 'columnheader'));
        t.querySelectorAll('th[scope="row"]').forEach(x => x.setAttribute('role', 'rowheader'));
        t.querySelectorAll('td').forEach(x => x.setAttribute('role', 'cell'));
      });
    }
    // Solun sisältö käärittään yhteen elementtiin, jotta pinottu rivi (otsikko | sisältö) pysyy kahdessa sarakkeessa.
    const td = (otsikko, sisalto, lisa) => `<td data-otsikko="${esc(otsikko)}"${lisa || ''}>${sisalto === '' ? '' : `<div class="sy-solu">${sisalto}</div>`}</td>`;

    // ---------- Yleiskuva (esihenkilö) ----------
    function nakymaYleiskuva() {
      const c = konteksti(), L = c.laskurit;
      const nyt = [['uusi', 'Uudet'], ['puutteellinen', 'Puutteelliset'], ['eraantyy', 'Erääntyy'], ['myohassa', 'Myöhässä']];
      return `${paa('yleiskuva', `Tilanne ${esc(fiVk(T))}. Jono näyttää tämän päivän tilanteen, luvut valitun jakson.`)}
        ${tyokalut(true)}
        <section class="sy-osio" aria-labelledby="sy-o-nyt"><${H(1)} id="sy-o-nyt">Jono nyt${c.kunta ? `: ${esc(kunnanNimi(c.kunta))}` : ''}</${H(1)}>
          <ul class="sy-tilanne">${nyt.map(([t, n]) => `<li><a class="sy-tilanne__linkki sy-tilanne__linkki--${t}" href="${esc(etuliite)}tyojono" data-sy-tila="${t}" data-sy-maara="${L[t]}"><span class="sy-tilanne__luku">${lukuFi(L[t])}</span> <span class="sy-tilanne__nimi">${n}</span></a></li>`).join('')}
            <li><a class="sy-tilanne__linkki" href="${esc(etuliite)}tyojono" data-sy-tila="avoimet" data-sy-maara="${L.avoimet}"><span class="sy-tilanne__luku">${lukuFi(L.avoimet)}</span> <span class="sy-tilanne__nimi">Avoimet yhteensä</span></a></li></ul>
        </section>
        <section class="sy-osio" aria-labelledby="sy-o-luvut"><${H(1)} id="sy-o-luvut">Jakson luvut: ${esc(c.jakso.nimi)}${c.jakso.kesken ? ' (kesken)' : ''}</${H(1)}>
          <div class="sy-kortit" id="sy-kortit">${kortit(c)}</div></section>
        ${(a.vertailu || []).length ? `<section class="sy-osio" aria-labelledby="sy-o-vertailu"><${H(1)} id="sy-o-vertailu">Ennen ja jälkeen: arvio</${H(1)}>
          <p class="sy-johdanto">Arvio lasketaan alla olevista oletuksista. Luvut eivät ole mitattua työaikaa. Vaihda oletukset kunnan omiin lukuihin, niin arvio päivittyy.</p>
          <div id="sy-vertailu">${vertailuTaulu(c)}</div>${oletuslomake()}</section>` : ''}`;
    }
    function kortit(c) {
      return mittarit(c).map(m => `<article class="sy-kortti${m.arvio ? ' sy-kortti--arvio' : ''}" data-mittari="${esc(m.id)}" data-arvo="${m.arvo ?? ''}">
        <${H(2)} class="sy-kortti__nimi">${esc(m.nimi)}${m.arvio ? ' ' + merkki('Arvio', 'arvio') : ''}</${H(2)}>
        <p class="sy-kortti__arvo">${esc(m.naytto)}</p>${m.selite ? `<p class="sy-kortti__selite">${esc(m.selite)}</p>` : ''}
        ${kaavaLohko('Näin luku lasketaan', m.kaava)}</article>`).join('');
    }
    function vertailuTaulu(c) {
      const V = c.vertailu;
      return `<table class="sy-taulu sy-taulu--pino sy-vertailu"><caption class="sy-sr">Ennen ja jälkeen, ${esc(c.jakso.nimi)}</caption>
        <thead><tr><th scope="col">Työvaihe</th><th scope="col">Määrä jaksolla</th><th scope="col">Ilman palvelua</th><th scope="col">Palvelun kanssa</th><th scope="col">Erotus</th></tr></thead>
        <tbody>${V.rivit.map(r => `<tr data-sy-vertailu="${esc(r.id)}"><th scope="row" data-otsikko="Työvaihe"><div class="sy-solu">${esc(r.nimi)}${r.selite ? `<span class="sy-vihje">${esc(r.selite)}</span>` : ''}</div></th>
          ${td('Määrä jaksolla', `${lukuFi(r.maara)} ${esc(r.maaraNimi)}`)}
          ${td('Ilman palvelua', `${lukuFi(r.maara)} × ${lukuFi(r.ennenMin, r.ennenMin % 1 ? 1 : 0)} min = ${tunnit(r.ennenYht)}`)}
          ${td('Palvelun kanssa', `${lukuFi(r.maara)} × ${lukuFi(r.jalkeenMin, r.jalkeenMin % 1 ? 1 : 0)} min = ${tunnit(r.jalkeenYht)}`)}
          ${td('Erotus', tunnit(r.saastoMin), ` data-arvo="${r.saastoMin}"`)}</tr>`).join('')}</tbody>
        <tfoot><tr><th scope="row" data-otsikko="Työvaihe"><div class="sy-solu">Yhteensä</div></th>${td('Määrä jaksolla', '')}${td('Ilman palvelua', tunnit(V.ennenMin), ` data-arvo="${V.ennenMin}"`)}
          ${td('Palvelun kanssa', tunnit(V.jalkeenMin), ` data-arvo="${V.jalkeenMin}"`)}${td('Erotus', `<b>${tunnit(V.saastoMin)}</b>`, ` id="sy-saasto-yht" data-arvo="${V.saastoMin}"`)}</tr></tfoot></table>
        <p class="sy-vihje" aria-live="polite">Säästöarvio ${esc(c.jakso.nimi)}: ${tunnit(V.saastoMin)}${V.euroa != null ? `, noin ${lukuFi(V.euroa)} € henkilöstökuluina` : ''}. Arvio, ei mitattu säästö.</p>`;
    }
    function oletuslomake() {
      return `<form class="sy-oletukset" id="sy-oletukset" novalidate><fieldset><legend>Laskennan oletukset</legend>
        <p class="sy-vihje">Muutos päivittää luvut heti. Muutokset säilyvät vain tässä selainvälilehdessä.</p>
        <div class="sy-ruudukko">${(a.oletukset || []).map(o => `<div class="sy-kentta">
          <label for="sy-ol-${esc(o.id)}">${esc(o.nimi)} (${esc(o.yksikko || '')})</label>
          <input type="number" id="sy-ol-${esc(o.id)}" data-sy-oletus="${esc(o.id)}" min="0" step="any" inputmode="decimal" value="${S.oletukset[o.id]}" aria-describedby="sy-ol-${esc(o.id)}-v">
          <p class="sy-vihje" id="sy-ol-${esc(o.id)}-v">${esc(o.selite || '')}${o.lahde ? ` Lähde: ${esc(o.lahde)}.` : ''} Oletus ${lukuFi(o.arvo, o.arvo % 1 ? 1 : 0)}.</p></div>`).join('')}</div>
        <button type="button" class="sy-nappi sy-nappi--toissijainen" data-sy-palauta-oletukset>Palauta oletukset</button></fieldset></form>`;
    }

    // ---------- Työjono ----------
    function nakymaTyojono() {
      const vaihtoehdot = (lista, valittu) => lista.map(([v, n]) => `<option value="${esc(v)}"${v === valittu ? ' selected' : ''}>${esc(n)}</option>`).join('');
      const kasittelijat = [...new Set(RIK.map(k => k.kasittelija).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'fi'));
      const f = S.suodatin;
      return `${paa('tyojono', `Tilanne ${esc(fiVk(T))}. Jono on järjestetty määräpäivän mukaan. Erääntyy tarkoittaa, että määräpäivään on enintään ${N} työpäivää.`)}
        <div class="sy-laskurit" role="group" aria-label="Tilat. Valitse tila suodattimeksi.">${TILAT.map(t => `<button type="button" class="sy-laskuri sy-laskuri--${t.id}" data-sy-tila="${t.id}" aria-pressed="false"><span class="sy-laskuri__luku" data-sy-laskuri="${t.id}">0</span> <span class="sy-laskuri__nimi">${t.nimi}</span></button>`).join('')}</div>
        <form class="sy-suodattimet" id="sy-suodattimet" novalidate>
          <div class="sy-kentta"><label for="sy-s-tila">Tila</label><select id="sy-s-tila" data-sy-suodatin="tila">${vaihtoehdot([['avoimet', 'Avoimet'], ['kaikki', 'Kaikki'], ...TILAT.map(t => [t.id, t.nimi])], f.tila)}</select></div>
          ${monta ? `<div class="sy-kentta"><label for="sy-s-kunta">Kunta</label><select id="sy-s-kunta" data-sy-suodatin="kunta">${vaihtoehdot([['', 'Kaikki kunnat'], ...a.kunnat.map(k => [k.id, k.nimi])], f.kunta)}</select></div>` : ''}
          <div class="sy-kentta"><label for="sy-s-yksikko">Yksikkö</label><select id="sy-s-yksikko" data-sy-suodatin="yksikko">${vaihtoehdot([['', 'Kaikki yksiköt'], ...yksikot.map(y => [y.id, y.nimi])], f.yksikko)}</select></div>
          <div class="sy-kentta"><label for="sy-s-kasittelija">Käsittelijä</label><select id="sy-s-kasittelija" data-sy-suodatin="kasittelija">${vaihtoehdot([['', 'Kaikki käsittelijät'], ['-', 'Ei käsittelijää'], ...kasittelijat.map(k => [k, k])], f.kasittelija)}</select></div>
        </form>
        <div id="sy-jono-tulos"></div>
        <div class="sy-viennit" role="group" aria-label="Vie näkyvät rivit">
          <button type="button" class="sy-nappi sy-nappi--toissijainen" data-sy-vie="csv">Lataa CSV</button>
          ${root.XlsxKevyt ? '<button type="button" class="sy-nappi sy-nappi--toissijainen" data-sy-vie="xlsx">Lataa Excel (.xlsx)</button>' : ''}
          <button type="button" class="sy-nappi sy-nappi--toissijainen" data-sy-vie="ics">Lataa määräpäivät kalenteriin (.ics)</button></div>
        <p class="sy-vihje">Vienti sisältää näkyvät rivit. CSV on UTF-8-muodossa, erottimena puolipiste ja desimaalierottimena pilkku. Kalenteriin tulevat avoimien määräpäivät.</p>`;
    }
    function jaljella(k) {
      const l = k.laskettu;
      if (l.tila === 'valmis') return `Valmis ${esc(fi(k.valmistui))}${l.ajassa === false ? `, ${l.myohassaTp} tp myöhässä` : ''}`;
      if (l.tila === 'myohassa') return `<b>${l.myohassaTp} työpäivää myöhässä</b>`;
      if (k.keskeytetty) return esc(k.huomautus || 'Määräaika keskeytetty');
      if (l.jaljellaTp === 0) return '<b>Määräpäivä tänään</b>';
      if (l.jaljellaTp != null) return `${l.jaljellaTp} työpäivää`;
      return esc(k.huomautus || 'Ei määräpäivää');
    }
    function kohdeLinkki(k) {
      const teksti = `<span class="sy-tunnus">${esc(k.id)}</span> ${esc(k.otsikko || '')}`;
      const url = kohdeUrl(k);
      if (url) return `<a href="${esc(url)}">${teksti}</a>`;
      if (a.avaaKohde) return `<button type="button" class="sy-linkkinappi" data-sy-avaa="${esc(k.id)}">${teksti}</button>`;
      return teksti;
    }
    function paivitaJono(ilmoitaMaara) {
      const f = S.suodatin;
      const perus = RIK.filter(k => (!f.kunta || k.kunta === f.kunta) && (!f.yksikko || k.yksikko === f.yksikko)
        && (!f.kasittelija || (f.kasittelija === '-' ? !k.kasittelija : k.kasittelija === f.kasittelija)));
      const c = laskeLaskurit(perus);
      juuri.querySelectorAll('[data-sy-laskuri]').forEach(el => { el.textContent = lukuFi(c[el.dataset.syLaskuri]); });
      juuri.querySelectorAll('.sy-laskuri').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.syTila === f.tila)));
      const tilaSel = $('#sy-s-tila'); if (tilaSel) tilaSel.value = f.tila;
      const rivit = perus.filter(k => f.tila === 'kaikki' || (f.tila === 'avoimet' ? k.laskettu.tila !== 'valmis' : k.laskettu.tila === f.tila)).sort(jarjestys);
      S.jonoRivit = rivit;
      const maaraTeksti = `Näytetään ${kpl(rivit.length)}.`;
      $('#sy-jono-tulos').innerHTML = `<p class="sy-maara" id="sy-jono-maara" data-maara="${rivit.length}">${maaraTeksti}</p>` + (rivit.length ? `
        <table class="sy-taulu sy-taulu--pino sy-jono"><caption class="sy-sr">Työjono määräpäivän mukaan</caption>
        <thead><tr><th scope="col">Määräpäivä</th><th scope="col">${esc(sanat.otsikko)}</th><th scope="col">Tila</th>${monta ? '<th scope="col">Kunta</th>' : ''}<th scope="col">Yksikkö</th><th scope="col">Käsittelijä</th><th scope="col">Saapui</th><th scope="col">Jäljellä</th></tr></thead>
        <tbody>${rivit.map(k => `<tr data-sy-kohde="${esc(k.id)}" data-tila="${k.laskettu.tila}">
          ${td('Määräpäivä', k.maarapaiva ? esc(fiVk(k.maarapaiva)) + (k.keskeytetty ? ' (keskeytetty)' : '') : 'Ei määräpäivää')}
          <th scope="row" data-otsikko="${esc(sanat.otsikko)}"><div class="sy-solu">${kohdeLinkki(k)}</div></th>${td('Tila', tilaMerkki(k.laskettu.tila))}
          ${monta ? td('Kunta', esc(kunnanNimi(k.kunta))) : ''}${td('Yksikkö', esc(yksikonNimi(k.yksikko)))}${td('Käsittelijä', k.kasittelija ? esc(k.kasittelija) : '<i>Ei käsittelijää</i>')}
          ${td('Saapui', esc(fi(k.saapui)))}${td('Jäljellä', jaljella(k))}</tr>`).join('')}</tbody></table>`
        : `<p class="sy-tyhja">Näillä valinnoilla ei ole yhtään ${esc(sanat.partitiivi)}.</p>`);
      lisaaRoolit($('#sy-jono-tulos'));
      if (ilmoitaMaara) ilmoita(maaraTeksti);
    }
    function vie(muoto) {
      const sarakkeet = (a.vienti && a.vienti.sarakkeet) || OLETUSSARAKKEET;
      const o = { apu, pvmMuoto: (a.vienti && a.vienti.pvmMuoto) || 'fi' };
      const nimi = `${(a.vienti && a.vienti.tiedostonimi) || a.palvelu.id}-${T}`;
      const rivit = S.jonoRivit;
      if (muoto === 'csv') lataa(`${nimi}.csv`, csv(sarakkeet, rivit, o), 'text/csv;charset=utf-8');
      else if (muoto === 'xlsx') lataa(`${nimi}.xlsx`, root.XlsxKevyt.xlsx(a.palvelu.nimi.slice(0, 31), xlsxRivit(sarakkeet, rivit, o)));
      else if (muoto === 'ics') {
        const osoite = u => { try { return u ? new URL(u, root.location.href).href : ''; } catch (e) { return ''; } };
        const tap = rivit.filter(k => k.maarapaiva && k.laskettu.tila !== 'valmis' && !k.keskeytetty).map(k => ({
          uid: `${a.palvelu.id}-${k.id}@savikurki.fi`, pvm: k.maarapaiva, otsikko: `Määräpäivä: ${k.id} ${k.otsikko || ''}`.trim(),
          kuvaus: `${a.palvelu.nimi}. ${kunnanNimi(k.kunta)}, ${yksikonNimi(k.yksikko)}. Käsittelijä: ${k.kasittelija || 'ei nimetty'}. Tila ${fi(T)}: ${k.laskettu.tilaNimi}.`,
          url: osoite(kohdeUrl(k)), muistutukset: [2, 0] }));
        lataa(`${nimi}.ics`, ics({ nimi: `${a.palvelu.nimi}: määräpäivät`, tapahtumat: tap }), 'text/calendar;charset=utf-8');
      }
      ilmoita(`Ladattiin ${nimi}.${muoto} (${kpl(rivit.length)}).`);
    }

    // ---------- Mitä palvelu esti ----------
    function nakymaEstetyt() {
      const c = konteksti(), E = c.estetyt, max = Math.max(1, ...E.ryhmat.map(r => r.maara));
      return `${paa('estetyt', 'Virheet, jotka lomakkeen tarkistus pysäytti ennen kuin ne ehtivät käsittelijälle. Hakija korjasi tiedon itse ennen lähettämistä.')}
        ${tyokalut(true)}
        <p class="sy-iso" id="sy-estetyt-yht" data-arvo="${E.yhteensa}">${esc(iso(c.jakso.nimi))}${c.jakso.kesken ? ' (kesken)' : ''}${c.kunta ? `, ${esc(kunnanNimi(c.kunta))}` : ''}: <b>${lukuFi(E.yhteensa)}</b> estettyä virhettä.</p>
        ${E.ryhmat.length ? `<ol class="sy-estot">${E.ryhmat.map(r => `<li class="sy-esto" data-syy="${esc(r.syy)}" data-maara="${r.maara}">
          <div class="sy-esto__rivi"><span class="sy-esto__nimi">${esc(r.nimi)}</span><span class="sy-esto__maara">${lukuFi(r.maara)}</span></div>
          <div class="sy-palkki" aria-hidden="true"><span style="width:${(r.maara / max * 100).toFixed(1)}%"></span></div>
          ${r.selite ? `<p class="sy-esto__selite">${esc(kpl(r.maara))} ${esc(r.selite)}.</p>` : ''}</li>`).join('')}</ol>`
          : '<p class="sy-tyhja">Jaksolla ei ole estettyjä virheitä.</p>'}
        ${kaavaLohko('Näin luvut lasketaan', `Palvelu kirjaa jokaisen kerran, kun lomakkeen tarkistus pysäyttää lähettämisen ja hakija korjaa tiedon. Luku kertoo pysäytysten määrän jaksolla ${fi(c.jakso.alku)}-${fi(c.jakso.loppu)}, syyn mukaan ryhmiteltynä. Yhdessä hakemuksessa voi olla useampi syy. Hakijan tunnistetietoja ei tallenneta.`)}`;
    }

    // ---------- Johtoraportti ----------
    function raporttiHtml(c) {
      const L = c.luvut, V = c.vertailu, E = c.estetyt, h = n => H(1 + n);
      const kunnat = c.kunta ? kunnanNimi(c.kunta) : a.kunnat.map(k => k.nimi + (k.isanta && monta ? ' (isäntäkunta)' : '')).join(', ');
      const riskit = c.kohteet.filter(k => ['myohassa', 'eraantyy'].includes(k.laskettu.tila)).sort(jarjestys);
      const sj = monta && !c.kunta ? seutu() : null;
      const saannot = (a.saannot || []).map(s => saannonTila(s, kaikkiKuittaukset(), T, saantoAsetukset));
      const luku = (id, nimi, arvo, lisa) => `<div class="sy-r-luku" data-sy-r="${id}"><span class="sy-r-luku__arvo">${arvo}</span><span class="sy-r-luku__nimi">${nimi}</span>${lisa ? `<span class="sy-r-luku__lisa">${lisa}</span>` : ''}</div>`;
      const myoh = L.myohassaRatkaistut;
      return `<article class="sy-raportti" aria-labelledby="sy-r-otsikko">
        <header class="sy-r-paa"><div><p class="sy-r-yla">Kuukausiraportti lautakunnalle tai johtoryhmälle</p>
          <${h(0)} class="sy-r-otsikko" id="sy-r-otsikko">${esc(a.palvelu.nimi)}: ${esc(c.jakso.nimi)}${c.jakso.kesken ? ' (kesken)' : ''}</${h(0)}>
          <p>${esc(kunnat)}</p></div>
          <dl class="sy-r-meta"><div><dt>Jakso</dt><dd>${fi(c.jakso.alku)}-${fi(c.jakso.loppu)}</dd></div><div><dt>Tilanne</dt><dd>${esc(fiVk(T))}</dd></div>${a.demo ? '<div><dt>Aineisto</dt><dd>Demo, kuvitteellinen</dd></div>' : ''}</dl></header>
        <div class="sy-r-luvut">${luku('saapuneet', 'Saapuneet', lukuFi(L.saapuneet))}${luku('ratkaistut', 'Ratkaistu', lukuFi(L.ratkaistut))}
          ${luku('maaraajassa', 'Määräajassa', pros(L.ajassaOsuus), `${L.ajassa}/${L.maaraajallisia} ratkaisua`)}
          ${luku('kasittelyaika', 'Käsittelyaika', L.kasittelyaikaKa == null ? 'ei ratkaisuja' : `${lukuFi(L.kasittelyaikaKa, 1)} tp`, 'keskiarvo, työpäivää')}
          ${luku('estetyt', 'Estetyt virheet', lukuFi(E.yhteensa), 'ennen käsittelijää')}
          ${(a.vertailu || []).length ? luku('saasto', 'Säästöarvio', tunnit(V.saastoMin), 'arvio, oletukset alla') : ''}</div>
        <div class="sy-r-sarakkeet"><section><${h(1)}>Määräajoissa pysyminen</${h(1)}>
          <p>${L.ratkaistut ? `Jaksolla ratkaistiin ${kpl(L.ratkaistut)}. Määräpäivään mennessä ${L.ajassa}/${L.maaraajallisia} (${pros(L.ajassaOsuus)}).` : 'Jaksolla ei ratkaistu yhtään.'}
          ${myoh.length ? ` Myöhässä: ${myoh.slice(0, 4).map(k => `${esc(k.id)} (${k.laskettu.myohassaTp} tp)`).join(', ')}${myoh.length > 4 ? ` ja ${myoh.length - 4} muuta` : ''}.` : ''}
          Avoimia nyt ${c.laskurit.avoimet}, joista ${c.laskurit.myohassa} myöhässä ja ${c.laskurit.eraantyy} erääntyy ${N} työpäivän sisällä.</p>
          <${h(1)}>Mitä palvelu esti</${h(1)}>
          ${E.ryhmat.length ? `<table class="sy-r-taulu"><tbody>${E.ryhmat.slice(0, 5).map(r => `<tr><th scope="row">${esc(r.nimi)}</th><td>${r.maara}</td></tr>`).join('')}${E.ryhmat.length > 5 ? `<tr><th scope="row">Muut syyt</th><td>${summa(E.ryhmat.slice(5).map(r => r.maara))}</td></tr>` : ''}</tbody></table>` : '<p>Ei estettyjä virheitä.</p>'}</section>
          <section><${h(1)}>Avoimet riskit ${esc(fi(T))}</${h(1)}>
          ${riskit.length ? `<table class="sy-r-taulu"><thead><tr><th scope="col">Määräpäivä</th><th scope="col">${esc(sanat.otsikko)}</th>${monta && !c.kunta ? '<th scope="col">Kunta</th>' : ''}<th scope="col">Tila</th></tr></thead>
            <tbody>${riskit.slice(0, 8).map(k => `<tr><td>${esc(fi(k.maarapaiva))}</td><th scope="row">${esc(k.id)}</th>${monta && !c.kunta ? `<td>${esc(kunnanNimi(k.kunta))}</td>` : ''}<td>${esc(k.laskettu.tilaNimi)}${k.laskettu.tila === 'myohassa' ? ` ${k.laskettu.myohassaTp} tp` : ''}</td></tr>`).join('')}</tbody></table>
            ${riskit.length > 8 ? `<p>Lisäksi ${riskit.length - 8} muuta.</p>` : ''}` : '<p>Ei myöhässä olevia eikä erääntyviä.</p>'}</section></div>
        ${sj ? `<section><${h(1)}>Kunnittain</${h(1)}><table class="sy-r-taulu sy-r-taulu--levea"><thead><tr><th scope="col">Kunta</th><th scope="col">Saapuneet</th><th scope="col">Ratkaistu</th><th scope="col">Määräajassa</th><th scope="col">Avoimet nyt</th><th scope="col">Myöhässä nyt</th><th scope="col">Estetyt</th>${(a.vertailu || []).length ? '<th scope="col">Säästöarvio</th>' : ''}</tr></thead>
          <tbody>${[...sj.rivit, { kunta: { nimi: 'Yhteensä' }, ...sj.yhteensa, yht: true }].map(r => `<tr${r.yht ? ' class="sy-r-yht"' : ''}><th scope="row">${esc(r.kunta.nimi)}</th><td>${r.saapuneet}</td><td>${r.ratkaistut}</td><td>${pros(r.ajassaOsuus)}</td><td>${r.avoimet}</td><td>${r.myohassa}</td><td>${r.estetyt}</td>${(a.vertailu || []).length ? `<td>${tunnit(r.saastoMin)}</td>` : ''}</tr>`).join('')}</tbody></table></section>` : ''}
        ${(a.vertailu || []).length ? `<section><${h(1)}>Säästöarvio ja laskennan oletukset</${h(1)}>
          <table class="sy-r-taulu sy-r-taulu--levea"><thead><tr><th scope="col">Työvaihe</th><th scope="col">Määrä</th><th scope="col">Ilman palvelua</th><th scope="col">Palvelun kanssa</th><th scope="col">Erotus</th></tr></thead>
          <tbody>${V.rivit.map(r => `<tr><th scope="row">${esc(r.nimi)}</th><td>${r.maara}</td><td>${lukuFi(r.ennenMin, r.ennenMin % 1 ? 1 : 0)} min/kpl</td><td>${lukuFi(r.jalkeenMin, r.jalkeenMin % 1 ? 1 : 0)} min/kpl</td><td>${tunnit(r.saastoMin)}</td></tr>`).join('')}
          <tr class="sy-r-yht"><th scope="row">Yhteensä</th><td></td><td>${tunnit(V.ennenMin)}</td><td>${tunnit(V.jalkeenMin)}</td><td>${tunnit(V.saastoMin)}${V.euroa != null ? `, noin ${lukuFi(V.euroa)} €` : ''}</td></tr></tbody></table>
          <p class="sy-r-pieni">Arvio, ei mitattu säästö. Oletukset: ${(a.oletukset || []).map(o => `${esc(o.nimi)} ${lukuFi(S.oletukset[o.id], S.oletukset[o.id] % 1 ? 1 : 0)} ${esc(o.yksikko || '')}${S.oletukset[o.id] !== Number(o.arvo) ? ' (muutettu)' : ''}`).join('; ')}.</p></section>` : ''}
        <footer class="sy-r-ala"><p>Laskentatapa: määräajat lain 150/1930 mukaan. Työpäiviä ovat ma-pe paitsi arkipyhät sekä joulu- ja juhannusaatto. Käsittelyaika lasketaan saapumista seuraavasta työpäivästä valmistumispäivään.${saannot.length ? ` Sääntökirjasto: ${saannot.length} sääntöä, kuitattu ${saannot.filter(s => s.tila === 'kuitattu').length}, tarkistettavana ${saannot.filter(s => s.tila === 'tarkistettava').length}, kuittaamatta ${saannot.filter(s => s.tila === 'kuittaamatta').length}.` : ''}</p>
          <p>${esc(a.palvelu.nimi)}, laadittu ${esc(fi(T))}. Savikurki-ydin ${VERSIO}.</p></footer></article>`;
    }
    function nakymaRaportti() {
      return `${paa('raportti', 'Yhden sivun kuukausiraportti lautakunnalle tai johtoryhmälle. Tulostuu yhdelle A4-sivulle.')}
        ${tyokalut(true)}<div class="sy-toiminnot"><button type="button" class="sy-nappi" data-sy-tulosta>Tulosta tai tallenna PDF</button></div>
        <div class="sy-paperi" id="sy-raportti-esikatselu">${raporttiHtml(konteksti())}</div>`;
    }
    function valmisteleTuloste() {
      let el = a.tuloste ? document.querySelector(a.tuloste) : document.getElementById('sy-tuloste');
      if (!el) { el = document.createElement('div'); el.id = 'sy-tuloste'; document.body.appendChild(el); }
      el.classList.add('sy-tuloste');
      el.innerHTML = raporttiHtml(konteksti());
      document.documentElement.classList.add('sy-tulostaa');
      return el;
    }
    const tulosta = () => { valmisteleTuloste(); root.print(); };

    // ---------- Kunnittain (seutu) ----------
    function nakymaSeutu() {
      const sj = seutu(), isanta = a.kunnat.find(k => k.isanta);
      const sar = [['saapuneet', 'Saapuneet'], ['ratkaistut', 'Ratkaistu'], ['ajassaOsuus', 'Määräajassa'], ['avoimet', 'Avoimet nyt'], ['eraantyy', 'Erääntyy nyt'], ['myohassa', 'Myöhässä nyt'], ['estetyt', 'Estetyt virheet'], ...((a.vertailu || []).length ? [['saastoMin', 'Säästöarvio']] : [])];
      const arvo = (f, v) => (f === 'ajassaOsuus' ? pros(v) : f === 'saastoMin' ? tunnit(v) : lukuFi(v));
      return `${paa('seutu', isanta ? `Isäntäkunta ${esc(isanta.nimi)} käsittelee myös näiden kuntien ${esc(sanat.monikko)}: ${esc(a.kunnat.filter(k => !k.isanta).map(k => k.nimi).join(', '))}. Luvut kunnittain ja yhteensä.` : 'Luvut kunnittain ja yhteensä.')}
        ${tyokalut(false)}
        <table class="sy-taulu sy-taulu--pino sy-seutu"><caption class="sy-sr">Luvut kunnittain, ${esc(kuukaudenNimi(S.jakso))}</caption>
        <thead><tr><th scope="col">Kunta</th>${sar.map(([, n]) => `<th scope="col">${n}</th>`).join('')}</tr></thead>
        <tbody>${sj.rivit.map(r => `<tr data-sy-kunta="${esc(r.kunta.id)}"><th scope="row" data-otsikko="Kunta"><div class="sy-solu">${esc(r.kunta.nimi)}${r.kunta.isanta ? ' ' + merkki('Isäntä') : ''}</div></th>${sar.map(([f, n]) => td(n, arvo(f, r[f]), ` data-sar="${f}" data-arvo="${r[f] ?? ''}"`)).join('')}</tr>`).join('')}</tbody>
        <tfoot><tr data-sy-kunta="yhteensa"><th scope="row" data-otsikko="Kunta"><div class="sy-solu">Yhteensä</div></th>${sar.map(([f, n]) => td(n, `<b>${arvo(f, sj.yhteensa[f])}</b>`, ` data-sar="${f}" data-arvo="${sj.yhteensa[f] ?? ''}"`)).join('')}</tr></tfoot></table>
        ${kaavaLohko('Näin yhteensä-rivi lasketaan', 'Määrät ja säästöarvio ovat kuntien summia. Määräajassa-osuus lasketaan summista (määräajassa ratkaistut yhteensä / ratkaistut, joilla on määräpäivä, yhteensä), ei kuntien prosenttien keskiarvona. Avoimet, erääntyvät ja myöhässä olevat ovat tämän päivän tilanne, muut valitun jakson luvut.')}`;
    }

    // ---------- Säännöt ja vuosikuittaus ----------
    function nakymaSaannot() {
      const lista = (a.saannot || []).map(s => ({ s, t: saannonTila(s, kaikkiKuittaukset(), T, saantoAsetukset) }));
      const lkm = t => lista.filter(x => x.t.tila === t).length;
      const historia = [...(a.saantoHistoria || []).map((h, i) => ({ ...h, jarj: i })), ...kaikkiKuittaukset().map((k, i) => ({ pvm: k.pvm, tunnus: k.tunnus, teksti: `Kuitattu: ${k.nimi}`, jarj: 1000 + i }))]
        .sort((x, y) => y.pvm.localeCompare(x.pvm) || y.jarj - x.jarj);
      return `${paa('saannot', `Palvelun säännöt lähteineen. Kunnan viranhaltija kuittaa säännöt kerran vuodessa. Kuittaus tarkoittaa, että hän on lukenut säännön lähteestä ja todennut sen ajantasaiseksi. Seuraava tarkistus on ${a.kuittausKk || 12} kuukauden päästä.`)}
        <ul class="sy-saantolaskurit">${Object.entries(SAANTOTILAT).map(([id, n]) => `<li class="sy-saantolaskuri sy-saantolaskuri--${id}"><span data-sy-saantolaskuri="${id}">${lkm(id)}</span> ${n}</li>`).join('')}</ul>
        <div class="sy-kentta sy-kuittaaja"><label for="sy-kuittaaja">Kuittaajan nimi ja nimike</label>
          <input type="text" id="sy-kuittaaja" autocomplete="name" value="${esc(S.kuittaaja)}" aria-describedby="sy-kuittaaja-v">
          <p class="sy-vihje" id="sy-kuittaaja-v">Demossa nimi ja päivä tallentuvat vain tähän selainvälilehteen, ja kuittauspäivä on tarkastelupäivä ${esc(fi(T))}. Tuotannossa nimi tulee kirjautumisesta.</p>
          <p class="sy-virhe" id="sy-kuittaaja-virhe" hidden>Kirjoita kuittaajan nimi ennen kuittausta.</p></div>
        <table class="sy-taulu sy-taulu--pino sy-saannot"><caption class="sy-sr">Säännöt ja niiden kuittaustila</caption>
        <thead><tr><th scope="col">Tunnus</th><th scope="col">Sääntö</th><th scope="col">Lähde</th><th scope="col">Voimassa alkaen</th><th scope="col">Tila</th><th scope="col">Kuittaus</th></tr></thead>
        <tbody>${lista.map(({ s, t }) => `<tr data-sy-saanto="${esc(s.tunnus)}" data-tila="${t.tila}">
          <th scope="row" data-otsikko="Tunnus" tabindex="-1" id="sy-s-${esc(s.tunnus)}"><div class="sy-solu">${esc(s.tunnus)}</div></th>${td('Sääntö', esc(s.kuvaus))}
          ${td('Lähde', `${s.lahde && s.lahde.url ? `<a href="${esc(s.lahde.url)}">${esc(s.lahde.otsikko || s.lahde.url)}</a>` : esc((s.lahde && s.lahde.otsikko) || 'Ei lähdettä')}<span class="sy-vihje">Haettu ${esc(fi(s.haettu) || 'ei tiedossa')}${s.muutettu ? `, sääntöä muutettu ${esc(fi(s.muutettu))}` : ''}</span>`)}
          ${td('Voimassa alkaen', esc(fi(s.voimassaAlkaen) || 'ei tiedossa'))}
          ${td('Tila', `<span class="sy-stila sy-stila--${t.tila}">${esc(t.tilaNimi)}</span><span class="sy-vihje">${esc(t.syy)}</span>`)}
          ${td('Kuittaus', `${t.kuittaus ? `<span class="sy-vihje">${esc(fi(t.kuittaus.pvm))}, ${esc(t.kuittaus.nimi)}</span>` : ''}<button type="button" class="sy-nappi sy-nappi--pieni" data-sy-kuittaa="${esc(s.tunnus)}">${t.tila === 'kuitattu' ? 'Kuittaa uudelleen' : 'Kuittaa'}<span class="sy-sr"> ${esc(s.tunnus)}</span></button>`)}</tr>`).join('')}</tbody></table>
        <section class="sy-osio" aria-labelledby="sy-o-historia"><${H(1)} id="sy-o-historia">Muutoshistoria</${H(1)}>
          ${historia.length ? `<table class="sy-taulu sy-taulu--pino sy-historia"><caption class="sy-sr">Sääntöjen muutokset ja kuittaukset, uusin ensin</caption>
          <thead><tr><th scope="col">Päivä</th><th scope="col">Sääntö</th><th scope="col">Tapahtuma</th></tr></thead>
          <tbody>${historia.map(h => `<tr>${td('Päivä', esc(fi(h.pvm)))}<th scope="row" data-otsikko="Sääntö"><div class="sy-solu">${esc(h.tunnus)}</div></th>${td('Tapahtuma', esc(h.teksti))}</tr>`).join('')}</tbody></table>` : '<p class="sy-tyhja">Ei merkintöjä.</p>'}</section>`;
    }
    function kuittaa(tunnus) {
      const nimiEl = $('#sy-kuittaaja'), nimi = (nimiEl ? nimiEl.value : S.kuittaaja).trim();
      if (!nimi) {
        const v = $('#sy-kuittaaja-virhe');
        v.hidden = false; nimiEl.setAttribute('aria-invalid', 'true'); nimiEl.setAttribute('aria-describedby', 'sy-kuittaaja-virhe sy-kuittaaja-v'); nimiEl.focus();
        return;
      }
      const k = { tunnus, nimi, pvm: T, kirjattu: new Date().toISOString() };
      S.kuittaukset.push(k); S.kuittaaja = nimi;
      tallenna('kuittaukset', S.kuittaukset); tallenna('kuittaaja', nimi);
      if (a.kuittausTallennettu) a.kuittausTallennettu(k);
      renderoi({ fokus: false });
      const rivi = $(`#sy-s-${CSS.escape(tunnus)}`); if (rivi) rivi.focus();
      ilmoita(`Sääntö ${tunnus} kuitattu ${fi(T)}.`);
    }

    // ---------- Määräaikalaskuri (käsittelijä) ----------
    function nakymaLaskuri() {
      const yks = Object.entries(YKSIKOT).map(([id, y]) => `<option value="${id}"${id === 'tyopaiva' ? ' selected' : ''}>${y.nimi}</option>`).join('');
      return `${paa('laskuri', 'Laskee määräpäivän työpäivinä, kalenteripäivinä, viikkoina tai kuukausina ja näyttää laskun vaiheet. Suomen arkipyhät vuosille 2024-2035.')}
        <form class="sy-lomake" id="sy-laskuri" novalidate><div class="sy-ruudukko">
          <div class="sy-kentta"><label for="sy-l-alku">Alkupäivä</label><input type="date" id="sy-l-alku" value="${T}" required></div>
          <div class="sy-kentta"><label for="sy-l-nimi">Alkupäivän nimi (vapaaehtoinen)</label><input type="text" id="sy-l-nimi" placeholder="esim. myöntö"></div>
          <div class="sy-kentta"><label for="sy-l-maara">Määrä</label><input type="number" id="sy-l-maara" value="20" min="0" max="36500" step="1" required inputmode="numeric"></div>
          <div class="sy-kentta"><label for="sy-l-yksikko">Yksikkö</label><select id="sy-l-yksikko">${yks}</select></div>
          <fieldset class="sy-kentta"><legend>Suunta</legend>
            <label class="sy-valinta"><input type="radio" name="sy-l-suunta" value="eteen" checked> Eteenpäin alkupäivästä</label>
            <label class="sy-valinta"><input type="radio" name="sy-l-suunta" value="taakse"> Taaksepäin tapahtumasta</label></fieldset>
          <div class="sy-kentta"><label for="sy-l-siirto">Jos päivä osuu vapaapäivälle</label><select id="sy-l-siirto" aria-describedby="sy-l-siirto-v">
            <option value="">Automaattinen</option>
            <option value="seuraava">Seuraava arkipäivä (laki 150/1930 5 §)</option><option value="edellinen">Edellinen arkipäivä (varovainen)</option><option value="ei">Ei siirretä</option></select>
            <p class="sy-vihje" id="sy-l-siirto-v">Automaattinen: eteenpäin laskettaessa seuraava arkipäivä, taaksepäin laskettaessa edellinen.</p></div>
        </div><p class="sy-virhe" id="sy-l-virhe" hidden></p><button type="submit" class="sy-nappi">Laske määräpäivä</button></form>
        <div class="sy-esimerkit" role="group" aria-label="Esimerkit"><span>Esimerkit:</span>
          <button type="button" class="sy-nappi sy-nappi--pieni sy-nappi--toissijainen" data-sy-esim="2026-04-02|20|tyopaiva|eteen|myöntö">Myöntö 2.4.2026 + 20 työpäivää</button>
          <button type="button" class="sy-nappi sy-nappi--pieni sy-nappi--toissijainen" data-sy-esim="2026-11-24|30|kalenteripaiva|eteen|tiedoksianto">Tiedoksianto 24.11.2026 + 30 päivää</button>
          <button type="button" class="sy-nappi sy-nappi--pieni sy-nappi--toissijainen" data-sy-esim="2026-06-20|14|kalenteripaiva|taakse|tapahtuma">Tapahtuma 20.6.2026 − 14 päivää</button></div>
        <div id="sy-laskuri-tulos" aria-live="polite"></div>`;
    }
    function laskeLomakkeesta() {
      const virhe = $('#sy-l-virhe'), alku = $('#sy-l-alku').value, maara = $('#sy-l-maara').value;
      let r;
      try {
        r = laske({ alku, maara: maara === '' ? NaN : Number(maara), yksikko: $('#sy-l-yksikko').value, suunta: juuri.querySelector('input[name="sy-l-suunta"]:checked').value,
          siirto: $('#sy-l-siirto').value || undefined, alkuNimi: $('#sy-l-nimi').value.trim() || undefined });
      } catch (e) {
        virhe.textContent = /Alkupäivä/.test(e.message) ? 'Anna alkupäivä.' : 'Anna määrä kokonaislukuna väliltä 0-36500.';
        virhe.hidden = false; (/Alkupäivä/.test(e.message) ? $('#sy-l-alku') : $('#sy-l-maara')).focus();
        return;
      }
      virhe.hidden = true; S.laskuriTulos = r;
      $('#sy-laskuri-tulos').innerHTML = `<div class="sy-tulos" data-maarapaiva="${r.maarapaiva}"><p class="sy-tulos__paiva">Määräpäivä <b>${esc(fiVk(r.maarapaiva))}</b></p>
        <p>${esc(r.selitys)}</p><ol class="sy-vaiheet">${r.vaiheet.map(v => `<li>${esc(v)}</li>`).join('')}</ol>
        ${r.varoitukset.map(v => `<p class="sy-virhe">${esc(v)}</p>`).join('')}
        <button type="button" class="sy-nappi sy-nappi--toissijainen" data-sy-vie-laskuri>Lataa kalenteriin (.ics)</button></div>`;
    }

    // ---------- rooli, välilehdet ja reititys ----------
    const sallitut = () => ROOLIT[S.rooli].nakymat.filter(n => n !== 'seutu' || monta);
    function renderoiRoolit() {
      $('#sy-roolit').innerHTML = S.ulkoinenRooli
        ? `<p class="sy-roolihuomio">Kirjautunut roolissa <b>${esc(ROOLIT[S.rooli].nimi)}</b>. Rooli tulee kunnan käyttäjähallinnasta (Entra ID).</p>`
        : `<fieldset class="sy-roolivalinta"><legend>Näkymä roolille</legend>${Object.entries(ROOLIT).map(([id, r]) => `<label class="sy-valinta"><input type="radio" name="sy-rooli" value="${id}"${id === S.rooli ? ' checked' : ''}> ${r.nimi}</label>`).join('')}</fieldset>
          <p class="sy-roolihuomio">${merkki('Demo')} Rooli valitaan tässä käsin. Tuotannossa käyttäjä kirjautuu kunnan Microsoft-tunnuksilla (Entra ID), ja rooli tulee hänen käyttäjäryhmästään.</p>`;
    }
    function renderoiValilehdet() {
      $('#sy-valilehdet').innerHTML = sallitut().map(id => `<li><a href="${esc(etuliite + id)}" data-sy-nakyma="${id}"${id === S.nakyma ? ' aria-current="page"' : ''}>${esc(NAKYMAT[id])}</a></li>`).join('');
    }
    const RENDEROIJAT = { yleiskuva: nakymaYleiskuva, tyojono: nakymaTyojono, estetyt: nakymaEstetyt, raportti: nakymaRaportti, seutu: nakymaSeutu, saannot: nakymaSaannot, laskuri: nakymaLaskuri };
    function renderoi(o) {
      const fokusId = document.activeElement && juuri.contains(document.activeElement) ? document.activeElement.id : '';
      renderoiValilehdet();
      const el = $('#sy-nakyma');
      el.innerHTML = RENDEROIJAT[S.nakyma]();
      el.dataset.nakyma = S.nakyma;
      lisaaRoolit(el);
      if (S.nakyma === 'tyojono') paivitaJono(false);
      if (o && o.fokus) { const h = $('#sy-otsikko'); if (h) h.focus(); }
      else if (fokusId && $(`#${CSS.escape(fokusId)}`)) $(`#${CSS.escape(fokusId)}`).focus();
      juuri.dispatchEvent(new CustomEvent('sy:nakyma', { detail: { nakyma: S.nakyma, rooli: S.rooli } }));
    }
    function nayta(id, o) {
      const sal = sallitut();
      S.nakyma = sal.includes(id) ? id : sal[0];
      renderoi({ fokus: !o || o.fokus !== false });
      return S.nakyma;
    }
    function reitita(hash, o) {
      if (!hash || !hash.startsWith(etuliite)) return false;
      nayta(hash.slice(etuliite.length).split(/[/?]/)[0], { fokus: !(o && o.fokus === false) && S.nakyma !== null });
      return true;
    }
    function asetaRooli(r, o) {
      if (!ROOLIT[r]) throw new Error(`Tuntematon rooli ${r}. Sallitut: ${Object.keys(ROOLIT).join(', ')}.`);
      S.rooli = r; S.ulkoinenRooli = !!(o && o.ulkoinen);
      if (!S.ulkoinenRooli) tallenna('rooli', r);
      renderoiRoolit();
      const nak = sallitut().includes(S.nakyma) ? S.nakyma : sallitut()[0];
      if (nak !== S.nakyma && root.location.hash.startsWith(etuliite)) root.history.replaceState(null, '', etuliite + nak);
      nayta(nak, { fokus: false });
      ilmoita(`Näkymä vaihdettu: ${ROOLIT[r].nimi}.`);
    }

    // ---------- tapahtumat (delegointi) ----------
    juuri.addEventListener('click', e => {
      const t = e.target.closest('[data-sy-tila], [data-sy-vie], [data-sy-kuittaa], [data-sy-tulosta], [data-sy-avaa], [data-sy-palauta-oletukset], [data-sy-esim], [data-sy-vie-laskuri]');
      if (!t || !juuri.contains(t)) return;
      const d = t.dataset;
      if (d.syTila) {
        if (S.nakyma === 'tyojono') { S.suodatin.tila = S.suodatin.tila === d.syTila ? 'avoimet' : d.syTila; paivitaJono(true); return; }
        S.suodatin = { tila: d.syTila, kunta: S.kunta, yksikko: '', kasittelija: '' }; // linkki vie työjonoon
      } else if (d.syVie) vie(d.syVie);
      else if (d.syKuittaa) kuittaa(d.syKuittaa);
      else if (t.hasAttribute('data-sy-tulosta')) tulosta();
      else if (d.syAvaa) a.avaaKohde(a.kohteet.find(k => String(k.id) === d.syAvaa));
      else if (t.hasAttribute('data-sy-palauta-oletukset')) { S.oletukset = { ...oletusArvot }; tallenna('oletukset', {}); renderoi({ fokus: false }); ilmoita('Oletukset palautettu.'); }
      else if (d.syEsim) {
        const [alku, maara, yksikko, suunta, nimi] = d.syEsim.split('|');
        $('#sy-l-alku').value = alku; $('#sy-l-maara').value = maara; $('#sy-l-yksikko').value = yksikko; $('#sy-l-nimi').value = nimi; $('#sy-l-siirto').value = '';
        juuri.querySelector(`input[name="sy-l-suunta"][value="${suunta}"]`).checked = true;
        laskeLomakkeesta();
      } else if (t.hasAttribute('data-sy-vie-laskuri') && S.laskuriTulos) {
        const r = S.laskuriTulos;
        lataa(`maarapaiva-${r.maarapaiva}.ics`, ics({ nimi: 'Määräpäivä', tapahtumat: [{ uid: `laskuri-${r.alku}-${r.maara}-${r.yksikko}-${r.suunta}@savikurki.fi`, pvm: r.maarapaiva, otsikko: 'Määräpäivä', kuvaus: r.selitys, muistutukset: [2, 0] }] }), 'text/calendar;charset=utf-8');
      }
    });
    juuri.addEventListener('change', e => {
      const t = e.target;
      if (t.name === 'sy-rooli') { asetaRooli(t.value); const r = juuri.querySelector(`input[name="sy-rooli"][value="${t.value}"]`); if (r) r.focus(); }
      else if (t.dataset.sySuodatin) { S.suodatin[t.dataset.sySuodatin] = t.value; paivitaJono(true); }
      else if (t.id === 'sy-jakso') { S.jakso = t.value; renderoi({ fokus: false }); }
      else if (t.id === 'sy-kunta') { S.kunta = t.value; renderoi({ fokus: false }); }
    });
    juuri.addEventListener('input', e => {
      const t = e.target;
      if (t.dataset.syOletus) {
        const v = Number(t.value);
        if (t.value === '' || !Number.isFinite(v) || v < 0) { t.setAttribute('aria-invalid', 'true'); return; }
        t.removeAttribute('aria-invalid');
        S.oletukset[t.dataset.syOletus] = v;
        tallenna('oletukset', Object.fromEntries(Object.entries(S.oletukset).filter(([k, x]) => x !== oletusArvot[k])));
        const c = konteksti();
        $('#sy-kortit').innerHTML = kortit(c); $('#sy-vertailu').innerHTML = vertailuTaulu(c); lisaaRoolit($('#sy-vertailu'));
      } else if (t.id === 'sy-kuittaaja') {
        S.kuittaaja = t.value; tallenna('kuittaaja', t.value);
        if (t.value.trim()) { t.removeAttribute('aria-invalid'); t.setAttribute('aria-describedby', 'sy-kuittaaja-v'); $('#sy-kuittaaja-virhe').hidden = true; }
      }
    });
    juuri.addEventListener('submit', e => { if (e.target.id === 'sy-laskuri') { e.preventDefault(); laskeLomakkeesta(); } else e.preventDefault(); });
    root.addEventListener('beforeprint', () => { if (S.nakyma === 'raportti' && !document.documentElement.classList.contains('sy-tulostaa')) valmisteleTuloste(); });
    root.addEventListener('afterprint', () => document.documentElement.classList.remove('sy-tulostaa'));

    // ---------- käynnistys ----------
    juuri.classList.add('sy');
    if (a.teema === 'vaalea') juuri.classList.add('sy--vaalea');
    juuri.innerHTML = `<div class="sy-kehys"><div class="sy-roolit" id="sy-roolit"></div>
      <nav class="sy-valilehdet" aria-label="${esc(a.navOtsikko || 'Kaupungin näkymä')}"><ul id="sy-valilehdet"></ul></nav>
      <div class="sy-nakyma" id="sy-nakyma"></div><p class="sy-sr" aria-live="polite" id="sy-ilmoitus"></p></div>`;
    if (a.rooli && typeof a.rooli.lahde === 'function') {
      S.ulkoinenRooli = true;
      Promise.resolve().then(() => a.rooli.lahde()).then(r => asetaRooli(typeof r === 'string' ? r : r.rooli, { ulkoinen: true }))
        .catch(() => { S.ulkoinenRooli = false; renderoiRoolit(); });
    }
    renderoiRoolit();
    if (omaReititys) root.addEventListener('hashchange', () => reitita(root.location.hash));
    if (!(omaReititys && reitita(root.location.hash))) nayta(a.aloitusnakyma || sallitut()[0], { fokus: false });

    return {
      nayta, reitita, asetaRooli, tulosta, valmisteleTuloste, vie,
      rooli: () => S.rooli, nakyma: () => S.nakyma, sallitutNakymat: sallitut,
      paivita(uusi) { if (uusi && uusi.kohteet) { a.kohteet = uusi.kohteet; RIK = rikasta(a.kohteet, T, N, a.kunnat[0].id); } if (uusi && uusi.estetyt) a.estetyt = uusi.estetyt; renderoi({ fokus: false }); },
      tila() { const c = konteksti(); return { tanaan: T, jakso: c.jakso, laskurit: laskeLaskurit(RIK), luvut: c.luvut, estetyt: c.estetyt, vertailu: c.vertailu, oletukset: { ...S.oletukset }, seutu: monta ? seutu() : null, saannot: (a.saannot || []).map(s => ({ tunnus: s.tunnus, ...saannonTila(s, kaikkiKuittaukset(), T, saantoAsetukset) })), jonoRivit: S.jonoRivit.map(k => k.id) }; },
      tyhjennaTallennukset() { try { Object.keys(root.sessionStorage).filter(k => k.startsWith(`${AV}:`)).forEach(k => root.sessionStorage.removeItem(k)); } catch (e) { /* ei tallennusta */ } },
    };
  }

  const api = {
    VERSIO, kaynnista, tarkistaAdapteri,
    pvm: { onPvm, lisaaPaivia, lisaaKuukausia, viikonpaiva, erotusPaivina, fi, fiLyhyt, fiVk, kuukaudenNimi, jakso },
    maaraaika: { TUETUT_VUODET, YKSIKOT, paasiainen, pyhat, pyhapaiva, vapaanSyy, onTyopaiva, tyopaiviaValilla, lisaaTyopaivia, siirra, laske, ics },
    laskenta: { TILAT, laskeTila, rikasta, laskeLaskurit, laskeJaksonLuvut, ryhmitaEstetyt, laskeVertailu, saannonTila, jarjestys },
    vienti: { csv, csvArvo, xlsxRivit, lataa, OLETUSSARAKKEET },
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SavikurkiYdin = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* Reittari: Kaupungin näkymä (#/kaupunki, 27.9.2026).
   Henkilöstön tilannekuva pysäkkijulisteista muutosvahdin viikkoajosta (docs/muutosvahti/<city>.json)
   Savikurki-ytimellä (vendor/savikurki-ydin/ydin.js). index.html lataa tämän tiedoston vasta tällä
   reitillä (viewCity), joten muut näkymät eivät lataa ydintä eivätkä sen tyylejä.

   Adapteri: kohde = pysäkkijuliste. Ytimen neljä perustilaa muutosvahdin kentistä:
     ajan tasalla (ei muuttunut eikä tulossa)  -> valmis, valmistui = ajopäivä
     muuttunut (pysäkillä oleva juliste vanha) -> puutteellinen, ei määräpäivää (vanhenemispäivää ei tiedetä)
     tulossa, voimaantulopäivä tiedossa        -> määräpäivä = arvioitu voimaantulo. Ydin näyttää Erääntyy,
                                                  koska Erääntyy-raja on muutosvahdin katseluikkuna, tai
                                                  Myöhässä, jos päivä on jo ohi
     tulossa, voimaantulopäivä ei tiedossa     -> uusi, huomautus
   Poikkeusviikko ei ole tila, koska se ei muuta julistetta: merkintä nimen perässä, mittari ja vienti.
   Mitä palvelu esti = tulossa-pysäkit, joita ei ole vielä merkitty vanhentuneiksi: vahti nosti ne ennen
   kuin vanha aikataulu jäi pysäkille.

   Ydintä ei muuteta. Hakemusmallin kortit, sarakkeet ja roolivalinta, joita julisteilla ei ole,
   piilotetaan kaupunki.css:ssä, ja hakemusmallin tekstit (estetyt virheet, johtoraportin luvut ja
   laskentatapa) korvataan piirron jälkeen (korvaa).

   Tulostusturva: ytimen ydin.css sisältää @page-säännön ja ydin.js window-tason beforeprint-kuuntelijan.
   Kun reitiltä poistutaan, tyylit kytketään pois ja ytimen näkymä siirretään pois raportista, jotta
   julisteiden ja vihkojen tulostus toimii kuten ennenkin. */
(function () {
  'use strict';
  const Y = window.SavikurkiYdin;
  const fi = Y.pvm.fi, fiVk = Y.pvm.fiVk, fiLyhyt = Y.pvm.fiLyhyt;
  // Voimaantulopäivä: muutosvahti tarkentaa päivän (yhteenveto.voimaanTarkka); muuten päivä on viikon otospäivä ja arvio.
  const voimaanTeksti = (v, tarkka, muoto = fiVk) => (tarkka ? muoto(v) : `noin ${muoto(v)}`);
  const LAHDE = { otsikko: 'Reittari, muutosvahti (tests/muutosvahti.js)', url: 'https://github.com/Veikkoville/lsl-aikataulut/blob/master/tests/muutosvahti.js' };
  const LAHDE_GTFS = { otsikko: 'Digitransit, avoin rajapinta', url: 'https://digitransit.fi/en/developers/' };
  const REITTI = /^#\/kaupunki(?:[/?]|$)/;
  const S = { data: undefined, ydin: null, juuri: null, tuloste: null, tyylit: null, luvut: null };

  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const luku = n => Number(n).toLocaleString('fi-FI');
  const pros = x => (x == null ? 'ei tietoa' : `${Math.round(x * 100)} %`);
  const kpl = n => `${luku(n)} ${n === 1 ? 'juliste' : 'julistetta'}`;
  const paikallinen = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ajoPvm = ts => { const d = new Date(ts); return ts && !isNaN(d) ? paikallinen(d) : null; };
  const onKaupunki = () => REITTI.test(location.hash);
  const aktiivinen = () => !!(S.juuri && S.juuri.isConnected);

  /* ---------- tyylit: päällä vain tällä reitillä ---------- */
  function tyylit(paalle) {
    if (!S.tyylit) {
      if (!paalle) return Promise.resolve();
      S.tyylit = ['vendor/savikurki-ydin/ydin.css', 'kaupunki.css'].map(href => {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = href; l.dataset.kaupunki = '';
        l.ladattu = new Promise(r => { l.onload = r; l.onerror = r; });
        document.head.appendChild(l);
        return l;
      });
    }
    S.tyylit.forEach(l => { l.disabled = !paalle; });
    return Promise.all(S.tyylit.map(l => l.ladattu));
  }
  function poisPaalta() {
    if (S.tyylit) S.tyylit.forEach(l => { l.disabled = true; });
    // Ytimen beforeprint valmistelee johtoraportin aina, kun sen näkymä on raportti: siirretään pois.
    if (S.ydin && S.ydin.nakyma() === 'raportti') S.ydin.nayta('yleiskuva', { fokus: false });
    // Tulostukseen valmisteltu raportti ja sen merkki pois, jos tulostusta ei tehty loppuun.
    if (S.tuloste) S.tuloste.innerHTML = '';
    document.documentElement.classList.remove('sy-tulostaa');
  }
  window.addEventListener('hashchange', () => { if (!onKaupunki()) poisPaalta(); });

  /* ---------- data ---------- */
  async function lataaData() {
    if (S.data !== undefined) return S.data;
    // Yhteenveto ensin, kuten Muutosvahti-välilehdellä: puuttuvaa kaupunkitiedostoa ei haeta (404 olisi konsolivirhe).
    const ix = await fetch('docs/muutosvahti/index.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (!ix || !ix.kaupungit || !ix.kaupungit[cityKey]) { S.data = null; return null; }
    const r = await fetch('docs/muutosvahti/' + encodeURIComponent(cityKey) + '.json', { cache: 'no-cache' });
    if (!r.ok) { S.data = null; return null; }
    const d = await r.json().catch(() => ({}));
    S.data = d && Array.isArray(d.pysakit) && ajoPvm(d.ajettu) ? d : { virhe: true };
    return S.data;
  }

  const linjaJarjestys = xs => [...(xs || [])].map(String).sort((a, b) => a.localeCompare(b, 'fi', { numeric: true }));

  function kohteet(d) {
    const ajo = ajoPvm(d.ajettu), y = d.yhteenveto || {}, pv = y.poikkeusviikot || {};
    const voimaan = Y.pvm.onPvm(y.voimaan) ? y.voimaan : null, tarkka = !!y.voimaanTarkka;
    const etuliitteet = new Set(d.pysakit.map(p => String(p.id).split(':')[0]));
    const lyhyt = id => (etuliitteet.size === 1 ? String(id).replace(/^[^:]*:/, '') : String(id));
    return d.pysakit.map(p => {
      const linjat = linjaJarjestys(p.lines);
      const poikkeusPvm = p.poikkeus && pv[p.poikkeus] && Y.pvm.onPvm(pv[p.poikkeus].pvm) ? pv[p.poikkeus].pvm : null;
      const l = linjat.length ? `, ${linjat.length === 1 ? 'linja' : 'linjat'} ${linjat.slice(0, 8).join(', ')}${linjat.length > 8 ? ` ja ${linjat.length - 8} muuta` : ''}` : '';
      // Pysäkkikohtainen voimaantulopäivä (muutosvahti 27.9. alkaen); vanhassa datassa kaupungin yhteinen päivä.
      const oma = p.tulossa && Y.pvm.onPvm(p.voimaan);
      const kv = p.tulossa ? (oma ? p.voimaan : voimaan) : null, kt = oma ? !!p.voimaanTarkka : tarkka;
      const k = {
        id: lyhyt(p.id), gtfsId: String(p.id), nimi: p.name || '', tunnus: p.code || '', linjat,
        otsikko: `${p.name || ''}${p.code && p.code !== lyhyt(p.id) ? ` (${p.code})` : ''}${l}${poikkeusPvm ? `; poikkeusviikko ${fiLyhyt(poikkeusPvm)}` : ''}`,
        saapui: ajo, kasittelija: '', muuttunut: !!p.muuttunut, tulossa: !!p.tulossa, poikkeus: p.poikkeus || '', poikkeusPvm,
        voimaan: kv, voimaanTarkka: kt, depsNear: Number(p.depsNear) || 0, depsFar: Number(p.depsFar) || 0,
        maarapaiva: null, valmistui: null, keskeytetty: false, huomautus: '',
      };
      if (k.muuttunut) {
        k.tila = 'puutteellinen';
        k.huomautus = `Juliste vanhentunut, tulosta uusi nyt${k.tulossa && kv ? `. Muuttuu uudelleen ${voimaanTeksti(kv, kt, fi)}` : ''}`;
      } else if (k.tulossa && kv) { k.tila = 'kasittelyssa'; k.maarapaiva = kv; }
      else if (k.tulossa) { k.tila = 'uusi'; k.huomautus = 'Muutos tulossa, voimaantulopäivä ei tiedossa'; }
      else { k.tila = 'valmis'; k.valmistui = ajo; }
      return k;
    });
  }

  // Luvut, joita ydin ei itse laske (tilannekuva ajopäivänä) ja joita korvaa() tarvitsee.
  function laske(d, T, K) {
    const ajo = ajoPvm(d.ajettu), y = d.yhteenveto || {};
    const voimaan = Y.pvm.onPvm(y.voimaan) ? y.voimaan : null;
    const far2 = d.paivat && Y.pvm.onPvm(d.paivat.far2) ? d.paivat.far2 : null;
    // Erääntyy-raja = muutosvahdin katseluikkuna: jokainen tulossa-muutos osuu sen sisään (enintään 6 viikkoa).
    const N = far2 && far2 > T ? Math.max(5, Y.maaraaika.tyopaiviaValilla(T, far2)) : 5;
    const pvKaikki = Object.values(y.poikkeusviikot || {}).filter(w => w && w.n > 0 && Y.pvm.onPvm(w.pvm)).sort((a, b) => a.pvm.localeCompare(b.pvm));
    const rik = Y.laskenta.rikasta(K, T, N, cityKey);
    const n = K.length, muuttunut = K.filter(k => k.muuttunut).length, tulossa = K.filter(k => k.tulossa).length;
    const valmis = K.filter(k => !k.muuttunut && !k.tulossa).length;
    // Ajan tasalla tänään: juliste vastaa tänään voimassa olevaa aikataulua. Tuleva muutos ei tee julisteesta
    // väärää ennen muutospäivää (muutosvahti takaa, että kaksi lähiviikkoa ovat vielä nykytilaa).
    const ajanTasalla = K.filter(k => !k.muuttunut && !(k.tulossa && k.voimaan && k.voimaan <= T)).length;
    return {
      ajo, T, N, far2, voimaan, voimaanTarkka: !!y.voimaanTarkka, pv: pvKaikki, rik, ajanTasalla,
      voimaanPaivia: new Set(K.filter(k => k.tulossa && k.voimaan).map(k => k.voimaan)).size,
      edellinen: ajoPvm(d.edellinen), ajettu: d.ajettu,
      n, muuttunut, tulossa, valmis, molemmat: K.filter(k => k.muuttunut && k.tulossa).length,
      ennakko: K.filter(k => k.tulossa && !k.muuttunut).length,
      poikkeus: K.filter(k => k.poikkeus).length, uusinnat: n - valmis,
    };
  }

  /* ---------- adapteri (ADAPTERI.md) ---------- */
  function adapteri(d, T, K, L) {
    const kaupunki = (CONFIG.cityNames && CONFIG.cityNames.fi) || CONFIG.city || cityKey;
    const ajo = L.ajo;
    const jaksolla = c => ajo >= c.jakso.alku && ajo <= c.jakso.loppu;
    const lkm = (c, f) => c.kohteet.filter(f).length;
    const uusittavat = c => (jaksolla(c) ? lkm(c, k => k.muuttunut || k.tulossa) : 0);
    const tanaan = k => !k.muuttunut && !(k.tulossa && k.voimaan && k.voimaan <= L.T);
    const viikot = L.pv.map(w => `${fiVk(w.pvm)}: ${luku(w.n)}`).join(', ');
    return {
      juuri: S.juuri, tanaan: T, jakso: ajo.slice(0, 7), otsikkotaso: 2, teema: 'vaalea',
      navOtsikko: 'Kaupungin näkymä', tuloste: '#knTuloste', tallennusAvain: `sy-reittari-${cityKey}`,
      reititys: { etuliite: '#/kaupunki/', oma: false }, rooli: { oletus: 'esihenkilo' },
      palvelu: { id: 'reittari-julisteet', nimi: 'Pysäkkijulisteet', kohde: { yksi: 'juliste', partitiivi: 'julistetta', monikko: 'julisteet', otsikko: 'Pysäkkijuliste' } },
      kunnat: [{ id: cityKey, nimi: kaupunki }],
      kohteet: K, eraantyyTyopaivina: L.N,
      kohdeUrl: k => '#/pysakki/' + encodeURIComponent(k.gtfsId),
      estetyt: K.filter(k => k.tulossa && !k.muuttunut).map(() => ({ pvm: ajo, syy: 'ennakko' })),
      estoSyyt: { ennakko: {
        nimi: L.voimaan ? `Aikataulu muuttuu ${voimaanTeksti(L.voimaan, L.voimaanTarkka)}` : 'Aikataulu muuttuu, päivä ei tiedossa',
        selite: 'nostettiin uusintapainatukseen ennen kuin vanha aikataulu jäi pysäkille' } },
      oletukset: [
        { id: 'selvitys-ennen', nimi: 'Muuttuvan pysäkin selvitys käsin', arvo: 10, yksikko: 'min/pysäkki', selite: 'Uuden aikataulun vertailu pysäkillä olevaan julisteeseen.', lahde: 'esimerkkioletus, korvaa kaupungin omalla luvulla' },
        { id: 'selvitys-nyt', nimi: 'Muutosvahdin listan tarkistus', arvo: 1, yksikko: 'min/pysäkki', selite: 'Vahti vertaa aikataulut, henkilöstö käy listan läpi.', lahde: 'esimerkkioletus' },
        { id: 'taitto-ennen', nimi: 'Julisteen taitto ja oikoluku käsin', arvo: 30, yksikko: 'min/juliste', selite: 'Aikataulun siirto julistepohjaan ja tarkistus.', lahde: 'esimerkkioletus, korvaa kaupungin omalla luvulla' },
        { id: 'taitto-nyt', nimi: 'Julisteen tulostus Reittarista', arvo: 2, yksikko: 'min/juliste', selite: 'Juliste syntyy suoraan aikataulusta.', lahde: 'esimerkkioletus' },
      ],
      vertailu: [
        { id: 'selvitys', nimi: 'Muuttuvien pysäkkien selvitys', maara: uusittavat, maaraNimi: 'pysäkkiä', ennen: 'selvitys-ennen', jalkeen: 'selvitys-nyt',
          selite: 'Varovainen arvio: mukana vain pysäkit, joiden juliste oikeasti vaihtuu. Käsin selvitettäessä käytäisiin läpi kaikki muuttuvien linjojen pysäkit.' },
        { id: 'taitto', nimi: 'Uuden julisteen taitto', maara: uusittavat, maaraNimi: 'julistetta', ennen: 'taitto-ennen', jalkeen: 'taitto-nyt' },
      ],
      mittarit: [
        { id: 'pysakkeja', nimi: 'Pysäkkejä', muoto: 'luku', arvo: c => c.kohteet.length,
          selite: `tarkistettu ${fiVk(ajo)}`,
          kaava: c => `Pysäkit, joilla on lähtöjä ensi viikolla tai 5-6 viikon päästä. Pysäkki ilman lähtöjä ei tarvitse julistetta, eikä se ole mukana. Muutosvahdin ajo ${fi(ajo)}: ${c.kohteet.length}.` },
        { id: 'ajan-tasalla', nimi: 'Ajan tasalla tänään', muoto: 'prosentti',
          arvo: c => (c.kohteet.length ? lkm(c, tanaan) / c.kohteet.length : null),
          selite: c => `${luku(lkm(c, tanaan))}/${luku(c.kohteet.length)} julistetta`,
          kaava: c => `Pysäkit, joiden juliste vastaa tänään voimassa olevaa aikataulua (${lkm(c, tanaan)}), jaettuna kaikilla pysäkeillä (${c.kohteet.length}). Juliste, jonka aikataulu muuttuu myöhemmin, on ajan tasalla muutospäivään asti ja näkyy luvussa Muutos tulossa. Poikkeusviikko ei tee julisteesta vanhentunutta.` },
        { id: 'vanhentuneita', nimi: 'Vanhentuneita', muoto: 'luku', arvo: c => lkm(c, k => k.muuttunut),
          selite: c => (lkm(c, k => k.muuttunut) ? 'tulosta uusi juliste nyt' : 'ei vanhentuneita julisteita'),
          kaava: c => `Pysäkit, joiden julisteen sisältö (lähdöt tiistaina, lauantaina ja sunnuntaina) on muuttunut edellisen viikkoajon${L.edellinen ? ` (${fi(L.edellinen)})` : ''} jälkeen. Pysäkillä oleva juliste ei enää vastaa aikataulua: ${lkm(c, k => k.muuttunut)}.` },
        { id: 'tulossa', nimi: 'Muutos tulossa', muoto: 'luku', arvo: c => lkm(c, k => k.tulossa),
          selite: c => (lkm(c, k => k.tulossa) ? (L.voimaan ? (L.voimaanPaivia > 1 ? `ensimmäinen ${voimaanTeksti(L.voimaan, L.voimaanTarkka)}, pysäkeittäin ${L.voimaanPaivia} eri päivää` : `voimaan ${voimaanTeksti(L.voimaan, L.voimaanTarkka)}, uusi juliste ennen sitä`) : 'voimaantulopäivä ei tiedossa') : 'ei tulevia muutoksia'),
          kaava: c => `Pysäkit, joiden vakaa aikataulu 5-6 viikon päästä eroaa nykyisestä: ${lkm(c, k => k.tulossa)}. ${L.voimaan ? (L.voimaanTarkka ? `Voimaantulopäivä lasketaan pysäkeittäin: ensimmäinen päivä, jonka lähdöt eroavat viikkoa aiemmasta ja ovat samat kuin viikkoa myöhemmin. Aikaisin ${fi(L.voimaan)}${L.voimaanPaivia > 1 ? `; eri päiviä ${L.voimaanPaivia}, ja kunkin pysäkin oma päivä on Työjonon määräpäivä` : ''}.` : `Voimaantulopäivä ${fi(L.voimaan)} on arvio: ensimmäinen viikko, jolla yli puolet otospysäkeistä näyttää uuden aikataulun. Tarkkaa päivää ei saatu selville.`) : 'Voimaantulopäivää ei ole arvioitu.'}${lkm(c, k => k.tulossa && k.muuttunut) ? ` Näistä ${lkm(c, k => k.tulossa && k.muuttunut)} on myös vanhentuneita.` : ''}` },
        { id: 'poikkeusviikko', nimi: 'Poikkeusviikon pysäkit', muoto: 'luku', arvo: c => lkm(c, k => k.poikkeus),
          selite: viikot || 'ei poikkeusviikkoja',
          kaava: c => `Pysäkit, joilla yksi viikko poikkeaa muista, esimerkiksi syysloman takia: ${lkm(c, k => k.poikkeus)}. Yhden viikon poikkeama ei ole pysyvä muutos, eikä julistetta tulosteta uudelleen.${viikot ? ` Viikot: ${viikot}.` : ''}` },
        { id: 'uusintapainatus', nimi: 'Uusintapainatuslista', muoto: 'luku', arvo: c => lkm(c, k => k.muuttunut || k.tulossa),
          selite: 'julistetta tulostettavana',
          kaava: c => `Vanhentuneet (${lkm(c, k => k.muuttunut)}) ja ne, joiden aikataulu muuttuu (${lkm(c, k => k.tulossa)}), kukin pysäkki kerran: ${lkm(c, k => k.muuttunut || k.tulossa)}. Lista on Työjonossa suodattimella Avoimet, ja sen voi ladata CSV-tiedostona. Julisteet tulostetaan Tulosteet-sivun Muutosvahti-välilehdeltä.` },
        // Ytimen oma säästökortti tulisi ennen näitä; sama luku viimeisenä korttina (ytimen kortti piilotetaan).
        { id: 'saastoarvio', nimi: 'Säästöarvio', muoto: 'tunnit', arvio: true, arvo: c => c.vertailu.saastoMin / 60,
          selite: 'henkilöstön työaikaa jaksolla, arvio',
          kaava: c => `Ilman palvelua ${luku(c.vertailu.ennenMin)} min, palvelun kanssa ${luku(c.vertailu.jalkeenMin)} min. Erotus ${luku(c.vertailu.saastoMin)} min. Rivit ja oletukset ovat alla, ja oletuksia voi muuttaa. Arvio, ei mitattua työaikaa.` },
      ],
      saannot: [
        ['MV-1', 'Julisteen sisältö on pysäkin lähdöt (linja, määränpää ja lähtöaika) edustavana tiistaina, lauantaina ja sunnuntaina. Tiistai valitaan, koska maanantai ja perjantai poikkeavat useimmin muista arkipäivistä.'],
        ['MV-2', 'Lähdöksi ei lasketa pysähdystä, jossa vain jätetään matkustajia, eikä vuoron viimeistä pysäkkiä, samoin kuin julisteessa.'],
        ['MV-3', 'Nykytila mitataan kahdelta peräkkäiseltä viikolta (ensi viikko ja sitä seuraava). Tila on vakaa, kun viikot ovat samat. Jos viikot eroavat, nykytila on se viikko, joka vastaa edellisen viikkoajon nykytilaa; toinen on poikkeusviikko tai muutoksen alku.'],
        ['MV-4', 'Yhden viikon poikkeama, esimerkiksi syysloma, on poikkeusviikko eikä muutos: juliste säilyy, eikä sitä tulosteta uudelleen. Poikkeusviikoksi nimetään se viikko, joka eroaa nykytilasta.'],
        ['MV-5', 'Muutos on tulossa, kun vakaa tila 5-6 viikon päästä eroaa vakaasta nykytilasta.'],
        ['MV-6', 'Juliste on vanhentunut, kun vakaa nykytila eroaa edellisen viikkoajon nykytilasta.'],
        ['MV-7', 'Voimaantulopäivä lasketaan jokaiselle muuttuvalle pysäkille: ensin viikko (ensimmäinen tiistaiviikko, jonka aikataulu on sama kuin vakaa uusi tila) ja sitten päivä (ensimmäinen päivä, jonka lähdöt eroavat samasta viikonpäivästä viikkoa aiemmin ja ovat samat kuin viikkoa myöhemmin). Jos päivää ei saada, näytetään viikon tiistai arviona. Kaupungin päivä on aikaisin pysäkkikohtainen päivä.'],
        ['MV-8', 'Pysäkki, jolla ei ole lähtöjä kummallakaan tarkastelujaksolla, ei tarvitse julistetta, eikä se ole mukana luvuissa.'],
      ].map(([tunnus, kuvaus]) => ({ tunnus, kuvaus, lahde: LAHDE, haettu: '2026-09-27', voimassaAlkaen: '2026-09-02' }))
        .concat([{ tunnus: 'MV-9', kuvaus: 'Aikataulut luetaan joka ajolla liikennöitsijän avoimesta aikatauluaineistosta (GTFS) Digitransitin rajapinnan kautta. Käsin ylläpidettyä aikataulua ei ole.',
          lahde: LAHDE_GTFS, haettu: '2026-09-27', voimassaAlkaen: '2026-09-02' }]),
      saantoHistoria: [
        { pvm: '2026-09-02', tunnus: 'MV-3', teksti: 'Kaksi viikkoa kummallekin tarkastelujaksolle: ensimmäisessä koeajossa (Vaasa) 274 pysäkkiä 545:stä näytti muuttuvan syyslomaviikon takia.' },
        { pvm: '2026-09-02', tunnus: 'MV-4', teksti: 'Poikkeusviikoksi nimetään se viikko, joka eroaa nykytilasta (Lahti: syysloma 20.10., ei 13.10.).' },
        { pvm: '2026-09-27', tunnus: 'MV-3', teksti: 'Edellisen viikkoajon nykytila ratkaisee, kumpi lähiviikko on voimassa (Joensuu: 10 pysäkkiä, ensi viikko nykytila, 13.10. syysloma, uusi aikataulu 19.10.; vanha sääntö käski tulostaa heti).' },
        { pvm: '2026-09-27', tunnus: 'MV-7', teksti: 'Voimaantulopäivä päivän tarkkuudella ja pysäkeittäin (Lahti: uusi linja 28 alkaa ma 2.11., viikkotaso näytti ti 3.11.; Kuopio: muutokset 12.10. ja 19.10., viiden pysäkin otos antoi 14.10.).' },
      ],
      vienti: {
        tiedostonimi: `uusintapainatukset-${cityKey}`, pvmMuoto: 'fi',
        sarakkeet: [
          { otsikko: 'Pysäkki-ID', arvo: k => k.gtfsId },
          { otsikko: 'Pysäkki', arvo: k => k.nimi },
          { otsikko: 'Pysäkkitunnus', arvo: k => k.tunnus },
          { otsikko: 'Linjat', arvo: k => k.linjat.join(', ') },
          { otsikko: 'Tila', arvo: k => k.laskettu.tilaNimi },
          { otsikko: 'Vanhentunut', arvo: k => (k.muuttunut ? 'kyllä' : '') },
          { otsikko: 'Muutos tulossa', arvo: k => (k.tulossa ? 'kyllä' : '') },
          { otsikko: 'Voimaan', arvo: k => k.voimaan, tyyppi: 'pvm' },
          { otsikko: 'Poikkeusviikko', arvo: k => k.poikkeusPvm, tyyppi: 'pvm' },
          { otsikko: 'Lähtöjä nyt (ti, la, su)', arvo: k => k.depsNear, tyyppi: 'luku' },
          { otsikko: 'Lähtöjä 5 viikon päästä (ti, la, su)', arvo: k => k.depsFar, tyyppi: 'luku' },
          { otsikko: 'Muutosvahti ajettu', arvo: k => k.saapui, tyyppi: 'pvm' },
        ],
      },
    };
  }

  /* ---------- hakemusmallin tekstit julisteille (ytimen piirron jälkeen) ---------- */
  const LASKENTATAPA = 'Laskentatapa: muutosvahti vertaa kerran viikossa jokaisen pysäkin lähtöjä edustavana tiistaina, lauantaina ja sunnuntaina ensi viikolla, 5-6 viikon päästä ja edellisessä ajossa. Voimaantulopäivä on arvio. Säännöt lähteineen ovat Säännöt-välilehdellä.';

  function korvaa(el) {
    const L = S.luvut;
    if (!L) return;
    const nak = el.querySelector('.sy-nakyma[data-nakyma="estetyt"]');
    if (nak) {
      const joh = nak.querySelector('.sy-nakymapaa .sy-johdanto');
      if (joh) joh.textContent = 'Julisteet, jotka muutosvahti nosti uusintapainatukseen ennen kuin aikataulu muuttui. Kun uusi juliste tulostetaan ennen voimaantuloa, vanha aikataulu ei jää pysäkille.';
      const yht = nak.querySelector('#sy-estetyt-yht');
      if (yht) {
        const n = Number(yht.dataset.arvo) || 0;
        yht.innerHTML = `${h(yht.textContent.split(':')[0])}: <b>${luku(n)}</b> ${n === 1 ? 'juliste nostettiin' : 'julistetta nostettiin'} uusintapainatukseen ennen muutosta.`;
      }
      const tyhja = nak.querySelector('.sy-tyhja');
      if (tyhja) tyhja.textContent = 'Jaksolla ei ollut tulevia muutoksia, jotka muutosvahti olisi nostanut etukäteen.';
      const kaava = nak.querySelector('.sy-kaava p');
      if (kaava) kaava.textContent = `Muutosvahti ajetaan kerran viikossa. Luku on niiden pysäkkien määrä, joiden aikataulu muuttuu 5-6 viikon sisällä ja jotka vahti nosti tulostettavaksi ennen muutosta (ajo ${fi(L.ajo)}). Vanhentuneiksi merkittyjä ei lasketa, koska niiden muutos on jo voimassa tai alkaa viimeistään ensi viikolla.`;
    }
    const rjoh = el.querySelector('.sy-nakyma[data-nakyma="raportti"] .sy-nakymapaa .sy-johdanto');
    if (rjoh) rjoh.textContent = 'Yhden sivun raportti joukkoliikenneyksikön johdolle: julisteiden tila, uusintapainatukset ja säästöarvio. Tulostuu yhdelle A4-sivulle.';
    el.querySelectorAll('.sy-raportti').forEach(korvaaRaportti);
  }

  const TILA_JARJ = { puutteellinen: 0, myohassa: 1, eraantyy: 2, uusi: 3, kasittelyssa: 4 };
  function tilaTeksti(k) {
    const t = k.laskettu.tila;
    if (t === 'puutteellinen') return 'Vanhentunut';
    if (t === 'myohassa') return `Muuttui ${fiLyhyt(k.maarapaiva)}`;
    if (t === 'uusi') return 'Muuttuu, päivä ei tiedossa';
    return `Muuttuu ${fiLyhyt(k.maarapaiva)}`;
  }

  function korvaaRaportti(r) {
    if (r.dataset.knKorvattu) return;
    r.dataset.knKorvattu = '1';
    const L = S.luvut;
    const jakso = S.ydin ? S.ydin.tila().jakso : null;
    const ennakko = !jakso || (L.ajo >= jakso.alku && L.ajo <= jakso.loppu) ? L.ennakko : 0;
    const ot = ((r.querySelector('.sy-r-sarakkeet section > :is(h2, h3, h4, h5, h6)') || {}).tagName || 'H4').toLowerCase();
    const yla = r.querySelector('.sy-r-yla');
    if (yla) yla.textContent = 'Johtoraportti joukkoliikenneyksikölle';
    const meta = r.querySelector('.sy-r-meta');
    if (meta) meta.insertAdjacentHTML('beforeend', `<div><dt>Muutosvahti</dt><dd>${h(fiVk(L.ajo))}</dd></div>`);
    const lk = (id, nimi, arvo, lisa) => `<div class="sy-r-luku" data-sy-r="${id}" data-arvo="${h(arvo)}"><span class="sy-r-luku__arvo">${h(arvo)}</span><span class="sy-r-luku__nimi">${h(nimi)}</span>${lisa ? `<span class="sy-r-luku__lisa">${h(lisa)}</span>` : ''}</div>`;
    const luvut = r.querySelector('.sy-r-luvut');
    if (luvut) {
      const saasto = luvut.querySelector('[data-sy-r="saasto"]');
      luvut.innerHTML = lk('kn-pysakkeja', 'Pysäkkejä', luku(L.n), `tarkistettu ${fiLyhyt(L.ajo)}`)
        + lk('kn-ajan-tasalla', 'Ajan tasalla tänään', pros(L.n ? L.ajanTasalla / L.n : null), `${luku(L.ajanTasalla)}/${luku(L.n)} julistetta`)
        + lk('kn-vanhentuneita', 'Vanhentuneita', luku(L.muuttunut), L.muuttunut ? 'tulosta nyt' : 'ei yhtään')
        + lk('kn-tulossa', 'Muutos tulossa', luku(L.tulossa), L.tulossa ? (L.voimaan ? `voimaan ${voimaanTeksti(L.voimaan, L.voimaanTarkka, fiLyhyt)}` : 'päivä ei tiedossa') : 'ei muutoksia')
        + lk('kn-poikkeus', 'Poikkeusviikko', luku(L.poikkeus), L.pv.length ? L.pv.map(w => fiLyhyt(w.pvm)).join(', ') : 'ei poikkeusviikkoja');
      if (saasto) luvut.appendChild(saasto);
    }
    const sar = r.querySelector('.sy-r-sarakkeet');
    if (sar) {
      const lista = L.rik.filter(k => k.laskettu.tila !== 'valmis')
        .sort((a, b) => (TILA_JARJ[a.laskettu.tila] - TILA_JARJ[b.laskettu.tila]) || a.nimi.localeCompare(b.nimi, 'fi') || a.id.localeCompare(b.id, 'fi', { numeric: true }));
      const poikkeus = L.pv.length ? ` Poikkeusviikko ${L.pv.map(w => `${fiLyhyt(w.pvm)}: ${luku(w.n)} pysäkkiä`).join(', ')}. Yhden viikon poikkeama ei muuta julistetta, eikä sitä tulosteta uudelleen.` : '';
      sar.innerHTML = `<section data-kn="tila"><${ot}>Julisteiden tila</${ot}>
          <p>Muutosvahti tarkisti ${luku(L.n)} pysäkkiä ${h(fiVk(L.ajo))}${L.edellinen ? ` (edellinen ${h(fi(L.edellinen))})` : ''}. Ajan tasalla tänään ${kpl(L.ajanTasalla)} (${pros(L.n ? L.ajanTasalla / L.n : null)}). Vanhentuneita ${luku(L.muuttunut)}${L.muuttunut ? ': uusi juliste tarvitaan nyt' : ''}. Muutos tulossa ${luku(L.tulossa)}${L.tulossa && L.voimaan ? `, voimaan ${h(voimaanTeksti(L.voimaan, L.voimaanTarkka))}` : ''}.${h(poikkeus)}</p>
          <${ot}>Mitä palvelu esti</${ot}>
          <p data-kn="esti" data-arvo="${ennakko}">${ennakko ? `${kpl(ennakko)} nostettiin uusintapainatukseen ennen kuin vanha aikataulu jäi pysäkille${L.voimaan ? ` (muutos ${h(voimaanTeksti(L.voimaan, L.voimaanTarkka, fi))})` : ''}.` : 'Jaksolla ei ollut tulevia muutoksia, jotka muutosvahti olisi nostanut etukäteen.'}</p></section>
        <section data-kn="uusinnat"><${ot}>Uusintapainatuslista ${h(fi(L.ajo))}</${ot}>
          ${lista.length ? `<table class="sy-r-taulu"><thead><tr><th scope="col">Pysäkki</th><th scope="col">Linjat</th><th scope="col">Tila</th></tr></thead>
            <tbody>${lista.slice(0, 8).map(k => `<tr><th scope="row">${h(k.nimi)}${k.tunnus ? ` ${h(k.tunnus)}` : ''}</th><td>${h(k.linjat.slice(0, 4).join(', '))}${k.linjat.length > 4 ? ' ...' : ''}</td><td>${h(tilaTeksti(k))}</td></tr>`).join('')}</tbody></table>
            ${lista.length > 8 ? `<p>Lisäksi ${luku(lista.length - 8)} muuta. Koko lista: Kaupungin näkymä, Työjono (CSV).</p>` : ''}`
          : `<p>Ei uusittavia julisteita: kaikki ${luku(L.n)} ovat ajan tasalla.</p>`}</section>`;
    }
    const ala = r.querySelector('.sy-r-ala p');
    if (ala) {
      const m = ala.textContent.match(/^Laskentatapa:[\s\S]*?valmistumispäivään\.\s*/);
      ala.textContent = LASKENTATAPA + (m ? ' ' + ala.textContent.slice(m[0].length) : '');
    }
  }

  /* ---------- näkymä ---------- */
  function kaynnista(d, T) {
    S.juuri = document.createElement('div');
    S.juuri.id = 'knYdin';
    S.juuri.lang = 'fi';
    const K = kohteet(d);
    S.luvut = laske(d, T, K);
    const a = adapteri(d, T, K, S.luvut);
    const puutteet = Y.tarkistaAdapteri(a);
    if (puutteet.length) throw new Error(puutteet.join(' '));
    S.tuloste = document.createElement('div');
    S.tuloste.id = 'knTuloste';
    S.tuloste.lang = 'fi';
    document.body.appendChild(S.tuloste);
    // Ennen ytimen omaa kuuntelijaa: poissa tältä reitiltä ydin ei saa valmistella raporttia.
    window.addEventListener('beforeprint', () => { if (!aktiivinen()) poisPaalta(); });
    S.ydin = Y.kaynnista(a);
    // Ytimen kuuntelijan jälkeen: tulostesäiliön raportti saa julisteiden tekstit.
    window.addEventListener('beforeprint', () => { if (aktiivinen()) korvaa(S.tuloste); });
    window.addEventListener('afterprint', () => { S.tuloste.innerHTML = ''; });
    S.juuri.addEventListener('sy:nakyma', () => korvaa(S.juuri));
    korvaa(S.juuri);
  }

  function kehys(d) {
    const L = S.luvut, tila = k => `<li>${h(t(k))}</li>`;
    return `${crumbHtml()}
      <section class="kn" id="knWrap" data-lang="${h(lang)}" aria-labelledby="knOtsikko">
        <div class="kn-paa">
          <h1 id="knOtsikko">${h(t('cvH'))}</h1>
          <p class="muted">${h(t('cvSub', { date: fmtDateLong(L.ajo) }))}</p>
          ${lang !== 'fi' ? `<p class="kn-kieli">${h(t('cvFiOnly'))}</p>` : ''}
          <details class="kn-tilat"><summary>${h(t('cvStatesH'))}</summary>
            <ul>${['cvStValmis', 'cvStPuute', 'cvStEraantyy', 'cvStMyoh', 'cvStUusi', 'cvStPoikkeus'].map(tila).join('')}</ul></details>
          <p class="kn-linkki"><a href="#/tulosteet/muutokset">${h(t('cvToWatch'))}</a></p>
        </div>
        <div id="knYdinPaikka"></div>
      </section>`;
  }

  async function nayta(nav) {
    await tyylit(true);
    const d = await lataaData();
    if (navStale(nav)) { if (!onKaupunki()) poisPaalta(); return; }
    if (!d || d.virhe) {
      setView(`${crumbHtml()}<section class="kn" id="knWrap" data-lang="${h(lang)}" data-kn-tila="${d ? 'virhe' : 'ei-dataa'}" aria-labelledby="knOtsikko">
        <div class="kn-paa"><h1 id="knOtsikko">${h(t('cvTitle'))}</h1>
        <p class="kn-tyhja" role="status">${h(t(d ? 'cvDataError' : 'cvNoData'))}</p></div></section>`);
      return;
    }
    if (!S.ydin) {
      const nyt = paikallinen(new Date()), ajo = ajoPvm(d.ajettu);
      kaynnista(d, nyt < ajo ? ajo : nyt);
    }
    const wrap = document.getElementById('knWrap');
    const uusi = !(wrap && wrap.isConnected && wrap.dataset.lang === lang && wrap.contains(S.juuri));
    if (uusi) {
      setView(kehys(d));
      document.getElementById('knYdinPaikka').appendChild(S.juuri);
    }
    if (!S.ydin.reitita(location.hash, { fokus: !uusi })) S.ydin.nayta(S.ydin.nakyma() || 'yleiskuva', { fokus: false });
  }

  window.ReittariKaupunki = { nayta, ydin: () => S.ydin };
})();

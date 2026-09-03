// Kevyt network-first service worker: sivu toimii asennettuna sovelluksena
// ja avautuu myös heikolla yhteydellä viimeksi haetusta versiosta.
// API- ja karttapyynnöt (eri origin) menevät aina suoraan verkkoon.
// Lisäksi: taustapush-ilmoitukset häiriöistä (push + notificationclick).
// v4 (3.9.2026): välimuistin sisältösääntö muuttui (vain 200-vastaukset talletetaan).
// Versio nostetaan, jotta v3:een mahdollisesti jääneet virhevastaukset poistuvat
// activate-vaiheessa eivätkä jää tarjolle offline-tilassa.
const CACHE = "lsl-aikataulut-v4";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then(res => {
        // Vain onnistunut kokonainen vastaus talletetaan. Ilman tätä 404- tai 5xx-sivu
        // jäi välimuistiin ja tarjoiltiin seuraavalla offline-käynnistyksellä oikean
        // sivun tilalle. 206 (Range) ei ole kelvollinen cache.put-syöte lainkaan.
        if (res.ok && res.status === 200) {
          const copy = res.clone();
          // put voi silti kaatua (kiintiö täynnä, tallennus estetty). Se ei saa jäädä
          // käsittelemättömäksi hylkäykseksi eikä estää vastauksen palautusta.
          caches.open(CACHE)
            .then(c => c.put(event.request, copy))
            .catch(() => {});
        }
        return res;
      })
      // Verkko ei vastaa: tarjoillaan välimuistista. Osuma voi puuttua (esim. tyhjä
      // välimuisti), ja respondWith(undefined) olisi TypeError, joten palautetaan
      // selkeä 504 sen sijaan että sivu kaatuisi tulkitsemattomaan verkkovirheeseen.
      .catch(() => caches.match(event.request).then(hit => hit || new Response(
        "Ei verkkoyhteyttä eikä tallennettua versiota tästä sivusta.",
        { status: 504, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      )))
  );
});

// Taustapush: worker lähettää JSON-hyötykuorman { title, body, url, tag }
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Häiriötiedote";
  const opts = {
    body: (data.body || "").slice(0, 240),
    tag: data.tag || undefined,
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: data.url || "./" },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// Ilmoituksen klikkaus: nosta auki oleva ikkuna tai avaa sovellus.
// Ikkuna myös NAVIGOIDAAN tiedotteen osoitteeseen. Aiemmin klikkaus vain fokusoi
// ensimmäisen auki olevan ikkunan, joten esim. Kuopion häiriöpush nosti Lahden
// välilehden eikä käyttäjä nähnyt tiedotetta lainkaan.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./";
  const kohde = new URL(target, self.location.origin).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (new URL(c.url).origin !== self.location.origin) continue;
        // navigate voi puuttua tai epäonnistua (ei hallittu ikkuna): fokus riittää silloin.
        if ("navigate" in c) return c.navigate(kohde).then(w => (w || c).focus()).catch(() => c.focus());
        if ("focus" in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(kohde);
    })
  );
});

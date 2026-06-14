// Kevyt network-first service worker: sivu toimii asennettuna sovelluksena
// ja avautuu myös heikolla yhteydellä viimeksi haetusta versiosta.
// API- ja karttapyynnöt (eri origin) menevät aina suoraan verkkoon.
// Lisäksi: taustapush-ilmoitukset häiriöistä (push + notificationclick).
const CACHE = "lsl-aikataulut-v3";

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
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
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

// Ilmoituksen klikkaus: nosta auki oleva ikkuna tai avaa sovellus
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

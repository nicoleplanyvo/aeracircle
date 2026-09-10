/* THE CIRCLE - Service Worker
 *
 * Zweck: Die App soll sich am Abend oeffnen, auch wenn das WLAN in der Playa
 * unter 130 Gaesten einbricht. Ablauf, Menue und der eigene Kreis liegen dann
 * aus dem Zwischenspeicher vor; nur die Live-Zahlen fehlen, und das sieht man
 * ihnen an.
 *
 * Drei Regeln, absichtlich unterschiedlich:
 *
 * 1. Die Seite selbst (index.html) NETZ ZUERST. Eine App, die nach dem
 *    Ausrollen die alte Fassung aus dem Zwischenspeicher zeigt, ist
 *    schlimmer als gar kein Zwischenspeicher - der Ablauf im Kopf des
 *    Gastes waere dann ein anderer als der im Raum. Erst wenn das Netz
 *    nicht antwortet, kommt die gespeicherte Fassung.
 *
 * 2. Bilder und Schriften ZWISCHENSPEICHER ZUERST. Die aendern sich nicht,
 *    und sie sind das, was ueber eine schwache Leitung am laengsten laedt.
 *
 * 3. Alles unter /api/ GAR NICHT. Wer bezahlt hat, wer zugesagt hat, wie
 *    das Votum steht - das darf nie aus der Konserve kommen. Lieber ein
 *    leeres Feld als eine Zahl von vorhin.
 */
const VERSION = "circle-2026-09-10i";
const SCHALE  = "schale-" + VERSION;      // die Seite
const STATIK  = "statik-" + VERSION;      // Bilder, Schriften

/* Beim Einbau schon einmal holen, was den Start ausmacht. Mehr nicht:
   Ein Service Worker, der beim ersten Besuch das halbe Bildmaterial zieht,
   kostet genau dort Bandbreite, wo sie knapp ist. */
const VORRAT = ["/", "/manifest.webmanifest", "/assets/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(SCHALE)
      .then(c => c.addAll(VORRAT))
      /* Ein fehlendes Einzelstueck darf die Installation nicht kippen -
         sonst bleibt die App ohne Service Worker, nur weil ein Symbol
         gerade nicht erreichbar war. */
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(namen => Promise.all(
        namen.filter(n => n !== SCHALE && n !== STATIK).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Fremde Adressen: durchreichen
  if (url.pathname.startsWith("/api/")) return;      // Regel 3
  /* Profilbilder NICHT auf dem Geraet horten: Die Portraits aller Gaeste
     laegen sonst dauerhaft auf jedem Handy, auch nach dem Abend. */
  if (url.pathname.startsWith("/foto/")) return;

  /* Regel 1: die Seite selbst */
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req, { cache: "no-store" })
        .then(a => {
          /* Nur eine gesunde Antwort wird zur Offline-Schale. Ein 502 vom
             Proxy, einmal gespeichert, waere sonst bei jedem Netzausfall
             "die App". */
          if (a && a.ok) { const kopie = a.clone(); caches.open(SCHALE).then(c => c.put("/", kopie)); }
          return a;
        })
        .catch(() => caches.match("/").then(a => a || caches.match(req)))
    );
    return;
  }

  /* Regel 2: Bilder, Schriften, Manifest */
  if (/\.(png|jpe?g|svg|webp|woff2|webmanifest)$/i.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(gespeichert => {
        if (gespeichert) return gespeichert;
        return fetch(req).then(a => {
          /* Nur Vollstaendiges aufbewahren: eine 404 oder eine halbe
             Teilantwort (206) im Zwischenspeicher waere dauerhaft kaputt. */
          if (a && a.status === 200 && a.type === "basic") {
            const kopie = a.clone();
            caches.open(STATIK).then(c => c.put(req, kopie));
          }
          return a;
        });
      })
    );
  }
});

/* ---- Push ----
 * Der Tischwechsel als Nachricht, waehrend das Handy in der Tasche liegt.
 * Der Server schickt {titel, text, url}; url zeigt auf die App mit dem
 * persoenlichen Token, damit ein Tippen direkt beim eigenen Tisch landet.
 * Kommt kein lesbarer Inhalt, gibt es trotzdem eine Nachricht - eine
 * stille Push zaehlt der Browser gegen die App. */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { text: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titel || "THE CIRCLE", {
    body: d.text || "",
    icon: "/assets/icon-192.png",
    badge: "/assets/icon-192.png",
    tag: d.tag || "circle",
    renotify: true,
    data: { url: d.url || "/" }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const ziel = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(liste => {
    /* Ist die App schon offen, dorthin - nicht ein zweites Fenster. */
    for (const c of liste) if ("focus" in c) { c.navigate(ziel); return c.focus(); }
    return self.clients.openWindow(ziel);
  }));
});

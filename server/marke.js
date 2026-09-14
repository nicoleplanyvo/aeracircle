/* Die Marke einer Website erkennen - Logo, Farbe, Name.
 *
 * Wofuer: Am planyvo-Stand gibt ein Gast seine Website ein, und die
 * Vorschau der Event-App steht sofort in seinen Farben, mit seinem Logo.
 * Das ist der Satz "White-Label ohne Aufpreis" als Handgriff statt als
 * Behauptung - in drei Sekunden, ohne dass jemand etwas hochlaedt.
 *
 * Kein Browser, keine Bibliothek: Der Server liest das HTML, holt bis zu
 * drei Stylesheets nach und sucht darin nach dem, was Marken ausmacht.
 * Das ist eine Heuristik, keine Wissenschaft - sie liegt bei den meisten
 * Firmenseiten richtig, und wenn nicht, waehlt der Gast am Stand eben
 * selbst. Deshalb liefert jede Antwort mit, WORAUS sie stammt.
 *
 * SICHERHEIT: Die Adresse kommt von einem Fremden an einem oeffentlichen
 * Bildschirm. Ein Server, der jede eingegebene Adresse abruft, ist ein
 * offener Tuersteher ins eigene Netz (SSRF). Deshalb: nur http/https, jede
 * Zieladresse wird aufgeloest und gegen private Netze geprueft - auch nach
 * jeder Weiterleitung -, hartes Zeitlimit, harte Groessenbegrenzung.
 */
"use strict";

const http = require("http");
const https = require("https");
const dns = require("dns");
const zlib = require("zlib");
const net = require("net");

const ZEIT = 8000;            // Gesamtzeit je Anfrage
const MAX_HTML = 600 * 1024;  // mehr liest keine Heuristik sinnvoll
const MAX_CSS = 400 * 1024;
const MAX_CSS_DATEIEN = 3;
const MAX_WEITERLEITUNGEN = 4;
/* Ein gewoehnlicher Browser-Kopf. Mit einer eigenen Kennung antworten
 * viele Firmenseiten mit 403 (Bot-Schutz vor der Startseite) - conrad-
 * electronic.de zum Beispiel. Wir holen eine einzelne oeffentliche Seite,
 * die jeder Besucher sieht, und das hoechstens ein paar Mal am Abend. */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/* --- Adressen, die niemand von aussen abfragen darf --- */
function privat(ip) {
  if (net.isIPv4(ip)) {
    const t = ip.split(".").map(Number);
    if (t[0] === 10 || t[0] === 127 || t[0] === 0) return true;
    if (t[0] === 172 && t[1] >= 16 && t[1] <= 31) return true;
    if (t[0] === 192 && t[1] === 168) return true;
    if (t[0] === 169 && t[1] === 254) return true;   // Link-local, AWS-Metadaten
    if (t[0] === 100 && t[1] >= 64 && t[1] <= 127) return true;
    if (t[0] >= 224) return true;                     // Multicast, reserviert
    return false;
  }
  const s = String(ip).toLowerCase();
  if (s === "::1" || s === "::" ) return true;
  if (s.startsWith("fc") || s.startsWith("fd")) return true;   // unique local
  if (s.startsWith("fe80")) return true;                        // link-local
  if (s.startsWith("::ffff:")) return privat(s.slice(7));       // IPv4 in IPv6
  return false;
}

function adressePruefen(hostname, cb) {
  if (net.isIP(hostname)) return cb(privat(hostname) ? new Error("Adresse aus einem privaten Netz") : null);
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(hostname)) return cb(new Error("Kein oeffentlicher Name"));
  dns.lookup(hostname, { all: true }, (err, adressen) => {
    if (err || !adressen.length) return cb(new Error("Adresse nicht gefunden"));
    for (const a of adressen) if (privat(a.address)) return cb(new Error("Adresse zeigt in ein privates Netz"));
    cb(null);
  });
}

/* --- Eine Seite holen: mit Zeitlimit, Groessenlimit und gepruefter
 *     Weiterleitung. Gibt Text und die tatsaechliche Adresse zurueck. --- */
function holen(adresse, max, cb, tiefe) {
  tiefe = tiefe || 0;
  if (tiefe > MAX_WEITERLEITUNGEN) return cb(new Error("zu viele Weiterleitungen"));
  let u;
  try { u = new URL(adresse); } catch (e) { return cb(new Error("keine gueltige Adresse")); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return cb(new Error("nur http und https"));
  adressePruefen(u.hostname, err => {
    if (err) return cb(err);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: "GET", timeout: ZEIT,
      headers: { "User-Agent": UA, "Accept": "text/html,text/css,*/*", "Accept-Encoding": "gzip, deflate",
                 "Accept-Language": "de,en;q=0.8" }
    }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        let ziel;
        try { ziel = new URL(r.headers.location, u).href; } catch (e) { return cb(new Error("kaputte Weiterleitung")); }
        return holen(ziel, max, cb, tiefe + 1);
      }
      if (r.statusCode !== 200) { r.resume(); return cb(new Error("HTTP " + r.statusCode)); }
      const kodierung = String(r.headers["content-encoding"] || "").toLowerCase();
      const strom = kodierung === "gzip" ? r.pipe(zlib.createGunzip())
                  : kodierung === "deflate" ? r.pipe(zlib.createInflate()) : r;
      const teile = []; let laenge = 0;
      strom.on("data", c => {
        laenge += c.length;
        if (laenge > max) { teile.push(c.slice(0, Math.max(0, c.length - (laenge - max)))); req.destroy(); return; }
        teile.push(c);
      });
      strom.on("error", () => cb(null, Buffer.concat(teile).toString("utf8"), u.href));
      strom.on("end", () => cb(null, Buffer.concat(teile).toString("utf8"), u.href));
    });
    req.on("timeout", () => req.destroy(new Error("Zeit abgelaufen")));
    req.on("error", e => cb(e));
    req.end();
  });
}

/* --- Farben --- */
function hexNorm(h) {
  h = h.replace("#", "").toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return /^[0-9a-f]{6}$/.test(h) ? "#" + h : null;
}
function rgbNachHex(r, g, b) {
  const f = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return "#" + f(r) + f(g) + f(b);
}
function hsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s, l };
}
/* Taugt die Farbe als Markenfarbe? Grau, fast weiss und fast schwarz
 * nicht - das sind Hintergruende, keine Marken. */
function markenfarbe(hex) {
  const c = hsl(hex);
  return c.s >= 0.22 && c.l >= 0.16 && c.l <= 0.78;
}
function farbenAusText(text) {
  const treffer = new Map();
  const zaehl = (hex, gewicht) => {
    const h = hexNorm(hex); if (!h || !markenfarbe(h)) return;
    treffer.set(h, (treffer.get(h) || 0) + gewicht);
  };
  /* Benannte Variablen zaehlen mehr: --brand, --primary, --accent sind
   * das, was eine Firma selbst fuer ihre Farbe haelt. */
  const varRe = /--([a-z0-9-]*(?:brand|primary|prim|accent|akzent|main|theme|corporate|ci)[a-z0-9-]*)\s*:\s*([^;}\n]+)/gi;
  let m;
  while ((m = varRe.exec(text))) {
    const wert = m[2].trim();
    const hx = wert.match(/#[0-9a-fA-F]{3,8}/);
    if (hx) { zaehl(hx[0].slice(0, 7), 400); continue; }
    const rgb = wert.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
    if (rgb) zaehl(rgbNachHex(+rgb[1], +rgb[2], +rgb[3]), 400);
    /* Tailwind-Stil: "--brand: 14 52% 51%" (HSL ohne Funktion) */
    const roh = wert.match(/^(\d{1,3})\s+(\d{1,3})%\s+(\d{1,3})%$/);
    if (roh) {
      const H = +roh[1] / 360, S = +roh[2] / 100, L = +roh[3] / 100;
      const q = L < 0.5 ? L * (1 + S) : L + S - L * S, p = 2 * L - q;
      const k = t => { t = (t + 1) % 1; return t < 1/6 ? p + (q - p) * 6 * t : t < 1/2 ? q : t < 2/3 ? p + (q - p) * (2/3 - t) * 6 : p; };
      zaehl(rgbNachHex(k(H + 1/3) * 255, k(H) * 255, k(H - 1/3) * 255), 400);
    }
  }
  /* Farben an Stellen, die eine Marke tragen: Knopf, Kopfzeile, Marke. */
  const naheRe = /(btn|button|brand|logo|header|nav|primary|cta|highlight)[^{};]{0,80}?(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/gi;
  while ((m = naheRe.exec(text))) {
    if (m[2][0] === "#") zaehl(m[2].slice(0, 7), 60);
    else { const p = m[2].match(/(\d+)[\s,]+(\d+)[\s,]+(\d+)/); if (p) zaehl(rgbNachHex(+p[1], +p[2], +p[3]), 60); }
  }
  /* Und zuletzt alles andere, einfach gezaehlt. */
  const alle = text.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || [];
  for (const h of alle) zaehl(h, 1);
  const rgbAlle = text.match(/rgba?\(\s*\d+[\s,]+\d+[\s,]+\d+/g) || [];
  for (const r of rgbAlle) { const p = r.match(/(\d+)[\s,]+(\d+)[\s,]+(\d+)/); if (p) zaehl(rgbNachHex(+p[1], +p[2], +p[3]), 1); }
  return treffer;
}

/* --- HTML-Haeppchen --- */
const entwirren = s => String(s || "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö").replace(/&uuml;/g, "ü")
  .replace(/&Auml;/g, "Ä").replace(/&Ouml;/g, "Ö").replace(/&Uuml;/g, "Ü").replace(/&szlig;/g, "ß")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .trim();

function meta(html, name) {
  const re = new RegExp('<meta[^>]+(?:name|property)\\s*=\\s*["\']' + name + '["\'][^>]*>', "i");
  const t = html.match(re);
  if (!t) return "";
  const c = t[0].match(/content\s*=\s*["']([^"']*)["']/i);
  return c ? entwirren(c[1]) : "";
}
function links(html, rel) {
  const out = [];
  const re = /<link\b[^>]*>/gi; let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const r = tag.match(/rel\s*=\s*["']([^"']*)["']/i);
    if (!r || !new RegExp(rel, "i").test(r[1])) continue;
    const h = tag.match(/href\s*=\s*["']([^"']*)["']/i);
    if (!h) continue;
    const s = tag.match(/sizes\s*=\s*["'](\d+)/i);
    out.push({ href: entwirren(h[1]), groesse: s ? +s[1] : 0 });
  }
  return out;
}

/* Das Logo: was eine Firma selbst als Marke hinterlegt hat. Reihenfolge
 * nach Verlaesslichkeit - ein <img> mit "logo" im Namen ist fast immer das
 * echte Logo, ein og:image oft nur ein Stimmungsbild. */
function logoAusHtml(html, basis) {
  const abs = h => { try { return new URL(entwirren(h), basis).href; } catch (e) { return ""; } };
  const kandidaten = [];
  const imgRe = /<img\b[^>]*>/gi; let m;
  while ((m = imgRe.exec(html))) {
    const tag = m[0];
    const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!src || /^data:/i.test(src)) continue;
    const rest = tag.replace(/\bsrc\s*=\s*["'][^"']*["']/i, "");
    const woertlich = /logo|wortmarke|brand/i;
    const punkte = (woertlich.test(src) ? 60 : 0) + (woertlich.test(rest) ? 40 : 0)
      + (/header|nav|top/i.test(rest) ? 10 : 0) + (kandidaten.length < 3 ? 8 : 0);
    if (punkte >= 40) kandidaten.push({ url: abs(src), punkte, art: "Logo der Seite" });
  }
  /* SVG-Logos stehen oft direkt im HTML und lassen sich nicht verlinken -
   * dann greift der naechste Kandidat. */
  for (const l of links(html, "apple-touch-icon")) kandidaten.push({ url: abs(l.href), punkte: 55 + Math.min(20, l.groesse / 10), art: "App-Symbol" });
  const og = meta(html, "og:image"); if (og) kandidaten.push({ url: abs(og), punkte: 30, art: "Vorschaubild" });
  for (const l of links(html, "^icon$|shortcut icon|icon")) kandidaten.push({ url: abs(l.href), punkte: 20 + Math.min(20, l.groesse / 10), art: "Favicon" });
  kandidaten.sort((a, b) => b.punkte - a.punkte);
  const gesehen = new Set();
  return kandidaten.filter(k => k.url && !gesehen.has(k.url) && gesehen.add(k.url)).slice(0, 4);
}

/* Titelteile, die keine Marke sind. Deutsche Seiten stellen sie gern nach
 * vorn ("Startseite | Sion Kölsch") - wer blind den ersten Teil nimmt,
 * begruesst den Gast am Stand mit "Startseite". */
const LEERE_TITEL = /^(startseite|home|homepage|willkommen|herzlich willkommen|aktuelles|news|neuigkeiten|über uns|ueber uns|unternehmen|index|wartung|wartungsarbeiten|baustelle|coming soon|website|webseite|offizielle website)$/i;

/* Seiten, die gar nicht die Firma zeigen, sondern einen Tuersteher davor:
 * Bot-Pruefung, Cookie-Wand, Fehlerseite. Deren Farben und Titel sind die
 * des Schutzdienstes - "Client Challenge" waere ein schlechter Markenname. */
const TUERSTEHER = /^(client challenge|just a moment|attention required|access denied|zugriff verweigert|please wait|security check|checking your browser|error|fehler|403 forbidden|404|not found|bitte warten|cookie|datenschutzeinstellungen)/i;

function nameAusHtml(html, basis) {
  const ausDomain = () => { try { return new URL(basis).hostname.replace(/^www\./, "").split(".")[0]; } catch (e) { return ""; } };
  let n = meta(html, "og:site_name") || meta(html, "application-name");
  if (!n || LEERE_TITEL.test(n)) {
    const t = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
    const roh = t ? entwirren(t[1]) : "";
    const teile = roh.split(/\s[|–—·]\s|\s[-–]\s|:\s/).map(s => s.trim()).filter(Boolean);
    const echte = teile.filter(s => !LEERE_TITEL.test(s));
    if (!echte.length) n = "";
    else if (echte.length === 1) n = echte[0];
    else {
      /* Mehrere Teile: der gewinnt, der nach der Domain klingt - bei
       * "Startseite | Sion Kölsch" auf sion-koelsch.de ist das eindeutig.
       * Sonst der kuerzeste: Marken sind kurz, Claims sind lang. */
      const d = ausDomain().toLowerCase().replace(/[^a-z0-9]/g, "");
      const passt = echte.filter(s => {
        const k = s.toLowerCase().replace(/[^a-z0-9]/g, "");
        return k && d && (k.includes(d.slice(0, 6)) || d.includes(k.slice(0, 6)));
      });
      n = (passt.length ? passt : echte).sort((a, b) => a.length - b.length)[0];
    }
  }
  if (!n || LEERE_TITEL.test(n)) {
    /* Letzter Ausweg: der Domainname, wenigstens gross geschrieben. */
    const d = ausDomain();
    n = d ? d.charAt(0).toUpperCase() + d.slice(1) : "";
  }
  /* "Sparkasse_de" und "meine--firma" sind Domainreste, keine Namen. */
  return n.replace(/[_]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 60);
}

/* --- Der ganze Vorgang --- */
function marke(eingabe, fertig) {
  let roh = String(eingabe || "").trim();
  if (!roh) return fertig(new Error("Keine Adresse"));
  if (!/^https?:\/\//i.test(roh)) roh = "https://" + roh.replace(/^\/+/, "");
  let start;
  try { start = new URL(roh); } catch (e) { return fertig(new Error("Das sieht nicht nach einer Adresse aus")); }
  if (!start.hostname.includes(".")) return fertig(new Error("Das sieht nicht nach einer Adresse aus"));

  const nachHtml = (err, html, adresse) => {
    /* https zuerst, http als zweiter Versuch - manche Firmenseiten liegen
     * noch unverschluesselt, und ein Stand, der dann nichts findet, sieht
     * schlechter aus als er ist. */
    if (err && start.protocol === "https:" && !nachHtml.zweiter) {
      nachHtml.zweiter = true;
      return holen("http://" + start.hostname + start.pathname, MAX_HTML, nachHtml);
    }
    if (err) return fertig(err);
    if (!html || html.length < 40) return fertig(new Error("Die Seite gab nichts her"));

    /* Steht ein Tuersteher davor, ist alles darauf seins, nicht das der
     * Firma - dann lieber ehrlich nichts liefern. */
    const titelRoh = (html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || "";
    if (TUERSTEHER.test(entwirren(titelRoh))) return fertig(new Error("Die Seite lässt uns nicht hinein"));

    const name = nameAusHtml(html, adresse);
    const logos = logoAusHtml(html, adresse);
    const quellen = [];
    const farben = new Map();
    const dazu = (m, gewicht) => { for (const [h, n] of m) farben.set(h, (farben.get(h) || 0) + n * gewicht); };

    const tc = hexNorm(meta(html, "theme-color") || "");
    if (tc && markenfarbe(tc)) { farben.set(tc, (farben.get(tc) || 0) + 800); quellen.push("theme-color"); }
    dazu(farbenAusText(html), 1);

    /* Stylesheets: dort steht die Marke, wenn sie nicht im HTML steht. */
    const css = [];
    for (const l of links(html, "stylesheet")) {
      try { const u = new URL(l.href, adresse); if (/^https?:$/.test(u.protocol)) css.push(u.href); } catch (e) {}
      if (css.length >= MAX_CSS_DATEIEN) break;
    }
    /* Am Stand zaehlt die Sekunde: Steht die Farbe schon im HTML
     * (theme-color), ist sie verlaesslicher als alles, was drei
     * Stylesheets noch beitragen koennten - dann sofort antworten statt
     * auf langsame Server zu warten. */
    let offen = css.length;
    const abschluss = () => {
      let beste = "", punkte = 0;
      for (const [h, n] of farben) if (n > punkte) { punkte = n; beste = h; }
      fertig(null, {
        ok: true,
        adresse,
        name,
        farbe: beste || "",
        farben: [...farben.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]),
        logo: logos.length ? logos[0].url : "",
        logoArt: logos.length ? logos[0].art : "",
        logos: logos.map(l => l.url),
        quellen: quellen.concat(css.length ? [css.length + " Stylesheet" + (css.length > 1 ? "s" : "")] : [])
      });
    };
    if (!offen || (tc && logos.length)) return abschluss();
    let fertigGemeldet = false;
    /* Drei Sekunden fuer die Stylesheets, mehr nicht: Was bis dahin da ist,
     * zaehlt; der Rest kommt zu spaet fuer einen Menschen vor dem Schirm. */
    const notbremse = setTimeout(() => { if (!fertigGemeldet) { fertigGemeldet = true; abschluss(); } }, 3000);
    for (const c of css) {
      holen(c, MAX_CSS, (e, text) => {
        if (!e && text) dazu(farbenAusText(text), 3);
        if (--offen === 0 && !fertigGemeldet) { fertigGemeldet = true; clearTimeout(notbremse); abschluss(); }
      });
    }
  };
  holen(start.href, MAX_HTML, nachHtml);
}

module.exports = { marke, privat, markenfarbe, hsl };

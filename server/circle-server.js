#!/usr/bin/env node
/*
 * THE CIRCLE – Einladungs- & Live-Server
 * Eine Datei, keine Abhängigkeiten.
 *
 * Er macht zwei Dinge:
 *
 * 1) EINLADUNG (vor dem Abend)
 *    Gästeliste kommt als CSV in Pools (je Veranstalter/Partner eine Liste).
 *    Jeder Gast bekommt einen unerratbaren Token; der Lettermint-Link führt auf
 *    die Landing Page (landing.html) mit den Event-Infos. Dort sagt der Gast zu:
 *      · Ehrengäste  -> reine Zusage
 *      · Ticket-Pool -> Stripe Checkout über 100 € (echte Session, keine SDK)
 *    Die Stripe-Webhooks buchen die Zahlung zurück ins Register.
 *
 *      node server/circle-server.js import gaeste.csv    → Pools einlesen
 *      node server/circle-server.js export               → Stand als CSV
 *
 * 2) LIVE (am Abend)
 *    Echtzeit-Ebene der App: Raum-Applaus, Live-Votum, Auktions-Board,
 *    Gäste-Zähler. (Die NFC-Stationen sind derzeit geparkt – es zählen die
 *    Handys der Gäste; station.html bleibt für später liegen.)
 *
 *      node server/circle-server.js          → http://localhost:8080
 *      PORT=3000 node server/circle-server.js
 *
 * Konfiguration über Umgebungsvariablen (alles optional – ohne Stripe-Key
 * läuft der Zusage-Teil weiter, der Zahlungsschritt meldet dann "nicht
 * konfiguriert"):
 *      PUBLIC_URL             öffentliche Basis-URL, live: https://thecircle.planyvo.com
 *      STRIPE_SECRET_KEY      sk_live_… / sk_test_…
 *      STRIPE_WEBHOOK_SECRET  whsec_… (Signaturprüfung der Webhooks)
 *      TICKET_PRICE           Ticketpreis in Cent (Default 10000 = 100 €)
 *      ADMIN_TOKEN            ein gemeinsamer Schlüssel für /api/admin/* (Monitor)
 *      ADMIN_TOKENS           besser: je Person einer, "anne:xxx,desi:yyy" –
 *                             so lässt sich einzeln entziehen
 *
 * DATENSCHUTZ: Im Register stehen Namen, E-Mail-Adressen und – wenn der Gast
 * sie angibt – Unverträglichkeiten. Das sind personenbezogene und teils
 * Gesundheitsdaten. Deshalb: ADMIN_TOKEN setzen, HTTPS verwenden,
 * live-state.json nicht ins Repo (steht in .gitignore) und nach dem Event
 * löschen bzw. auf das Nötige eindampfen.
 *
 * Zustand liegt im Speicher und wird alle 2 s nach live-state.json
 * gesichert (übersteht Neustarts).
 */
"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, "..");
const STATE_FILE = path.join(__dirname, "live-state.json");

const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:" + PORT).replace(/\/$/, "");
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const TICKET_PRICE = parseInt(process.env.TICKET_PRICE, 10) || 10000;   // Cent
/* Welche Zahlungsarten der Checkout anbietet. Ohne Angabe entscheidet Stripe
 * selbst ("dynamic payment methods") - das setzt aber voraus, dass im
 * Dashboard fuer Euro ueberhaupt eine Art aktiviert ist. Ist sie das nicht,
 * bricht jede Sitzung mit "No valid payment method types" ab, und zwar erst
 * beim Gast. Deshalb geben wir "card" fest vor: das deckt Karte, Apple Pay
 * und Google Pay ab, also genau das, was wir den Gaesten versprechen.
 * Mehr Arten (z.B. paypal) per STRIPE_ZAHLARTEN="card,paypal"; "auto"
 * ueberlaesst die Wahl wieder Stripe. */
const STRIPE_ZAHLARTEN = (process.env.STRIPE_ZAHLARTEN || "card")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
/* Zugaenge zum Monitor. Entweder ein gemeinsames Geheimnis (ADMIN_TOKEN) oder
 * - besser - je Person eines (ADMIN_TOKENS="anne:xxx,desi:yyy"). Dann laesst
 * sich ein einzelner Zugang entziehen, ohne allen anderen den Link zu aendern,
 * und im Log steht, wer geschaut hat. */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ADMIN_TOKENS = new Map(
  (process.env.ADMIN_TOKENS || "").split(",")
    .map(e => e.trim()).filter(Boolean)
    .map(e => {
      const i = e.indexOf(":");
      return i > 0 ? [e.slice(i + 1).trim(), e.slice(0, i).trim()] : [e, "unbenannt"];
    })
);
if (ADMIN_TOKEN) ADMIN_TOKENS.set(ADMIN_TOKEN, "gemeinsam");

/* Zeitkonstanter Vergleich, damit sich der Schluessel nicht erraten laesst */
function adminName(key) {
  if (!key) return null;
  const a = Buffer.from(String(key));
  for (const [token, name] of ADMIN_TOKENS) {
    const b = Buffer.from(token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return name;
  }
  return null;
}

/* ---------- Lettermint: Versand ueber die API ----------
 * Lettermint ist API-first (kein Template-/Broadcast-Editor mit Merge-Feldern).
 * Deshalb verschickt dieser Server selbst: er kennt zu jedem Gast Token,
 * persoenlichen Link, Ticketnummer und Partner - es muss nichts ueber eine CSV
 * wandern, und die Zuordnung kann nicht verrutschen.
 *   POST https://api.lettermint.co/v1/send   Header: x-lettermint-token
 *   Body: { from, to[], subject, html, reply_to[], metadata, headers }        */
const LETTERMINT_TOKEN = process.env.LETTERMINT_TOKEN || "";
const MAIL_FROM = process.env.MAIL_FROM || "THE CIRCLE <hello@the-circle-cologne.de>";
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO || "";
const MAIL_ROUTE = process.env.MAIL_ROUTE || "";
/* "Signing secret" aus den Lettermint-Webhook-Einstellungen */
const LETTERMINT_WEBHOOK_SECRET = process.env.LETTERMINT_WEBHOOK_SECRET || "";
/* Die Homepage - Ziel des CTA in Welle 0. Nicht PUBLIC_URL: das ist der
 * Server mit App und persoenlichen Links, nicht die Website. */
const WEBSITE_URL = process.env.WEBSITE_URL || "https://www.the-circle-cologne.de";
/* Rueckmeldefrist der Einladung. Steht in drei Vorlagen - deshalb an EINER
 * Stelle, sonst laeuft sie beim naechsten Verschieben auseinander. */
const RSVP_DEADLINE = process.env.RSVP_DEADLINE || "27.08.2026";
/* Die Bezahlgaeste sind eine Woche spaeter dran als die Ehrengaeste: ihre
 * Einladung geht spaeter raus, und ueberwiesen sein will sie auch noch.
 * Zwei Fristen statt einer - sonst stuende in der Bezahlgast-Einladung ein
 * Datum, das beim Verschicken schon fast abgelaufen ist. */
const RSVP_DEADLINE_TICKET = process.env.RSVP_DEADLINE_TICKET || "28.08.2026";
const rsvpFrist = inv => (inv && inv.typ === "ticket") ? RSVP_DEADLINE_TICKET : RSVP_DEADLINE;
/* Wie viele Bezahlgaeste hoechstens in den Kreis duerfen. Der Saal ist
 * endlich, und die Plaetze der Partner- und Ehrengaeste sind zugesagt,
 * bevor der erste Bezahlgast antwortet - ohne Deckel wuerde ein guter Tag
 * bei den Bezahlgaesten genau die Plaetze wegnehmen, die schon vergeben
 * sind. Wer danach kommt, landet auf der Warteliste statt vor einer
 * Bezahlseite, die er nicht mehr haette nutzen duerfen. */
const TICKET_LIMIT = parseInt(process.env.TICKET_LIMIT, 10) || 50;
/* Belegt ist ein Platz mit der Zusage, nicht erst mit der Zahlung: zwischen
 * beidem liegen bei manchen Tage, und in dieser Zeit darf der Platz nicht
 * ein zweites Mal vergeben werden. */
function ticketZusagen() {
  return Object.values(state.invites)
    .filter(i => i.typ !== "ehrengast" && (i.status === "zugesagt" || i.status === "bezahlt")).length;
}
const ticketPlaetzeFrei = () => Math.max(0, TICKET_LIMIT - ticketZusagen());
/* Was dieser eine Gast zahlt. Regulaer der Ticketpreis - abweichend nur bei
 * Testgaesten, damit eine echte Live-Zahlung geprueft werden kann, ohne
 * dafuer jedes Mal 100 Euro zu bewegen. */
const preisVon = inv => (inv && inv.preis > 0) ? inv.preis : TICKET_PRICE;

const VOTES = ["ja", "vielleicht", "nein"];
const MOMENTS_TOTAL = 6;
const VOTE_LABEL = { ja: "Sofort", vielleicht: "Vielleicht", nein: "Heute nicht" };
/* Stationen, die genau einen Moment setzen */
const STATION_MOMENT = {
  checkin: "ankommen",
  impuls: "impuls",
  mentor: "mentor",
  kunst: "kunst",
  verbindung: "verbindung"
};

let state = {
  applause: 0,
  votes: { ja: 0, vielleicht: 0, nein: 0 },
  bid: null,            // { amount, paddle, name, t }
  bids: [],             // letzte Gebote, neueste zuerst
  guests: {},           // bandId -> { name, table, moments:{}, applause, vote, t }
  invites: {},          // token -> Gast der Einladungsliste (siehe importRows)
  feed: []              // Ereignis-Log für den Monitor, neueste zuerst
};
try {
  const roh = fs.readFileSync(STATE_FILE, "utf8");
  if (roh.trim()) Object.assign(state, JSON.parse(roh));
} catch (e) {
  if (e.code !== "ENOENT") {
    // Eine vorhandene, aber unlesbare Datei NICHT stillschweigend ueberschreiben -
    // das waere Totalverlust (Gaesteliste, Zusagen, Zahlungen). Beiseitelegen
    // und mit Fehler abbrechen; der Betreiber sieht es und kann eingreifen.
    const rettung = STATE_FILE + ".corrupt-" + process.pid;
    try { fs.renameSync(STATE_FILE, rettung); } catch (e2) {}
    console.error("live-state.json unlesbar - nach " + rettung + " verschoben:", e.message);
    process.exit(1);
  }
  /* ENOENT: frischer Start */
}
if (!state.guests) state.guests = {};
if (!state.invites) state.invites = {};
if (!state.feed) state.feed = [];

let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  // Atomar: erst in .tmp schreiben, dann umbenennen. Ein Absturz waehrend des
  // Schreibens hinterlaesst so die alte, vollstaendige Datei statt einer halben.
  const tmp = STATE_FILE + ".tmp";
  fs.writeFile(tmp, JSON.stringify(state), (err) => {
    if (err) { console.error("state-Sicherung fehlgeschlagen:", err.message); return; }
    fs.rename(tmp, STATE_FILE, (err2) => {
      if (err2) console.error("state-Umbenennung fehlgeschlagen:", err2.message);
    });
  });
}, 2000).unref();

/* ---------- SSE ---------- */
const clients = new Set();

/* Leichtes Rate-Limit fuer die offenen Live-Endpunkte (Applaus/Votum/Gebot).
 * Ohne das kann ein Skript mit wenigen Requests den Applaus aufblasen oder
 * Stimmen loeschen. Kein Ersatz fuer echte Auth, aber fuer einen Abend genug. */
const RL = new Map();
function rateLimit(req, res, schluessel, max, fensterMs) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    (req.socket && req.socket.remoteAddress) || "?";
  const k = schluessel + ":" + ip;
  const jetzt = Date.now();
  let e = RL.get(k);
  if (!e || e.resetAt < jetzt) { e = { count: 0, resetAt: jetzt + fensterMs }; RL.set(k, e); }
  e.count++;
  if (RL.size > 5000) for (const [kk, vv] of RL) if (vv.resetAt < jetzt) RL.delete(kk);
  if (e.count > max) { json(res, 429, { error: "zu viele Anfragen" }); return false; }
  return true;
}

function guestCount() { return Object.keys(state.guests).length; }

function snapshot() {
  return JSON.stringify({
    applause: state.applause,
    votes: state.votes,
    bid: state.bid,
    bids: state.bids.slice(0, 5),
    guests: clients.size,
    checkedIn: guestCount()
  });
}

let pushTimer = null;
function broadcast() {           // gebündelt, max. ~7 Updates/s
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const line = "data: " + snapshot() + "\n\n";
    for (const res of clients) res.write(line);
  }, 140);
}

/* ---------- Helpers ---------- */
function json(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(obj));
}

function readBody(req, res, cb) {
  let raw = "";
  req.on("data", c => {
    raw += c;
    if (raw.length > 10_000) { req.destroy(); }
  });
  req.on("end", () => {
    try { cb(JSON.parse(raw || "{}")); }
    catch (e) { json(res, 400, { error: "bad json" }); }
  });
}

const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>&"\']/g, "").trim().slice(0, n);

/* Fuer Freitext von Gaesten: Namen duerfen & und ' enthalten ("Falk & Cie",
 * "O'Brien"). Steuerzeichen und spitze Klammern fliegen raus; ausgegeben wird
 * ohnehin nur ueber textContent bzw. JSON, nie ueber innerHTML.
 * Geschweifte Klammern ebenfalls: ein Gast, der sich per RSVP "{{vorname}}"
 * nennt, wuerde im Wellenversand sonst wie ein Vorlagenfehler aussehen und
 * den Lauf fuer alle anderen blockieren. */
const cleanText = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>{}]/g, "").trim().slice(0, n);

/* Schluessel-Sicherheit: state.invites/state.guests sind normale Objekte.
 * Ein Zugriff mit "__proto__"/"constructor"/"toString" liefert sonst geerbte
 * Werte (Object.prototype etc.) statt undefined -> der Handler stuerzt ab und
 * reisst den ganzen Prozess mit (ein einziger Request killt den Server).
 * Deshalb: nur eigene Eigenschaften lesen, reservierte Keys nie schreiben. */
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const hasOwn = (o, k) => typeof k === "string" && !RESERVED.has(k) &&
  Object.prototype.hasOwnProperty.call(o, k);

/* Excel/LibreOffice werten Zellen, die mit = + - @ (oder Tab/CR) beginnen, als
 * Formel aus. Beim CSV-Export deshalb ein ' voranstellen, sonst kann ein als
 * Gastname eingeschmuggeltes =HYPERLINK(...) beim Oeffnen der Versandliste die
 * Nachbarzellen (Mails, Einladungslinks) exfiltrieren. */
function csvCell(f) {
  let s = String(f == null ? "" : f);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function paddleFrom(band) {       // stabile Bieterkarten-Nummer aus der Band-ID
  let h = 0;
  for (const c of band) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 11 + (h % 88);
}

function pubGuest(band) {
  if (!hasOwn(state.guests, band)) return null;
  const g = state.guests[band];
  return {
    name: g.name,
    table: g.table || "",
    moments: Object.keys(g.moments),
    momentsTotal: MOMENTS_TOTAL,
    applause: g.applause,
    vote: g.vote,
    paddle: paddleFrom(band)
  };
}

function serveFile(res, file, type) {
  fs.readFile(path.join(ROOT, file), (err, buf) => {
    if (err) { res.writeHead(500); return res.end(file + " fehlt"); }
    res.writeHead(200, { "Content-Type": type });
    res.end(buf);
  });
}

/* ================= EINLADUNG: Pools, Gästeliste, Zusagen ================= */

/* Ein Gast der Einladungsliste:
 *   { token, pool, typ:"ticket"|"ehrengast", name, email, firma, position,
 *     anrede,                                        <- "Liebe"/"Lieber", sonst "Hallo"
 *     partner, partnerLogo,                          <- wenn ein Partner eingeladen hat
 *     status:"offen"|"zugesagt"|"bezahlt"|"abgesagt",
 *     mail:{sent,delivered,opened,clicked},          <- Lettermint-Webhooks
 *     daten:{phone,diet,allergy},                    <- vom Gast selbst
 *     zahlung:{sessionId,paymentIntent,amount,paidAt},
 *     ticketNr }
 */

const newToken = () => crypto.randomBytes(9).toString("base64url");   // 12 Zeichen, unerratbar

/* Die Nummer im Kreis.
 *
 * Erste Fassung war "11 + (hash % 88)" - 88 moegliche Nummern. Bei 107
 * Gaesten ist eine Doppelung nicht unwahrscheinlich, sondern zwingend, und
 * schon ab etwa 15 Gaesten wahrscheinlicher als nicht (Geburtstagsparadox).
 * Gemerkt hat es niemand, weil die Nummer erst mit der Zusage sichtbar wird
 * - und dann steht sie in der Bestaetigungsmail.
 *
 * Jetzt: derselbe Hash als VORSCHLAG, aber in einem Bereich mit Luft, und
 * belegte Nummern werden weitergezaehlt. Die Nummer bleibt zufaellig
 * verteilt - eine laufende Nummer wuerde verraten, wer als Erster zugesagt
 * hat. */
/* 001 bis 199. Der Bereich muss groesser sein als die Gaesteliste - sonst
 * kaeme die Doppelung zurueck - aber nicht viel groesser: die Nummer ist
 * eine Aussage ueber die Groesse des Kreises. Bei 110 Gaesten liest sich
 * "No 294" wie ein Saal fuer dreihundert. */
const NUMMERN_BEREICH = 199;                   // 001 … 199

function ticketNumber(token) {                 // Vorschlag aus dem Token
  let h = 0;
  for (const c of token) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
const nummerText = n => "№ " + String(n).padStart(3, "0");

/* Die naechste freie Nummer ab dem Vorschlag. `belegt` ist ein Set der
 * bereits vergebenen Nummern - wer viele Gaeste auf einmal anlegt, reicht
 * dasselbe Set durch und spart sich den Aufbau je Gast. */
function ticketNummerVergeben(token, belegt) {
  if (!belegt) {
    belegt = new Set();
    for (const i of Object.values(state.invites)) if (i.ticketNr) belegt.add(i.ticketNr);
  }
  const start = ticketNumber(token) % NUMMERN_BEREICH;
  for (let i = 0; i < NUMMERN_BEREICH; i++) {
    const nr = nummerText(1 + ((start + i) % NUMMERN_BEREICH));
    if (!belegt.has(nr)) { belegt.add(nr); return nr; }
  }
  return "";                                   // alle 299 vergeben - dann fehlt sie lieber
}

function logEvent(art, gast, detail) {
  state.feed.unshift({ t: Date.now(), art, gast: gast || "", detail: detail || "" });
  state.feed = state.feed.slice(0, 200);
  dirty = true;
}

function inviteLink(token) { return PUBLIC_URL + "/einladung?t=" + token; }
function abmeldeLink(token) { return PUBLIC_URL + "/abmelden?t=" + token; }
/* Welle 2: derselbe Token, aber direkt in die App - sie holt sich Name,
 * Kontakt und Ernaehrung selbst aus der Zusage (kein Onboarding-Formular). */
function appLink(token) { return PUBLIC_URL + "/?t=" + token; }
/* Save the Date als persoenliche Webseite (WhatsApp-Gaeste, Welle-0-Phase) */
function stdLink(token) { return PUBLIC_URL + "/std?t=" + token; }

/* Kalendereintrag fuer den Knopf auf der Bestaetigungsseite.
 * Die Zeiten stehen als 18:00 bis 23:00 Ortszeit Berlin. Damit jeder
 * Kalender weiss, was Ortszeit an dem Tag bedeutet, liegt die passende
 * VTIMEZONE-Definition mit in der Datei - sonst raet Outlook.
 * Komma und Semikolon muessen in TEXT-Feldern escaped werden (RFC 5545). */
function icsText(s) { return String(s).replace(/([,;\\])/g, "\\$1"); }
const TERMIN_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//planyvo//THE CIRCLE//DE",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:the-circle-no1-2026-09-16@the-circle-cologne.de",
  "DTSTAMP:20260819T120000Z",
  "DTSTART;TZID=Europe/Berlin:20260916T180000",
  "DTEND;TZID=Europe/Berlin:20260916T230000",
  "SUMMARY:THE CIRCLE No1 - connecting generations",
  "LOCATION:" + icsText("Playa Cologne, Junkersdorfer Str. 1, 50933 Köln"),
  "DESCRIPTION:" + icsText("Ein Abend im ausgewählten Kreis. 18:00 bis 23:00 Uhr."),
  "URL:" + WEBSITE_URL,
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n") + "\r\n";

/* Satz ueber dem CTA der Ehrengast-Mail. Hat ein Partner eingeladen, waere
 * "Einladung des Hauses" ein Widerspruch zum Partner-Block darueber. */
function platzSatz(inv) {
  /* Nur Ehrengaeste haben einen Platz geschenkt bekommen. In den Vorlagen
   * greift der Satz ohnehin nur dort - aber die Kontrollliste rechnet ihn
   * fuer JEDEN Gast aus, und dort stand bei Bezahlgaesten "Einladung des
   * Hauses" neben "Beitrag 100 Euro". */
  if (inv.typ !== "ehrengast") return "";
  return inv.partner
    ? "Dein Platz ist für dich freigehalten — es genügt ein Wort."
    : "Dein Platz ist eine Einladung des Hauses — es genügt ein Wort.";
}

/* Was die Landing Page sehen darf – ohne fremde Daten */
function pubInvite(inv) {
  return {
    token: inv.token,
    typ: inv.typ,
    status: inv.status,
    name: inv.name,
    vorname: (inv.name || "").split(" ")[0],
    anrede: inv.anrede || "Hallo",
    partner: inv.partner || "",
    partnerLogo: partnerLogoUrl(inv),
    firma: inv.firma || "",
    rolle: inv.rolle || "",
    email: inv.email || "",
    pool: inv.pool,
    preis: inv.typ === "ticket" ? preisVon(inv) : 0,
    /* Wie viele Bezahlplaetze noch offen sind. Die Seite sagt es dem Gast,
     * BEVOR er das Formular ausfuellt - niemand soll seine Daten eintippen
     * und danach erfahren, dass er nur auf die Warteliste kommt.
     * Wer schon einen Platz hat, sieht keine Warteliste. */
    ticketFrei: (inv.status === "zugesagt" || inv.status === "bezahlt")
      ? TICKET_LIMIT : ticketPlaetzeFrei(),
    ticketNr: inv.status === "zugesagt" || inv.status === "bezahlt" ? inv.ticketNr : "",
    /* Eigene Angaben aus der Zusage - nur der Token-Inhaber sieht sie.
     * Damit oeffnet sich die App aus der Welle-2-Mail fertig personalisiert. */
    phone: (inv.daten && inv.daten.phone) || "",
    diet: (inv.daten && inv.daten.diet) || "",
    allergy: (inv.daten && inv.daten.allergy) || "",
    zahlungMoeglich: !!STRIPE_KEY
  };
}

function findInvite(token) {
  const t = String(token || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return hasOwn(state.invites, t) ? state.invites[t] : null;
}

/* --- CSV --- */
function parseCSV(text) {
  const head = text.split(/\r?\n/, 1)[0] || "";
  const sep = (head.split(";").length > head.split(",").length) ? ";" : ",";
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') { inQuotes = true; }
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else if (c !== "\r") { field += c; }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ""));
}

/* Erwartete Spalten (Reihenfolge egal, Groß/Klein egal):
 *   pool, typ, name, email, firma, rolle, anrede, partner, partner_logo
 * firma und rolle sind getrennt: "gadplan GmbH" und "Geschaeftsfuehrer"
 * lassen sich sonst fuer Namensschilder nicht auseinandernehmen. Fehlt die
 * Spalte 'rolle', bleibt eine vom Gast selbst eingetragene Rolle erhalten.
 * typ: "ticket" (100 € über Stripe) oder "ehrengast" (nur Zusage).
 * Fehlt typ, gilt der Pool-Default aus poolTyp() – sonst "ticket".
 * Wiederholter Import aktualisiert bestehende Gäste (Schlüssel: E-Mail).
 */
function importRows(rows) {
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = name => header.indexOf(name);
  const iPool = col("pool"), iTyp = col("typ"), iName = col("name"),
        iMail = col("email") >= 0 ? col("email") : col("e-mail"), iFirma = col("firma"),
        iAnrede = col("anrede"), iPartner = col("partner"), iPartnerLogo = col("partner_logo"),
        iRolle = col("rolle"),
        /* Optional: Telefon aus der Liste. Fehlt die Spalte, bleibt es beim
         * Bisherigen - niemand muss seine Listen umbauen. */
        iTelefon = col("telefon") >= 0 ? col("telefon") : col("mobil");
  if (iName < 0 || iMail < 0) throw new Error("CSV braucht mindestens die Spalten 'name' und 'email'");

  const byMail = {};
  for (const inv of Object.values(state.invites)) if (inv.email) byMail[inv.email.toLowerCase()] = inv;
  /* WhatsApp-Gaeste (ohne Mailadresse) werden ueber Name+Pool wiedererkannt,
   * damit ein zweiter Import derselben Liste keine Doppelgaenger anlegt -
   * und damit eine spaeter nachgetragene Adresse den Gast UPGRADED statt
   * ihn zu duplizieren (sein Token/Link ist ja evtl. schon verschickt). */
  const byNamePool = {};
  const npKey = (name, pool) => (name || "").toLowerCase().trim() + "|" + (pool || "").toLowerCase().trim();
  for (const inv of Object.values(state.invites)) if (!inv.email) byNamePool[npKey(inv.name, inv.pool)] = inv;

  /* Korrigierte Adressen. Steht in der Liste eine Adresse, die das Register
   * nicht kennt, waehrend genau EIN Gast mit demselben Namen im selben Pool
   * schon eine andere hat, ist das eine Korrektur - kein neuer Mensch.
   * Ohne diesen Griff legt der Import einen Doppelgaenger an: der alte Gast
   * bleibt mit der toten Adresse liegen, der neue kommt dazu, und die
   * Gaestezahl stimmt nicht mehr.
   * Bewusst nur bei GENAU einem Treffer - zwei gleiche Namen im selben Pool
   * waeren geraten, und Raten hat hier nichts zu suchen. Jede Aenderung wird
   * gemeldet, damit sie ein Mensch sieht. */
  const mitMailProNamePool = {};
  for (const inv of Object.values(state.invites)) {
    if (!inv.email) continue;
    (mitMailProNamePool[npKey(inv.name, inv.pool)] ||= []).push(inv);
  }

  let neu = 0, aktualisiert = 0;
  const adressen = [];
  /* Einmal aufgebaut und durchgereicht: sonst vergaebe ein Import mit zwei
   * neuen Gaesten beiden dieselbe freie Nummer, weil der zweite den ersten
   * noch nicht im Register sieht. */
  const belegteNummern = new Set();
  for (const i of Object.values(state.invites)) if (i.ticketNr) belegteNummern.add(i.ticketNr);
  for (const r of rows.slice(1)) {
    const email = clean(r[iMail], 120).toLowerCase();
    const zeilenName = cleanText(r[iName], 60);
    /* Eine Adresse MIT Inhalt aber OHNE @ ist ein Tippfehler - Zeile
     * ueberspringen statt still einen mail-losen Gast anzulegen, der nie
     * eine Einladung bekaeme. Ganz leer + Name vorhanden = WhatsApp-Gast:
     * bekommt Token und Link, faellt aus allen Mailwellen, und traegt
     * seine Adresse selbst nach, sobald er ueber den Link zusagt. */
    if (email && email.indexOf("@") < 0) continue;
    if (!email && !zeilenName) continue;
    const pool = cleanText(iPool >= 0 ? r[iPool] : "", 40) || "Allgemein";
    const typRaw = clean(iTyp >= 0 ? r[iTyp] : "", 20).toLowerCase();
    const typ = (typRaw === "ehrengast" || typRaw === "zusage" || typRaw === "gast des hauses")
      ? "ehrengast" : (typRaw === "ticket" ? "ticket" : poolTyp(pool));

    /* Wiedererkennen: erst ueber die Mailadresse, sonst (auch: Adresse jetzt
     * nachgeliefert) ueber Name+Pool der mail-losen WhatsApp-Gaeste. */
    let inv = (email && byMail[email]) || byNamePool[npKey(zeilenName, pool)];
    /* Adresse geaendert? Dann ist es derselbe Gast - mit seinem Token, seiner
     * Ticketnummer und einer eventuell schon erteilten Zusage. */
    if (!inv && email) {
      const treffer = mitMailProNamePool[npKey(zeilenName, pool)] || [];
      if (treffer.length === 1) inv = treffer[0];
    }
    if (inv) {
      inv.pool = pool; inv.typ = typ;
      inv.name = zeilenName || inv.name;
      if (email && !inv.email) {                     // WhatsApp-Gast bekommt Adresse
        inv.email = email;
        delete byNamePool[npKey(zeilenName, pool)];
        byMail[email] = inv;
      } else if (email && inv.email !== email) {     // Adresse korrigiert
        adressen.push({ name: inv.name, vorher: inv.email, jetzt: email });
        delete byMail[inv.email];
        /* Einmal ist eine Korrektur, zweimal waeren zwei Menschen: nach dem
         * Griff ist der Name+Pool-Schluessel verbraucht. */
        delete mitMailProNamePool[npKey(zeilenName, pool)];
        inv.email = email;
        byMail[email] = inv;
        /* Die neue Adresse hat die Bounce-Sperre der alten nicht verdient. */
        if (inv.mail && inv.mail.bounced) inv.mail.bounced = 0;
      }
      if (iFirma >= 0) inv.firma = cleanText(r[iFirma], 80);
      if (iRolle >= 0) inv.rolle = cleanText(r[iRolle], 80);
      /* Telefon aus der Liste nur setzen, wenn der Gast nicht selbst eine
       * Nummer angegeben hat - seine Angabe ist die neuere. */
      if (iTelefon >= 0 && r[iTelefon] && !(inv.daten && inv.daten.phone)) {
        inv.daten = inv.daten || {};
        inv.daten.phone = cleanText(r[iTelefon], 30);
      }
      if (iAnrede >= 0) inv.anrede = cleanText(r[iAnrede], 12);
      if (iPartner >= 0) inv.partner = cleanText(r[iPartner], 60);
      if (iPartnerLogo >= 0) inv.partnerLogo = cleanText(r[iPartnerLogo], 200);
      aktualisiert++;
    } else {
      const token = newToken();
      inv = state.invites[token] = {
        token, pool, typ,
        name: zeilenName, email,
        firma: iFirma >= 0 ? cleanText(r[iFirma], 80) : "",
        rolle: iRolle >= 0 ? cleanText(r[iRolle], 80) : "",
        anrede: iAnrede >= 0 ? cleanText(r[iAnrede], 12) : "",
        partner: iPartner >= 0 ? cleanText(r[iPartner], 60) : "",
        partnerLogo: iPartnerLogo >= 0 ? cleanText(r[iPartnerLogo], 200) : "",
        status: "offen",
        mail: { sent: 0, delivered: 0, opened: 0, clicked: 0 },
        daten: iTelefon >= 0 && r[iTelefon] ? { phone: cleanText(r[iTelefon], 30) } : {},
        zahlung: null,
        ticketNr: ticketNummerVergeben(token, belegteNummern),
        t: Date.now()
      };
      if (email) byMail[email] = inv;
      else byNamePool[npKey(zeilenName, pool)] = inv;
      neu++;
    }
  }
  dirty = true;
  return { neu, aktualisiert, adressen, gesamt: Object.keys(state.invites).length };
}

/* Pool-Defaults: Ehrengast-Pools brauchen kein Ticket. Namen frei erweiterbar. */
function poolTyp(pool) {
  /* "Partner · …" zaehlt zu den Ehrengaesten: Gaeste eines Partners sind
   * dessen Gaeste und zahlen keine 100 Euro. Faellt die Spalte typ in einer
   * Partnerliste weg, darf daraus kein Zahlgast werden. */
  return /ehrengast|gast des hauses|presse|jury|speaker|kuenstler|künstler|partner/i.test(pool)
    ? "ehrengast" : "ticket";
}

function poolStats() {
  const pools = {};
  /* "Versendet" hat zwei Quellen - genau wie in gesamtStats. Ohne das
   * Versand-Gedaechtnis stand in jeder Poolzeile eine 0, waehrend die
   * Kopfzeile 94 meldete: derselbe Bildschirm, zwei Wahrheiten. */
  const vlog = versandLogLesenGepuffert();
  for (const inv of Object.values(state.invites)) {
    const p = pools[inv.pool] || (pools[inv.pool] = {
      pool: inv.pool, typ: inv.typ, gesamt: 0,
      /* Pools sind nicht sortenrein: in AERA sitzen Ehrengaeste UND
       * Bezahlgaeste. Ein einzelnes typ-Feld (das des ersten Gastes)
       * schrieb ganzen Pools die falsche Rolle zu. */
      ehrengaeste: 0, tickets: 0,
      versendet: 0, geoeffnet: 0, geklickt: 0,
      zugesagt: 0, bezahlt: 0, abgesagt: 0, offen: 0, warteliste: 0, umsatz: 0
    });
    p.gesamt++;
    if (inv.typ === "ehrengast") p.ehrengaeste++; else p.tickets++;
    if (inv.mail.sent || (hasOwn(vlog, inv.token) && Object.keys(vlog[inv.token]).length)) p.versendet++;
    if (inv.mail.opened) p.geoeffnet++;
    if (inv.mail.clicked) p.geklickt++;
    if (inv.status === "zugesagt" || inv.status === "bezahlt") p.zugesagt++;
    if (inv.status === "bezahlt") { p.bezahlt++; p.umsatz += (inv.zahlung && inv.zahlung.amount) || 0; }
    if (inv.status === "abgesagt") p.abgesagt++;
    if (inv.status === "offen") p.offen++;
    if (inv.status === "warteliste") p.warteliste++;
  }
  return Object.values(pools).sort((a, b) => b.gesamt - a.gesamt);
}

function gesamtStats() {
  const all = Object.values(state.invites);
  const zaehl = f => all.filter(f).length;
  /* "Versendet" hat zwei Quellen: den sent-Webhook von Lettermint UND das
   * Versand-Gedaechtnis der CLI (nur lesend). Ohne das Log zeigte der
   * Monitor "0 versendet", obwohl die Welle laengst draussen ist. */
  const vlog = versandLogLesenGepuffert();
  return {
    gesamt: all.length,
    versendet: zaehl(i => i.mail.sent || (hasOwn(vlog, i.token) && Object.keys(vlog[i.token]).length)),
    zugestellt: zaehl(i => i.mail.delivered),
    geoeffnet: zaehl(i => i.mail.opened),
    geklickt: zaehl(i => i.mail.clicked),
    zugesagt: zaehl(i => i.status === "zugesagt" || i.status === "bezahlt"),
    bezahlt: zaehl(i => i.status === "bezahlt"),
    abgesagt: zaehl(i => i.status === "abgesagt"),
    /* Der Deckel fuer Bezahlgaeste - und wer davor wartet. */
    warteliste: zaehl(i => i.status === "warteliste"),
    ticketLimit: TICKET_LIMIT,
    ticketFrei: ticketPlaetzeFrei(),
    unzustellbar: zaehl(i => i.mail.bounced),
    abgemeldet: zaehl(i => i.abgemeldet),
    umsatz: all.reduce((s, i) => s + ((i.zahlung && i.zahlung.amount) || 0), 0)
  };
}

/* Wellenstand fuer den Monitor. Zwei Quellen, beide hart: das Versand-
 * Gedaechtnis (versand-log.json - wer hat Welle n schon bekommen) und
 * dieselbe gilt()-Regel, nach der der Versand entscheidet. Damit steht im
 * Monitor genau das, was ein "welle n --senden" jetzt tun WUERDE - und
 * niemand muss die Wellenzeilen von Hand pflegen.
 *   versendet  hat die Welle bekommen (Log)
 *   faellig    bekaeme sie beim naechsten Lauf
 *   gesperrt   gehoert in die Welle, ist aber nicht anschreibbar
 *              (keine Adresse, abgemeldet oder Bounce) */
function wellenStats() {
  const vlog = versandLogLesenGepuffert();
  const all = Object.values(state.invites);
  return Object.keys(WELLEN).map(nr => {
    const w = WELLEN[nr];
    let versendet = 0, faellig = 0, gesperrt = 0, erster = 0, letzter = 0, ueberholt = 0;
    /* Die Reaktionen zaehlen JE WELLE - fruehere Zahlen mischten alle
     * Mailings in einen Topf und lasen sich dadurch falsch. */
    let zugestellt = 0, geoeffnet = 0, geklickt = 0, zugesagt = 0, bezahlt = 0;
    for (const inv of all) {
      const ts = (hasOwn(vlog, inv.token) && vlog[inv.token][nr]) || 0;
      if (ts) {
        versendet++;
        if (!erster || ts < erster) erster = ts;
        if (ts > letzter) letzter = ts;
        const w2 = (inv.wellen && inv.wellen[nr]) || null;
        if (w2 && w2.delivered) zugestellt++;
        if (w2 && w2.opened)    geoeffnet++;
        if (w2 && w2.clicked)   geklickt++;
        /* Zusage und Zahlung gehoeren keiner einzelnen Mail - hier zaehlen
         * sie den heutigen Stand DERER, die diese Welle bekommen haben.
         * So laesst sich lesen: "von den 62 Eingeladenen haben 16 zugesagt". */
        if (inv.status === "zugesagt" || inv.status === "bezahlt") zugesagt++;
        if (inv.status === "bezahlt") bezahlt++;
        continue;                                  // raus ist raus
      }
      if (!w.gilt(inv)) continue;                  // gehoert nicht in diese Welle
      if (!inv.email || inv.abgemeldet || (inv.mail && inv.mail.bounced)) { gesperrt++; continue; }
      /* Wer schon eine SPAeTERE Welle bekommen hat, ist fuer diese hier
       * durch. Sonst stuende bei "Save the Date" auf ewig "41 faellig" -
       * fuer Gaeste, die laengst ihre Einladung haben. Ein Nachlauf haette
       * ihnen nach der Einladung noch die Vorankuendigung geschickt. */
      const spaeter = hasOwn(vlog, inv.token) &&
        Object.keys(vlog[inv.token]).some(n => Number(n) > Number(nr) && vlog[inv.token][n]);
      if (spaeter) ueberholt++;
      else faellig++;
    }
    return { nr: Number(nr), name: w.name, versendet, faellig, gesperrt, ueberholt, erster, letzter,
             zugestellt, geoeffnet, geklickt, zugesagt, bezahlt };
  });
}

/* Welche Fassung ist wie gelaufen. Gruppiert die Gaeste nach der Vorlage,
 * die sie in der jeweiligen Welle bekommen haben (Welle 1 zerfaellt in
 * Ticket / Ehrengast / Ehrengast-Partner).
 * ACHTUNG bei der Deutung: geoeffnet/geklickt/zugesagt/bezahlt sind der
 * HEUTIGE Stand des Gastes, nicht die Reaktion auf genau diese eine Mail -
 * das Register fuehrt pro Gast einen Stand, nicht pro Sendung. Wer zwei
 * Wellen bekommen hat, zaehlt in beiden Gruppen. Der Monitor schreibt das
 * unter die Tabelle dazu. */
function fassungStats() {
  const vlog = versandLogLesenGepuffert();
  const gruppen = {};
  for (const inv of Object.values(state.invites)) {
    if (!hasOwn(vlog, inv.token)) continue;
    for (const nr of Object.keys(WELLEN)) {
      if (!vlog[inv.token][nr]) continue;
      let datei;
      try { datei = WELLEN[nr].vorlage(inv); } catch (e) { continue; }
      const key = nr + "|" + datei;
      const g = gruppen[key] || (gruppen[key] = {
        welle: Number(nr), name: WELLEN[nr].name, vorlage: datei,
        versendet: 0, geoeffnet: 0, geklickt: 0, zugesagt: 0, bezahlt: 0, ticket: false
      });
      g.versendet++;
      const wm = (inv.wellen && inv.wellen[nr]) || {};
      if (wm.opened)  g.geoeffnet++;
      if (wm.clicked) g.geklickt++;
      if (inv.status === "zugesagt" || inv.status === "bezahlt") g.zugesagt++;
      if (inv.status === "bezahlt") g.bezahlt++;
      if (inv.typ !== "ehrengast") g.ticket = true;      // in dieser Fassung wird gezahlt
    }
  }
  return Object.values(gruppen).sort((a, b) => a.welle - b.welle || b.versendet - a.versendet);
}

/* ================= MAILVERSAND (Lettermint, ohne SDK) =================
 *
 * Warum der Server selbst verschickt und nicht Lettermint aus einer Liste:
 * Jede Mail traegt einen persoenlichen Link, eine Ticketnummer und - bei
 * Partnergaesten - das Logo des einladenden Partners. Diese Zuordnung liegt
 * hier im Register. Ginge sie ueber eine hochgeladene CSV, koennte sie beim
 * naechsten Import verrutschen: der falsche Gast bekaeme den Link eines
 * anderen und saehe dessen Daten. Deshalb: eine Quelle, kein Umweg.
 */

/* Bilder in E-Mails brauchen feste, oeffentliche Adressen (kein data:). */
/* Bilder liefert der Server mit 30 Tagen Cache aus - richtig fuer Gaeste,
 * falsch waehrend wir noch an den Logos arbeiten: die Adresse bleibt gleich,
 * also holt kein Browser und kein Mail-Proxy die neue Datei. Deshalb haengt
 * an jeder Asset-Adresse ein Kuerzel aus dem INHALT der Datei. Aendert sich
 * die Datei, aendert sich die Adresse; bleibt sie gleich, bleibt der Cache.
 * Einmal beim Start berechnet - im Versand laufen sonst 90 Mails x 8 Bilder. */
const ASSET_STEMPEL = {};
function assetStempel(datei) {
  if (hasOwn(ASSET_STEMPEL, datei)) return ASSET_STEMPEL[datei];
  let v = "";
  try {
    v = crypto.createHash("sha1").update(fs.readFileSync(path.join(__dirname, "..", "email", "assets", datei)))
              .digest("hex").slice(0, 8);
  } catch (e) { /* Datei fehlt: dann eben ohne Kuerzel - der Fehler faellt beim Abruf auf */ }
  return (ASSET_STEMPEL[datei] = v);
}
function assetUrl(datei) {
  const v = assetStempel(datei);
  return PUBLIC_URL + "/assets/" + datei + (v ? "?v=" + v : "");
}

/* Partnerlogo als vollstaendige Adresse. In der Gaesteliste darf beides
   stehen: eine fertige URL oder nur der Dateiname aus email/assets/.
   Beide Ausgabewege - Mail UND Landing Page - muessen dieselbe Regel
   anwenden, sonst zeigt die Mail das Logo und die Seite ein kaputtes Bild. */
function partnerLogoUrl(inv) {
  if (!inv || !inv.partnerLogo) return "";
  const roh = inv.partnerLogo;
  if (!/^https?:\/\//i.test(roh)) return assetUrl(roh);
  /* Zeigt die fertige Adresse auf unsere eigenen Assets - so steht es in der
   * Gaesteliste -, dann durch assetUrl schicken, damit sie das Kuerzel
   * bekommt. Sonst haenge das Logo eines Partners am 30-Tage-Cache fest. */
  const eigen = roh.split("?")[0].match(/^https?:\/\/[^/]+\/assets\/(.+)$/i);
  return eigen ? assetUrl(eigen[1]) : roh;
}

/* Die Wellen. Zu jeder gehoert: wer sie bekommt, welche Vorlage gilt
 * (Partnergaeste bekommen eine eigene mit dem Logo ihres Gastgebers) und
 * welcher Betreff in der Inbox steht. */
/* Die Betreffs sind Du-Form wie die Vorlagen selbst - ein "Ihre Einladung"
 * ueber einem "Du bist eingeladen" waere ein Stilbruch in derselben Mail.
 * Doppelversand verhindert nicht gilt(), sondern das Versand-Gedaechtnis
 * (versand-log.json, siehe CLI): gilt() beschreibt nur, wer fachlich passt. */
const WELLEN = {
  0: {
    name: "Welle 0 · Save the Date",
    /* Alle ausser Absagen - wer abgesagt hat, braucht kein "halte dir den
     * Abend frei" mehr. BEWUSST eine Fassung fuer alle, auch Ehrengaeste
     * (Entscheidung der Runde, 12.08.): die Zeile "Teilnahme: 100 Euro"
     * bleibt drin, wer nicht zahlt, wird vom Team persoenlich informiert.
     * Die Unterscheidung ticket/ehrengast greift erst ab Welle 1. */
    gilt: inv => inv.status !== "abgesagt",
    vorlage: inv => "save-the-date.html",
    betreff: inv => "Save the Date · THE CIRCLE No1, 16. September 2026"
  },
  1: {
    name: "Welle 1 · Einladung",
    /* Wer schon zu- oder abgesagt hat, braucht keine Einladung mehr. */
    gilt: inv => inv.status === "offen",
    /* Wer ein Partner eingeladen hat, ist GAST DES PARTNERS: sein Logo steht
     * in der Mail, und er zahlt nichts (Entscheidung Desi/Nicole, 19.08.).
     * Bezahlgaeste kommen aus dem eigenen Netzwerk - dort waere ein fremdes
     * Logo falsch, sie bekommen deshalb nie eine Partner-Fassung. */
    vorlage: inv => inv.typ === "ehrengast"
      ? ((inv.partner && inv.partnerLogo) ? "einladung-ehrengast-partner.html" : "einladung-ehrengast.html")
      : "einladung-ticket.html",
    betreff: inv => "Deine Einladung zu THE CIRCLE No1"
  },
  2: {
    name: "Welle 2 · App-Zugang",
    /* Nur an wirklich bestaetigte Gaeste - der App-Link zeigt persoenliche
     * Daten. Ehrengaeste sind mit der Zusage bestaetigt; Ticketgaeste erst
     * mit der Zahlung, sonst bekaeme ein unbezahltes Ticket den Zugang
     * "samt Ticketnummer" geschenkt. */
    gilt: inv => inv.typ === "ehrengast" ? inv.status === "zugesagt" || inv.status === "bezahlt"
                                         : inv.status === "bezahlt",
    vorlage: inv => (inv.partner && inv.partnerLogo) ? "app-zugang-partner.html" : "app-zugang.html",
    betreff: inv => "THE CIRCLE No1 · Dein Zugang zum Abend"
  }
};

/* Die Abmelde-Seiten im CI der uebrigen Seiten: Navy-Grund, Kapitalis-
 * Headline (Cinzel per Google Fonts, Georgia-Fallback wie in den Mails),
 * Koralle, Logo. Drei Zustaende: "frage" (Bestaetigungs-Knopf), "fertig",
 * "ungueltig". Der Token stammt aus findInvite und ist damit [A-Za-z0-9_-]. */
function abmeldeSeite(art, token) {
  const inhalt = art === "frage"
    ? '<h1>Abmelden?</h1>' +
      '<p>Ein Druck auf den Knopf, und du bekommst keine weiteren E-Mails zu THE CIRCLE No1.<br>' +
      'Eine bestehende Zusage bleibt davon unber&uuml;hrt.</p>' +
      '<form method="post" action="/abmelden?t=' + token + '"><button type="submit">Abmelden</button></form>'
    : art === "fertig"
      ? '<h1>Abgemeldet</h1><p>Du erh&auml;ltst keine weiteren E-Mails zu THE CIRCLE No1.<br>Danke, dass du uns Bescheid gegeben hast.</p>'
      : '<h1>Link nicht mehr g&uuml;ltig</h1><p>Dieser Abmeldelink ist nicht mehr g&uuml;ltig.<br>Schreib uns gern kurz &ndash; dann tragen wir dich von Hand aus.</p>';
  return '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>' + (art === "frage" ? "Abmelden" : art === "fertig" ? "Abgemeldet" : "Link ungültig") + ' · THE CIRCLE</title>' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600&family=Montserrat:wght@300;500&display=swap" rel="stylesheet">' +
    '<style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{background:#122648;color:#f8f7f4;font-family:Montserrat,"Avenir Next",Helvetica,Arial,sans-serif;font-weight:300;' +
    'min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.75}' +
    '.box{max-width:30rem;padding:3rem 1.6rem}' +
    '.logo{width:120px;height:auto;opacity:.92;margin-bottom:1.8rem}' +
    'h1{font-family:Cinzel,"Trajan Pro 3",Georgia,serif;font-weight:600;letter-spacing:.08em;text-transform:uppercase;' +
    'font-size:clamp(1.5rem,6vw,2.1rem);color:#ff6b6c;margin-bottom:1.2rem;line-height:1.2}' +
    'p{font-size:.95rem;color:#dfe4ef}' +
    'button{margin-top:1.5rem;background:#ff6b6c;color:#fff;border:0;border-radius:999px;padding:.95rem 2.6rem;' +
    'font-family:Montserrat,Helvetica,Arial,sans-serif;font-weight:500;font-size:.78rem;letter-spacing:.22em;' +
    'text-transform:uppercase;cursor:pointer}' +
    'button:hover{background:#e85c5d}' +
    '.hr{width:44px;height:1px;background:rgba(248,247,244,.35);margin:1.6rem auto}' +
    '.foot{font-size:.6rem;letter-spacing:.24em;text-transform:uppercase;color:#7d90b8}' +
    '</style></head><body><div class="box">' +
    '<img class="logo" src="/assets/logo-zentriert-neg.png" alt="THE CIRCLE">' +
    inhalt +
    '<div class="hr"></div>' +
    '<div class="foot">16. September 2026 · Playa · Köln</div>' +
    '</div></body></html>';
}

/* Versand-Gedaechtnis der CLI - bewusst eine EIGENE Datei, nie live-state.json.
 * Die laufende App haelt den kompletten Zustand im Speicher und schreibt ihn
 * alle 2 s ganz weg; ein CLI-Prozess, der dieselbe Datei schriebe, wuerfe
 * deren frische Zusagen, Allergien und Zahlungen weg - und die App im
 * Gegenzug seine Versand-Marker. Getrennte Dateien, getrennte Schreiber:
 * die App fasst dieses Log nie an, die Versand-CLI fasst live-state.json nie
 * an. "Versendet/zugestellt/geoeffnet" im Monitor kommt ueber die
 * Lettermint-Webhooks in den laufenden Prozess.
 * Format: { "<token>": { "0": ts, "1": ts, "2": ts } }  je Welle einmal. */
const VERSAND_LOG = path.join(__dirname, "versand-log.json");
function versandLogLesen() {
  /* Nur "Datei gibt es noch nicht" ist harmlos. Eine UNLESBARE Datei darf
   * nicht stillschweigend zu {} werden - sonst kaeme der Massen-
   * Doppelversand genau dann zurueck, wenn das Gedaechtnis kaputt ist. */
  try { return JSON.parse(fs.readFileSync(VERSAND_LOG, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT") return {};
    console.error("Versand-Gedächtnis " + VERSAND_LOG + " ist unlesbar: " + e.message);
    console.error("Kein Versand, sonst ginge die Welle wieder an ALLE. Datei prüfen oder wiederherstellen.");
    process.exit(1);
  }
}
function versandLogSchreiben(log) {
  /* tmp + rename: ein Abbruch mitten im Schreiben darf das Gedaechtnis
   * nicht zerstoeren - sonst ginge die naechste Welle wieder an alle. */
  fs.writeFileSync(VERSAND_LOG + ".tmp", JSON.stringify(log));
  fs.renameSync(VERSAND_LOG + ".tmp", VERSAND_LOG);
}

/* Das Versand-Gedaechtnis gehoert der CLI; der Server liest es nur - aber
 * er liest es oft (jeder Webhook fragt, zu welcher Welle das Ereignis
 * gehoert). Deshalb kurz gepuffert. */
let vlogCache = { t: 0, daten: {} };
function versandLogLesenGepuffert() {
  const jetzt = Date.now();
  if (jetzt - vlogCache.t < 5000) return vlogCache.daten;
  let daten = {};
  try { daten = JSON.parse(fs.readFileSync(VERSAND_LOG, "utf8")); } catch (e) { /* kein Log */ }
  vlogCache = { t: jetzt, daten };
  return daten;
}

/* ---------- Status JE WELLE ----------
 *
 * Warum das sein muss: inv.mail fuehrt EINEN Satz Zeitstempel
 * (sent/delivered/opened/clicked) - aber es gibt drei Mailings. Und jeder
 * Schreibzugriff galt "nur wenn noch leer". Ergebnis im Betrieb: hat ein
 * Gast das Save the Date geoeffnet, sind seine Felder belegt; die
 * Einladung eine Woche spaeter kann sie nicht mehr fuellen. Ihr
 * "zugestellt/geoeffnet/geklickt" wurde verworfen ("schon gesetzt"), im
 * Monitor stand weiter der Stand des Save the Date - und es sah aus, als
 * lieferte Lettermint keine Webhooks mehr.
 *
 * Die Zuordnung war immer da, sie wurde nur weggeworfen: der Versand gibt
 * jeder Mail metadata.welle mit, Lettermint gibt es im Webhook zurueck.
 * inv.wellen[n] fuehrt jetzt die einzelne Sendung, inv.mail bleibt als
 * Gesamtsicht ("hat der Gast ueberhaupt je geoeffnet") unveraendert - alle
 * bisherigen Leser, Bounce-Sperre und Abmeldung eingeschlossen. */
function wellenMail(inv, n) {
  inv.wellen = inv.wellen || {};
  return inv.wellen[n] || (inv.wellen[n] = { sent: 0, delivered: 0, opened: 0, clicked: 0 });
}

/* Zu welcher Welle gehoert ein Ereignis ohne metadata.welle? Zur zuletzt
 * verschickten Welle, die VOR dem Ereignis rausging - das ist die Mail, die
 * der Gast in dem Moment vor sich hatte. */
function welleZuZeit(inv, ts) {
  const log = versandLogLesenGepuffert()[inv.token];
  if (!log) return "";
  let treffer = "", besteZeit = 0;
  for (const n of Object.keys(log)) {
    const raus = log[n];
    if (raus && raus <= ts + 60_000 && raus >= besteZeit) { besteZeit = raus; treffer = n; }
  }
  return treffer;
}

/* Einmal beim Start: den alten Sammel-Stand auf die Wellen aufteilen, damit
 * nichts verloren geht, was schon im Register steht. Je FELD einzeln - die
 * Felder koennen zu verschiedenen Wellen gehoeren (Save the Date verschickt,
 * nie geoeffnet, dann die Einladung geoeffnet: sent gehoert zu Welle 0,
 * opened zu Welle 1). Der Versandzeitpunkt je Welle kommt ohnehin aus dem
 * Gedaechtnis, nicht aus dem Webhook. */
function wellenNachruesten() {
  const log = versandLogLesenGepuffert();
  let ergaenzt = 0;
  for (const inv of Object.values(state.invites)) {
    if (inv.wellen) continue;                       // schon aufgeteilt
    inv.wellen = {};
    for (const n of Object.keys(log[inv.token] || {})) wellenMail(inv, n).sent = log[inv.token][n];
    for (const feld of ["delivered", "opened", "clicked"]) {
      const ts = inv.mail && inv.mail[feld];
      if (!ts) continue;
      const n = welleZuZeit(inv, ts);
      if (n !== "") wellenMail(inv, n)[feld] = ts;
    }
    ergaenzt++;
  }
  if (ergaenzt) {
    dirty = true;
    console.log("Status je Welle nachgetragen: " + ergaenzt + " Gäste");
  }
}

/* Vorlagen einmal von der Platte lesen und behalten. */
const vorlagenCache = new Map();
function vorlageLesen(datei) {
  if (!vorlagenCache.has(datei)) {
    vorlagenCache.set(datei, fs.readFileSync(path.join(ROOT, "email", datei), "utf8"));
  }
  return vorlagenCache.get(datei);
}

/* HTML-Escape fuer alles, was aus der Gaesteliste in die Mail wandert.
 * Ein Firmenname wie "Falk & Cie" darf die Vorlage nicht zerlegen. */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* Alle Platzhalter einer Vorlage fuer genau einen Gast fuellen. */
function renderMail(inv, datei) {
  const werte = {
    anrede: inv.anrede || "Hallo",
    name: inv.name || "",
    vorname: (inv.name || "").split(" ")[0],
    link: inviteLink(inv.token),
    app_link: appLink(inv.token),
    ticket_nr: inv.ticketNr || "",
    platz_satz: platzSatz(inv),
    partner_name: inv.partner || "",
    /* Partnerlogos liegen als absolute URL in der Gaesteliste; ein relativer
     * Dateiname wird auf unsere Asset-Adresse gehoben. */
    partner_logo_url: partnerLogoUrl(inv),
    abmelden_url: abmeldeLink(inv.token),
    rueckmeldung_datum: rsvpFrist(inv),
    /* Nur fuer die Zusage-Bestaetigung: der Kalendereintrag und der Beitrag,
     * den der Gast bezahlt hat. */
    termin_ics_url: PUBLIC_URL + "/termin.ics",
    beitrag: (preisVon(inv) / 100).toFixed(2).replace(".", ",") + " Euro",
    /* CTA der Welle 0: die Homepage, nicht die App. PUBLIC_URL ist der
     * Server mit den persoenlichen Links - die Website ist eine andere. */
    website_url: WEBSITE_URL,
    header_img_url: assetUrl("circle-header.jpg"),
    /* Standen bis eben als feste Adresse in den Vorlagen und blieben damit
     * als einzige ohne Cache-Kuerzel haengen. */
    header_std_url: assetUrl("circle-header-std.jpg"),
    planyvo_logo_url: assetUrl("planyvo-neg.png"),
    logo_url: assetUrl("logo-zentriert-neg.png"),
    partnerwand_url: assetUrl("partnerwand-bordeaux.jpg"),
    portrait_amiaz_url: assetUrl("portrait-amiaz.jpg"),
    portrait_ien_url: assetUrl("portrait-ien.jpg"),
    portrait_max_url: assetUrl("portrait-max.jpg")
  };
  const roh = vorlageLesen(datei);
  /* Unbekannte Platzhalter am ROHEN Template pruefen, nicht am Ergebnis:
   * Gastdaten koennten "{{...}}" enthalten (Altbestand vor dem cleanText-
   * Filter) - am fertigen HTML gemessen saehe das wie ein Vorlagenfehler aus
   * und wuerde die ganze Welle abbrechen. Am Template gemessen bleibt der
   * Abbruch echten Tippfehlern vorbehalten. */
  const offen = [...new Set((roh.match(/\{\{[a-z_]+\}\}/g) || [])
    .filter(p => !hasOwn(werte, p.slice(2, -2))))];
  if (offen.length) throw new Error(datei + ": unbekannte Platzhalter " + offen.join(", "));
  return roh.replace(/\{\{([a-z_]+)\}\}/g, (ganz, schluessel) => esc(werte[schluessel]));
}

/* Reine Textfassung als Rueckfallebene: Mail-Clients ohne HTML und
 * Spamfilter, die HTML-only misstrauisch finden. */
/* Bestaetigung nach der Zusage. Anders als die Wellen loest sie kein Mensch
 * aus, sondern der Gast selbst - Ehrengaeste mit ihrer Zusage, Bezahlgaeste
 * mit der eingegangenen Zahlung. Deshalb verschickt sie der laufende Server
 * und nicht die Kommandozeile; dafuer braucht die App LETTERMINT_TOKEN.
 *
 * Genau einmal je Gast: der Vermerk steht VOR dem Versand im Register, sonst
 * schickt ein zweites Abschicken des Formulars eine zweite Mail. Scheitert
 * der Versand, wird er zurueckgenommen, damit ein spaeterer Anlauf ihn holt.
 * Fehler bleiben folgenlos fuer den Gast: seine Zusage ist da, ob die
 * Bestaetigung ankam oder nicht. */
function bestaetigungFaellig(inv) {
  if (!inv || !inv.email || inv.bestaetigung || inv.abgemeldet) return false;
  /* Ehrengaeste sind mit der Zusage fertig. Bezahlgaeste erst mit der Zahlung:
   * "Platz gesichert - 100 Euro bezahlt" an jemanden zu schicken, der nur
   * zugesagt hat, waere schlicht falsch. */
  return inv.typ === "ehrengast"
    ? (inv.status === "zugesagt" || inv.status === "bezahlt")
    : inv.status === "bezahlt";
}

function bestaetigungSenden(inv) {
  if (!LETTERMINT_TOKEN) return;                 // App ohne Token: still nichts tun
  if (!bestaetigungFaellig(inv)) return;
  inv.bestaetigung = Date.now();                 // Platz belegen, BEVOR irgendetwas laeuft
  dirty = true;
  bestaetigungAbschicken(inv);
}

/* Setzt voraus, dass der Vermerk schon steht - siehe bestaetigungSenden und
 * den Nachhol-Endpunkt. Getrennt, damit ein Stapel ALLE Vermerke sofort
 * setzen kann und nicht erst beim Abschicken der einzelnen Mail: sonst
 * faende ein zweiter Aufruf dieselben Gaeste noch einmal. */
function bestaetigungAbschicken(inv) {
  const datei = inv.typ === "ehrengast"
    ? ((inv.partner && inv.partnerLogo) ? "bestaetigung-ehrengast-partner.html" : "bestaetigung-ehrengast.html")
    : "bestaetigung-ticket.html";
  let html;
  try { html = renderMail(inv, datei); }
  catch (e) {
    /* Vermerk zurueck: er steht seit dem Aufruf, und ohne Ruecknahme gaelte
     * der Gast als bestaetigt, ohne je eine Mail bekommen zu haben. */
    inv.bestaetigung = 0; dirty = true;
    console.error("Bestätigung " + datei + " bricht: " + e.message);
    return;
  }

  const text = [
    (inv.anrede || "Hallo") + " " + ((inv.name || "").split(" ")[0] || "") + ",",
    "",
    "du bist im Kreis" + (inv.ticketNr ? " – " + inv.ticketNr : "") + ".",
    "",
    "16. September 2026, 18:00 bis 23:00 Uhr",
    "Playa Cologne, Junkersdorfer Str. 1, 50933 Köln",
    inv.typ === "ticket" ? "Beitrag: " + (preisVon(inv) / 100).toFixed(2).replace(".", ",") + " Euro, bezahlt" : null,
    "",
    "Termin in den Kalender: " + PUBLIC_URL + "/termin.ics",
    "Deine Seite: " + inviteLink(inv.token),
    "",
    "Keine weiteren Mails: " + abmeldeLink(inv.token)
  ].filter(z => z !== null).join("\n");

  lettermintSenden({
    to: inv.email,
    subject: inv.typ === "ticket" ? "Dein Platz bei THE CIRCLE No1 ist gesichert"
                                  : "Deine Zusage zu THE CIRCLE No1",
    html, text,
    abmeldeUrl: abmeldeLink(inv.token),
    metadata: { token: inv.token, art: "bestaetigung", pool: inv.pool || "" }
  }, (err) => {
    if (err) {
      inv.bestaetigung = 0; dirty = true;        // beim naechsten Anlass neu versuchen
      console.error("Bestätigung an " + inv.email + " fehlgeschlagen: " + err.message);
    } else {
      console.log("Bestätigung an " + inv.email + " verschickt.");
    }
  });
}

function textFassung(inv, welle) {
  /* Welle 0 hat bewusst KEINEN persoenlichen Link - die HTML-Fassung zeigt
   * nur die Website, also darf die Textfassung nicht heimlich den Zusage-
   * Link (samt Ticketnummer) vorwegnehmen. Du-Form wie die Vorlagen.
   * null = Zeile faellt weg; "" = gewollte Leerzeile. */
  const zeilen = [
    (inv.anrede || "Hallo") + " " + ((inv.name || "").split(" ")[0] || "") + ",",
    "",
    "THE CIRCLE No1 - connecting generations",
    "16. September 2026, 18:00 bis 23:00 Uhr, Playa in der Kölner Südstadt",
    "",
    welle === 0 ? "Alle Informationen: " + WEBSITE_URL
      : "Dein persönlicher Link: " + (welle === 2 ? appLink(inv.token) : inviteLink(inv.token)),
    welle === 2 && inv.ticketNr ? "Deine Ticketnummer: " + inv.ticketNr : null,
    "",
    "Keine weiteren Mails: " + abmeldeLink(inv.token)
  ];
  return zeilen.filter(z => z !== null).join("\n");
}

/* Dieselbe Einladung als WhatsApp-Nachricht, zum Kopieren. Kein HTML, keine
 * Abmeldezeile: Wer per WhatsApp schreibt, hat den Kontakt ohnehin in der
 * Hand. Der Link ist derselbe wie in der Mail - die Zusage landet also im
 * selben Register, mit derselben Ticketnummer. */
function whatsappText(inv) {
  const partnerZeile = inv.typ === "ehrengast"
    ? (inv.partner ? "Du bist eingeladen von unserem Partner " + inv.partner + "."
                   : "Du bist eingeladen von THE CIRCLE.")
    : "Teilnahme: 100 Euro.";
  return [
    (inv.anrede || "Hallo") + " " + ((inv.name || "").split(" ")[0] || "") + ",",
    "",
    "du bist eingeladen zu THE CIRCLE No1 – connecting generations.",
    "",
    "Ein Abend im ausgewählten Kreis: Gäste über Generationen hinweg, " +
      "ein Menü in drei Gängen – und ein Werk von Max Leinfelder, das vor deinen Augen entsteht.",
    "",
    "16. September 2026, 18:00 bis 23:00 Uhr",
    "Playa Cologne, Junkersdorfer Str. 1, 50933 Köln",
    partnerZeile,
    "",
    "Die Plätze sind limitiert. Wir bitten um Rückmeldung bis zum " + rsvpFrist(inv) + ".",
    "",
    "Dein persönlicher Link – zusagen oder absagen dauert eine Minute:",
    inviteLink(inv.token)
  ].join("\n");
}

/* Ein Aufruf an die Lettermint-API. Kein SDK: eine einzige POST-Anfrage
 * gegen /v1/send, Authentifizierung ueber den Header x-lettermint-token. */
function lettermintSenden(mail, cb) {
  if (!LETTERMINT_TOKEN) return cb(new Error("LETTERMINT_TOKEN fehlt"));
  const nutzlast = {
    from: MAIL_FROM,
    to: [mail.to],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    metadata: mail.metadata || {}
  };
  if (MAIL_ROUTE) nutzlast.route = MAIL_ROUTE;
  if (MAIL_REPLY_TO) nutzlast.reply_to = [MAIL_REPLY_TO];
  /* Oeffnungen/Klicks explizit messen lassen - ohne diese Einstellung
   * haengt es am Konto-Default, und der Monitor bliebe ggf. stumm. */
  nutzlast.settings = { track_opens: true, track_clicks: true };
  /* One-Click-Abmeldung (RFC 8058): Gmail und Outlook zeigen dafuer den
   * eigenen Abmelden-Knopf und verlangen die Header bei Bulk-Absendern -
   * fuer eine junge Domain bares Geld in der Zustellbarkeit. Der Klient
   * schickt dann ein POST auf /abmelden, das der Server versteht. */
  if (mail.abmeldeUrl) nutzlast.headers = {
    "List-Unsubscribe": "<" + mail.abmeldeUrl + ">",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
  };
  const body = Buffer.from(JSON.stringify(nutzlast), "utf8");
  const req = https.request({
    hostname: "api.lettermint.co",
    path: "/v1/send",
    method: "POST",
    headers: {
      "x-lettermint-token": LETTERMINT_TOKEN,
      "Content-Type": "application/json",
      "Content-Length": body.length
    }
  }, r => {
    let raw = "";
    r.on("data", c => raw += c);
    r.on("end", () => {
      let data = null;
      try { data = JSON.parse(raw || "{}"); } catch (e) { /* Text-Antwort */ }
      if (r.statusCode >= 400) {
        const grund = (data && (data.message || data.error)) || raw.slice(0, 200) || ("HTTP " + r.statusCode);
        return cb(new Error("Lettermint " + r.statusCode + ": " + grund));
      }
      cb(null, data || {});
    });
  });
  req.on("error", cb);
  req.write(body);
  req.end();
}

/* Signatur der Lettermint-Webhooks. Ohne diese Pruefung koennte jeder
 * "delivered" und "opened" in unser Register schreiben und die Zahlen im
 * Monitor faelschen - oder mit erfundenen Adressen darin herumstochern.
 *
 * Lettermint signiert im Stripe-Stil (Quelle: lettermint.co/docs/platform/
 * webhooks/signing, live gegen den Test-Event verifiziert):
 *   Header X-Lettermint-Signature: "t={timestamp},v1={hmac_hex}"
 *   hmac_hex = HMAC-SHA256(secret, "{timestamp}.{rawBody}")
 * Das Secret geht KOMPLETT ein, mitsamt "whsec_"-Praefix. */
function lettermintWebhookGueltig(headers, rawBuf) {
  if (!LETTERMINT_WEBHOOK_SECRET) return false;
  const kopf = String(headers["x-lettermint-signature"] || "");
  if (!kopf) return false;
  const teile = {};
  for (const p of kopf.split(",")) {
    const i = p.indexOf("=");
    if (i > 0) (teile[p.slice(0, i).trim()] ||= []).push(p.slice(i + 1).trim());
  }
  const ts = teile.t && teile.t[0];
  if (!ts || !teile.v1) return false;
  const tsNum = Number(ts);
  /* Replay-Schutz: alte Mitschnitte laufen ab (wie beim Stripe-Webhook).
   * Lettermint schickt den Timestamp in Sekunden. */
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false;
  const erwartet = crypto.createHmac("sha256", LETTERMINT_WEBHOOK_SECRET)
    .update(ts + ".").update(rawBuf).digest("hex");
  const a = Buffer.from(erwartet, "utf8");
  return teile.v1.some(v => {
    const b = Buffer.from(v.toLowerCase(), "utf8");
    return b.length === a.length && crypto.timingSafeEqual(a, b);
  });
}

/* Fangschaltung: die letzten Webhook-Eingaenge im Speicher, fuer
 * /api/admin/webhook-log. Kein Persistieren, kein Secret-Inhalt - nur was
 * zum Diagnostizieren noetig ist. */
const webhookLog = [];
function webhookMerken(eintrag) {
  webhookLog.unshift(eintrag);
  if (webhookLog.length > 30) webhookLog.pop();
}

/* ================= STRIPE (ohne SDK, reine HTTPS-Aufrufe) ================= */

/* Verschachtelte Parameter form-encodieren: {a:{b:1}} -> a[b]=1 */
function formEncode(obj, prefix, out) {
  out = out || [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? prefix + "[" + k + "]" : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(v));
  }
  return out.join("&");
}

function stripeRequest(pfad, params, cb) {
  if (!STRIPE_KEY) return cb(new Error("STRIPE_SECRET_KEY fehlt"));
  const body = formEncode(params);
  const req = https.request({
    hostname: "api.stripe.com",
    path: "/v1/" + pfad,
    method: "POST",
    headers: {
      "Authorization": "Bearer " + STRIPE_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
      "Stripe-Version": "2024-06-20"
    }
  }, r => {
    let raw = "";
    r.on("data", c => raw += c);
    r.on("end", () => {
      let data;
      try { data = JSON.parse(raw); } catch (e) { return cb(new Error("Stripe-Antwort unlesbar")); }
      if (r.statusCode >= 400) return cb(new Error((data.error && data.error.message) || "Stripe-Fehler"));
      cb(null, data);
    });
  });
  req.on("error", cb);
  req.write(body);
  req.end();
}

function createCheckout(inv, cb) {
  const arten = {};
  if (STRIPE_ZAHLARTEN[0] !== "auto") STRIPE_ZAHLARTEN.forEach((a, i) => { arten[i] = a; });
  stripeRequest("checkout/sessions", {
    mode: "payment",
    locale: "de",
    ...(Object.keys(arten).length ? { payment_method_types: arten } : {}),
    customer_email: inv.email,
    client_reference_id: inv.token,
    success_url: inviteLink(inv.token) + "&bezahlt=1",
    cancel_url: inviteLink(inv.token),
    metadata: { token: inv.token, pool: inv.pool, name: inv.name },
    payment_intent_data: {
      description: "THE CIRCLE N°1 · 16.09.2026 · " + inv.name,
      metadata: { token: inv.token, pool: inv.pool }
    },
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: preisVon(inv),
          product_data: {
            name: "THE CIRCLE N°1 – 16. September 2026",
            description: "Persönliche Einladung · 1 Platz · Playa Cologne"
          }
        }
      }
    }
  }, cb);
}

/* Webhook-Signatur nach Stripe-Schema: HMAC-SHA256 über "timestamp.payload" */
function webhookGueltig(sigHeader, rawBody) {
  if (!STRIPE_WEBHOOK_SECRET) return false;
  const teile = {};
  for (const p of String(sigHeader || "").split(",")) {
    const i = p.indexOf("=");
    if (i > 0) (teile[p.slice(0, i).trim()] ||= []).push(p.slice(i + 1).trim());
  }
  const ts = teile.t && teile.t[0];
  if (!ts || !teile.v1) return false;
  const tsNum = Number(ts);
  // Nicht-numerischer Timestamp: Math.abs(x - NaN) > 300 ist false und wuerde
  // den Replay-Schutz aushebeln - deshalb explizit auf endliche Zahl pruefen.
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false;
  // rawBody ist ein Buffer: getrennt updaten, sonst wird er zu utf8-String gecastet.
  const erwartet = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(ts + ".").update(rawBody).digest("hex");
  const a = Buffer.from(erwartet, "utf8");
  return teile.v1.some(v => {
    const b = Buffer.from(v, "utf8");
    return b.length === a.length && crypto.timingSafeEqual(a, b);
  });
}

function zahlungBuchen(token, session) {
  const inv = findInvite(token);
  if (!inv) return;
  if (inv.status === "bezahlt") return;                                      // idempotent
  inv.status = "bezahlt";
  inv.zahlung = {
    sessionId: session.id,
    paymentIntent: session.payment_intent || "",
    amount: session.amount_total || preisVon(inv),
    paidAt: Date.now()
  };
  logEvent("bezahlt", inv.name, inv.pool);
  dirty = true;
  bestaetigungSenden(inv);
}

/* ---------- Server ---------- */
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  const q = new URLSearchParams(req.url.split("?")[1] || "");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  /* --- Live-API (aggregiert, für die App) --- */
  /* Health verraet keine Geheimnisse, aber ob der Monitor-Schutz greift –
   * sonst laesst sich von aussen nicht pruefen, ob ADMIN_TOKENS angekommen
   * ist (Tippfehler im Variablennamen faellt sonst niemandem auf). */
  if (url === "/api/live/health") {
    return json(res, 200, {
      ok: true,
      adminGeschuetzt: ADMIN_TOKENS.size > 0,
      adminZugaenge: ADMIN_TOKENS.size,
      stripe: !!STRIPE_KEY,
      /* Live oder Test steht dem Schluessel selbst an der Stirn geschrieben.
       * Ohne diese Angabe laesst sich von aussen nicht unterscheiden, ob
       * echtes Geld fliesst - und ohne stripeWebhook nicht, ob eine Zahlung
       * ueberhaupt im Register ankaeme: fehlt das Secret, weist der Server
       * jede Stripe-Meldung ab und der Gast bleibt auf "zugesagt" stehen. */
      stripeModus: STRIPE_KEY ? (STRIPE_KEY.startsWith("sk_live") ? "live" : "test") : "",
      stripeWebhook: !!STRIPE_WEBHOOK_SECRET,
      /* Nur ob gesetzt, nie die Werte - sonst liesse sich von aussen nicht
       * pruefen, ob die Mail-Variablen im Panel angekommen sind. */
      mail: !!LETTERMINT_TOKEN,
      mailWebhook: !!LETTERMINT_WEBHOOK_SECRET,
      publicUrl: PUBLIC_URL
    });
  }

  if (url === "/api/live/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    res.write("retry: 3000\n\n");
    clients.add(res);
    res.write("data: " + snapshot() + "\n\n");
    broadcast();                                   // Gäste-Zähler an alle
    req.on("close", () => { clients.delete(res); broadcast(); });
    return;
  }

  if (req.method === "POST" && url === "/api/live/applause") {
    if (!rateLimit(req, res, "live", 60, 10_000)) return;
    return readBody(req, res, body => {
      const n = Math.min(Math.max(parseInt(body.n, 10) || 0, 0), 30);
      state.applause += n;
      dirty = true; broadcast();
      json(res, 200, { ok: true });
    });
  }

  if (req.method === "POST" && url === "/api/live/vote") {
    if (!rateLimit(req, res, "live", 60, 10_000)) return;
    return readBody(req, res, body => {
      const vote = VOTES.includes(body.vote) ? body.vote : null;
      const prev = VOTES.includes(body.prev) ? body.prev : null;
      if (prev && state.votes[prev] > 0) state.votes[prev]--;
      if (vote) state.votes[vote]++;
      dirty = true; broadcast();
      json(res, 200, { ok: true });
    });
  }

  if (req.method === "POST" && url === "/api/live/bid") {
    if (!rateLimit(req, res, "live", 60, 10_000)) return;
    return readBody(req, res, body => {
      const amount = parseInt(body.amount, 10) || 0;
      const current = state.bid ? state.bid.amount : 0;
      // Sprung nach oben deckeln: ein einzelnes Gebot darf current nicht um mehr
      // als 5.000 € ueberbieten. Sonst nagelt ein Fake-Maxgebot die Auktion an
      // die 2-Mio-Decke und jedes echte Gebot gilt danach als "zu niedrig".
      if (amount <= current || amount > current + 500_000 || amount > 2_000_000) {
        return json(res, 409, { error: "ungültiges Gebot", bid: state.bid });
      }
      state.bid = {
        amount,
        paddle: clean(body.paddle, 4),
        name: clean(body.name, 30),
        t: Date.now()
      };
      state.bids.unshift(state.bid);
      state.bids = state.bids.slice(0, 20);
      dirty = true; broadcast();
      json(res, 200, { ok: true, bid: state.bid });
    });
  }

  /* --- Stations-/Armband-API --- */

  // Band einem Gast zuordnen (Self-Service-Check-in am Tablet)
  if (req.method === "POST" && url === "/api/station/register") {
    return readBody(req, res, body => {
      const band = clean(body.band, 40);
      const name = clean(body.name, 40);
      if (!band || !name || RESERVED.has(band)) return json(res, 400, { error: "band und name nötig" });
      const g = hasOwn(state.guests, band) ? state.guests[band]
        : (state.guests[band] = { name, table: "", moments: {}, applause: 0, vote: null, t: Date.now() });
      g.name = name;
      if (body.table) g.table = clean(body.table, 20);
      if (!g.moments.ankommen) g.moments.ankommen = Date.now();   // registrieren = angekommen
      dirty = true; broadcast();
      json(res, 200, { ok: true, guest: pubGuest(band) });
    });
  }

  // Ein Band an einer Station auflegen
  if (req.method === "POST" && url === "/api/station/tap") {
    return readBody(req, res, body => {
      const band = clean(body.band, 40);
      const station = clean(body.station, 30);
      if (!band || RESERVED.has(band)) return json(res, 400, { error: "kein band" });

      let g = hasOwn(state.guests, band) ? state.guests[band] : null;
      if (!g) {
        // Unbekanntes Band am Check-in -> Name erfragen; sonst anonym anlegen
        if (station === "checkin") return json(res, 200, { ok: false, needName: true, band });
        g = state.guests[band] = { name: "Gast", table: "", moments: {}, applause: 0, vote: null, t: Date.now() };
      }

      let message = "";
      if (station === "checkin") {
        if (!g.moments.ankommen) g.moments.ankommen = Date.now();
        message = "Willkommen, " + g.name;
      } else if (station === "applause") {
        g.applause++; state.applause++;
        if (g.applause >= 5 && !g.moments.pitch) g.moments.pitch = Date.now();
        message = "Applaus gezählt";
      } else if (station.startsWith("vote-")) {
        const v = station.slice(5);
        if (!VOTES.includes(v)) return json(res, 400, { error: "unbekanntes votum" });
        if (g.vote && state.votes[g.vote] > 0) state.votes[g.vote]--;
        g.vote = v; state.votes[v]++;
        message = "Deine Stimme: " + VOTE_LABEL[v];
      } else if (station === "bid") {
        const inc = Math.min(Math.max(parseInt(body.inc, 10) || 250, 50), 5000);
        const current = state.bid ? state.bid.amount : 0;
        const amount = current + inc;
        state.bid = { amount, paddle: String(paddleFrom(band)), name: g.name, t: Date.now() };
        state.bids.unshift(state.bid);
        state.bids = state.bids.slice(0, 20);
        message = "Gebot: " + amount.toLocaleString("de-DE") + " €";
      } else if (STATION_MOMENT[station]) {
        const m = STATION_MOMENT[station];
        if (!g.moments[m]) g.moments[m] = Date.now();
        message = "Moment gesetzt";
      } else {
        return json(res, 400, { error: "unbekannte station" });
      }

      dirty = true; broadcast();
      json(res, 200, {
        ok: true,
        name: g.name,
        message,
        moments: Object.keys(g.moments).length,
        momentsTotal: MOMENTS_TOTAL,
        paddle: paddleFrom(band)
      });
    });
  }

  // Gast per Band auslesen (fürs optionale Handy)
  if (req.method === "GET" && url === "/api/guest") {
    const band = clean(q.get("band"), 40);
    const g = pubGuest(band);
    if (!g) return json(res, 404, { error: "unbekannt" });
    return json(res, 200, { ok: true, guest: g });
  }

  /* --- Einladungs-API (Landing Page) --- */

  // Gast zum persönlichen Link laden
  if (req.method === "GET" && url === "/api/invite") {
    /* Token-Raten ist bei 72 Bit aussichtslos, aber ein Limit haelt
     * Enumerations-Versuche aus dem Log und die Last unten. */
    if (!rateLimit(req, res, "invite", 120, 60_000)) return;
    const inv = findInvite(q.get("t"));
    if (!inv) return json(res, 404, { error: "Diese Einladung kennen wir nicht." });
    // "Geklickt" nur zaehlen, wenn der Aufruf von der Landing Page kommt, nicht
    // vom App-Link (/?t=, ruft mit app=1). Sonst verfaelscht das Oeffnen der App
    // die Klickquote und meldet Gaeste als engagiert, die nur die App geladen haben.
    if (q.get("app") !== "1") {
      /* Der persoenliche Link steht in der Einladung - der Klick gehoert
       * also zu der Welle, die zuletzt an diesen Gast rausging. */
      const jetzt = Date.now();
      const n = welleZuZeit(inv, jetzt);
      const w = n === "" ? null : wellenMail(inv, n);
      if (w && !w.clicked) {
        w.clicked = jetzt;
        logEvent("geklickt", inv.name, (inv.pool || "") + " · Welle " + n);
        dirty = true;
      }
      if (!inv.mail.clicked) {
        inv.mail.clicked = jetzt;
        if (!w) logEvent("geklickt", inv.name, inv.pool);
        dirty = true;
      }
    }
    return json(res, 200, { ok: true, gast: pubInvite(inv) });
  }

  // Zusagen / absagen (+ die Angaben des Gastes)
  /* Kein Honeypot-Feld im Formular - bewusst. Das Formular ist ohnehin
   * token-geschuetzt (72 Bit, nicht erratbar), Bots kommen also gar nicht
   * heran; ein verstecktes Feld haette nur einen Effekt: Browser und
   * Passwortmanager fuellen es beim Autofill mit, die Zusage wuerde als
   * "Bot" verworfen, und der Gast erfaehrt nie, warum er nicht auf der
   * Liste steht. Gegen das reale Restrisiko - jemand mit einem Link
   * haemmert den Endpunkt - hilft ein Limit, kein Koeder.
   * Grosszuegig bemessen: hinter einem Firmen-NAT teilen sich viele Gaeste
   * eine IP, und ein korrigiertes Formular darf mehrfach abgeschickt werden. */
  if (req.method === "POST" && url === "/api/invite/rsvp") {
    if (!rateLimit(req, res, "rsvp", 30, 60_000)) return;
    return readBody(req, res, body => {
      const inv = findInvite(body.t);
      if (!inv) return json(res, 404, { error: "unbekannte Einladung" });

      if (body.absage) {
        // Eine bereits bezahlte Teilnahme darf sich nicht per RSVP selbst auf
        // "abgesagt" setzen - sonst zahlt derselbe Gast ein zweites Mal und der
        // Umsatz im Monitor wird inkonsistent. Absage/Erstattung ist manuell.
        if (inv.status === "bezahlt") {
          return json(res, 409, { error: "bereits bezahlt – Absage bitte über die Veranstalter (Erstattung)" });
        }
        inv.status = "abgesagt";
        logEvent("abgesagt", inv.name, inv.pool);
        dirty = true;
        return json(res, 200, { ok: true, gast: pubInvite(inv) });
      }

      if (body.name)   inv.name = cleanText(body.name, 60);
      if (body.firma !== undefined) inv.firma = cleanText(body.firma, 80);
      /* Rolle steht getrennt von der Firma - sonst landen "gadplan GmbH"
       * und "Geschaeftsfuehrer" wieder in einem Feld und lassen sich fuer
       * Namensschilder und Sitzordnung nicht mehr auseinandernehmen. */
      if (body.rolle !== undefined) inv.rolle = cleanText(body.rolle, 80);
      /* E-Mail aus dem Zusage-Formular ins Register uebernehmen. Wichtig fuer
       * WhatsApp-Gaeste (ohne Adresse importiert, Link kam per Chat): ab der
       * Zusage sind sie fuer Welle 2 per Mail erreichbar. */
      if (body.email !== undefined) {
        const mail = clean(body.email, 120).toLowerCase();
        if (mail.indexOf("@") > 0) inv.email = mail;
      }
      // Nur mitgesendete Felder mergen - ein zweites RSVP ohne Allergiefeld darf
      // eine zuvor gemeldete Unvertraeglichkeit nicht loeschen (Kueche!).
      if (!inv.daten) inv.daten = {};
      if (body.phone   !== undefined) inv.daten.phone   = cleanText(body.phone, 30);
      if (body.diet    !== undefined) inv.daten.diet    = cleanText(body.diet, 20);
      if (body.allergy !== undefined) inv.daten.allergy = cleanText(body.allergy, 120);

      // Ehrengäste sind mit der Zusage fertig, Ticket-Gäste erst nach Zahlung
      if (inv.typ === "ehrengast") {
        if (inv.status !== "bezahlt") inv.status = "zugesagt";
        logEvent("zugesagt", inv.name, inv.pool);
        /* Ehrengaeste sind mit der Zusage fertig - also bestaetigen wir jetzt.
         * Bezahlgaeste erst nach der Zahlung, sonst bestaetigten wir einen
         * Platz, der noch offen ist (siehe zahlungBuchen). */
        bestaetigungSenden(inv);
      } else if (inv.status === "offen" || inv.status === "abgesagt" || inv.status === "warteliste") {
        /* Der Deckel greift genau hier: nicht erst an der Bezahlseite,
         * sondern in dem Moment, in dem der Platz beansprucht wird. Wer
         * schon zugesagt hat, faellt nicht in diesen Zweig und verliert
         * seinen Platz auch dann nicht, wenn er das Formular ein zweites
         * Mal abschickt. */
        if (ticketPlaetzeFrei() <= 0) {
          inv.status = "warteliste";
          inv.wartelisteSeit = inv.wartelisteSeit || Date.now();
          logEvent("warteliste", inv.name, inv.pool);
        } else {
          inv.status = "zugesagt";                  // zugesagt, Zahlung offen
          logEvent("zugesagt", inv.name, inv.pool);
        }
      }
      dirty = true;
      json(res, 200, { ok: true, gast: pubInvite(inv) });
    });
  }

  // Stripe-Checkout starten -> Landing Page leitet auf die zurückgegebene URL
  if (req.method === "POST" && url === "/api/invite/checkout") {
    /* Jeder Aufruf legt eine Stripe-Session an - ohne Limit koennte ein
     * Skript mit einem Link tausende erzeugen und unser Stripe-Konto
     * zumuellen. */
    if (!rateLimit(req, res, "checkout", 15, 60_000)) return;
    return readBody(req, res, body => {
      const inv = findInvite(body.t);
      if (!inv) return json(res, 404, { error: "unbekannte Einladung" });
      if (inv.typ !== "ticket") return json(res, 400, { error: "Für dich ist kein Beitrag fällig." });
      if (inv.status === "bezahlt") return json(res, 200, { ok: true, bereitsBezahlt: true });
      /* Zweite Sperre hinter der ersten: die Bezahlseite darf sich auch
       * nicht ueber einen alten Tab oder einen zurueckgelegten Link oeffnen
       * lassen, wenn der Kreis voll ist. Wer bereits zugesagt hat, haelt
       * seinen Platz und darf immer zahlen - auch wenn der Deckel inzwischen
       * erreicht ist, denn er ist ja mitgezaehlt. */
      if (inv.status === "warteliste" || (inv.status !== "zugesagt" && ticketPlaetzeFrei() <= 0)) {
        return json(res, 409, {
          /* Enthält bewusst das Wort "Warteliste": die Landing Page erkennt
           * daran, dass sie den Warteliste-Schritt zeigen muss statt einer
           * Fehlermeldung. Gaesten gegenueber heisst es nie "Bezahlgast" -
           * das ist unsere interne Einteilung, nicht ihre. */
          error: "Die Gästeliste ist aktuell voll – du stehst auf der Warteliste.",
          warteliste: true
        });
      }
      if (!STRIPE_KEY) return json(res, 503, { error: "Zahlung ist noch nicht scharf geschaltet (STRIPE_SECRET_KEY fehlt)." });

      createCheckout(inv, (err, session) => {
        if (err) return json(res, 502, { error: err.message });
        inv.zahlung = Object.assign({}, inv.zahlung, { sessionId: session.id });
        dirty = true;
        json(res, 200, { ok: true, url: session.url });
      });
    });
  }

  // Stripe-Webhook: Zahlung buchen (Rohkörper für die Signaturprüfung)
  if (req.method === "POST" && url === "/api/stripe/webhook") {
    // Rohkoerper als Buffer sammeln (nicht als String): an einer TCP-Chunk-Grenze
    // zerrissene UTF-8-Zeichen - deutsche Gastnamen wie "Sven König" landen als
    // metadata im Event - wuerden sonst zu U+FFFD und zerstoerten das HMAC; der
    // Gast haette gezahlt, die Buchung schlaege fehl.
    const chunks = [];
    let laenge = 0;
    req.on("data", c => { chunks.push(c); laenge += c.length; if (laenge > 1_000_000) req.destroy(); });
    req.on("end", () => {
      const rawBuf = Buffer.concat(chunks);
      if (!webhookGueltig(req.headers["stripe-signature"], rawBuf)) {
        return json(res, 400, { error: "Signatur ungültig" });
      }
      const raw = rawBuf.toString("utf8");
      let evt;
      try { evt = JSON.parse(raw); } catch (e) { return json(res, 400, { error: "bad json" }); }
      const obj = (evt.data && evt.data.object) || {};
      if (evt.type === "checkout.session.completed" && obj.payment_status === "paid") {
        zahlungBuchen((obj.metadata && obj.metadata.token) || obj.client_reference_id, obj);
      }
      json(res, 200, { received: true });          // Stripe erwartet 2xx
    });
    return;
  }

  /* Lettermint-Webhook: Versand-/Öffnungs-/Klickstatus in die Liste schreiben.
   * Nur mit gueltiger Signatur - sonst koennte jeder unsere Zustellzahlen
   * faelschen. Ist kein Secret hinterlegt, bleibt der Weg zu.
   * Jede eintreffende Meldung landet zusaetzlich in einer kleinen
   * Fangschaltung (webhookLog, nur im Speicher, nur fuer Admins sichtbar) -
   * damit ein Format-Missverstaendnis wie beim Signatur-Standard nie wieder
   * blind gesucht werden muss. */
  if (req.method === "POST" && url === "/api/lettermint/webhook") {
    const chunks = [];
    let laenge = 0;
    req.on("data", c => { chunks.push(c); laenge += c.length; if (laenge > 200_000) req.destroy(); });
    req.on("end", () => {
      const rawBuf = Buffer.concat(chunks);
      const ereignisKopf = String(req.headers["x-lettermint-event"] || "");
      if (!lettermintWebhookGueltig(req.headers, rawBuf)) {
        webhookMerken({ t: Date.now(), event: ereignisKopf, ergebnis: "401 Signatur",
                        body: rawBuf.toString("utf8").slice(0, 600) });
        return json(res, 401, { error: "Signatur ungültig" });
      }
      let body;
      try { body = JSON.parse(rawBuf.toString("utf8") || "{}"); }
      catch (e) { return json(res, 400, { error: "bad json" }); }
      /* Svix-artige Payloads verschachteln die Nutzdaten unter "data" und
       * nennen den Typ "email.delivered" - beides normalisieren. */
      const daten = (body.data && typeof body.data === "object") ? body.data : body;
      /* Zuordnung bevorzugt über den Token, den wir beim Versand als
       * metadata mitgeben - E-Mail-Adressen können doppelt vorkommen. */
      const token = String((daten.metadata && daten.metadata.token) ||
                           (body.metadata && body.metadata.token) || daten.token || "");
      /* Empfaenger je nach Ereignis: message.* -> data.recipient,
       * message.created -> data.to[0], suppression.* -> data.value. */
      const email = String(daten.recipient || daten.email ||
                           (Array.isArray(daten.to) ? daten.to[0] : "") ||
                           daten.value || body.email || "").toLowerCase();
      /* Leere Adresse darf NIE matchen - sonst faengt der erste
       * WhatsApp-Gast (email="") alle Ereignisse ohne Adressfeld ab. */
      const inv = findInvite(token) ||
                  (email ? Object.values(state.invites).find(i => i.email === email) : null);
      if (!inv) {
        webhookMerken({ t: Date.now(), event: ereignisKopf, ergebnis: "ignoriert: kein Gast",
                        token: token.slice(0, 6) + "…", email,
                        body: rawBuf.toString("utf8").slice(0, 600) });
        return json(res, 200, { ok: true, ignoriert: true });
      }
      /* Der Ereignistyp steht bei Lettermint auch im Header X-Lettermint-Event
       * ("message.delivered"); der Namespace-Teil wird abgeworfen. */
      const typ = String(req.headers["x-lettermint-event"] ||
                         body.event || body.type || body.status || daten.status || "")
        .toLowerCase().split(".").pop();
      /* Beschwerde ("als Spam markiert") und Abmeldung ueber den Mail-Client
       * = Abmeldung bei uns: der Gast will nichts mehr - und jede weitere
       * Mail kostet die junge Absenderdomain Reputation. inv.abgemeldet
       * nimmt ihn aus allen kuenftigen Wellen. */
      /* Suppression-Liste: added = Adresse gesperrt (zuverlaessigster
       * Bounce-Indikator), removed = wieder frei. Kommt ohne metadata,
       * Zuordnung laeuft ueber data.value (oben in email). */
      if (typ === "added" || typ === "removed") {
        inv.mail = inv.mail || { sent: 0, delivered: 0, opened: 0, clicked: 0 };
        if (typ === "added" && !inv.mail.bounced) {
          inv.mail.bounced = Date.now();
          logEvent("unzustellbar", inv.name, inv.pool);
          dirty = true;
        }
        if (typ === "removed" && inv.mail.bounced) {
          inv.mail.bounced = 0;
          dirty = true;
        }
        webhookMerken({ t: Date.now(), event: ereignisKopf, typ, gast: inv.name, ergebnis: "suppression " + typ });
        return json(res, 200, { ok: true });
      }
      if (typ === "complained" || typ === "complaint" || typ === "spam_complaint" || typ === "spam" || typ === "unsubscribed") {
        if (!inv.abgemeldet) {
          inv.abgemeldet = Date.now();
          logEvent("beschwerde", inv.name, inv.pool);
          dirty = true;
        }
        return json(res, 200, { ok: true });
      }
      const map = { sent: "sent", created: "sent", delivered: "delivered", opened: "opened", open: "opened",
                    clicked: "clicked", click: "clicked",
                    /* Unzustellbar - ohne dieses Feld wuerden tote Adressen
                     * in jeder Welle erneut angeschrieben. (Lettermint-Namen:
                     * message.hard_bounced/soft_bounced/failed/suppressed/
                     * policy_rejected, Namespace bereits abgeworfen.) */
                    /* Nur ENDGUELTIGE Fehler sperren die Adresse - ein Soft
                     * Bounce (Postfach voll) ist voruebergehend und wird
                     * bewusst ignoriert, Lettermint versucht es selbst neu. */
                    bounced: "bounced", bounce: "bounced", hard_bounce: "bounced", hard_bounced: "bounced",
                    failed: "bounced", rejected: "bounced", policy_rejected: "bounced", suppressed: "bounced" };
      const LABEL = { sent: "versendet", delivered: "zugestellt", opened: "geöffnet",
                      clicked: "geklickt", bounced: "unzustellbar" };
      /* Scanner-/Proxy-Oeffnungen (Apple MPP & Co.) nicht als Engagement
       * zaehlen - Lettermint liefert dafuer eine Bot-Einschaetzung mit. */
      if ((typ === "opened" || typ === "clicked") &&
          daten.bot && daten.bot.counts_for_metrics === false) {
        webhookMerken({ t: Date.now(), event: ereignisKopf, typ, gast: inv.name, ergebnis: "Bot-" + typ + " ignoriert" });
        return json(res, 200, { ok: true });
      }
      const feld = hasOwn(map, typ) ? map[typ] : null;
      inv.mail = inv.mail || { sent: 0, delivered: 0, opened: 0, clicked: 0 };  // Altbestand

      /* Zeitpunkt des Ereignisses aus der Meldung selbst (ISO in
       * body.timestamp) - nicht die Empfangszeit: Lettermint liefert
       * auch mal mit Verzoegerung oder (nach einer Webhook-Pause)
       * gar rueckwirkend nach. Plausibilitaetsfenster: nicht in der
       * Zukunft, nicht aelter als der Projektstart. */
      const gemeldet = Date.parse(body.timestamp || "");
      const jetzt = Date.now();
      const zeit = (Number.isFinite(gemeldet) &&
                    gemeldet <= jetzt + 60_000 &&
                    gemeldet > Date.parse("2026-08-01")) ? gemeldet : jetzt;

      /* Zu WELCHER Mail gehoert das? Der Versand gibt jeder Mail
       * metadata.welle mit; fehlt sie (aeltere Sendung, fremder Absender),
       * wird sie aus dem Versandzeitpunkt erschlossen. Ohne diese
       * Zuordnung landete jedes Ereignis in einem gemeinsamen Topf, und
       * die zweite Welle konnte nichts mehr eintragen. */
      const welleRoh = String((daten.metadata && daten.metadata.welle) ??
                              (body.metadata && body.metadata.welle) ?? "");
      const welle = /^[0-9]+$/.test(welleRoh) ? welleRoh : welleZuZeit(inv, zeit);

      let neuInWelle = false;
      if (feld && welle !== ""){
        const w = wellenMail(inv, welle);
        if (!w[feld]) { w[feld] = zeit; neuInWelle = true; }
      }
      /* Gesamtsicht wie bisher: die erste Regung ueberhaupt. Daran haengen
       * Bounce-Sperre, Abmeldung und die Gaesteliste. */
      const warNeu = feld && !inv.mail[feld];
      if (warNeu) inv.mail[feld] = zeit;

      /* Ins Ereignis-Log gehoert, was in SEINER Welle neu ist - sonst
       * bliebe die zweite Welle im Feed unsichtbar. */
      if (neuInWelle || (warNeu && welle === "")) {
        logEvent(LABEL[feld], inv.name, (inv.pool || "") + (welle !== "" ? " · Welle " + welle : ""));
      }
      if (warNeu || neuInWelle) dirty = true;

      webhookMerken({ t: Date.now(), event: ereignisKopf, typ, gast: inv.name,
                      welle: welle === "" ? "?" : welle,
                      ergebnis: !feld ? "unbekannter Typ"
                              : neuInWelle ? "gesetzt: " + feld + " (Welle " + welle + ")"
                              : welle === "" ? (warNeu ? "gesetzt: " + feld + " (Welle unbekannt)"
                                                       : "schon gesetzt: " + feld)
                              : "schon gesetzt: " + feld + " (Welle " + welle + ")" });
      json(res, 200, { ok: true });
    });
    return;
  }

  /* Abmeldung aus dem Verteiler. GET zeigt nur die Frage - abgemeldet wird
   * erst per POST. Der Grund ist kein Stilempfinden: Firmen-Mailgateways
   * (Microsoft Safe Links, Proofpoint, Mimecast ...) rufen Links in
   * eingehenden Mails per GET ab, teils schon bei der Zustellung. Ein GET
   * mit Wirkung wuerde Gaeste abmelden, die nie geklickt haben - und die
   * bekaemen dann stillschweigend nie die eigentliche Einladung. RFC 8058
   * (One-Click aus dem Mailprogramm) schickt ohnehin POST; der
   * List-Unsubscribe-Header jeder Mail zeigt hierher. Die Zusage bleibt
   * bestehen; abgemeldet heisst nur: keine weiteren Wellen. */
  if ((req.method === "GET" || req.method === "POST") && url === "/abmelden") {
    const inv = findInvite(q.get("t"));
    const antworten = art => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(abmeldeSeite(art, inv ? inv.token : ""));
    };
    if (req.method === "GET") {
      return antworten(!inv ? "ungueltig" : inv.abgemeldet ? "fertig" : "frage");
    }
    /* POST: One-Click-Clients schicken einen kleinen Formular-Body mit -
     * abtropfen lassen, gebraucht wird nur der Token aus der URL. */
    req.on("data", () => {});
    req.on("end", () => {
      if (!inv) return antworten("ungueltig");
      if (!inv.abgemeldet) {
        inv.abgemeldet = Date.now();
        logEvent("abgemeldet", inv.name, inv.pool);
        dirty = true;
      }
      antworten("fertig");
    });
    return;
  }

  /* --- Admin (Monitor) ---
   * Hinter /api/admin/ stehen Namen, E-Mail-Adressen, Unvertraeglichkeiten und
   * die persoenlichen Einladungslinks. Ist kein Zugang konfiguriert, wird
   * GESPERRT statt geoeffnet: ein vergessenes oder falsch geschriebenes
   * ADMIN_TOKENS darf nicht dazu fuehren, dass die Gaesteliste offen im Netz
   * steht. Lieber ein toter Monitor als ein offenes Register. */
  if (url.startsWith("/api/admin/")) {
    if (!ADMIN_TOKENS.size) {
      return json(res, 503, {
        error: "Monitor ist nicht konfiguriert – ADMIN_TOKENS fehlt. " +
               "Aus Datenschutzgründen bleibt der Zugang gesperrt."
      });
    }
    const wer = adminName(q.get("key"));
    if (!wer) return json(res, 401, { error: "kein Zugriff" });

    if (url === "/api/admin/pools") {
      return json(res, 200, {
        ok: true,
        stand: Date.now(),                         // "Stand HH:MM" im Monitor
        gesamt: gesamtStats(),
        pools: poolStats(),
        wellen: wellenStats(),
        fassungen: fassungStats(),
        feed: state.feed.slice(0, 30)
      });
    }
    // Kontrollliste als CSV: Name, E-Mail, Typ, persönlicher Link
    if (url === "/api/admin/versandliste") {
      const zeilen = [["pool", "typ", "anrede", "vorname", "name", "email", "firma", "rolle", "mobil", "ernaehrung", "unvertraeglichkeiten", "partner_name", "partner_logo_url", "platz_satz", "link", "app_link", "std_link", "ticket_nr", "status", "abgemeldet"]];
      for (const inv of Object.values(state.invites)) {
        zeilen.push([inv.pool, inv.typ, inv.anrede || "Hallo", (inv.name || "").split(" ")[0],
                     inv.name, inv.email, inv.firma || "", inv.rolle || "",
                     (inv.daten && inv.daten.phone) || "", (inv.daten && inv.daten.diet) || "",
                     (inv.daten && inv.daten.allergy) || "",
                     inv.partner || "", inv.partnerLogo || "",
                     platzSatz(inv), inviteLink(inv.token), appLink(inv.token), stdLink(inv.token), inv.ticketNr, inv.status,
                     inv.abgemeldet ? "ja" : ""]);
      }
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
      return res.end(zeilen.map(r => r.map(csvCell).join(",")).join("\n"));
    }

    /* Fangschaltung ausgeben: was kam zuletzt am Lettermint-Webhook an,
     * und was hat der Server daraus gemacht. */
    if (url === "/api/admin/webhook-log") {
      return json(res, 200, { ok: true, log: webhookLog });
    }

    /* Wegwerf-Testgast fuer Zahlungs-/Strecken-Tests: eigener Pool
     * "Stripe-Test", Ticket-Typ, klar als Test benannt. Loeschen geht nur
     * fuer Gaeste aus genau diesem Pool - echte Gaeste sind unantastbar. */
    /* Wegwerf-Gast zum Anschauen und zum Stripe-Test.
     *   ?typ=ticket|ehrengast   welche Fassung der Seite (Standard: ticket)
     *   ?partner=neuland.ai     macht daraus einen Partnergast; das Logo wird
     *                           aus dem Namen abgeleitet (partner-<name>-neg.png)
     * Bleibt immer im Pool "Stripe-Test": nur der laesst sich wieder loeschen,
     * und die Vorflugkontrolle zeigt ihn als zusaetzlichen Empfaenger an.
     * Bewusst mit Adresse @planyvo.com - faellt uns ein Loeschen durch, geht
     * die Mail an uns selbst und nicht an einen Gast. */
    /* Bestaetigungen nachholen. Gebraucht fuer alle, die zugesagt haben,
     * BEVOR es die Bestaetigung gab - und als Netz, falls Lettermint einmal
     * nicht erreichbar war (dann steht der Vermerk wieder auf 0).
     * Ohne &senden=1 nur eine Liste: wer bekaeme sie, mit welcher Vorlage.
     * Nacheinander mit Abstand, damit ein Nachlauf ueber viele Gaeste nicht
     * als Schwall beim Anbieter ankommt. */
    if (req.method === "POST" && url === "/api/admin/bestaetigungen-nachholen") {
      /* ?nur=adresse schickt an genau einen - der Weg, eine neue Vorlage
       * einmal an sich selbst zu schicken, bevor sie an Gaeste geht. */
      const nur = String(q.get("nur") || "").toLowerCase().trim();
      const dran = Object.values(state.invites)
        .filter(bestaetigungFaellig)
        .filter(inv => !nur || (inv.email || "").toLowerCase() === nur);
      if (nur && !dran.length) {
        return json(res, 404, { error: "Kein fälliger Gast mit dieser Adresse: " + nur });
      }
      const liste = dran.map(inv => ({
        name: inv.name, email: inv.email, typ: inv.typ, partner: inv.partner || "",
        status: inv.status,
        vorlage: inv.typ === "ehrengast"
          ? ((inv.partner && inv.partnerLogo) ? "bestaetigung-ehrengast-partner.html" : "bestaetigung-ehrengast.html")
          : "bestaetigung-ticket.html"
      }));
      if (q.get("senden") !== "1") {
        return json(res, 200, { ok: true, probelauf: true, anzahl: dran.length, gaeste: liste });
      }
      if (!LETTERMINT_TOKEN) return json(res, 503, { error: "LETTERMINT_TOKEN fehlt in der App" });
      const jetzt = Date.now();
      dran.forEach(inv => { inv.bestaetigung = jetzt; });   // erst alle belegen
      dirty = true;
      dran.forEach((inv, i) => setTimeout(() => bestaetigungAbschicken(inv), i * 400));
      return json(res, 200, { ok: true, verschickt: dran.length, gaeste: liste });
    }

    /* Die fertigen WhatsApp-Nachrichten fuer Gaeste ohne Mailadresse.
     * Dieselbe Auswahl und derselbe Text wie der CLI-Befehl "whatsapp" -
     * nur abrufbar, statt in einer Datei auf dem Server zu landen, die
     * dann jemand suchen muss.
     * Enthaelt persoenliche Links: bewusst NUR fuer Gaeste ohne Adresse,
     * die ihren Link ohnehin von Hand bekommen. Alle anderen bleiben
     * draussen, damit ein abhandengekommener Admin-Zugang nicht gleich
     * die Zusage jedes Gastes eroeffnet. */
    if (url === "/api/admin/whatsapp") {
      const mitMail = new Set(Object.values(state.invites)
        .filter(i => i.email).map(i => (i.name || "").trim().toLowerCase()));
      /* Nachreichen fuer einen benannten Gast MIT Adresse: die Einladung
       * ist im Spam gelandet oder geloescht worden, und jemand braucht den
       * Link von Hand. Bewusst nur gegen eine ausdruecklich genannte
       * Adresse - kein Weg, sich die Liste aller Links ausgeben zu lassen. */
      const auch = new Set(String(q.get("auch") || "").toLowerCase()
        .split(",").map(s => s.trim()).filter(s => s.indexOf("@") > 0));
      const uebersprungen = [];
      const dran = Object.values(state.invites).filter(inv => {
        if (auch.size && inv.email && auch.has(inv.email.toLowerCase())) return true;
        if (inv.email || inv.abgemeldet || inv.status === "abgesagt") return false;
        if (mitMail.has((inv.name || "").trim().toLowerCase())) {
          uebersprungen.push({ name: inv.name, pool: inv.pool, grund: "bekommt die Einladung per Mail" });
          return false;
        }
        return true;
      }).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      return json(res, 200, {
        ok: true,
        anzahl: dran.length,
        uebersprungen,
        gaeste: dran.map(inv => ({
          name: inv.name, pool: inv.pool,
          rolle: inv.typ === "ehrengast" ? "Ehrengast" : "Bezahlgast, 100 €",
          /* Hat eine Adresse und steht trotzdem hier: nachgereicht. */
          nachgereicht: !!inv.email,
          email: inv.email || "",
          token: inv.token,
          raus: (inv.whatsapp && inv.whatsapp["1"]) || 0,
          link: inviteLink(inv.token),
          nachricht: whatsappText(inv)
        }))
      });
    }

    /* Vermerk: diese Einladung ist per WhatsApp rausgegangen.
     * Der Server kann das nicht selbst wissen - verschickt wird von Hand,
     * aus einem fremden Messenger. Also traegt es der Mensch ein, der es
     * getan hat. Ohne diesen Vermerk stehen die Gaeste ohne Adresse auf
     * ewig unter "nicht angeschrieben", obwohl sie laengst eingeladen sind.
     * Bewusst KEIN Zustell- oder Lesestatus: wir wissen nur, dass jemand
     * die Nachricht abgeschickt hat. */
    if (req.method === "POST" && url === "/api/admin/whatsapp-vermerk") {
      const inv = state.invites[String(q.get("token") || "")];
      if (!inv) return json(res, 404, { error: "Unbekannter Gast" });
      const welle = String(q.get("welle") || "1");
      inv.whatsapp = inv.whatsapp || {};
      if (q.get("zurueck") === "1") delete inv.whatsapp[welle];
      else inv.whatsapp[welle] = Date.now();
      dirty = true;
      return json(res, 200, { ok: true, raus: inv.whatsapp[welle] || 0 });
    }

    /* Einen Gast nachtragen, waehrend die Wellen laufen. Absagen und
     * Nachrueckerinnen kommen jetzt taeglich - und der CSV-Import ist dafuer
     * der falsche Weg: der schreibt live-state.json aus einem ZWEITEN
     * Prozess, waehrend die laufende App dieselbe Datei alle zwei Sekunden
     * aus ihrem eigenen Speicher zurueckschreibt. Wer waehrenddessen zusagt
     * oder zahlt, faellt durch den Rost. Hier passiert es IN der App.
     * Dieselbe Funktion wie der Import, damit es nur eine Regel gibt, wie
     * ein Gast entsteht (Token, Ticketnummer, Wiedererkennung). */
    if (req.method === "POST" && url === "/api/admin/gast") {
      const name = cleanText(q.get("name") || "", 60);
      const email = clean(q.get("email") || "", 120).toLowerCase();
      if (!name) return json(res, 400, { error: "name fehlt" });
      if (email && email.indexOf("@") < 1) return json(res, 400, { error: "email ohne @" });
      const kopf = ["pool", "typ", "anrede", "name", "email", "firma", "rolle", "partner", "partner_logo", "telefon"];
      const zeile = kopf.map(k => cleanText(q.get(k === "email" ? "email" : k) || "", 200));
      let ergebnis;
      try { ergebnis = importRows([kopf, zeile]); }
      catch (e) { return json(res, 400, { error: e.message }); }
      dirty = true;
      const inv = (email && Object.values(state.invites).find(i => (i.email || "").toLowerCase() === email)) ||
                  Object.values(state.invites).find(i => i.name === name);
      return json(res, 200, {
        ok: true, neu: ergebnis.neu, aktualisiert: ergebnis.aktualisiert,
        gast: inv ? { name: inv.name, pool: inv.pool, typ: inv.typ, email: inv.email,
                      ticketNr: inv.ticketNr, status: inv.status, link: inviteLink(inv.token) } : null
      });
    }

    /* Eine ganze Liste einspielen, waehrend die Wellen laufen - derselbe
     * Grund wie oben: der CLI-Import schreibt live-state.json aus einem
     * zweiten Prozess und ueberfaehrt damit alles, was die laufende App
     * seit ihrem Start gesehen hat. Hier laeuft dieselbe Funktion IN der
     * App, und die Antwort sagt genauso wie die CLI, was sich geaendert
     * hat - besonders die stillen Adressaenderungen.
     * Der Rumpf ist die CSV selbst, nicht JSON. */
    if (req.method === "POST" && url === "/api/admin/import") {
      let roh = "", zuGross = false;
      req.on("data", c => { roh += c; if (roh.length > 500_000) { zuGross = true; req.destroy(); } });
      req.on("end", () => {
        if (zuGross) return json(res, 413, { error: "CSV zu groß (max. 500 KB)" });
        let ergebnis;
        try { ergebnis = importRows(parseCSV(roh)); }
        catch (e) { return json(res, 400, { error: "Import fehlgeschlagen: " + e.message }); }
        dirty = true;
        return json(res, 200, {
          ok: true, neu: ergebnis.neu, aktualisiert: ergebnis.aktualisiert,
          gesamt: ergebnis.gesamt, adressen: ergebnis.adressen
        });
      });
      return;
    }

    /* Doppelte Kreis-Nummern einsammeln und neu vergeben.
     *
     * Noetig geworden durch den zu engen Zahlenbereich der ersten Fassung
     * (88 Nummern fuer 107 Gaeste). Ohne ?senden=1 nur die Liste: wer
     * behaelt seine Nummer, wer bekommt eine neue.
     *
     * Wer seine Nummer schon KENNT, behaelt sie - sie stand in seiner
     * Bestaetigungsmail und auf seinem Bildschirm. Bei mehreren Wissenden
     * in derselben Gruppe kann nur einer sie behalten; dann gewinnt, wer
     * zuerst reagiert hat (frueherer Klick), und die anderen werden in der
     * Antwort einzeln aufgefuehrt - die muss ein Mensch sehen. */
    if (req.method === "POST" && url === "/api/admin/nummern") {
      const alle = Object.values(state.invites);
      const kennt = i => i.status === "zugesagt" || i.status === "bezahlt";
      const gruppen = {};
      for (const i of alle) if (i.ticketNr) (gruppen[i.ticketNr] ||= []).push(i);

      /* Wer in seiner Gruppe die Nummer behaelt. */
      const rang = i => [kennt(i) ? 0 : 1,
                         (i.mail && i.mail.clicked) || Number.MAX_SAFE_INTEGER,
                         i.name || ""];
      const behalten = new Set();
      const neuVergeben = [];
      for (const nr of Object.keys(gruppen)) {
        const liste = gruppen[nr].slice().sort((a, b) => {
          const ra = rang(a), rb = rang(b);
          return ra[0] - rb[0] || ra[1] - rb[1] || String(ra[2]).localeCompare(String(rb[2]));
        });
        behalten.add(liste[0].token);
        for (const i of liste.slice(1)) neuVergeben.push(i);
      }
      const belegt = new Set();
      for (const i of alle) if (i.ticketNr && behalten.has(i.token)) belegt.add(i.ticketNr);

      const aenderungen = neuVergeben.map(inv => {
        const neu = ticketNummerVergeben(inv.token, belegt);
        return { name: inv.name, email: inv.email || "", status: inv.status,
                 vorher: inv.ticketNr, jetzt: neu,
                 /* Diese Gaeste haben ihre alte Nummer schon gesehen. */
                 kannteSieSchon: kennt(inv) };
      });
      if (q.get("senden") !== "1") {
        return json(res, 200, { ok: true, probelauf: true, anzahl: aenderungen.length,
                                schonMitgeteilt: aenderungen.filter(a => a.kannteSieSchon),
                                aenderungen });
      }
      aenderungen.forEach((a, i) => { neuVergeben[i].ticketNr = a.jetzt; });
      dirty = true;
      return json(res, 200, { ok: true, geaendert: aenderungen.length,
                              schonMitgeteilt: aenderungen.filter(a => a.kannteSieSchon),
                              aenderungen });
    }

    /* Jemanden von der Warteliste nachruecken lassen - wenn ein Bezahlgast
     * abgesagt hat oder ein Platz erstattet wurde. Der Gast steht danach
     * auf "zugesagt": der Platz gehoert ihm, die Zahlung fehlt noch. Die
     * Antwort enthaelt seinen persoenlichen Link, damit ihm jemand
     * schreiben kann - der Server tut das nicht von selbst, denn wer
     * nachrueckt und wann, ist eine Entscheidung und keine Regel. */
    if (req.method === "POST" && url === "/api/admin/nachruecken") {
      const mail = String(q.get("email") || "").toLowerCase().trim();
      const inv = findInvite(q.get("t")) ||
                  (mail ? Object.values(state.invites).find(i => (i.email || "").toLowerCase() === mail) : null);
      if (!inv) return json(res, 404, { error: "Gast nicht gefunden" });
      if (inv.status !== "warteliste") {
        return json(res, 409, { error: "Steht nicht auf der Warteliste (Stand: " + inv.status + ")" });
      }
      if (ticketPlaetzeFrei() <= 0 && q.get("trotzdem") !== "1") {
        return json(res, 409, {
          error: "Kein Platz frei (" + ticketZusagen() + " von " + TICKET_LIMIT +
                 "). Mit &trotzdem=1 ueber den Deckel hinaus."
        });
      }
      inv.status = "zugesagt";
      logEvent("nachgerückt", inv.name, inv.pool);
      dirty = true;
      return json(res, 200, {
        ok: true, name: inv.name, email: inv.email, ticketNr: inv.ticketNr,
        link: inviteLink(inv.token), frei: ticketPlaetzeFrei()
      });
    }

    /* Absage von Hand vermerken - der Gast hat ueber Dylan oder am Telefon
     * abgesagt und wird seinen persoenlichen Link nicht selbst benutzen.
     * Bezahlte Teilnahmen bleiben aussen vor: da haengt Geld dran, das erst
     * erstattet werden muss. */
    if (req.method === "POST" && url === "/api/admin/absage") {
      const mail = String(q.get("email") || "").toLowerCase().trim();
      const inv = findInvite(q.get("t")) ||
                  (mail ? Object.values(state.invites).find(i => (i.email || "").toLowerCase() === mail) : null);
      if (!inv) return json(res, 404, { error: "Gast nicht gefunden" });
      if (inv.status === "bezahlt") {
        return json(res, 409, { error: "bereits bezahlt – erst in Stripe erstatten" });
      }
      inv.status = q.get("zurueck") === "1" ? "offen" : "abgesagt";
      logEvent(inv.status === "abgesagt" ? "abgesagt" : "zurueckgesetzt", inv.name, inv.pool);
      dirty = true;
      return json(res, 200, { ok: true, name: inv.name, status: inv.status });
    }

    if (req.method === "POST" && url === "/api/admin/testgast") {
      const token = newToken();
      const typ = q.get("typ") === "ehrengast" ? "ehrengast" : "ticket";
      const partner = cleanText(q.get("partner") || "", 60);
      const logo = partner
        ? "partner-" + partner.toLowerCase().replace(/\.ai$/, "").replace(/[^a-z0-9]/g, "") + "-neg.png"
        : "";
      /* Eigene Adresse, damit die Bestaetigungsmail beim Test wirklich
       * ankommt und geprueft werden kann - statt an eine Sammeladresse zu
       * gehen, die vielleicht gar nicht existiert und dann bounct. */
      const mail = clean(q.get("email"), 120).toLowerCase();
      /* Abweichender Betrag in Cent. Eine Live-Zahlung ueber 1 Euro beweist
       * dasselbe wie eine ueber 100 - kostet aber nur die Gebuehr, falls
       * die Rueckerstattung liegen bleibt. Nur fuer Testgaeste. */
      const preis = Math.max(100, Math.min(10000, parseInt(q.get("preis"), 10) || 0));
      const inv = state.invites[token] = {
        token, pool: "Stripe-Test", typ,
        name: "Testgast " + (partner || (typ === "ehrengast" ? "Ehrengast" : "Bezahlgast")),
        email: (mail.indexOf("@") > 0 ? mail : "stripe-test@planyvo.com"),
        firma: "", anrede: "Liebe", partner, partnerLogo: logo,
        status: "offen",
        preis: q.get("preis") ? preis : 0,
        mail: { sent: 0, delivered: 0, opened: 0, clicked: 0 },
        daten: {}, zahlung: null,
        ticketNr: ticketNummerVergeben(token), t: Date.now()
      };
      dirty = true;
      return json(res, 200, { ok: true, token, typ, partner, partnerLogo: logo,
                              email: inv.email, preis: preisVon(inv),
                              link: inviteLink(token) });
    }
    if (req.method === "POST" && url === "/api/admin/testgast-loeschen") {
      const inv = findInvite(q.get("t"));
      if (!inv) return json(res, 404, { error: "nicht gefunden" });
      if (inv.pool !== "Stripe-Test") return json(res, 403, { error: "nur Stripe-Test-Gäste löschbar" });
      delete state.invites[inv.token];
      dirty = true;
      return json(res, 200, { ok: true, geloescht: inv.name });
    }

    /* E-Mail-Adresse eines Gastes korrigieren (z. B. nach Hard Bounce durch
     * Tippfehler in der Liste). Token, Status und Historie bleiben; die
     * Bounce-Sperre wird aufgehoben, damit die naechste Welle die neue
     * Adresse wieder anschreibt. */
    if (req.method === "POST" && url === "/api/admin/email-korrektur") {
      const inv = findInvite(q.get("t")) ||
                  Object.values(state.invites).find(i => i.email === String(q.get("alt") || "").toLowerCase());
      if (!inv) return json(res, 404, { error: "Gast nicht gefunden" });
      const neu = clean(q.get("email"), 120).toLowerCase();
      if (!neu || neu.indexOf("@") < 1) return json(res, 400, { error: "neue Adresse fehlt/ungültig" });
      const vorher = inv.email;
      inv.email = neu;
      inv.mail = inv.mail || { sent: 0, delivered: 0, opened: 0, clicked: 0 };
      inv.mail.bounced = 0;
      logEvent("adresse korrigiert", inv.name, inv.pool);
      dirty = true;
      return json(res, 200, { ok: true, gast: inv.name, vorher, jetzt: neu });
    }

    /* Oeffnungs-/Klickmarker eines Gastes zuruecksetzen - fuer den Fall,
     * dass das Team beim Testen einen fremden Link angetippt hat (haeufig
     * bei den WhatsApp-Links). Bewusst NUR opened/clicked: Zusagen,
     * Zahlungen und Zustellstatus bleiben unantastbar. */
    if (req.method === "POST" && url === "/api/admin/mailstatus-reset") {
      const inv = findInvite(q.get("t")) ||
                  Object.values(state.invites).find(i => i.email === String(q.get("email") || "").toLowerCase());
      if (!inv) return json(res, 404, { error: "Gast nicht gefunden" });
      const vorher = { opened: inv.mail.opened || 0, clicked: inv.mail.clicked || 0 };
      inv.mail.opened = 0;
      inv.mail.clicked = 0;
      dirty = true;
      return json(res, 200, { ok: true, gast: inv.name, zurueckgesetzt: vorher });
    }

    /* Mailstatus je Gast fuer den Monitor: Wer hat welche Mail bekommen,
     * wurde sie zugestellt, geoeffnet, geklickt? Die Zeitstempel kommen aus
     * den Lettermint-Webhooks; Klicks erkennt der Server auch selbst, sobald
     * ein Gast seine Landing Page oeffnet. Der Token bleibt draussen - die
     * Links stehen in der Versandliste, hier geht es nur um den Status. */
    if (url === "/api/admin/gaeste") {
      /* "Versendet" speist sich aus zwei Quellen: dem sent-Webhook von
       * Lettermint UND dem Versand-Gedaechtnis der CLI (nur LESEND - die
       * Datei gehoert der CLI, siehe dort). So zeigt der Monitor den
       * Versand auch, wenn der Webhook noch nicht eingerichtet ist. */
      const vlog = versandLogLesenGepuffert();
      const gaeste = Object.values(state.invites).map(inv => {
        const mail = Object.assign({ sent: 0, delivered: 0, opened: 0, clicked: 0 }, inv.mail);
        if (!mail.sent && hasOwn(vlog, inv.token)) {
          const zeiten = Object.values(vlog[inv.token]);
          if (zeiten.length) mail.sent = Math.min.apply(null, zeiten);
        }
        /* Der Stand JE WELLE - das ist die Zeile, die im Monitor wirklich
         * etwas aussagt. "Verschickt" kommt dabei aus dem Versand-
         * Gedaechtnis und nicht aus dem Webhook: es ist die einzige
         * Quelle, die auch dann stimmt, wenn Lettermint nichts meldet. */
        const wellen = {};
        for (const n of Object.keys(hasOwn(vlog, inv.token) ? vlog[inv.token] : {})) {
          const w = (inv.wellen && inv.wellen[n]) || {};
          wellen[n] = { sent: vlog[inv.token][n] || w.sent || 0,
                        delivered: w.delivered || 0, opened: w.opened || 0, clicked: w.clicked || 0 };
        }
        /* Wellen, von denen nur der Webhook weiss (Versand-Log verloren) */
        for (const n of Object.keys(inv.wellen || {})) {
          if (!hasOwn(wellen, n)) wellen[n] = Object.assign({ sent: 0, delivered: 0, opened: 0, clicked: 0 }, inv.wellen[n]);
        }
        return {
          wellen,
          /* Von Hand per WhatsApp verschickt - je Welle ein Zeitpunkt.
           * Steht neben den Mailwellen, damit ein Gast ohne Adresse nicht
           * aussieht, als haette man ihn vergessen. */
          whatsapp: inv.whatsapp || {},
          pool: inv.pool,
          typ: inv.typ,
          name: inv.name,
          email: inv.email,
          partner: inv.partner || "",
          status: inv.status,
          abgemeldet: inv.abgemeldet || 0,
          /* Die Angaben aus dem Zusageformular - der Monitor zeigt sie in
           * der Kuechenliste. Unvertraeglichkeiten sind Gesundheitsdaten:
           * sie stehen nur hinter dem Admin-Zugang, so wie Namen und
           * Adressen auch, und werden nach dem Event geloescht. */
          firma: inv.firma || "",
          rolle: inv.rolle || "",
          daten: {
            phone: (inv.daten && inv.daten.phone) || "",
            diet: (inv.daten && inv.daten.diet) || "",
            allergy: (inv.daten && inv.daten.allergy) || ""
          },
          ticketNr: inv.ticketNr || "",
          /* Nur der gebuchte Betrag und wann - fuer "zuletzt bezahlt" im
           * Monitor. Session- und PaymentIntent-ID bleiben hier drin. */
          zahlung: (inv.zahlung && inv.zahlung.paidAt)
            ? { betrag: inv.zahlung.amount || 0, t: inv.zahlung.paidAt }
            : null,
          mail
        };
      });
      gaeste.sort((a, b) => (a.pool || "").localeCompare(b.pool || "") || (a.name || "").localeCompare(b.name || ""));
      return json(res, 200, { ok: true, gaeste });
    }
  }

  /* --- Statik --- */

  /* Bilder der Mailings: /assets/<datei> -> email/assets/<datei>
   * E-Mails können keine Data-URIs laden, deshalb brauchen Porträts, Header und
   * Partnerwand feste Adressen. Lange Cache-Zeit, weil Mail-Clients die Bilder
   * ohnehin zwischenspeichern. */
  if ((req.method === "GET" || req.method === "HEAD") && url.startsWith("/assets/")) {
    let name;
    try { name = path.basename(decodeURIComponent(url.slice(8))); }   // basename kappt ../
    catch (e) { return json(res, 400, { error: "ungültiger Name" }); }
    const TYP = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                  ".svg": "image/svg+xml", ".webp": "image/webp",
                  /* Kapitalis-Webfont fuer die Mails: Apple Mail laedt
                   * @font-face, dann sitzt die CI-Schrift auch mobil. */
                  ".woff2": "font/woff2" };
    const typ = TYP[path.extname(name).toLowerCase()];
    // Nur unbedenkliche Dateinamen: ein Null-Byte o.ae. laesst fs.readFile sonst
    // synchron werfen -> Prozessabsturz. Allowlist statt Blocklist.
    if (!name || !typ || !/^[A-Za-z0-9._-]+$/.test(name)) { res.writeHead(404); return res.end("nicht gefunden"); }
    return fs.readFile(path.join(ROOT, "email", "assets", name), (err, buf) => {
      if (err) { res.writeHead(404); return res.end("nicht gefunden"); }
      res.writeHead(200, {
        "Content-Type": typ,
        "Content-Length": buf.length,
        "Cache-Control": "public, max-age=2592000",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  }

  /* Persoenliches Save the Date als Webseite - fuer Gaeste, die (noch) keine
   * Mailadresse haben und ihren Link per WhatsApp bekommen. Dieselbe Vorlage
   * wie die Mail, mit Anrede des Gastes. Das Oeffnen zaehlt als "geoeffnet":
   * fuer diese Gaeste IST diese Seite das Mailing, und der Monitor liest sich
   * dann fuer alle gleich (geoeffnet -> geklickt -> zugesagt). */
  if (req.method === "GET" && url === "/std") {
    const inv = findInvite(q.get("t"));
    if (!inv) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(abmeldeSeite("ungueltig", ""));
    }
    /* Link-Vorschau-Roboter (WhatsApp, Telegram & Co. holen die Seite fuer
     * das Vorschaubild) duerfen nicht als Gast-Oeffnung zaehlen. */
    const ua = String(req.headers["user-agent"] || "");
    const vorschauBot = /whatsapp|facebookexternalhit|telegrambot|slackbot|twitterbot|linkedinbot|discordbot|skypeuripreview/i.test(ua);
    /* Diese Seite IST das Save the Date - also Welle 0, unabhaengig davon,
     * was der Gast sonst schon geoeffnet hat. */
    if (!vorschauBot) {
      const w0 = wellenMail(inv, "0");
      if (!w0.opened) {
        w0.opened = Date.now();
        if (!inv.mail.opened) inv.mail.opened = w0.opened;
        logEvent("geöffnet", inv.name, (inv.pool || "") + " · Welle 0");
        dirty = true;
      }
    }
    let seite;
    try { seite = renderMail(inv, "save-the-date.html"); }
    catch (e) { res.writeHead(500); return res.end("Vorlage fehlt"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(seite);
  }

  if (req.method === "GET" && (url === "/einladung" || url === "/landing.html")) {
    return serveFile(res, "landing.html", "text/html; charset=utf-8");
  }
  if (req.method === "GET" && (url === "/monitor" || url === "/monitor.html")) {
    return serveFile(res, "monitor.html", "text/html; charset=utf-8");
  }
  if (req.method === "GET" && (url === "/station" || url === "/station.html")) {
    return serveFile(res, "station.html", "text/html; charset=utf-8");
  }
  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    return serveFile(res, "index.html", "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url === "/termin.ics") {
    res.writeHead(200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="the-circle-no1.ics"',
      "Cache-Control": "public, max-age=3600"
    });
    return res.end(TERMIN_ICS);
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

/* ---------- CLI: Gästeliste rein, Versandliste raus ---------- */
const argv = process.argv.slice(2);
const [befehl, arg] = argv;
const flagge = name => argv.some(a => a === "--" + name);
const wert = name => {
  const t = argv.find(a => a.startsWith("--" + name + "="));
  return t ? t.slice(name.length + 3) : "";
};

if (befehl === "import") {
  if (!arg) { console.error("Aufruf: node server/circle-server.js import gaeste.csv"); process.exit(1); }
  let ergebnis;
  try {
    ergebnis = importRows(parseCSV(fs.readFileSync(arg, "utf8")));
  } catch (e) { console.error("Import fehlgeschlagen: " + e.message); process.exit(1); }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  console.log(`Import: ${ergebnis.neu} neu, ${ergebnis.aktualisiert} aktualisiert, ${ergebnis.gesamt} Gäste gesamt.`);
  /* Eine geaenderte Adresse ist die einzige stille Aenderung am Register -
   * sie muss ein Mensch gesehen haben. */
  for (const a of ergebnis.adressen)
    console.log(`  Adresse geändert: ${a.name}  ${a.vorher}  →  ${a.jetzt}`);
  for (const p of poolStats()) console.log(`  ${p.pool.padEnd(24)} ${String(p.gesamt).padStart(4)}  (${p.typ})`);
  console.log("\nVersandliste für Lettermint:  node server/circle-server.js export > versand.csv");
  process.exit(0);
}

/* Kuechenliste: was das Catering wirklich braucht, ohne alles andere.
 * Nur Gaeste, die zugesagt oder bezahlt haben - wer noch nicht geantwortet
 * hat, isst auch nichts. Am Ende die Summen, damit die Kueche nicht zaehlen
 * muss.
 *
 *   node server/circle-server.js kueche              Uebersicht
 *   node server/circle-server.js kueche --csv        als Tabelle
 */
if (befehl === "kueche") {
  const dabei = Object.values(state.invites)
    .filter(i => i.status === "zugesagt" || i.status === "bezahlt")
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const kost = { alles: "Alles", vegetarisch: "Vegetarisch", vegan: "Vegan", pescetarisch: "Pescetarisch" };
  const zeile = i => ({
    name: i.name || "", diet: (i.daten && i.daten.diet) || "",
    allergy: (i.daten && i.daten.allergy) || "", phone: (i.daten && i.daten.phone) || ""
  });

  if (flagge("csv")) {
    const raus = [["name", "ernaehrung", "unvertraeglichkeiten", "mobil", "status"]];
    for (const i of dabei) {
      const z = zeile(i);
      raus.push([z.name, kost[z.diet] || z.diet, z.allergy, z.phone, i.status]);
    }
    process.stdout.write(raus.map(r => r.map(csvCell).join(",")).join("\n") + "\n");
    process.exit(0);
  }

  console.log("Küchenliste · " + dabei.length + " zugesagte Gäste\n");
  const zaehl = {};
  for (const i of dabei) {
    const z = zeile(i);
    zaehl[z.diet || "(nicht angegeben)"] = (zaehl[z.diet || "(nicht angegeben)"] || 0) + 1;
    console.log("  " + (z.name || "?").padEnd(28) +
                (kost[z.diet] || z.diet || "—").padEnd(15) +
                (z.allergy ? "⚠ " + z.allergy : ""));
  }
  console.log("\nNach Ernährung:");
  for (const [k, n] of Object.entries(zaehl).sort((a, b) => b[1] - a[1]))
    console.log("  " + (kost[k] || k).padEnd(20) + n);
  const allergien = dabei.map(zeile).filter(z => z.allergy);
  console.log("\nUnverträglichkeiten: " + allergien.length);
  for (const z of allergien) console.log("  " + z.name.padEnd(28) + z.allergy);
  console.log("\nAls Tabelle:  node server/circle-server.js kueche --csv > kueche.csv");
  process.exit(0);
}

if (befehl === "export") {
  const zeilen = [["pool", "typ", "anrede", "vorname", "name", "email", "firma", "rolle", "mobil", "ernaehrung", "unvertraeglichkeiten", "partner_name", "partner_logo_url", "platz_satz", "link", "app_link", "std_link", "ticket_nr", "status", "abgemeldet"]];
  for (const inv of Object.values(state.invites)) {
    zeilen.push([inv.pool, inv.typ, inv.anrede || "Hallo", (inv.name || "").split(" ")[0],
                     inv.name, inv.email, inv.firma || "", inv.rolle || "",
                     (inv.daten && inv.daten.phone) || "", (inv.daten && inv.daten.diet) || "",
                     (inv.daten && inv.daten.allergy) || "",
                     inv.partner || "", inv.partnerLogo || "",
                     platzSatz(inv), inviteLink(inv.token), appLink(inv.token), stdLink(inv.token), inv.ticketNr, inv.status,
                     inv.abgemeldet ? "ja" : ""]);
  }
  process.stdout.write(zeilen.map(r => r.map(csvCell).join(",")).join("\n") + "\n");
  process.exit(0);
}

/* Vorflugkontrolle vor einer Welle. Der Trockenlauf beantwortet "bricht das
 * Rendern?" - dieser Befehl beantwortet "stimmt, was da rausgeht?".
 *
 *   node server/circle-server.js pruefen 1
 *   node server/circle-server.js pruefen 1 --bilder   ruft jede Bild-URL ab
 *
 * FEHLER halten den Versand auf, WARNUNG will ein Mensch gesehen haben.
 * Was der Befehl NICHT kann: erkennen, ob jemand in der Gaesteliste als
 * Ehrengast steht, der eigentlich zahlen soll. Dafuer gibt es --beleg.
 */
if (befehl === "pruefen") {
  const ERLAUBT_P = /^--(bilder|beleg)$/;
  const kaputtP = argv.slice(2).filter(a => !ERLAUBT_P.test(a));
  if (kaputtP.length) {
    console.error("Unbekanntes Argument: " + kaputtP.join(" "));
    console.error("Aufruf: node server/circle-server.js pruefen <0|1|2> [--bilder] [--beleg]");
    process.exit(1);
  }
  const nrP = String(arg || "").replace(/[^0-9]/g, "");
  const welleP = hasOwn(WELLEN, nrP) ? WELLEN[nrP] : null;
  if (!welleP) {
    console.error("Aufruf: node server/circle-server.js pruefen <0|1|2> [--bilder] [--beleg]");
    process.exit(1);
  }
  const fehler = [], warnung = [];
  const merke = (liste, gast, text) => liste.push((gast || "—").padEnd(28) + " " + text);

  const alleGaeste = Object.values(state.invites);
  const empfaenger = alleGaeste.filter(inv =>
    inv.email && !inv.abgemeldet && !(inv.mail && inv.mail.bounced) && welleP.gilt(inv));

  /* --- Register als Ganzes: Doppelgaenger faenden erst beim Gast auf --- */
  const proMail = {}, proName = {};
  for (const inv of alleGaeste) {
    if (inv.email) (proMail[inv.email.toLowerCase()] ||= []).push(inv);
    const n = (inv.name || "").toLowerCase().trim();
    if (n) (proName[n] ||= []).push(inv);
  }
  for (const [mail, liste] of Object.entries(proMail))
    if (liste.length > 1) merke(fehler, liste[0].name, "Adresse " + mail + " steht " + liste.length + "× im Register (" + liste.map(i => i.pool).join(", ") + ")");
  for (const [, liste] of Object.entries(proName))
    if (liste.length > 1) merke(warnung, liste[0].name, "steht " + liste.length + "× im Register – zwei Einladungen? (" + liste.map(i => i.email || "ohne Adresse").join(", ") + ")");

  /* --- Gast fuer Gast --- */
  const bilder = new Set();
  const beleg = [];
  for (const inv of empfaenger) {
    const g = inv.name || inv.email;
    if (!(inv.name || "").trim()) merke(fehler, inv.email, "kein Name – die Anrede bliebe leer");
    if (!inv.anrede) merke(warnung, g, "keine Anrede – die Mail beginnt mit „Hallo“");
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(inv.email)) merke(fehler, g, "Adresse sieht nicht wie eine Adresse aus: " + inv.email);
    if (inv.email !== inv.email.trim() || /\s/.test(inv.email)) merke(fehler, g, "Leerzeichen in der Adresse: „" + inv.email + "“");
    if (inv.typ !== "ticket" && inv.typ !== "ehrengast") merke(fehler, g, "unbekannter Typ „" + inv.typ + "“");
    /* Der teuerste denkbare Fehler: ein Gast, den ein Partner eingeladen
     * hat, wird nach 100 Euro gefragt. */
    if (inv.partner && inv.typ === "ticket") merke(fehler, g, "kommt über Partner " + inv.partner + ", ist aber Bezahlgast – zahlt er wirklich?");
    if (inv.partner && !inv.partnerLogo) merke(fehler, g, "Partner " + inv.partner + " ohne Logo – die Mail zeigt ein leeres Feld");
    if (inv.partnerLogo && !inv.partner) merke(warnung, g, "Logo hinterlegt, aber kein Partnername");

    const datei = welleP.vorlage(inv);
    let html;
    try { html = renderMail(inv, datei); }
    catch (e) { merke(fehler, g, "Vorlage " + datei + " bricht: " + e.message); continue; }

    const offen = html.match(/\{\{\s*[a-z_]+\s*\}\}/gi);
    if (offen) merke(fehler, g, "Platzhalter nicht ersetzt: " + [...new Set(offen)].join(" "));

    /* Jeder Link muss auf unsere Basis zeigen und den Token DIESES Gastes
     * tragen - ein vertauschter Link waere der Fehler, den niemand sieht. */
    const fremd = (html.match(/href="(https?:\/\/[^"]+)"/g) || [])
      .map(h => h.slice(6, -1))
      .filter(u => u.startsWith(PUBLIC_URL + "/") && !u.includes(inv.token));
    if (fremd.length) merke(fehler, g, "Link mit fremdem Token: " + fremd[0]);
    if (nrP !== "0" && !html.includes(inviteLink(inv.token))) merke(fehler, g, "der persönliche Link fehlt in der Mail");

    for (const m of html.match(/src="(https?:\/\/[^"]+)"/g) || []) bilder.add(m.slice(5, -1));
    beleg.push([inv.pool || "-", inv.name, inv.email, inv.typ === "ehrengast" ? "Ehrengast" : "Bezahlgast 100 €",
                inv.partner || "—", datei, welleP.betreff(inv)]);
  }

  console.log("Vorflugkontrolle · " + welleP.name);
  console.log("Links & Bilder über: " + PUBLIC_URL);
  console.log(empfaenger.length + " Empfänger von " + alleGaeste.length + " im Register\n");

  const uebrig = alleGaeste.length - empfaenger.length;
  if (uebrig) {
    const ohneMail = alleGaeste.filter(i => !i.email).length;
    const raus = alleGaeste.filter(i => i.abgemeldet).length;
    const tot = alleGaeste.filter(i => i.email && i.mail && i.mail.bounced).length;
    const nichtDran = uebrig - ohneMail - raus - tot;
    console.log("Nicht dabei: " + ohneMail + " ohne Adresse · " + tot + " unzustellbar · " +
                raus + " abgemeldet · " + nichtDran + " nach Status dieser Welle\n");
  }

  const zeigen = () => {
    for (const z of fehler) console.log("  FEHLER   " + z);
    for (const z of warnung) console.log("  WARNUNG  " + z);
    console.log("");
    console.log(fehler.length + " Fehler · " + warnung.length + " Warnungen");
    if (flagge("beleg")) {
      console.log("\nBeleg – wer bekommt was (zum Gegenlesen):\n");
      for (const b of beleg)
        console.log("  " + b[0].padEnd(22) + " " + b[1].padEnd(26) + " " + b[3].padEnd(18) +
                    " Partner: " + b[4].padEnd(16) + " " + b[5]);
    }
    process.exit(fehler.length ? 1 : 0);
  };

  if (!flagge("bilder")) {
    console.log("(Bild-URLs nicht geprüft – dafür --bilder anhängen)\n");
    return zeigen();
  }

  /* Ein fehlendes Logo faellt sonst erst auf, wenn 30 Partnergaeste ein
   * leeres Kaestchen sehen. Deshalb jede URL einmal wirklich abrufen. */
  const urls = [...bilder];
  let offenN = urls.length;
  console.log("Prüfe " + offenN + " Bild-Adressen …\n");
  for (const u of urls) {
    const mod = u.startsWith("https:") ? https : http;
    const req = mod.request(u, { method: "HEAD", timeout: 10000 }, r => {
      if (r.statusCode !== 200) merke(fehler, "Bild", u + " antwortet mit " + r.statusCode);
      r.resume();
      if (--offenN === 0) zeigen();
    });
    req.on("timeout", () => req.destroy(new Error("Zeitüberschreitung")));
    req.on("error", e => { merke(fehler, "Bild", u + " nicht erreichbar: " + e.message); if (--offenN === 0) zeigen(); });
    req.end();
  }
}

/* Einladungen fuer Gaeste, die keine Mailadresse haben - sie bekommen
 * denselben persoenlichen Link, nur von Hand ueber WhatsApp statt per Mail.
 * Der Link ist derselbe wie in der Mail, also zaehlt auch die Zusage gleich.
 *
 *   node server/circle-server.js whatsapp          nur Gaeste ohne Adresse
 *   node server/circle-server.js whatsapp --alle   alle Gaeste
 *
 * Bewusst KEIN Eintrag im Versand-Gedaechtnis: Ob die Nachricht wirklich
 * rausging, weiss nur der Mensch, der sie verschickt hat. Wer spaeter eine
 * Adresse nachtraegt, soll die Mail trotzdem bekommen.
 */
if (befehl === "whatsapp") {
  const alle = argv.slice(1).includes("--alle");
  const kaputt = argv.slice(1).filter(a => a !== "--alle");
  if (kaputt.length) {
    console.error("Aufruf: node server/circle-server.js whatsapp [--alle]");
    process.exit(1);
  }
  /* Wer unter demselben Namen anderswo MIT Adresse im Register steht, bekommt
   * seine Einladung schon per Mail. Ihn hier nochmal aufzufuehren hiesse: der
   * Gast wird zweimal angeschrieben, per Mail und per WhatsApp. Kommt vor,
   * wenn eine aeltere Liste denselben Menschen ohne Adresse enthielt. */
  const mitMail = new Set(Object.values(state.invites)
    .filter(i => i.email).map(i => (i.name || "").trim().toLowerCase()));
  const doppelt = [];
  const gaeste = Object.values(state.invites)
    .filter(inv => {
      if (inv.abgemeldet || inv.status === "abgesagt") return false;
      if (!alle && inv.email) return false;
      if (!inv.email && mitMail.has((inv.name || "").trim().toLowerCase())) {
        doppelt.push(inv); return false;
      }
      return true;
    })
    .sort((a, b) => (a.pool || "").localeCompare(b.pool || "") || (a.name || "").localeCompare(b.name || ""));

  if (doppelt.length) {
    console.log("Nicht dabei, weil sie ihre Einladung per Mail bekommen:");
    for (const i of doppelt) console.log("  " + (i.name || "?") + "  (Pool " + (i.pool || "-") + ", ohne Adresse)");
    console.log("");
  }

  if (!gaeste.length) {
    console.log(alle ? "Keine Gäste in der Liste." : "Alle Gäste haben eine Mailadresse – nichts zu tun.");
    process.exit(0);
  }
  console.log(gaeste.length + (alle ? " Gäste" : " Gäste ohne Mailadresse") + "\n");
  for (const inv of gaeste) {
    console.log("─".repeat(72));
    console.log((inv.name || "(ohne Namen)") + "   ·   " + (inv.pool || "-") +
                "   ·   " + (inv.typ === "ehrengast" ? "Ehrengast" : "Bezahlgast, 100 €"));
    console.log("");
    console.log(whatsappText(inv));
    console.log("");
  }
  process.exit(0);
}

/* Wellenversand.
 *   node server/circle-server.js welle 1                  -> Trockenlauf
 *   node server/circle-server.js welle 1 --senden         -> verschickt wirklich
 *   ... --pool=neuland             nur Pools, deren Name das enthaelt
 *   ... --typ=ehrengast            nur Ehrengaeste (oder --typ=ticket)
 *   ... --nur=max@example.com      genau eine Adresse (Testmail; ueberspringt
 *                                  Status-Regeln UND Versand-Gedaechtnis)
 *   ... --limit=5                  hoechstens fuenf Mails
 *   ... --erneut                   auch an bereits Angeschriebene dieser Welle
 *   ... --vorschau=datei.html      erste fertige Mail auf die Platte legen
 *
 * Voreinstellung ist immer der Trockenlauf: Er zeigt Zeile fuer Zeile, wer
 * welche Vorlage bekaeme, und rendert jede Mail komplett durch. Ein fehlender
 * Platzhalter oder eine kaputte Vorlage faellt hier auf - nicht erst, wenn
 * 200 Gaeste "{{vorname}}" in der Anrede lesen.
 *
 * Doppelversand-Schutz: Jeder Erfolg landet sofort im Versand-Gedaechtnis
 * (versand-log.json). Ein zweiter Lauf derselben Welle - etwa nach einem
 * Abbruch bei Mail 120 von 200 - schickt nur an die, die noch fehlen.
 */
if (befehl === "welle") {
  /* Unbekannte oder wertlose Argumente hart abweisen: "--nur max@x.de"
   * (Leerzeichen statt =) wuerde sonst still ignoriert - und der Befehl,
   * der eine Testmail schicken sollte, schickt die ganze Welle. */
  const ERLAUBT = /^--(senden|erneut|pool=.+|typ=.+|nur=.+|limit=[1-9]\d*|vorschau=.+)$/;
  const kaputt = argv.slice(2).filter(a => !ERLAUBT.test(a));
  if (kaputt.length) {
    console.error("Unbekanntes oder unvollständiges Argument: " + kaputt.join(" "));
    console.error("Aufruf: node server/circle-server.js welle <0|1|2> [--senden] [--erneut] [--pool=…] [--typ=…] [--nur=mail] [--limit=n] [--vorschau=datei.html]");
    console.error("Werte immer mit '=': --nur=max@example.com (nicht: --nur max@example.com)");
    process.exit(1);
  }
  const nr = String(arg || "").replace(/[^0-9]/g, "");
  const welle = hasOwn(WELLEN, nr) ? WELLEN[nr] : null;
  if (!welle) {
    console.error("Aufruf: node server/circle-server.js welle <0|1|2> [--senden] [--erneut] [--pool=…] [--typ=…] [--nur=mail] [--limit=n]");
    process.exit(1);
  }
  const echt = flagge("senden");
  const erneut = flagge("erneut");
  const nurPool = wert("pool").toLowerCase();
  const nurMail = wert("nur").toLowerCase();
  /* Ehrengaeste koennen losgeschickt werden, bevor Stripe steht - fuer
   * Bezahlgaeste liefe der Knopf "Weiter zur Zahlung" ins Leere. Ein
   * vertippter Wert wuerde sonst still niemanden treffen, deshalb hart. */
  const nurTyp = wert("typ").toLowerCase();
  if (nurTyp && nurTyp !== "ticket" && nurTyp !== "ehrengast") {
    console.error("--typ= kennt nur 'ticket' oder 'ehrengast' (nicht: " + nurTyp + ")");
    process.exit(1);
  }
  const limit = parseInt(wert("limit"), 10) || 0;

  /* Ohne PUBLIC_URL zeigt jeder Link und jedes Bild in den Mails auf
   * localhost - und im Trockenlauf faellt das niemandem auf. Deshalb steht
   * die Basis hier in der ersten Zeile, und der echte Versand verweigert. */
  if (echt && /^http:\/\/(localhost|127\.)/.test(PUBLIC_URL)) {
    console.error("PUBLIC_URL zeigt auf " + PUBLIC_URL + " – jede Mail enthielte localhost-Links.");
    console.error("So aufrufen:  PUBLIC_URL=https://thecircle.planyvo.com LETTERMINT_TOKEN=… node server/circle-server.js welle " + nr + " --senden");
    process.exit(1);
  }

  const log = versandLogLesen();
  const schonRaus = inv => !!(hasOwn(log, inv.token) && log[inv.token][nr]);

  let uebersprungen = 0, unzustellbar = 0;
  let gaeste = Object.values(state.invites).filter(inv => {
    if (!inv.email) return false;
    if (inv.abgemeldet) return false;                 // Abmeldung gilt fuer alle Wellen
    if (nurMail) return inv.email.toLowerCase() === nurMail;
    if (nurTyp && inv.typ !== nurTyp) return false;
    if (nurPool && !String(inv.pool || "").toLowerCase().includes(nurPool)) return false;
    if (!welle.gilt(inv)) return false;
    /* Tote Adressen (Bounce aus einer frueheren Welle) nicht erneut
     * anschreiben - jede weitere Mail dorthin schadet der Zustellbarkeit.
     * --erneut uebersteuert, etwa nach einer Adresskorrektur per Import.
     * Nach gilt() gezaehlt, damit der Kopf nur Gaeste ausweist, die die
     * Welle sonst wirklich bekaeme. */
    if (inv.mail && inv.mail.bounced && !erneut) { unzustellbar++; return false; }
    if (schonRaus(inv) && !erneut) { uebersprungen++; return false; }
    return true;
  });
  gaeste.sort((a, b) => (a.pool || "").localeCompare(b.pool || "") || (a.name || "").localeCompare(b.name || ""));
  if (limit) gaeste = gaeste.slice(0, limit);

  console.log(welle.name + (echt ? "  — VERSAND" : "  — Trockenlauf (nichts wird verschickt)"));
  console.log("Links & Bilder über: " + PUBLIC_URL);
  console.log(gaeste.length + " Empfänger" +
    (uebersprungen ? " · " + uebersprungen + " bereits angeschrieben (übersprungen, --erneut schickt trotzdem)" : "") +
    (unzustellbar ? " · " + unzustellbar + " unzustellbar (Bounce, übersprungen)" : "") + "\n");
  if (!gaeste.length) process.exit(0);

  /* Gaeste ohne Namen VOR dem Rendern abfangen: "Hallo ," in der Anrede
   * faellt sonst durch keinen Platzhalter-Check. */
  const namenlos = gaeste.filter(inv => !(inv.name || "").trim());
  if (namenlos.length) {
    console.error("ABBRUCH: " + namenlos.length + " Gast/Gäste ohne Namen – die Anrede wäre leer:");
    for (const inv of namenlos) console.error("  " + inv.email + "  (Pool " + (inv.pool || "-") + ")");
    console.error("Namen in der CSV ergänzen und neu importieren.");
    process.exit(1);
  }

  /* Erst alles rendern, dann erst senden: Bricht eine Vorlage, geht keine
   * halbe Welle raus. */
  const fertig = [];
  for (const inv of gaeste) {
    const datei = welle.vorlage(inv);
    let html;
    try { html = renderMail(inv, datei); }
    catch (e) { console.error("ABBRUCH bei " + inv.email + ": " + e.message); process.exit(1); }
    fertig.push({ inv, datei, html, betreff: welle.betreff(inv), text: textFassung(inv, Number(nr)) });
  }

  for (const m of fertig) {
    console.log("  " + (m.inv.pool || "-").padEnd(22) + " " +
                (m.inv.name || "").padEnd(26) + " " + m.inv.email.padEnd(32) + " " + m.datei +
                /* Welle 0 hat keine Partnervorlage - da waere die Warnung Laerm. */
                (nr === "0" ? ""
                  : m.inv.partner && m.inv.typ === "ticket"
                    /* Der teuerste Tippfehler der Liste: Gast eines Partners
                     * als "ticket" importiert - er wuerde 100 Euro zahlen
                     * sollen UND das Logo seines Gastgebers nicht sehen. */
                    ? "   ⚠ Partner-Gast als ZAHLGAST – typ auf ehrengast ändern?"
                    : m.inv.partner && !m.inv.partnerLogo
                      ? "   ⚠ Partner ohne Logo – Basisvorlage"
                      : ""));
  }

  /* --vorschau=datei.html legt die erste fertige Mail auf die Platte - genau
   * so, wie sie beim Gast ankaeme, mit seinem Namen und seinem Link. */
  const vorschau = wert("vorschau");
  if (vorschau) {
    fs.writeFileSync(vorschau, fertig[0].html);
    console.log("\nVorschau (" + fertig[0].inv.email + ", Betreff: " + fertig[0].betreff + ") → " + vorschau);
  }

  if (!echt) {
    console.log("\nNichts verschickt. Zum Senden dieselbe Zeile noch einmal mit  --senden");
    console.log("Vorher empfohlen:  --nur=deine@adresse.de --senden   (eine Testmail an dich selbst)");
    process.exit(0);
  }
  if (!LETTERMINT_TOKEN) { console.error("\nLETTERMINT_TOKEN fehlt – kein Versand."); process.exit(1); }

  /* Sind Bezahlgaeste dabei, muss der LAUFENDE Server Stripe scharf haben -
   * und zwar im Live-Modus. Sonst klicken sie "Weiter zur Zahlung" und
   * landen in einer Fehlermeldung oder, schlimmer, in einem Testkonto:
   * 48 Zusagen ohne einen Cent, und niemandem faellt es auf.
   * Der Versand laeuft in einem eigenen Prozess ohne die Panel-Variablen,
   * kann Stripe also nicht selbst pruefen - deshalb die Gesundheitsseite
   * des Servers fragen, der die Zahlungen tatsaechlich entgegennimmt. */
  let i = 0, ok = 0, fehler = 0;
  const mitBezahlgaesten = fertig.some(m => m.inv.typ === "ticket");
  if (!mitBezahlgaesten) return versandStarten();

  https.get(PUBLIC_URL + "/api/live/health", { timeout: 10000 }, r => {
    let roh = "";
    r.on("data", c => roh += c);
    r.on("end", () => {
      let g = {};
      try { g = JSON.parse(roh); } catch (e) { /* unten abgefangen */ }
      const zahl = fertig.filter(m => m.inv.typ === "ticket").length;
      if (!g.stripe || g.stripeModus !== "live" || !g.stripeWebhook) {
        console.error("\nABBRUCH: " + zahl + " Bezahlgäste in dieser Welle, aber der Server unter");
        console.error(PUBLIC_URL + " kann keine Zahlungen annehmen:");
        console.error("  Stripe-Schlüssel: " + (g.stripe ? g.stripeModus.toUpperCase() : "fehlt"));
        console.error("  Webhook-Secret:   " + (g.stripeWebhook ? "gesetzt" : "FEHLT"));
        console.error("\nEntweder Stripe in Ordnung bringen – oder erst die Ehrengäste schicken:");
        console.error("  node server/circle-server.js welle " + nr + " --senden --typ=ehrengast");
        process.exit(1);
      }
      /* Gesetzte Schluessel heissen nicht, dass Stripe auch Geld annimmt:
       * ein pausiertes Konto sieht von aussen genauso aus. Deshalb einmal
       * wirklich eine Checkout-Sitzung anlegen - sie wird nie geoeffnet und
       * verfaellt von selbst. Genau dieser Fall (Konto pausiert, keine
       * Zahlungsart fuer Euro) waere sonst erst beim ersten Gast aufgefallen. */
      const probeGast = fertig.find(m => m.inv.typ === "ticket").inv;
      const daten = JSON.stringify({ t: probeGast.token });
      const anfrage = https.request(PUBLIC_URL + "/api/invite/checkout", {
        method: "POST", timeout: 15000,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(daten) }
      }, a => {
        let p = "";
        a.on("data", c => p += c);
        a.on("end", () => {
          let j = {};
          try { j = JSON.parse(p); } catch (e) { /* unten */ }
          if (a.statusCode === 200 && j.url) return versandStarten();
          /* Voller Kreis heisst nicht kaputtes Stripe: die Probe traf einen
           * Gast, der auf die Warteliste gehoert. Der Versand darf laufen. */
          if (j.warteliste) return versandStarten();
          console.error("\nABBRUCH: " + zahl + " Bezahlgäste in dieser Welle, aber Stripe");
          console.error("nimmt gerade kein Geld an. Antwort auf eine Testbuchung:");
          console.error("  " + (j.error || ("HTTP " + a.statusCode)));
          console.error("\nErst die Ehrengäste schicken:");
          console.error("  node server/circle-server.js welle " + nr + " --senden --typ=ehrengast");
          process.exit(1);
        });
      });
      anfrage.on("error", e => {
        console.error("\nABBRUCH: Stripe-Probe fehlgeschlagen: " + e.message);
        process.exit(1);
      });
      anfrage.end(daten);
    });
  }).on("error", e => {
    console.error("\nABBRUCH: Bezahlgäste in dieser Welle, aber " + PUBLIC_URL +
                  " antwortet nicht (" + e.message + ").");
    console.error("Läuft die App? Ohne sie kann niemand zusagen oder zahlen.");
    process.exit(1);
  });

  /* Nacheinander, nicht alle auf einmal: das schont das Sendelimit und die
   * Zustellbarkeit einer noch jungen Absenderdomain.
   * WICHTIG: Dieser Prozess schreibt live-state.json NICHT - die laufende
   * App darf waehrend des Versands weiterlaufen (Landing Page, Zusagen,
   * Zahlungen). Jeder Erfolg landet sofort im Versand-Gedaechtnis, damit
   * auch ein Strg-C bei Mail 120 von 200 nichts vergisst. */
  function versandStarten() { weiter(); }
  function weiter() {
    if (i >= fertig.length) {
      console.log("\n" + ok + " verschickt, " + fehler + " fehlgeschlagen.");
      if (fehler) console.log("Nochmal ausführen schickt NUR an die Fehlgeschlagenen (Versand-Gedächtnis).");
      console.log("Zugestellt/geöffnet/geklickt meldet Lettermint per Webhook an den laufenden Server.");
      process.exit(fehler ? 1 : 0);
    }
    const m = fertig[i++];
    lettermintSenden({
      to: m.inv.email, subject: m.betreff, html: m.html, text: m.text,
      abmeldeUrl: abmeldeLink(m.inv.token),
      metadata: { token: m.inv.token, welle: nr, pool: m.inv.pool || "" }
    }, (err, antwort) => {
      if (err) { fehler++; console.error("  FEHLER " + m.inv.email + ": " + err.message); }
      else {
        ok++;
        log[m.inv.token] = log[m.inv.token] || {};
        log[m.inv.token][nr] = Date.now();
        try { versandLogSchreiben(log); }
        catch (e) { console.error("  WARNUNG: Versand-Gedächtnis nicht schreibbar: " + e.message); }
        console.log("  ok     " + m.inv.email + "  " + ((antwort && antwort.message_id) || ""));
      }
      setTimeout(weiter, 250);
    });
  }
  return;
}

/* Letzte Verteidigungslinie: Am Eventabend ist ein weiterlaufender Server mit
 * einem geloggten Fehler besser als ein toter. Die bekannten Ein-Request-
 * Abstuerze sind oben gezielt behoben; das hier faengt kuenftige ab, damit ein
 * einzelner kaputter Request nie wieder App, Landing Page und Monitor mitreisst. */
process.on("uncaughtException", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error("Port " + PORT + " ist schon belegt – laeuft der Server bereits? Prozess beendet sich.");
    process.exit(1);
  }
  console.error("uncaughtException (Server laeuft weiter):", err && err.stack || err);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err && err.stack || err);
});

/* Ab hier laeuft nur noch der Server - und zwar NUR, wenn gar kein Befehl
 * angegeben wurde. Die meisten Befehle beenden sich vorher selbst; der echte
 * Versand und die Bilderpruefung warten dagegen auf Antworten und laufen bis
 * hierher weiter. Wuerde dann der Server starten und der Port waere schon von
 * der laufenden App belegt, brechen EADDRINUSE und der Fehlerhaken den Prozess
 * ab - mitten in einer Welle, nach vierzig von vierundneunzig Mails. */
if (befehl) {
  const BEKANNT = ["import", "export", "welle", "whatsapp", "pruefen", "kueche"];
  if (!BEKANNT.includes(befehl)) {
    console.error("Unbekannter Befehl: " + befehl);
    console.error("Bekannt: " + BEKANNT.join(", "));
    process.exit(1);
  }
  /* Befehl laeuft noch (Versand, Bilderpruefung) – er beendet sich selbst. */
} else server.listen(PORT, () => {
  /* Einmalig: alten Sammel-Stand auf die Wellen aufteilen. */
  wellenNachruesten();
  const stats = gesamtStats();
  console.log("THE CIRCLE läuft auf " + PUBLIC_URL);
  console.log("  Landing Page:  " + PUBLIC_URL + "/einladung?t=TOKEN");
  console.log("  App (Abend):   " + PUBLIC_URL + "/");
  console.log("  Gästeliste:    " + stats.gesamt + " Einladungen, " + stats.zugesagt + " zugesagt, " + stats.bezahlt + " bezahlt");
  console.log("  Stripe:        " + (STRIPE_KEY
    ? (STRIPE_KEY.startsWith("sk_live") ? "LIVE-Modus" : "Test-Modus")
      + (STRIPE_WEBHOOK_SECRET ? " · Webhook aktiv" : " · ACHTUNG: STRIPE_WEBHOOK_SECRET fehlt")
    : "nicht konfiguriert (Zusagen gehen, Zahlung nicht)"));
  console.log("  Monitor:       " + (ADMIN_TOKENS.size
    ? ADMIN_TOKENS.size + " Zugang/Zugänge (" + [...new Set(ADMIN_TOKENS.values())].join(", ") + ")"
    : "ACHTUNG: kein ADMIN_TOKEN/ADMIN_TOKENS gesetzt – /api/admin/* ist gesperrt (503)"));
});

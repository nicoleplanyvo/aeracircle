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
 *   { token, pool, typ:"ticket"|"ehrengast", name, email, firma,
 *     anrede,                                        <- "Liebe"/"Lieber", sonst "Hallo"
 *     partner, partnerLogo,                          <- wenn ein Partner eingeladen hat
 *     status:"offen"|"zugesagt"|"bezahlt"|"abgesagt",
 *     mail:{sent,delivered,opened,clicked},          <- Lettermint-Webhooks
 *     daten:{phone,diet,allergy},                    <- vom Gast selbst
 *     zahlung:{sessionId,paymentIntent,amount,paidAt},
 *     ticketNr }
 */

const newToken = () => crypto.randomBytes(9).toString("base64url");   // 12 Zeichen, unerratbar

function ticketNumber(token) {                 // stabile Nummer aus dem Token
  let h = 0;
  for (const c of token) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return "№ " + String(11 + (h % 88)).padStart(3, "0");
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

/* Satz ueber dem CTA der Ehrengast-Mail. Hat ein Partner eingeladen, waere
 * "Einladung des Hauses" ein Widerspruch zum Partner-Block darueber. */
function platzSatz(inv) {
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
    partnerLogo: inv.partnerLogo || "",
    firma: inv.firma || "",
    email: inv.email || "",
    pool: inv.pool,
    preis: inv.typ === "ticket" ? TICKET_PRICE : 0,
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
 *   pool, typ, name, email, firma, anrede, partner, partner_logo
 * typ: "ticket" (100 € über Stripe) oder "ehrengast" (nur Zusage).
 * Fehlt typ, gilt der Pool-Default aus poolTyp() – sonst "ticket".
 * Wiederholter Import aktualisiert bestehende Gäste (Schlüssel: E-Mail).
 */
function importRows(rows) {
  const header = rows[0].map(h => h.trim().toLowerCase());
  const col = name => header.indexOf(name);
  const iPool = col("pool"), iTyp = col("typ"), iName = col("name"),
        iMail = col("email") >= 0 ? col("email") : col("e-mail"), iFirma = col("firma"),
        iAnrede = col("anrede"), iPartner = col("partner"), iPartnerLogo = col("partner_logo");
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

  let neu = 0, aktualisiert = 0;
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
    if (inv) {
      inv.pool = pool; inv.typ = typ;
      inv.name = zeilenName || inv.name;
      if (email && !inv.email) {                     // WhatsApp-Gast bekommt Adresse
        inv.email = email;
        delete byNamePool[npKey(zeilenName, pool)];
        byMail[email] = inv;
      }
      if (iFirma >= 0) inv.firma = cleanText(r[iFirma], 80);
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
        anrede: iAnrede >= 0 ? cleanText(r[iAnrede], 12) : "",
        partner: iPartner >= 0 ? cleanText(r[iPartner], 60) : "",
        partnerLogo: iPartnerLogo >= 0 ? cleanText(r[iPartnerLogo], 200) : "",
        status: "offen",
        mail: { sent: 0, delivered: 0, opened: 0, clicked: 0 },
        daten: {},
        zahlung: null,
        ticketNr: ticketNumber(token),
        t: Date.now()
      };
      if (email) byMail[email] = inv;
      else byNamePool[npKey(zeilenName, pool)] = inv;
      neu++;
    }
  }
  dirty = true;
  return { neu, aktualisiert, gesamt: Object.keys(state.invites).length };
}

/* Pool-Defaults: Ehrengast-Pools brauchen kein Ticket. Namen frei erweiterbar. */
function poolTyp(pool) {
  return /ehrengast|gast des hauses|presse|jury|speaker|kuenstler|künstler/i.test(pool)
    ? "ehrengast" : "ticket";
}

function poolStats() {
  const pools = {};
  for (const inv of Object.values(state.invites)) {
    const p = pools[inv.pool] || (pools[inv.pool] = {
      pool: inv.pool, typ: inv.typ, gesamt: 0,
      versendet: 0, geoeffnet: 0, geklickt: 0,
      zugesagt: 0, bezahlt: 0, abgesagt: 0, offen: 0, umsatz: 0
    });
    p.gesamt++;
    if (inv.mail.sent) p.versendet++;
    if (inv.mail.opened) p.geoeffnet++;
    if (inv.mail.clicked) p.geklickt++;
    if (inv.status === "zugesagt" || inv.status === "bezahlt") p.zugesagt++;
    if (inv.status === "bezahlt") { p.bezahlt++; p.umsatz += (inv.zahlung && inv.zahlung.amount) || 0; }
    if (inv.status === "abgesagt") p.abgesagt++;
    if (inv.status === "offen") p.offen++;
  }
  return Object.values(pools).sort((a, b) => b.gesamt - a.gesamt);
}

function gesamtStats() {
  const all = Object.values(state.invites);
  const zaehl = f => all.filter(f).length;
  /* "Versendet" hat zwei Quellen: den sent-Webhook von Lettermint UND das
   * Versand-Gedaechtnis der CLI (nur lesend). Ohne das Log zeigte der
   * Monitor "0 versendet", obwohl die Welle laengst draussen ist. */
  let vlog = {};
  try { vlog = JSON.parse(fs.readFileSync(VERSAND_LOG, "utf8")); } catch (e) { /* kein Log = kein Versand */ }
  return {
    gesamt: all.length,
    versendet: zaehl(i => i.mail.sent || (hasOwn(vlog, i.token) && Object.keys(vlog[i.token]).length)),
    zugestellt: zaehl(i => i.mail.delivered),
    geoeffnet: zaehl(i => i.mail.opened),
    geklickt: zaehl(i => i.mail.clicked),
    zugesagt: zaehl(i => i.status === "zugesagt" || i.status === "bezahlt"),
    bezahlt: zaehl(i => i.status === "bezahlt"),
    abgesagt: zaehl(i => i.status === "abgesagt"),
    unzustellbar: zaehl(i => i.mail.bounced),
    abgemeldet: zaehl(i => i.abgemeldet),
    umsatz: all.reduce((s, i) => s + ((i.zahlung && i.zahlung.amount) || 0), 0)
  };
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
function assetUrl(datei) { return PUBLIC_URL + "/assets/" + datei; }

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
    vorlage: inv => inv.typ === "ehrengast" ? "einladung-ehrengast.html"
      : (inv.partner && inv.partnerLogo ? "einladung-ticket-partner.html" : "einladung-ticket.html"),
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
    partner_logo_url: !inv.partnerLogo ? ""
      : (/^https?:\/\//i.test(inv.partnerLogo) ? inv.partnerLogo : assetUrl(inv.partnerLogo)),
    abmelden_url: abmeldeLink(inv.token),
    /* CTA der Welle 0: die Homepage, nicht die App. PUBLIC_URL ist der
     * Server mit den persoenlichen Links - die Website ist eine andere. */
    website_url: WEBSITE_URL,
    header_img_url: assetUrl("circle-header.jpg"),
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
  stripeRequest("checkout/sessions", {
    mode: "payment",
    locale: "de",
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
          unit_amount: TICKET_PRICE,
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
    amount: session.amount_total || TICKET_PRICE,
    paidAt: Date.now()
  };
  logEvent("bezahlt", inv.name, inv.pool);
  dirty = true;
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
    const inv = findInvite(q.get("t"));
    if (!inv) return json(res, 404, { error: "Diese Einladung kennen wir nicht." });
    // "Geklickt" nur zaehlen, wenn der Aufruf von der Landing Page kommt, nicht
    // vom App-Link (/?t=, ruft mit app=1). Sonst verfaelscht das Oeffnen der App
    // die Klickquote und meldet Gaeste als engagiert, die nur die App geladen haben.
    if (q.get("app") !== "1" && !inv.mail.clicked) {
      inv.mail.clicked = Date.now();
      logEvent("geklickt", inv.name, inv.pool);
    }
    return json(res, 200, { ok: true, gast: pubInvite(inv) });
  }

  // Zusagen / absagen (+ die Angaben des Gastes)
  if (req.method === "POST" && url === "/api/invite/rsvp") {
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
      } else if (inv.status === "offen" || inv.status === "abgesagt") {
        inv.status = "zugesagt";                    // zugesagt, Zahlung offen
        logEvent("zugesagt", inv.name, inv.pool);
      }
      dirty = true;
      json(res, 200, { ok: true, gast: pubInvite(inv) });
    });
  }

  // Stripe-Checkout starten -> Landing Page leitet auf die zurückgegebene URL
  if (req.method === "POST" && url === "/api/invite/checkout") {
    return readBody(req, res, body => {
      const inv = findInvite(body.t);
      if (!inv) return json(res, 404, { error: "unbekannte Einladung" });
      if (inv.typ !== "ticket") return json(res, 400, { error: "Für dich ist kein Beitrag fällig." });
      if (inv.status === "bezahlt") return json(res, 200, { ok: true, bereitsBezahlt: true });
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
      const warNeu = feld && !inv.mail[feld];
      if (warNeu) {
        /* Zeitpunkt des Ereignisses aus der Meldung selbst (ISO in
         * body.timestamp) - nicht die Empfangszeit: Lettermint liefert
         * auch mal mit Verzoegerung oder (nach einer Webhook-Pause)
         * gar rueckwirkend nach. Plausibilitaetsfenster: nicht in der
         * Zukunft, nicht aelter als der Projektstart. */
        const gemeldet = Date.parse(body.timestamp || "");
        const jetzt = Date.now();
        inv.mail[feld] = (Number.isFinite(gemeldet) &&
                          gemeldet <= jetzt + 60_000 &&
                          gemeldet > Date.parse("2026-08-01")) ? gemeldet : jetzt;
        logEvent(LABEL[feld], inv.name, inv.pool);
        dirty = true;
      }
      webhookMerken({ t: Date.now(), event: ereignisKopf, typ, gast: inv.name,
                      ergebnis: feld ? (warNeu ? "gesetzt: " + feld : "schon gesetzt: " + feld) : "unbekannter Typ" });
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
               "Aus Datenschutzgruenden bleibt der Zugang gesperrt."
      });
    }
    const wer = adminName(q.get("key"));
    if (!wer) return json(res, 401, { error: "kein Zugriff" });

    if (url === "/api/admin/pools") {
      return json(res, 200, {
        ok: true,
        gesamt: gesamtStats(),
        pools: poolStats(),
        feed: state.feed.slice(0, 30)
      });
    }
    // Kontrollliste als CSV: Name, E-Mail, Typ, persönlicher Link
    if (url === "/api/admin/versandliste") {
      const zeilen = [["pool", "typ", "anrede", "vorname", "name", "email", "partner_name", "partner_logo_url", "platz_satz", "link", "app_link", "std_link", "ticket_nr", "status", "abgemeldet"]];
      for (const inv of Object.values(state.invites)) {
        zeilen.push([inv.pool, inv.typ, inv.anrede || "Hallo", (inv.name || "").split(" ")[0],
                     inv.name, inv.email, inv.partner || "", inv.partnerLogo || "",
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
      let vlog = {};
      try { vlog = JSON.parse(fs.readFileSync(VERSAND_LOG, "utf8")); } catch (e) { /* egal hier */ }
      const gaeste = Object.values(state.invites).map(inv => {
        const mail = Object.assign({ sent: 0, delivered: 0, opened: 0, clicked: 0 }, inv.mail);
        if (!mail.sent && hasOwn(vlog, inv.token)) {
          const zeiten = Object.values(vlog[inv.token]);
          if (zeiten.length) mail.sent = Math.min.apply(null, zeiten);
        }
        return {
          pool: inv.pool,
          typ: inv.typ,
          name: inv.name,
          email: inv.email,
          partner: inv.partner || "",
          status: inv.status,
          abgemeldet: inv.abgemeldet || 0,
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
    if (!vorschauBot && !inv.mail.opened) {
      inv.mail.opened = Date.now();
      logEvent("geöffnet", inv.name, inv.pool);
      dirty = true;
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
  for (const p of poolStats()) console.log(`  ${p.pool.padEnd(24)} ${String(p.gesamt).padStart(4)}  (${p.typ})`);
  console.log("\nVersandliste für Lettermint:  node server/circle-server.js export > versand.csv");
  process.exit(0);
}

if (befehl === "export") {
  const zeilen = [["pool", "typ", "anrede", "vorname", "name", "email", "partner_name", "partner_logo_url", "platz_satz", "link", "app_link", "std_link", "ticket_nr", "status", "abgemeldet"]];
  for (const inv of Object.values(state.invites)) {
    zeilen.push([inv.pool, inv.typ, inv.anrede || "Hallo", (inv.name || "").split(" ")[0],
                     inv.name, inv.email, inv.partner || "", inv.partnerLogo || "",
                     platzSatz(inv), inviteLink(inv.token), appLink(inv.token), stdLink(inv.token), inv.ticketNr, inv.status,
                     inv.abgemeldet ? "ja" : ""]);
  }
  process.stdout.write(zeilen.map(r => r.map(csvCell).join(",")).join("\n") + "\n");
  process.exit(0);
}

/* Wellenversand.
 *   node server/circle-server.js welle 1                  -> Trockenlauf
 *   node server/circle-server.js welle 1 --senden         -> verschickt wirklich
 *   ... --pool=neuland             nur Pools, deren Name das enthaelt
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
  const ERLAUBT = /^--(senden|erneut|pool=.+|nur=.+|limit=[1-9]\d*|vorschau=.+)$/;
  const kaputt = argv.slice(2).filter(a => !ERLAUBT.test(a));
  if (kaputt.length) {
    console.error("Unbekanntes oder unvollständiges Argument: " + kaputt.join(" "));
    console.error("Aufruf: node server/circle-server.js welle <0|1|2> [--senden] [--erneut] [--pool=…] [--nur=mail] [--limit=n] [--vorschau=datei.html]");
    console.error("Werte immer mit '=': --nur=max@example.com (nicht: --nur max@example.com)");
    process.exit(1);
  }
  const nr = String(arg || "").replace(/[^0-9]/g, "");
  const welle = hasOwn(WELLEN, nr) ? WELLEN[nr] : null;
  if (!welle) {
    console.error("Aufruf: node server/circle-server.js welle <0|1|2> [--senden] [--erneut] [--pool=…] [--nur=mail] [--limit=n]");
    process.exit(1);
  }
  const echt = flagge("senden");
  const erneut = flagge("erneut");
  const nurPool = wert("pool").toLowerCase();
  const nurMail = wert("nur").toLowerCase();
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
                (nr !== "0" && m.inv.partner && !m.inv.partnerLogo ? "   ⚠ Partner ohne Logo – Basisvorlage" : ""));
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

  /* Nacheinander, nicht alle auf einmal: das schont das Sendelimit und die
   * Zustellbarkeit einer noch jungen Absenderdomain.
   * WICHTIG: Dieser Prozess schreibt live-state.json NICHT - die laufende
   * App darf waehrend des Versands weiterlaufen (Landing Page, Zusagen,
   * Zahlungen). Jeder Erfolg landet sofort im Versand-Gedaechtnis, damit
   * auch ein Strg-C bei Mail 120 von 200 nichts vergisst. */
  let i = 0, ok = 0, fehler = 0;
  (function weiter() {
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
  })();
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

server.listen(PORT, () => {
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

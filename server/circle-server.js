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
 * Stelle, sonst laeuft sie beim naechsten Verschieben auseinander.
 * Verschoben auf den 09.09. (zuvor 27./28.08., dann 03.09.): waehrend noch
 * nachgefasst wird, laeuft die Frist immer wieder ab, und jede neue
 * Einladung nennt dann ein Datum aus der Vergangenheit.
 *
 * BEWUSST OHNE process.env. Die Frist war frueher ueberschreibbar, und genau
 * das ist zweimal schiefgegangen: einmal hiess die Variable im Panel
 * "RSVP_DEADLINE " mit einem Leerzeichen am Ende und wirkte deshalb gar
 * nicht, einmal stand dort eine laengst abgelaufene Frist und schlug den
 * frisch ausgerollten Code. Beides sieht man der Mail nicht an - man sieht
 * es erst, wenn der Gast ein Datum von gestern liest. Eine Frist, die in
 * jeder Einladung steht, gehoert in den Code, wo sie im Diff auftaucht und
 * ueberprueft werden kann, nicht in ein Textfeld.
 *
 * Zwei Fristen statt einer, weil die Bezahlgaeste spaeter dran waren: ihre
 * Einladung ging spaeter raus, und ueberwiesen sein wollte sie auch noch.
 * Stand heute laufen beide auf denselben Tag. */
const RSVP_DEADLINE = "09.09.2026";
const RSVP_DEADLINE_TICKET = "09.09.2026";
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

/* ---------- Rechnung ----------
 *
 * Warum wir sie selbst schreiben und nicht Stripe schreiben lassen:
 * Das Stripe-Konto laeuft auf eine andere Gesellschaft als die, die
 * Rechnungssteller sein soll. Die Kontodaten zu aendern hiesse, die gerade
 * erst abgeschlossene Pruefung erneut auszuloesen - und ohne Stripe kann
 * niemand mehr zahlen. Eine eigene Rechnung aus unserer Mail kostet uns
 * nichts und ruehrt an nichts.
 *
 * 100 Euro sind eine Kleinbetragsrechnung nach Paragraf 33 UStDV (bis 250
 * Euro brutto). Die braucht KEINE Anschrift des Empfaengers und keine
 * fortlaufende Nummer - beides haben wir ohnehin nicht vollstaendig. Noetig
 * sind: Aussteller mit Anschrift, Datum, Art der Leistung, Bruttobetrag und
 * der Steuersatz bzw. der Hinweis auf die Steuerbefreiung. Eine Nummer
 * vergeben wir trotzdem: die Buchhaltung dankt es.
 *
 * Alles Ausstellerbezogene kommt aus der Umgebung - es steht auf einem
 * steuerlichen Dokument und gehoert nicht in ein Repository. */
const RECHNUNG_AKTIV    = process.env.RECHNUNG_AKTIV === "1";
const RECHNUNG_FIRMA    = process.env.RECHNUNG_FIRMA || "";
/* Zeilen mit | getrennt: "Musterstr. 1|50667 Köln" */
const RECHNUNG_ANSCHRIFT= process.env.RECHNUNG_ANSCHRIFT || "";
const RECHNUNG_STEUER   = process.env.RECHNUNG_STEUER || "";
/* 19 = ausgewiesen, 0 = keine (dann gehoert der Grund in RECHNUNG_HINWEIS) */
const RECHNUNG_USTSATZ  = parseFloat(process.env.RECHNUNG_USTSATZ || "0") || 0;
const RECHNUNG_HINWEIS  = process.env.RECHNUNG_HINWEIS || "";
const RECHNUNG_PRAEFIX  = process.env.RECHNUNG_PRAEFIX || "CIRCLE-2026-";
const RECHNUNG_KONTAKT  = process.env.RECHNUNG_KONTAKT || MAIL_FROM.replace(/^.*<|>.*$/g, "");

/* Ohne Aussteller und Anschrift ist es keine Rechnung, sondern ein Zettel. */
const rechnungMoeglich = () => RECHNUNG_AKTIV && !!RECHNUNG_FIRMA && !!RECHNUNG_ANSCHRIFT;

const euroText = cent => (cent / 100).toFixed(2).replace(".", ",") + " €";
/* Was dieser eine Gast zahlt. Regulaer der Ticketpreis - abweichend nur bei
 * Testgaesten, damit eine echte Live-Zahlung geprueft werden kann, ohne
 * dafuer jedes Mal 100 Euro zu bewegen. */
const preisVon = inv => (inv && inv.preis > 0) ? inv.preis : TICKET_PRICE;

const VOTES = ["ja", "vielleicht", "nein"];
/* Fuenf Momente statt sechs: Start-Up-Pitch und Mentor-Minuten stehen nicht
 * mehr im Ablauf (Programm Desi, 04.09.). Der Kreis schliesst sich also
 * frueher - die Zahl steht hier UND in index.html, beide muessen zusammen
 * passen, sonst bleibt der Kreis auf 5/6 stehen und schliesst sich nie. */
const MOMENTS_TOTAL = 5;
const VOTE_LABEL = { ja: "Sofort", vielleicht: "Vielleicht", nein: "Heute nicht" };
/* Stationen, die genau einen Moment setzen */
const STATION_MOMENT = {
  checkin: "ankommen",
  impuls: "impuls",
  kunst: "kunst",
  verbindung: "verbindung"
};

/* ---------- Zeiten des Abends ----------
 *
 * App-freie Stellen und die Fenster der Live-Funktionen. Standen bis
 * hierher in index.html - also in einer Datei, die nur ein Deploy aendert.
 * Am Abend selbst ist das die falsche Stelle: Wenn der Impuls zehn Minuten
 * spaeter anfaengt, weil das Dessert laenger braucht, muss das jemand aus
 * dem Monitor verschieben koennen, waehrend er im Raum steht.
 *
 * "aus" schaltet ein Fenster ab, ohne es zu loeschen - eine Zeit, die man
 * geloescht hat, muss man neu eintippen; eine ausgeschaltete steht wieder
 * da, wenn man sie braucht.
 *
 * "jetzt" ist der Griff fuer den Fall, dass alles anders kommt: ein
 * Handschalter, der die App JETZT app-frei stellt, unabhaengig von jeder
 * Uhrzeit, bis jemand ihn wieder loest. Der Ablauf im Raum haelt sich nicht
 * an Tabellen, und wer vorne steht, hat keine Zeit, Uhrzeiten zu rechnen. */
const ZEITEN_STANDARD = {
  appfrei: [
    { id: "impuls1", from: "19:30", to: "19:45", was: "Impuls · Ien Bäumler",
      hinweis: "Teil 1. Fünfzehn Minuten, die es wert sind.", aus: false },
    { id: "impuls2", from: "21:15", to: "21:30", was: "Impuls · Ien Bäumler",
      hinweis: "Teil 2 – dort, wo der erste aufgehört hat.", aus: false },
    { id: "auktion", from: "22:45", to: "22:55", was: "Auktion · Live Painting",
      hinweis: "Max Leinfelders Werk findet sein Zuhause. Augen nach vorn.", aus: false }
  ],
  gates: {
    av8:     { from: "19:00", to: "23:00" },
    auktion: { from: "22:45", to: "23:00" }
  },
  /* null = kein Handschalter. Sonst { was, hinweis, seit } */
  jetzt: null,
  /* Der Ablauf. Steht auch in der App als Notvorrat; was hier steht, gilt.
   * Nur so laesst sich am Abend "alles ab jetzt +15 Minuten" schieben. */
  timeline: [
    { id:"empfang",  time:"18:00", title:"Empfang & Check-in",           ort:"Wechselbereich",
      desc:"Ankommen in der Playa Cologne. Erste Gespräche, erste Drinks." },
    { id:"opening",  time:"18:30", title:"Begrüßung · Amiaz Habtu",      ort:"Dinnerbereich",
      desc:"Der Abend beginnt – mit Haltung, Humor und einem Blick auf das, was verbindet." },
    { id:"av8",      time:"18:55", title:"AV8 stellt sich vor",          ort:"Dinnerbereich",
      desc:"Kurz vorgestellt von der Moderation. Ihr Stand ist den ganzen Abend geöffnet – geh vorbei und probier." },
    { id:"gang1",    time:"19:00", title:"Erster Gang · Vorspeise",      ort:"Dinnerbereich",
      desc:"Das Sharing-Menü beginnt. Alles kommt in die Mitte." },
    { id:"vortrag1", time:"19:30", title:"Impuls · Ien Bäumler (I)",     ort:"Dinnerbereich",
      desc:"Ein relevantes Thema, ein starker Gedanke – Mehrwert für jeden im Raum." },
    { id:"wechsel1", time:"19:45", title:"Austausch & Gespräche",        ort:"Wechselbereich · bis 20:15",
      desc:"Zeit für den Kreis. Hier lernst du die Menschen kennen, wegen denen du hier bist.", moment:"impuls", momentLabel:"Impuls mitgenommen" },
    { id:"gang2",    time:"20:25", title:"Zweiter Gang · Hauptspeise",   ort:"Dinnerbereich",
      desc:"Weiter geht’s – geteilt wird auch hier." },
    { id:"vortrag2", time:"21:15", title:"Impuls · Ien Bäumler (II)",    ort:"Dinnerbereich",
      desc:"Der zweite Teil – dort, wo der erste aufgehört hat." },
    { id:"painting", time:"21:30", title:"Live Painting · Max Leinfelder", ort:"Wechselbereich · bis 22:00",
      desc:"Das Werk entsteht vor deinen Augen. Schau zu, sprich mit ihm.", moment:"kunst", momentLabel:"Kunst erlebt" },
    { id:"gang3",    time:"22:15", title:"Dritter Gang · Dessert",       ort:"Dinnerbereich",
      desc:"Süßer Abschluss, bevor die Nacht beginnt." },
    { id:"auktion",  time:"22:45", title:"Auktion · Live Painting",      ort:"Dinnerbereich",
      desc:"Max Leinfelders Werk findet sein Zuhause. Der Erlös wird gespendet." },
    { id:"dj",       time:"22:55", title:"Ausklang · Drinks & DJ",       ort:"",
      desc:"Der Abend endet, wie er begonnen hat: mit Atmosphäre." }
  ]
};

let state = {
  zeiten: JSON.parse(JSON.stringify(ZEITEN_STANDARD)),
  applause: 0,
  votes: { ja: 0, vielleicht: 0, nein: 0 },
  /* Rueckmeldung an AV8. Kein Pitch-Votum, sondern ein Stimmungsbild:
   * die Frage nach der Investition (votes), eine Sterne-Bewertung des
   * Produkts und zwei Angebote, die ein Gast markieren kann. */
  sterne: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  interesse: { intro: 0, investor: 0 },
  bid: null,            // { amount, paddle, name, t }
  bids: [],             // letzte Gebote, neueste zuerst
  guests: {},           // bandId -> { name, table, moments:{}, applause, vote, t }
  invites: {},          // token -> Gast der Einladungsliste (siehe importRows)
  verbindungen: {},     // "gidA|gidB" -> { von, status, t, antwort }   (Welle 2)
  signal: null,         // laufendes Signal aus dem Monitor: Als Naechstes / Tischwechsel
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
/* Zeiten aus einer aelteren Zustandsdatei koennen unvollstaendig sein -
 * fehlende Teile aus dem Standard nachlegen, statt die App ohne Fenster
 * laufen zu lassen. */
if (!state.zeiten || typeof state.zeiten !== "object") state.zeiten = {};
if (!Array.isArray(state.zeiten.appfrei)) {
  state.zeiten.appfrei = JSON.parse(JSON.stringify(ZEITEN_STANDARD.appfrei));
}
if (!state.zeiten.gates || typeof state.zeiten.gates !== "object") {
  state.zeiten.gates = JSON.parse(JSON.stringify(ZEITEN_STANDARD.gates));
}
if (!("jetzt" in state.zeiten)) state.zeiten.jetzt = null;
if (!Array.isArray(state.zeiten.timeline) || !state.zeiten.timeline.length) {
  state.zeiten.timeline = JSON.parse(JSON.stringify(ZEITEN_STANDARD.timeline));
}
/* Gaeste aus der Zeit vor den Runden gehoeren zur ersten. */
for (const inv of Object.values(state.invites)) if (!inv.runde) inv.runde = "no1";

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
/* Die Limits fuer /api/app und /api/live sind auf den SAAL bemessen, nicht
 * auf einen Menschen: Im Veranstaltungs-WLAN teilen sich 130 Gaeste eine
 * Adresse. Ein Limit je IP, das fuer einen Gast grosszuegig ist, sperrt
 * dort nach dem ersten Applaus den ganzen Raum aus - und die App zeigt dann
 * leere Listen ohne Fehler. Was ein einzelner Gast nicht darf (Liste
 * abgrasen), regelt anfrageErlaubt() je Token. */
const LIMIT_APP  = [6000, 60_000];
const LIMIT_LIVE = [1500, 10_000];
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

/* Der Abend in Zahlen: wer ist in der App, wer installiert, wer im Haus,
 * wen erreicht eine Push. Wenn der Tischwechsel nur die Haelfte erreicht,
 * soll das VORHER auf dem Schirm stehen. */
function kreisZahlen() {
  let im = 0, reg = 0, da = 0, push = 0, verbunden = 0, inst = 0;
  for (const i of Object.values(state.invites)) {
    /* Nur die laufende Runde: die Zahl auf dem Schirm ist die fuer DIESEN
     * Abend, nicht die Summe aller bisherigen. */
    if (!imKreis(i) || rundeVon(i) !== RUNDE) continue;
    im++;
    if (i.app && i.app.standalone) inst++;
    if (i.profil && i.profil.registriert) reg++;
    if (i.da) da++;
    if (i.push) push++;
  }
  for (const [k, v] of Object.entries(state.verbindungen || {})) if (v.status === "verbunden" && k.startsWith(RUNDE + "|")) verbunden++;
  return { im, registriert: reg, installiert: inst, da, push, verbunden, gang: tische().gang, runde: RUNDE,
           letzterPush: state.letzterPush || null, koeln: berlinJetzt().hhmm, jetztMs: Date.now(),
           signalGesehen: state.signal && state.signal.gesehen ? Object.keys(state.signal.gesehen).length : 0,
           phase: phaseJetzt(), phaseHand: state.phaseHand || "",
           appfrei: appfreiJetzt() ? ((appfreiJetzt().was) || "Handschalter") : "",
           pushMoeglich: pushMoeglich(), signal: state.signal || null, gaenge: tische().gaenge, tische: tische().liste.length };
}
function snapshot() {
  return JSON.stringify({
    applause: state.applause,
    votes: state.votes,
    sterne: state.sterne,
    interesse: state.interesse,
    bid: state.bid,
    bids: state.bids.slice(0, 5),
    guests: clients.size,
    checkedIn: guestCount(),
    /* Der Abend in Zahlen fuer den Monitor: wer ist in der App, wer ist
     * im Haus, wen erreicht eine Push. Wenn der Tischwechsel nur die
     * Haelfte erreicht, soll das VORHER auf dem Schirm stehen. */
    kreis: kreisZahlen(),
    /* rev steigt bei jeder Aenderung an Verbindungen, Profilen und
     * Anwesenheit. Die App laedt Gaestebuch und Kreis nur nach, wenn sich
     * rev geaendert hat - nicht bei jedem Applaus. */
    rev: state.rev || 0,
    jetztMs: Date.now(),
    /* Fuer die Wand im Raum und die Buehnen-Karte im Monitor. */
    wand: state.wand || { modus: "auto", enthuellt: false },
    auktion: state.auktion || null,
    tipps: Object.values(state.invites).filter(i => i.tipp).length,
    ringe: ringeZahlen()
  });
}
/* Momente je Gast auf dem Server: "41 Kreise geschlossen" laesst sich
 * sonst nicht ansagen - die Striche lagen nur im Speicher der Handys. */
function ringeZahlen() {
  let geschlossen = 0, summe = 0, n = 0;
  for (const i of Object.values(state.invites)) {
    if (!imKreis(i) || !i.momente) continue;
    const k = Object.keys(i.momente).length; n++; summe += k;
    if (k >= MOMENTS_TOTAL) geschlossen++;
  }
  return { geschlossen, mitStrich: n, striche: summe };
}
function revHoch() { state.rev = (state.rev || 0) + 1; }

/* Die Zeiten gehen als EIGENES Ereignis raus, nicht im snapshot: Der
 * snapshot fliegt bei jedem Applaus und jeder Stimme durch die Leitung, die
 * Zeiten aendern sich an einem Abend vielleicht dreimal. Sie jedes Mal
 * mitzuschicken hiesse, das WLAN ausgerechnet dort zu belasten, wo 130
 * Geraete an derselben Zelle haengen. */
function zeitenZeile() {
  return "event: zeiten\ndata: " + JSON.stringify(Object.assign({}, state.zeiten,
    { jetztMs: Date.now(), tz: "Europe/Berlin", appfreiJetzt: appfreiJetzt(), phase: phaseJetzt() })) + "\n\n";
}
/* Ein einziger halbtoter Socket darf nicht die Schleife sprengen - sonst
 * bekommt die halbe Menge hinter ihm den Tischwechsel nie. */
function anAlle(line) {
  for (const res of clients) {
    try {
      if (res.writableEnded || res.destroyed) { clients.delete(res); continue; }
      res.write(line);
    } catch (e) { clients.delete(res); }
  }
}
function zeitenSenden() { anAlle(zeitenZeile()); }
/* Herzschlag alle 20 s: Ohne Datenverkehr kappt ein Proxy die Leitung nach
 * seinem Timeout, und der Browser merkt es erst beim naechsten Ereignis. */
setInterval(() => anAlle(": hb\n\n"), 20_000);

let pushTimer = null;
function broadcast() {           // gebündelt, max. ~7 Updates/s
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    anAlle("data: " + snapshot() + "\n\n");
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

/* Zu grosser Rumpf: erst antworten, dann die Leitung kappen. Ein blosses
   req.destroy() liess den Knopf in der App bis zum Timeout haengen - und
   das "end"-Ereignis, in dem die 413 stehen sollte, kam nie. */
function zuGrossAbbruch(req, res, text) {
  if (res.headersSent) return;
  res.writeHead(413, { "Content-Type": "application/json", "Connection": "close" });
  res.end(JSON.stringify({ error: text || "zu gross" }), () => req.destroy());
}
function readBody(req, res, cb) {
  let raw = "", zuGross = false;
  req.on("data", c => {
    raw += c;
    /* Antworten, nicht nur kappen: ein stumm zerstoerter Request laesst
       den Knopf in der App bis zum Timeout haengen. */
    if (raw.length > 10_000 && !zuGross) { zuGross = true; zuGrossAbbruch(req, res); }
  });
  req.on("end", () => {
    if (zuGross) return;
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

/* extra: zusaetzliche Kopfzeilen (z. B. Cache-Control fuer den Service
 * Worker, der niemals aus dem Zwischenspeicher kommen darf). */
function serveFile(res, file, type, extra) {
  fs.readFile(path.join(ROOT, file), (err, buf) => {
    if (err) { res.writeHead(500); return res.end(file + " fehlt"); }
    res.writeHead(200, Object.assign({ "Content-Type": type }, extra || {}));
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

/* ================= DIE APP ZUM ABEND (Welle 2) =================
 *
 * Das Herzstueck aus dem Call vom 19.08.: die Gaeste untereinander.
 * Jeder Gast oeffnet seinen persoenlichen Link, vervollstaendigt sein
 * Profil (Bild, Freigabe), sieht die Teilnehmerliste und verbindet sich
 * beidseitig. Spezifikation: docs/MODUL-VERNETZUNG.md auf dem Branch
 * claude/app-design-call-ho85fk.
 *
 * Zwei Kennungen je Gast, bewusst getrennt:
 *   token - geheim, steht nur im eigenen Link. Weist den Gast aus.
 *   gid   - oeffentlich, abgeleitet aus dem Token (Hash, nicht umkehrbar).
 *           Damit verweisen Gaeste aufeinander, in Listen, Verbindungen und
 *           Bild-Adressen. Stuende dort der Token, koennte jeder, der eine
 *           Bild-URL sieht, die Zusage des anderen oeffnen. */
function gid(inv) {
  if (!inv._gid) inv._gid = crypto.createHash("sha1").update("gid:" + inv.token).digest("hex").slice(0, 12);
  return inv._gid;
}
function findByGid(id) {
  const s = String(id || "").replace(/[^a-f0-9]/g, "").slice(0, 12);
  if (!s) return null;
  for (const inv of Object.values(state.invites)) if (gid(inv) === s) return inv;
  return null;
}
/* In der App ist, wer zugesagt hat. Offene und Absagen sehen die Liste nicht
 * und stehen nicht drin - "ueber die App kommt nur, wer zugesagt hat". */
const imKreis = inv => inv && (inv.status === "zugesagt" || inv.status === "bezahlt") && !inv.abgemeldet;

/* --- Runden ---
 * THE CIRCLE gibt es mehr als einmal, und der Gaestekreis wechselt fast
 * vollstaendig. Im Gaestebuch sieht ein Gast nur die Gaeste SEINER Runde -
 * die Verbindungen von No1 gehen niemanden aus No2 etwas an, und umgekehrt.
 * Jeder Gast traegt seine Runde; wer zu einer spaeteren wiederkommt, bekommt
 * dafuer einen neuen Eintrag mit neuem Link und sieht dort deren Kreis.
 * RUNDE ist die Runde, in die neue Importe fallen. */
const RUNDE = process.env.RUNDE || "no1";
const rundeVon = inv => inv.runde || "no1";
const gleicheRunde = (a, b) => rundeVon(a) === rundeVon(b);

/* Profil-Anteil, der zum Gast dazukommt, wenn er die App registriert.
 * Vorher existiert er nicht - "noch nicht registriert" ist ein gueltiger,
 * sichtbarer Zustand in der Liste. */
function profil(inv) {
  if (!inv.profil) inv.profil = { foto: "", sichtbar: false, registriert: 0, ueber: "", linkedin: "" };
  return inv.profil;
}
const FOTO_DIR = path.join(__dirname, "fotos");
const fotoUrl = (inv, mini) => {
  const p = inv.profil;
  return p && p.foto ? "/foto/" + p.foto + (mini ? "-m" : "") + ".jpg" : "";
};

/* --- Verbindungen ---
 * Ein Paar, eine Zeile: Schluessel ist das sortierte gid-Paar. Sonst gaebe
 * es zwei Zeilen, wenn beide gleichzeitig anfragen, und "Mein Kreis" zeigte
 * Dubletten. Fragt B an, waehrend A schon angefragt hat, ist das keine
 * Kollision, sondern die Zustimmung. */
/* Der Schluessel traegt die Runde vorne: Verbindungen sind je Runde, und
 * zwei Gaeste, die sich in No1 und No2 begegnen, haben zwei Zeilen. */
function paarKey(a, b, runde) { return (runde || "no1") + "|" + [a, b].sort().join("|"); }
function verbindung(a, b, runde) {
  if (!state.verbindungen) state.verbindungen = {};
  const k = paarKey(a, b, runde);
  return hasOwn(state.verbindungen, k) ? state.verbindungen[k] : null;
}
/* Wie ICH (ich = gid) die Verbindung zu einem anderen sehe.
 *   keine · angefragt (ich warte) · anfrage (der andere wartet auf mich)
 *   verbunden · spaeter
 * Eine Ablehnung sieht der Anfragende NIE - fuer ihn bleibt es "angefragt".
 * Eine Ablehnung, die ankommt, vergiftet den Abend. */
function verbindungAusSicht(ich, andere, runde) {
  const v = verbindung(ich, andere, runde);
  if (!v) return "keine";
  if (v.status === "verbunden") return "verbunden";
  if (v.status === "spaeter") return "spaeter";
  if (v.status === "abgelehnt") return v.von === ich ? "angefragt" : "keine";
  /* offen */
  return v.von === ich ? "angefragt" : "anfrage";
}
/* Die eine Regel, die nirgends verletzt werden darf: Kontaktdaten verlassen
 * den Server nur bei "verbunden" UND wenn das Gegenueber sie freigegeben
 * hat. Zwei Bedingungen, nicht eine. */
function kontaktSichtbar(ich, anderer) {
  return gleicheRunde(ich, anderer) &&
         verbindungAusSicht(gid(ich), gid(anderer), rundeVon(ich)) === "verbunden" && !!profil(anderer).sichtbar;
}

/* Eintrag in der Teilnehmerliste, aus Sicht des Gastes "ich". */
function listenEintrag(ich, inv) {
  const p = inv.profil || {};
  return {
    id: gid(inv),
    name: inv.name || "",
    firma: inv.firma || "",
    rolle: inv.rolle || "",
    foto: fotoUrl(inv, true),
    registriert: !!p.registriert,
    da: !!inv.da,
    /* Der Satz, der ein Gespraech anstoesst, gehoert in die Liste - nicht
     * nur ins Kurzprofil, das man erst antippen muss. */
    ueber: p.ueber || "",
    sucht: p.sucht || "",
    tisch: meinTisch(inv),
    verbindung: ich ? verbindungAusSicht(gid(ich), gid(inv), rundeVon(ich)) : "keine"
  };
}
/* Kurzprofil - was beim Antippen erscheint. Kontaktdaten nur nach Regel. */
function kurzprofil(ich, inv) {
  const e = listenEintrag(ich, inv);
  e.foto = fotoUrl(inv, false);
  e.ueber = (inv.profil && inv.profil.ueber) || "";
  /* LinkedIn zaehlt als Kontaktdatum, nicht als Profiltext: "Nur
   * kontaktierbar" verspricht, dass die Kontaktdaten beim Gast bleiben -
   * und ein Profil-Link ist ein Weg, ihn zu erreichen. */
  if (ich) {
    const v = verbindung(gid(ich), gid(inv), rundeVon(ich));
    e.notiz = (v && v.notizen && v.notizen[gid(ich)]) || "";
  }
  if (ich && kontaktSichtbar(ich, inv)) {
    e.email = inv.email || "";
    e.telefon = (inv.daten && inv.daten.phone) || "";
    e.linkedin = (inv.profil && inv.profil.linkedin) || "";
  }
  return e;
}

/* --- Tische ---
 * Der Plan kommt am 14.09. von Jonan; die Maske steht vorher. Ein Gast
 * sitzt je Gang an einem Tisch (Switch zwischen den Gaengen). "gang" ist
 * der Gang, der gerade laeuft - 0 vor dem Essen. */
function tische() {
  if (!state.tische) state.tische = {
    gaenge: ["Vorspeise", "Hauptspeise", "Dessert"],
    gang: 0,                     // 1-basiert; 0 = noch kein Gang
    liste: [],                   // [{ nr, name }]
    sitz: {}                     // gid -> [tischNr je Gang]
  };
  return state.tische;
}
function meinTisch(inv, gangNr) {
  const t = tische();
  const s = t.sitz[gid(inv)];
  if (!s) return 0;
  return s[Math.max(0, (gangNr || t.gang) - 1)] || 0;
}
function tischnachbarn(ich, gangNr) {
  const t = tische();
  const nr = meinTisch(ich, gangNr);
  if (!nr) return [];
  const g = Math.max(0, (gangNr || t.gang) - 1);
  return Object.values(state.invites)
    .filter(inv => imKreis(inv) && inv !== ich && gleicheRunde(inv, ich) && t.sitz[gid(inv)] && t.sitz[gid(inv)][g] === nr)
    .map(inv => listenEintrag(ich, inv))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* --- App-frei, aus Sicht des Servers ---
 * Die App entscheidet selbst, wann sie das Blatt zeigt. Der Server braucht
 * dieselbe Antwort fuer Push: Eine Nachricht, die im Impuls rausgeht, holt
 * niemand zurueck. Deshalb die Fenster hier noch einmal auswerten. */
const EVENT_DATE = "2026-09-16";
/* Uhrzeit in Koeln, egal in welcher Zone der Server laeuft. Ein Server auf
 * UTC haette den Push-Stopp zwei Stunden zu spaet greifen lassen - mitten
 * in Iens Impuls. */
function berlinJetzt() {
  const teile = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
  const t = {}; for (const x of teile) t[x.type] = x.value;
  return { hhmm: (t.hour === "24" ? "00" : t.hour) + ":" + t.minute, datum: t.year + "-" + t.month + "-" + t.day };
}
function appfreiJetzt() {
  const z = state.zeiten || {};
  if (z.jetzt) return z.jetzt;
  const { hhmm, datum: heute } = berlinJetzt();
  if (heute !== EVENT_DATE) return null;
  return (z.appfrei || []).find(f => !f.aus && hhmm >= f.from && hhmm < f.to) || null;
}

/* --- Phase: vor · abend · danach ---
 * Am Morgen des 17.09. darf auf der Startseite kein toter Countdown stehen.
 * Automatisch nach Datum (Koelner Zeit), von Hand aus dem Monitor
 * uebersteuerbar. */
function phaseJetzt() {
  if (state.phaseHand) return state.phaseHand;
  const { datum, hhmm } = berlinJetzt();
  if (datum < EVENT_DATE) return "vor";
  if (datum === EVENT_DATE) return "abend";
  /* Bis 02:00 am Folgetag gilt noch der Abend. */
  const folgetag = new Date(EVENT_DATE + "T12:00:00Z"); folgetag.setUTCDate(folgetag.getUTCDate() + 1);
  const f = folgetag.toISOString().slice(0, 10);
  if (datum === f && hhmm < "02:00") return "abend";
  return "danach";
}

/* --- Galerie ---
 * Dateien je Runde unter server/galerie/<runde>/<id>-m.jpg (Raster, 400 px)
 * und -w.jpg (Ansicht, 1600 px). Die Groessen rechnet der Browser der
 * Upload-Seite - der Server hat keine Bildbibliothek und soll keine
 * bekommen. */
const GALERIE_DIR = path.join(__dirname, "galerie");
function galerie(runde) {
  if (!state.galerie) state.galerie = {};
  const r = runde || RUNDE;
  if (!state.galerie[r]) state.galerie[r] = { offen: 0, fotos: {} };
  return state.galerie[r];
}
const galerieUrl = (runde, id, art) => "/g/" + encodeURIComponent(runde) + "/" + id + "-" + art + ".jpg";

/* Bilder kommen als Data-URL (JPEG, vom Browser bereits verkleinert und
 * gedreht). Der Server speichert nur, was wie ein JPEG aussieht, und
 * begrenzt die Groesse - 100 Gaeste mal Originalfotos waeren zweistellige
 * Megabyte je Listenaufruf im Veranstaltungs-WLAN. */
function jpegAusDataUrl(s, maxBytes) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ""));
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 100 || buf.length > maxBytes) return null;
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;      // JPEG-Magic
  return buf;
}
/* Wie readBody, aber fuer das Profilbild: 1,5 MB statt 10 KB. */
function readBodyGross(req, res, cb) {
  let raw = "", zuGross = false;
  req.on("data", c => { raw += c; if (raw.length > 1_500_000 && !zuGross) { zuGross = true; zuGrossAbbruch(req, res, "Bild zu groß"); } });
  req.on("end", () => {
    if (zuGross) return;
    try { cb(JSON.parse(raw || "{}")); }
    catch (e) { json(res, 400, { error: "bad json" }); }
  });
}
/* --- Push ---
 * Beim Dinner liegen die Handys in der Tasche, die Bildschirme sind
 * gesperrt - ein SSE-Signal kommt nur an, wenn die App im Vordergrund ist.
 * Der Tischwechsel geht deshalb als Push. Modul: server/webpush.js (ohne
 * fremde Pakete). Schluessel einmal erzeugen und nie wechseln, sonst sind
 * alle Abonnements ungueltig:  node -e "console.log(require('./server/webpush').schluesselErzeugen())" */
const webpush = require("./webpush");
const VAPID = {
  publicKey: process.env.VAPID_PUBLIC || "",
  privateKey: process.env.VAPID_PRIVATE || "",
  subject: process.env.VAPID_SUBJECT || "mailto:hello@the-circle-cologne.de"
};
const pushMoeglich = () => !!(VAPID.publicKey && VAPID.privateKey);
const pushbar = () => Object.values(state.invites).filter(i => imKreis(i) && i.push).length;

/* An alle, die es erlaubt haben. Im app-freien Fenster geht NICHTS raus -
 * serverseitig, nicht nur in der Oberflaeche: eine Push, die im Impuls
 * ankommt, holt niemand zurueck. Tote Abonnements (404/410) werden
 * geloescht, damit der Zaehler im Monitor stimmt. */
async function pushAnAlle(nachricht, opts) {
  if (!pushMoeglich()) return { gesendet: 0, grund: "kein VAPID-Schluessel" };
  const frei = appfreiJetzt();
  if (frei && !(opts && opts.trotzAppfrei)) return { gesendet: 0, grund: "app-frei: " + (frei.was || "Handschalter") };
  const payload = JSON.stringify(nachricht);
  let gesendet = 0, tot = 0, fehler = 0;
  for (const inv of Object.values(state.invites)) {
    if (!imKreis(inv) || !inv.push) continue;
    try {
      const a = await webpush.senden({ subscription: inv.push, payload, vapid: VAPID, ttl: 1800, urgency: "high" });
      if (a.status === 404 || a.status === 410) { inv.push = null; tot++; dirty = true; }
      else if (a.status >= 200 && a.status < 300) gesendet++;
      else fehler++;
    } catch (e) { fehler++; }
  }
  return { gesendet, tot, fehler };
}

/* Wie pushAnAlle, aber der Text wird je Gast gebaut (Tischnummer). */
async function pushJeGast(bauen, opts) {
  if (!pushMoeglich()) return { gesendet: 0, grund: "kein VAPID-Schlüssel" };
  const frei = appfreiJetzt();
  if (frei && !(opts && opts.trotzAppfrei)) return { gesendet: 0, grund: "app-frei: " + (frei.was || "Handschalter") };
  let gesendet = 0, tot = 0, fehler = 0;
  for (const inv of Object.values(state.invites)) {
    if (!imKreis(inv) || !inv.push) continue;
    try {
      const a = await webpush.senden({ subscription: inv.push, payload: JSON.stringify(bauen(inv)), vapid: VAPID, ttl: 1800, urgency: "high" });
      if (a.status === 404 || a.status === 410) { inv.push = null; tot++; dirty = true; }
      else if (a.status >= 200 && a.status < 300) gesendet++;
      else fehler++;
    } catch (e) { fehler++; }
  }
  return { gesendet, tot, fehler, erreichbar: pushbar() };
}
const tischName = nr => ((tische().liste.find(x => x.nr === nr) || {}).name || "");
/* Eine Push an EINEN Gast. Fuer Anfragen und Zustimmungen: Der andere hat
 * sein Handy in der Tasche, und eine Anfrage, die um 23 Uhr gelesen wird,
 * kommt nach dem Gespraech. Im app-freien Fenster geht nichts raus. */
async function pushAnEinen(inv, nachricht) {
  if (!pushMoeglich() || !inv || !inv.push || appfreiJetzt()) return false;
  try {
    const a = await webpush.senden({ subscription: inv.push, payload: JSON.stringify(nachricht), vapid: VAPID, ttl: 3600, urgency: "normal" });
    if (a.status === 404 || a.status === 410) { inv.push = null; dirty = true; return false; }
    return a.status >= 200 && a.status < 300;
  } catch (e) { return false; }
}

/* Signale (Als Naechstes, Tischwechsel) als eigenes SSE-Ereignis, wie die
 * Zeiten: selten, aber wenn, dann sofort an alle. */
/* Ein Signal verfaellt nach 15 Minuten: Wer nach dem Neustart um 20:30
 * neu verbindet, soll nicht den Tischwechsel von 19:20 samt Vibration
 * noch einmal bekommen. */
const SIGNAL_LEBT = 15 * 60_000;
function signalAktuell() { return state.signal && (Date.now() - state.signal.t) < SIGNAL_LEBT ? state.signal : null; }
function signalZeile() { return "event: signal\ndata: " + JSON.stringify(signalAktuell()) + "\n\n"; }
function signalSenden() { anAlle(signalZeile()); }

/* Ein Gast darf anfragen, aber nicht die Liste abgrasen. Das ist kein
 * Angriff, sondern der Reflex "ich sammle mal alle" - und er macht das
 * Modul wertlos. Je Gast, nicht je IP: hinter dem Veranstaltungs-WLAN
 * teilen sich alle eine Adresse. */
const ANFRAGEN = new Map();
function anfrageErlaubt(id) {
  const jetzt = Date.now();
  let e = ANFRAGEN.get(id);
  if (!e || e.resetAt < jetzt) { e = { n: 0, resetAt: jetzt + 3600_000 }; ANFRAGEN.set(id, e); }
  e.n++;
  return e.n <= 40;
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
        token, pool, typ, runde: RUNDE,
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
/* Datenschutzhinweise und Impressum. Die App verarbeitet Namen,
 * Kontaktdaten, Ernaehrung/Unvertraeglichkeiten (Gesundheitsdaten), Fotos
 * und wer sich mit wem verbindet - ohne diese Seite waere jede Einwilligung
 * in der Registrierung ohne Informationsgrundlage. Der Verantwortliche
 * kommt aus der Umgebung; solange er fehlt, steht das sichtbar auf der
 * Seite, damit es niemand uebersieht. */
const VERANTWORTLICH = process.env.VERANTWORTLICH || "";       // Zeilen mit |
const DATENSCHUTZ_KONTAKT = process.env.DATENSCHUTZ_KONTAKT || "hello@the-circle-cologne.de";
function rechtsSeite(art) {
  const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const wer = VERANTWORTLICH
    ? VERANTWORTLICH.split("|").map(esc).join("<br>")
    : "<b style=\"color:#ff6b6c\">Verantwortlicher noch einzutragen</b> (Umgebungsvariable VERANTWORTLICH: Firma|Stra&szlig;e|PLZ Ort|Vertreten durch)";
  const kopf = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>THE CIRCLE &middot; ' + (art === "impressum" ? "Impressum" : "Datenschutz") + '</title>' +
    '<style>body{background:#122648;color:#f8f7f4;font-family:Montserrat,"Avenir Next",Helvetica,Arial,sans-serif;font-weight:300;margin:0;padding:32px 22px 60px;line-height:1.7;font-size:15px}' +
    'main{max-width:640px;margin:0 auto}h1{font-family:Cinzel,"Trajan Pro 3",Georgia,serif;font-weight:600;letter-spacing:.08em;text-transform:uppercase;font-size:24px;margin:0 0 6px}' +
    'h2{font-family:Cinzel,Georgia,serif;font-weight:600;font-size:15px;letter-spacing:.08em;text-transform:uppercase;margin:32px 0 8px;color:#d8d3c3}' +
    'p,li{color:#aeb9d2}b{color:#f8f7f4;font-weight:500}a{color:#f8f7f4}small{display:block;margin-top:40px;color:#93a4c6;font-size:12px}</style></head><body><main>';
  const fuss = '<small>THE CIRCLE No1 &middot; connecting generations &middot; <a href="/impressum">Impressum</a> &middot; <a href="/datenschutz">Datenschutz</a></small></main></body></html>';
  if (art === "impressum") {
    return kopf + '<h1>Impressum</h1><p>Angaben gem&auml;&szlig; &sect; 5 DDG</p><h2>Verantwortlich</h2><p>' + wer + '</p>' +
      '<h2>Kontakt</h2><p><a href="mailto:' + esc(DATENSCHUTZ_KONTAKT) + '">' + esc(DATENSCHUTZ_KONTAKT) + '</a></p>' +
      '<h2>Veranstalter</h2><p>Ihre Markenwerkstatt &middot; AERA &middot; Public Cologne</p>' + fuss;
  }
  return kopf + '<h1>Datenschutz</h1><p>Informationen nach Art. 13 DSGVO f&uuml;r die Einladung, die Zusage und die App zu THE CIRCLE No1.</p>' +
    '<h2>Verantwortlicher</h2><p>' + wer + '<br>Kontakt f&uuml;r Datenschutzfragen: <a href="mailto:' + esc(DATENSCHUTZ_KONTAKT) + '">' + esc(DATENSCHUTZ_KONTAKT) + '</a></p>' +
    '<h2>Welche Daten, wof&uuml;r, auf welcher Grundlage</h2><ul>' +
    '<li><b>Einladung und Zusage</b> &ndash; Name, Anrede, Unternehmen, Rolle, E-Mail, Telefon, Zusage/Absage, Kreisnummer. Zweck: Durchf&uuml;hrung des Abends. Grundlage: Art. 6 Abs. 1 b DSGVO (Vertrag/Teilnahme).</li>' +
    '<li><b>Ern&auml;hrung und Unvertr&auml;glichkeiten</b> &ndash; freiwillige Angabe in der Zusage. Zweck: Men&uuml; und K&uuml;che. Grundlage: Einwilligung, Art. 6 Abs. 1 a und Art. 9 Abs. 2 a DSGVO. Wird nur an das Catering weitergegeben und nach dem Abend gel&ouml;scht.</li>' +
    '<li><b>Zahlung</b> (nur Bezahlg&auml;ste) &ndash; Abwicklung &uuml;ber Stripe; wir speichern Betrag, Zeitpunkt und Zahlungskennung. Grundlage: Art. 6 Abs. 1 b und c DSGVO (steuerliche Aufbewahrung).</li>' +
    '<li><b>Profil in der App</b> &ndash; Unternehmen, Rolle, ein Satz &uuml;ber dich, wonach du suchst, LinkedIn, <b>Profilbild</b>. Das Bild sehen alle G&auml;ste dieses Abends in der Teilnehmerliste und im Tischplan; es liegt auf unserem Server unter einer nicht erratbaren Adresse. Grundlage: Einwilligung, Art. 6 Abs. 1 a DSGVO. Widerruf jederzeit &uuml;ber &bdquo;Profil und Bild l&ouml;schen&ldquo; in der App.</li>' +
    '<li><b>Kontaktfreigabe</b> &ndash; E-Mail, Telefon und LinkedIn werden nur dann an einen anderen Gast weitergegeben, wenn ihr euch beidseitig verbunden habt <b>und</b> du die Weitergabe in der App erlaubt hast. Beides kannst du jederzeit &auml;ndern.</li>' +
    '<li><b>Verbindungen und Notizen</b> &ndash; wer sich mit wem verbunden hat, sehen nur die beiden Beteiligten; der Veranstalter sieht nur die Anzahl. Notizen sieht nur, wer sie schreibt.</li>' +
    '<li><b>Anwesenheit, Tisch, Live-Funktionen</b> &ndash; &bdquo;Ich bin da&ldquo;, Tischzuordnung, R&uuml;ckmeldungen zu AV8 (Votum, Sterne, Interesse), Gebote und Sch&auml;tzspiel. Interesse und Gebote werden mit deinem Namen an die jeweils Betroffenen (Gr&uuml;nder, Auktionator) weitergegeben. Grundlage: Art. 6 Abs. 1 b bzw. a DSGVO.</li>' +
    '<li><b>Benachrichtigungen</b> &ndash; wenn du sie erlaubst, speichern wir die Push-Adresse deines Ger&auml;ts (Apple/Google). Inhalte werden verschl&uuml;sselt &uuml;bertragen. Abschalten jederzeit in den Ger&auml;teeinstellungen.</li>' +
    '<li><b>Technik</b> &ndash; Server-Protokolle (IP-Adresse, Zeitpunkt) f&uuml;r Betrieb und Sicherheit, Art. 6 Abs. 1 f DSGVO; lokale Speicherung deines Zugangs auf deinem Ger&auml;t.</li></ul>' +
    '<h2>Empf&auml;nger</h2><p>Stripe (Zahlung), Lettermint (E-Mail-Versand), Apple/Google (Push), Catering (nur Ern&auml;hrungsangaben), unser Hosting-Anbieter. Keine Weitergabe an Dritte zu Werbezwecken.</p>' +
    '<h2>Speicherdauer</h2><p>Profil, Bild, Verbindungen, Notizen, Ern&auml;hrungsangaben und Push-Adressen l&ouml;schen wir sp&auml;testens 30 Tage nach dem Abend, sofern du die App nicht weiter nutzt. Zahlungsdaten bewahren wir gem&auml;&szlig; steuerlicher Pflichten auf.</p>' +
    '<h2>Deine Rechte</h2><p>Auskunft, Berichtigung, L&ouml;schung, Einschr&auml;nkung, Daten&uuml;bertragbarkeit, Widerspruch und Widerruf erteilter Einwilligungen &ndash; per E-Mail an die oben genannte Adresse oder direkt in der App. Beschwerderecht bei einer Datenschutzaufsichtsbeh&ouml;rde.</p>' + fuss;
}

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
function renderMail(inv, datei, extra) {
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
  /* Zusaetzliche Werte fuer Vorlagen, die nicht jeder Gast braucht (die
   * Rechnung). Bewusst NACH den Standardwerten: eine Vorlage darf einen
   * Standardwert ueberschreiben, nicht umgekehrt. */
  if (extra) Object.assign(werte, extra);
  /* Optionale Abschnitte: {{#schluessel}} … {{/schluessel}} bleibt nur
   * stehen, wenn der Wert gefuellt ist. Gebraucht fuer die Rechnung: ohne
   * ausgewiesene Umsatzsteuer darf dort keine leere Steuerzeile stehen -
   * "Umsatzsteuer" mit nichts dahinter liest sich wie ein Fehler.
   * Vor der Platzhalterpruefung, damit entfernte Abschnitte keine
   * unbekannten Platzhalter mehr melden koennen. */
  const roh = vorlageLesen(datei)
    .replace(/\{\{#([a-z_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
             (ganz, schluessel, inhalt) => werte[schluessel] ? inhalt : "");
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
  /* Rechnung statt blossem Zahlungsbeleg.
   *
   * Stripe schickt nach jeder Zahlung einen Beleg ("receipt") - der zeigt
   * nur, dass Geld geflossen ist. Wer die 100 Euro absetzen will, braucht
   * eine Rechnung mit Nummer, Aussteller und Steuerausweis. Genau die
   * erzeugt invoice_creation: der Gast bekommt sie als PDF und findet sie
   * unter dem Link in seiner Zahlungsbestaetigung.
   *
   * Bewusst per Schalter und standardmaessig AUS: auf der Rechnung stehen
   * Firmierung, Anschrift und Steuerausweis aus dem Stripe-Konto. Eine
   * Rechnung mit falschem oder fehlendem Umsatzsteuerausweis ist schlimmer
   * als gar keine - das muss jemand entscheiden, der die steuerliche Lage
   * kennt, nicht der Server. */
  const rechnung = process.env.STRIPE_RECHNUNG === "1";
  stripeRequest("checkout/sessions", {
    mode: "payment",
    locale: "de",
    ...(Object.keys(arten).length ? { payment_method_types: arten } : {}),
    ...(rechnung ? {
      invoice_creation: {
        enabled: true,
        invoice_data: {
          /* KEIN description hier: der Vermerk gehoert nach Stripe unter
           * Billing -> Rechnungen -> Standardvermerk. Setzten wir ihn auch
           * hier, gaebe es zwei Stellen fuer denselben Satz - und die aus
           * dem Code gewaenne, waehrend im Dashboard etwas anderes steht.
           * Hier nur, was Stripe nicht wissen kann: welcher Gast, welcher
           * Platz. */
          custom_fields: {
            0: { name: "Gast",  value: (inv.name || "—").slice(0, 30) },
            1: { name: "Platz", value: inv.ticketNr || "—" }
          },
          metadata: { token: inv.token },
          rendering_options: { amount_tax_display: "include_inclusive_tax" }
        }
      }
    } : {}),
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

/* Faellig ist eine Rechnung fuer bezahlte Bezahlgaeste - genau einmal.
 * Ehrengaeste zahlen nichts, ueber nichts stellt man keine Rechnung. */
function rechnungFaellig(inv) {
  if (!rechnungMoeglich()) return false;
  if (!inv || !inv.email || inv.typ === "ehrengast") return false;
  if (inv.status !== "bezahlt") return false;
  return !(inv.rechnung && inv.rechnung.verschickt);
}

/* Die Nummer wird EINMAL vergeben und bleibt dann am Gast kleben - auch
 * wenn der Versand scheitert. Ein zweiter Anlauf schickt dieselbe Rechnung
 * mit derselben Nummer. Eine Nummer neu zu vergeben, weil eine Mail nicht
 * durchkam, hiesse dieselbe Leistung zweimal zu berechnen. */
function rechnungNummer(inv) {
  if (inv.rechnung && inv.rechnung.nr) return inv.rechnung.nr;
  state.rechnungZaehler = (state.rechnungZaehler || 0) + 1;
  inv.rechnung = { nr: RECHNUNG_PRAEFIX + String(state.rechnungZaehler).padStart(4, "0"),
                   t: Date.now(), verschickt: 0 };
  dirty = true;
  return inv.rechnung.nr;
}

function rechnungSenden(inv) {
  if (!LETTERMINT_TOKEN) return;
  if (!rechnungFaellig(inv)) return;
  const nr = rechnungNummer(inv);
  const brutto = (inv.zahlung && inv.zahlung.amount) || preisVon(inv);
  /* Bei ausgewiesener Steuer ist der gezahlte Betrag der BRUTTObetrag -
   * herausgerechnet, nicht aufgeschlagen. Der Gast hat 100 Euro gezahlt,
   * nicht 119. */
  const netto = RECHNUNG_USTSATZ > 0
    ? Math.round(brutto / (1 + RECHNUNG_USTSATZ / 100))
    : brutto;
  const ust = brutto - netto;
  const datum = new Date(inv.rechnung.t);
  const dstr = d => String(d.getDate()).padStart(2, "0") + "." +
                    String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();
  const extra = {
    rechnung_nr: nr,
    rechnung_datum: dstr(datum),
    zahlung_datum: dstr(new Date((inv.zahlung && inv.zahlung.paidAt) || inv.rechnung.t)),
    aussteller: RECHNUNG_FIRMA,
    aussteller_anschrift: RECHNUNG_ANSCHRIFT.split("|").map(z => z.trim()).filter(Boolean).join(", "),
    aussteller_steuer: RECHNUNG_STEUER,
    aussteller_kontakt: RECHNUNG_KONTAKT,
    empfaenger: [inv.name, inv.firma].filter(Boolean).join(", "),
    betrag_brutto: euroText(brutto),
    betrag_netto: euroText(netto),
    ust_satz: RECHNUNG_USTSATZ > 0 ? String(RECHNUNG_USTSATZ).replace(".", ",") + " %" : "",
    ust_betrag: RECHNUNG_USTSATZ > 0 ? euroText(ust) : "",
    /* Steht statt der Steuerzeile, wenn keine ausgewiesen wird - der Grund
     * MUSS auf der Rechnung stehen, sonst fehlt eine Pflichtangabe. */
    steuer_hinweis: RECHNUNG_USTSATZ > 0 ? "" : RECHNUNG_HINWEIS,
    leistungsdatum: "16.09.2026"
  };
  let html;
  try { html = renderMail(inv, "rechnung.html", extra); }
  catch (e) { console.error("Rechnung bricht: " + e.message); return; }

  const text = [
    (inv.anrede || "Hallo") + " " + ((inv.name || "").split(" ")[0] || "") + ",",
    "",
    "anbei die Rechnung über deine Teilnahme an THE CIRCLE No1.",
    "",
    "Rechnung " + nr + " vom " + extra.rechnung_datum,
    RECHNUNG_FIRMA, extra.aussteller_anschrift,
    RECHNUNG_STEUER, "",
    "Teilnahme THE CIRCLE No1 · 16. September 2026 · Playa Cologne, Köln",
    RECHNUNG_USTSATZ > 0
      ? "Netto " + extra.betrag_netto + " · zzgl. " + extra.ust_satz + " USt " + extra.ust_betrag
      : RECHNUNG_HINWEIS,
    "Gesamtbetrag " + extra.betrag_brutto + " – bezahlt am " + extra.zahlung_datum + ".",
    "",
    "Fragen zur Rechnung: " + RECHNUNG_KONTAKT
  ].filter(Boolean).join("\n");

  lettermintSenden({
    to: inv.email,
    subject: "Deine Rechnung zu THE CIRCLE No1 · " + nr,
    html, text,
    metadata: { token: inv.token, art: "rechnung", pool: inv.pool || "" }
  }, (err) => {
    if (err) {
      /* Nummer BLEIBT - nur der Versandvermerk fehlt, der naechste Anlauf
       * schickt dieselbe Rechnung. */
      console.error("Rechnung " + nr + " an " + inv.email + " fehlgeschlagen: " + err.message);
    } else {
      inv.rechnung.verschickt = Date.now();
      dirty = true;
      console.log("Rechnung " + nr + " an " + inv.email + " verschickt.");
    }
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
  /* Mit Abstand, damit Bestaetigung und Rechnung nicht in derselben Sekunde
   * beim Anbieter ankommen - und damit sie in der richtigen Reihenfolge im
   * Postfach liegen. */
  setTimeout(() => rechnungSenden(inv), 4000);
}

/* ---------- Server ---------- */
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  const q = new URLSearchParams(req.url.split("?")[1] || "");

  /* Fuer jede Antwort. Der persoenliche Token steht in der Adresse der App -
     ohne Referrer-Policy wanderte er mit jedem Klick auf LinkedIn, Maps oder
     einen News-Link zum fremden Server. */
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  /* --- Live-API (aggregiert, für die App) --- */

  /* Die Zeiten des Abends, oeffentlich lesbar. Der Weg ueber den Stream ist
   * der normale; dieser Abruf ist der Rueckfallweg fuer den Fall, dass der
   * Stream nicht zustande kommt (Firmen-WLAN mit Proxy, alter Browser).
   * Ohne ihn haetten genau die Gaeste mit der schlechtesten Verbindung die
   * veralteten Zeiten aus der App-Datei. */
  if (req.method === "GET" && url === "/api/live/zeiten") {
    return json(res, 200, { ok: true, zeiten: Object.assign({}, state.zeiten,
      { jetztMs: Date.now(), tz: "Europe/Berlin", appfreiJetzt: appfreiJetzt(), phase: phaseJetzt() }) });
  }

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
      /* Damit um 17:00 pruefbar ist, ob die Uhr stimmt. */
      jetztMs: Date.now(), koeln: berlinJetzt().hhmm,
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
    /* Die Zeiten einmal beim Verbinden - danach nur noch bei Aenderung.
     * Dasselbe fuer das laufende Signal: wer die App nach dem Tischwechsel
     * oeffnet, soll ihn trotzdem sehen. */
    res.write(zeitenZeile());
    res.write(signalZeile());
    broadcast();                                   // Gäste-Zähler an alle
    req.on("close", () => { clients.delete(res); broadcast(); });
    return;
  }

  if (req.method === "POST" && url === "/api/live/applause") {
    if (!rateLimit(req, res, "live", LIMIT_LIVE[0], LIMIT_LIVE[1])) return;
    return readBody(req, res, body => {
      const n = Math.min(Math.max(parseInt(body.n, 10) || 0, 0), 30);
      state.applause += n;
      dirty = true; broadcast();
      json(res, 200, { ok: true });
    });
  }

  if (req.method === "POST" && url === "/api/live/vote") {
    if (!rateLimit(req, res, "live", LIMIT_LIVE[0], LIMIT_LIVE[1])) return;
    return readBody(req, res, body => {
      const vote = VOTES.includes(body.vote) ? body.vote : null;
      const prev = VOTES.includes(body.prev) ? body.prev : null;
      if (prev && state.votes[prev] > 0) state.votes[prev]--;
      if (vote) state.votes[vote]++;
      dirty = true; broadcast();
      json(res, 200, { ok: true });
    });
  }

  /* Sterne fuer das Produkt. Wie beim Votum schickt der Klient seine
   * vorherige Wahl mit, damit ein Umentscheiden nicht doppelt zaehlt -
   * der Server fuehrt bewusst keine Liste, wer was gewaehlt hat. */
  if (req.method === "POST" && url === "/api/live/stern") {
    if (!rateLimit(req, res, "live", LIMIT_LIVE[0], LIMIT_LIVE[1])) return;
    return readBody(req, res, body => {
      const gueltig = n => Number.isInteger(n) && n >= 1 && n <= 5;
      const stern = gueltig(body.stern) ? body.stern : null;
      const prev = gueltig(body.prev) ? body.prev : null;
      if (prev && state.sterne[prev] > 0) state.sterne[prev]--;
      if (stern) state.sterne[stern] = (state.sterne[stern] || 0) + 1;
      /* Mit Token auch am Gast: AV8 soll nachher wissen, wer die fuenf
       * Sterne gegeben hat - nicht nur, dass es 31 waren. */
      const inv = findInvite(body.t);
      if (inv) { if (!inv.av8) inv.av8 = {}; inv.av8.stern = stern || 0; inv.av8.t = Date.now(); }
      dirty = true; broadcast();
      json(res, 200, { ok: true });
    });
  }

  /* "Ich biete ein Intro" / "Ich moechte als Investor:in sprechen".
   * Ein Schalter, kein Zaehler: der Gast kann ihn wieder ausmachen. */
  if (req.method === "POST" && url === "/api/live/interesse") {
    if (!rateLimit(req, res, "live", LIMIT_LIVE[0], LIMIT_LIVE[1])) return;
    return readBody(req, res, body => {
      const art = (body.art === "intro" || body.art === "investor") ? body.art : null;
      if (!art) return json(res, 400, { error: "unbekannte Art" });
      if (body.an) state.interesse[art] = (state.interesse[art] || 0) + 1;
      else if (state.interesse[art] > 0) state.interesse[art]--;
      /* Das Versprechen "wir sagen den Gruendern Bescheid" ist nur haltbar,
       * wenn der Server weiss, WER sich gemeldet hat. Ohne Token (Demo)
       * bleibt es beim Zaehler. */
      const inv = findInvite(body.t);
      if (inv) { if (!inv.av8) inv.av8 = {}; inv.av8[art] = body.an ? Date.now() : 0; }
      dirty = true; broadcast();
      json(res, 200, { ok: true, gemerkt: !!inv });
    });
  }

  /* Schaetzspiel: der Tipp zum Erloes, je Gast, damit nach dem Zuschlag
   * jemand aufloesen kann. Bisher lag er nur im Speicher des Handys. */
  if (req.method === "POST" && url === "/api/live/tipp") {
    if (!rateLimit(req, res, "live", LIMIT_LIVE[0], LIMIT_LIVE[1])) return;
    return readBody(req, res, body => {
      const wert = parseInt(body.wert, 10);
      if (!Number.isInteger(wert) || wert < 1 || wert > 5_000_000) return json(res, 400, { error: "Tipp 1–5.000.000" });
      const inv = findInvite(body.t);
      if (!inv) return json(res, 200, { ok: true, gemerkt: false });
      inv.tipp = { wert, t: Date.now() };
      dirty = true;
      json(res, 200, { ok: true, gemerkt: true });
    });
  }

  if (req.method === "POST" && url === "/api/live/bid") {
    if (!rateLimit(req, res, "live", LIMIT_LIVE[0], LIMIT_LIVE[1])) return;
    return readBody(req, res, body => {
      const amount = parseInt(body.amount, 10) || 0;
      const current = state.bid ? state.bid.amount : 0;
      // Sprung nach oben deckeln: ein einzelnes Gebot darf current nicht um mehr
      // als 5.000 € ueberbieten. Sonst nagelt ein Fake-Maxgebot die Auktion an
      // die 2-Mio-Decke und jedes echte Gebot gilt danach als "zu niedrig".
      if (amount <= current || amount > current + 5_000 || amount > 2_000_000) {
        return json(res, 409, { error: "ungültiges Gebot", bid: state.bid });
      }
      /* Nach dem Zuschlag ist Schluss - egal, was noch aus der App kommt. */
      if (state.auktion && state.auktion.zu) return json(res, 409, { error: "Die Auktion ist beendet.", bid: state.bid });
      /* Mit Token: Bieterkarte und Name kommen vom Gast selbst - die
       * Kreisnummer ist eindeutig, ein Hash aus dem Namen war es nicht
       * (88 Nummern fuer 130 Gaeste). Ohne Token (Demo, Station) wie
       * bisher aus dem Rumpf. */
      const bieter = findInvite(body.t);
      state.bid = {
        amount,
        paddle: bieter ? String(bieter.ticketNr || "").replace(/\D/g, "") : clean(body.paddle, 4),
        name: bieter ? (bieter.name || "").split(" ")[0] : clean(body.name, 30),
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

  /* ================= APP-API (Welle 2) =================
   * Alles haengt am persoenlichen Token (?t= bzw. body.t). Wer keinen hat,
   * sieht nichts - auch keine Liste. Die Liste ist der Grund, warum die
   * Gaeste die App oeffnen, und genau deshalb darf sie nicht offen liegen. */

  /* Ich selbst: Register-Daten plus Profil. Erster Aufruf der App. */
  if (req.method === "GET" && url === "/api/app/ich") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    const inv = findInvite(q.get("t"));
    if (!inv) return json(res, 404, { error: "unbekannt" });
    if (!imKreis(inv)) return json(res, 403, { error: "nicht zugesagt", status: inv.status });
    const p = profil(inv);
    /* Womit oeffnet der Gast die App - Browser oder installiert? Das ist
     * die Zahl, an der haengt, ob die App nach dem Abend weiterlebt.
     * Ohne sie wuesste am 16. niemand, wen Galerie und News erreichen. */
    const modus = q.get("modus");
    if (modus === "standalone" || modus === "browser") {
      if (!inv.app) inv.app = {};
      inv.app[modus] = Date.now(); dirty = true;
    }
    return json(res, 200, { ok: true, ich: {
      id: gid(inv), name: inv.name, vorname: (inv.name || "").split(" ")[0],
      anrede: inv.anrede || "Hallo", firma: inv.firma || "", rolle: inv.rolle || "",
      email: inv.email || "", telefon: (inv.daten && inv.daten.phone) || "",
      diet: (inv.daten && inv.daten.diet) || "", allergy: (inv.daten && inv.daten.allergy) || "",
      ticketNr: inv.ticketNr || "", typ: inv.typ, partner: inv.partner || "",
      foto: fotoUrl(inv, false), sichtbar: !!p.sichtbar, registriert: p.registriert || 0,
      ueber: p.ueber || "", sucht: p.sucht || "", linkedin: p.linkedin || "",
      da: inv.da || 0, push: !!inv.push, runde: rundeVon(inv),
      installiert: !!(inv.app && inv.app.standalone),
      tisch: meinTisch(inv), gang: tische().gang,
      /* Nach dem Abend: was der Gast mitnimmt. */
      abend: inv.abend || null, momente: inv.momente || {}, feedback: inv.feedback || null,
      galerieOffen: !!galerie(rundeVon(inv)).offen, no2: state.no2 || null
    }, vapid: VAPID.publicKey, signal: signalAktuell(), jetztMs: Date.now(), phase: phaseJetzt() });
  }

  /* Registrierung abschliessen: Profil vervollstaendigen, Bild, Freigabe.
   * Die Freigabe wird HIER gesetzt, im selben Schritt wie das Foto - nicht
   * im Zusage-Formular. Damit steht die Einwilligung vor dem ersten Kontakt
   * und nicht mittendrin. */
  if (req.method === "POST" && url === "/api/app/profil") {
    if (!rateLimit(req, res, "profil", 30, 60_000)) return;
    return readBodyGross(req, res, body => {
      const inv = findInvite(body.t);
      if (!inv || !imKreis(inv)) return json(res, 403, { error: "kein Zugang" });
      const p = profil(inv);
      if (body.firma    !== undefined) inv.firma = cleanText(body.firma, 80);
      if (body.rolle    !== undefined) inv.rolle = cleanText(body.rolle, 80);
      if (body.ueber    !== undefined) p.ueber = cleanText(body.ueber, 200);
      if (body.sucht    !== undefined) p.sucht = cleanText(body.sucht, 60);
      if (body.linkedin !== undefined) p.linkedin = cleanText(body.linkedin, 120).replace(/^https?:\/\//, "");
      if (body.telefon  !== undefined) { if (!inv.daten) inv.daten = {}; inv.daten.phone = cleanText(body.telefon, 30); }
      if (body.sichtbar !== undefined) p.sichtbar = !!body.sichtbar;

      /* Bild: zwei Groessen, beide vom Browser gerechnet. Gross fuers
       * Kurzprofil, klein fuer die Liste. Kein Bild ist ein gueltiger
       * Zustand - keine Blockade. */
      if (body.foto === "") {
        /* Loeschen heisst loeschen - nicht nur das Feld leeren. Sonst bleibt
         * das Bild unter seiner Adresse abrufbar. */
        if (p.foto) for (const sfx of ["", "-m"]) { try { fs.unlinkSync(path.join(FOTO_DIR, p.foto + sfx + ".jpg")); } catch (e) {} }
        p.foto = "";
      } else if (body.foto) {
        const gross = jpegAusDataUrl(body.foto, 400_000);
        const klein = jpegAusDataUrl(body.mini, 40_000);
        if (!gross || !klein) return json(res, 400, { error: "Bild nicht lesbar (JPEG, zwei Größen erwartet)" });
        const id = crypto.randomBytes(8).toString("hex");
        try {
          fs.mkdirSync(FOTO_DIR, { recursive: true });
          fs.writeFileSync(path.join(FOTO_DIR, id + ".jpg"), gross);
          fs.writeFileSync(path.join(FOTO_DIR, id + "-m.jpg"), klein);
        } catch (e) { return json(res, 500, { error: "Bild konnte nicht gespeichert werden" }); }
        /* Altes Bild wegraeumen - sonst sammeln sich Dateien, und ein
         * altes Bild bliebe unter seiner Adresse abrufbar. */
        if (p.foto) for (const s of ["", "-m"]) { try { fs.unlinkSync(path.join(FOTO_DIR, p.foto + s + ".jpg")); } catch (e) {} }
        p.foto = id;
      }
      if (!p.registriert) { p.registriert = Date.now(); logEvent("App registriert", inv.name, inv.pool); }
      dirty = true; revHoch(); broadcast();
      return json(res, 200, { ok: true, foto: fotoUrl(inv, false), sichtbar: p.sichtbar, registriert: p.registriert });
    });
  }

  /* Profil loeschen: Bild, Profiltexte, Verbindungen samt Notizen, Push,
   * Telefon. Die Zusage und die Zahlung bleiben - die brauchen wir fuer
   * den Abend und die Buchhaltung. Danach steht der Gast in der Liste wie
   * einer, der die App nie geoeffnet hat. */
  if (req.method === "POST" && url === "/api/app/loeschen") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    return readBody(req, res, body => {
      const inv = findInvite(body.t);
      if (!inv || !imKreis(inv)) return json(res, 403, { error: "kein Zugang" });
      const p = profil(inv);
      if (p.foto) for (const sfx of ["", "-m"]) { try { fs.unlinkSync(path.join(FOTO_DIR, p.foto + sfx + ".jpg")); } catch (e) {} }
      inv.profil = null; inv.push = null; inv.av8 = null; inv.tipp = null;
      if (inv.daten) inv.daten.phone = "";
      const g = gid(inv);
      for (const k of Object.keys(state.verbindungen || {})) if (k.split("|").includes(g)) delete state.verbindungen[k];
      dirty = true; revHoch(); broadcast();
      logEvent("Profil gelöscht", "", "");
      return json(res, 200, { ok: true });
    });
  }

  /* Galerie-Bilder: unerratbare Kennung, lange gecacht (die Kennung ist
   * stabil, ein Bild aendert sich nie). */
  if ((req.method === "GET" || req.method === "HEAD") && url.startsWith("/g/")) {
    const m = /^\/g\/([a-z0-9_-]{1,20})\/([a-f0-9]{16})-(m|w)\.jpg$/.exec(url);
    if (!m) { res.writeHead(404); return res.end(); }
    return fs.readFile(path.join(GALERIE_DIR, m[1], m[2] + "-" + m[3] + ".jpg"), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": buf.length,
                           "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  }

  /* Bilder. Die Kennung ist zufaellig und verraet nichts ueber den Gast. */
  if ((req.method === "GET" || req.method === "HEAD") && url.startsWith("/foto/")) {
    const name = url.slice(6);
    if (!/^[a-f0-9]{16}(-m)?\.jpg$/.test(name)) { res.writeHead(404); return res.end(); }
    return fs.readFile(path.join(FOTO_DIR, name), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": buf.length,
                           "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  }

  /* Teilnehmerliste. JEDER Gast des Abends steht drin, auch wer die App nie
   * geoeffnet hat - sonst ist die Liste am Anfang leer und niemand kommt
   * wieder. Registrierte mit Bild zuerst: das belohnt das Hochladen. */
  if (req.method === "GET" && url === "/api/app/gaeste") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    const ich = findInvite(q.get("t"));
    if (!ich || !imKreis(ich)) return json(res, 403, { error: "kein Zugang" });
    const liste = Object.values(state.invites).filter(inv => imKreis(inv) && inv !== ich && gleicheRunde(inv, ich))
      .map(inv => listenEintrag(ich, inv))
      .sort((a, b) => (b.foto ? 1 : 0) - (a.foto ? 1 : 0) || (b.registriert ? 1 : 0) - (a.registriert ? 1 : 0) || a.name.localeCompare(b.name));
    return json(res, 200, { ok: true, gaeste: liste, anzahl: liste.length + 1 });
  }

  /* Kurzprofil eines anderen. */
  if (req.method === "GET" && url === "/api/app/gast") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    const ich = findInvite(q.get("t"));
    if (!ich || !imKreis(ich)) return json(res, 403, { error: "kein Zugang" });
    const inv = findByGid(q.get("wen"));
    if (!inv || !imKreis(inv) || !gleicheRunde(inv, ich)) return json(res, 404, { error: "unbekannt" });
    return json(res, 200, { ok: true, gast: kurzprofil(ich, inv) });
  }

  /* Verbinden. Zustaende: offen -> verbunden | abgelehnt | spaeter.
   * Idempotent je Paar. */
  if (req.method === "POST" && url === "/api/app/verbinden") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    return readBody(req, res, body => {
      const ich = findInvite(body.t);
      if (!ich || !imKreis(ich)) return json(res, 403, { error: "kein Zugang" });
      const andere = findByGid(body.wen);
      if (!andere || !imKreis(andere) || andere === ich || !gleicheRunde(andere, ich)) return json(res, 404, { error: "unbekannt" });
      const a = gid(ich), b = gid(andere);
      if (!state.verbindungen) state.verbindungen = {};
      const k = paarKey(a, b, rundeVon(ich));
      let v = hasOwn(state.verbindungen, k) ? state.verbindungen[k] : null;
      const aktion = String(body.aktion || "");

      if (aktion === "anfragen") {
        if (v && v.status === "verbunden") { /* schon verbunden - nichts zu tun */ }
        else if (v && v.status === "offen" && v.von === b) {
          /* Der andere hatte schon gefragt: das ist die Zustimmung. */
          v.status = "verbunden"; v.antwort = Date.now();
          logEvent("verbunden", "", "");
          pushAnEinen(andere, { titel: "Ihr seid verbunden", text: ich.name + " hat zugestimmt – der Kontakt liegt in deinem Gästebuch.", url: "/?t=" + andere.token + "#kreis", tag: "kreis" });
        } else if (!v || v.status === "spaeter" || (v.status === "abgelehnt" && v.von !== a)) {
          if (!anfrageErlaubt(a)) return json(res, 429, { error: "Genug für den Moment – sprich erst mit den Leuten." });
          state.verbindungen[k] = v = { von: a, status: "offen", t: Date.now(), antwort: 0 };
          pushAnEinen(andere, { titel: "Jemand möchte sich verbinden", text: ich.name + (ich.firma ? " · " + ich.firma : "") + " – antworten im Gästebuch.", url: "/?t=" + andere.token + "#kreis", tag: "kreis" });
        }
        /* offen von mir oder abgelehnt von mir: bleibt, wie es ist */
      } else if (aktion === "annehmen") {
        if (!v || v.status !== "offen" || v.von !== b) return json(res, 409, { error: "keine offene Anfrage" });
        v.status = "verbunden"; v.antwort = Date.now();
        logEvent("verbunden", "", "");
        pushAnEinen(andere, { titel: "Ihr seid verbunden", text: ich.name + " hat zugestimmt – der Kontakt liegt in deinem Gästebuch.", url: "/?t=" + andere.token + "#kreis", tag: "kreis" });
      } else if (aktion === "ablehnen") {
        if (!v || v.status !== "offen" || v.von !== b) return json(res, 409, { error: "keine offene Anfrage" });
        v.status = "abgelehnt"; v.antwort = Date.now();
      } else if (aktion === "spaeter") {
        /* Der leise zweite Weg: nicht abgelehnt, nicht verbunden. Geht in
         * beide Richtungen, auch ohne vorherige Anfrage. */
        if (v && v.status === "verbunden") return json(res, 409, { error: "schon verbunden" });
        state.verbindungen[k] = v = { von: a, status: "spaeter", t: Date.now(), antwort: 0 };
      } else if (aktion === "trennen") {
        if (v) delete state.verbindungen[k];
        v = null;
      } else return json(res, 400, { error: "unbekannte Aktion" });

      dirty = true; revHoch();
      /* Beide Seiten sollen es sofort sehen - der andere wartet vielleicht
       * gerade auf die Antwort. */
      broadcast();
      return json(res, 200, { ok: true, verbindung: verbindungAusSicht(a, b, rundeVon(ich)), gast: kurzprofil(ich, andere) });
    });
  }

  /* Notiz zu einer Verbindung - "wollte ihr das Deck schicken". Gehoert
   * nur dem, der sie schreibt; der andere sieht sie nie. */
  if (req.method === "POST" && url === "/api/app/notiz") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    return readBody(req, res, body => {
      const ich = findInvite(body.t);
      if (!ich || !imKreis(ich)) return json(res, 403, { error: "kein Zugang" });
      const andere = findByGid(body.wen);
      if (!andere || !gleicheRunde(andere, ich)) return json(res, 404, { error: "unbekannt" });
      const v = verbindung(gid(ich), gid(andere), rundeVon(ich));
      if (!v) return json(res, 409, { error: "keine Verbindung" });
      if (!v.notizen) v.notizen = {};
      v.notizen[gid(ich)] = cleanText(body.text, 300);
      dirty = true;
      return json(res, 200, { ok: true });
    });
  }

  /* Mein Kreis: alle Begegnungen des Abends an einem Ort. */
  if (req.method === "GET" && url === "/api/app/kreis") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    const ich = findInvite(q.get("t"));
    if (!ich || !imKreis(ich)) return json(res, 403, { error: "kein Zugang" });
    const a = gid(ich);
    const verbunden = [], spaeter = [], anfragen = [], angefragt = [];
    for (const inv of Object.values(state.invites)) {
      if (!imKreis(inv) || inv === ich || !gleicheRunde(inv, ich)) continue;
      const s = verbindungAusSicht(a, gid(inv), rundeVon(ich));
      if (s === "verbunden") verbunden.push(kurzprofil(ich, inv));
      else if (s === "spaeter") spaeter.push(listenEintrag(ich, inv));
      else if (s === "anfrage") anfragen.push(listenEintrag(ich, inv));
      else if (s === "angefragt") angefragt.push(listenEintrag(ich, inv));
    }
    const nachName = (x, y) => x.name.localeCompare(y.name);
    return json(res, 200, { ok: true, verbunden: verbunden.sort(nachName), spaeter: spaeter.sort(nachName),
                            anfragen: anfragen.sort(nachName), angefragt: angefragt.sort(nachName) });
  }

  /* Ein Moment im Kreis. Bleibt auch auf dem Server, damit die Wand am
   * Ende "41 Kreise geschlossen" zeigen kann. */
  if (req.method === "POST" && url === "/api/app/moment") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    return readBody(req, res, body => {
      const inv = findInvite(body.t);
      if (!inv || !imKreis(inv)) return json(res, 403, { error: "kein Zugang" });
      const id = clean(body.id, 20);
      if (!id) return json(res, 400, { error: "id" });
      if (!inv.momente) inv.momente = {};
      if (!inv.momente[id]) { inv.momente[id] = Date.now(); dirty = true; broadcast(); }
      return json(res, 200, { ok: true, anzahl: Object.keys(inv.momente).length });
    });
  }

  /* Quittung: die App hat ein Signal angezeigt. Im Monitor steht dann
   * "118 Push gesendet - 71 Apps haben es angezeigt" - die Frage, die man
   * sich in dem Moment wirklich stellt. */
  if (req.method === "POST" && url === "/api/app/gesehen") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    return readBody(req, res, body => {
      const inv = findInvite(body.t);
      if (!inv || !imKreis(inv)) return json(res, 403, { error: "kein Zugang" });
      const t = parseInt(body.signalT, 10);
      if (state.signal && state.signal.t === t) {
        if (!state.signal.gesehen) state.signal.gesehen = {};
        if (!state.signal.gesehen[gid(inv)]) { state.signal.gesehen[gid(inv)] = 1; dirty = true; }
      }
      return json(res, 200, { ok: true });
    });
  }

  /* Der eigene Satz vom Abend ("Meine Erkenntnis"). Lag nur im Speicher
   * des Handys - neues Geraet, weg. Jetzt auf dem Server, damit er in den
   * Rueckblick und in die Mail kann. */
  if (req.method === "POST" && url === "/api/app/abend") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    return readBody(req, res, body => {
      const inv = findInvite(body.t);
      if (!inv || !imKreis(inv)) return json(res, 403, { error: "kein Zugang" });
      if (!inv.abend) inv.abend = {};
      if (body.satz !== undefined) inv.abend.satz = cleanText(body.satz, 500);
      if (body.fotoOk !== undefined) inv.abend.fotoOk = !!body.fotoOk;
      inv.abend.t = Date.now(); dirty = true;
      return json(res, 200, { ok: true });
    });
  }

  /* Feedback 24-36 h danach: ein Daumen, ein Satz. Ueberschreibbar. */
  if (req.method === "POST" && url === "/api/app/feedback") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    return readBody(req, res, body => {
      const inv = findInvite(body.t);
      if (!inv || !imKreis(inv)) return json(res, 403, { error: "kein Zugang" });
      const d = body.daumen === 1 || body.daumen === -1 ? body.daumen : 0;
      if (!d) return json(res, 400, { error: "daumen 1 oder -1" });
      inv.feedback = { daumen: d, satz: cleanText(body.satz, 400), t: Date.now() };
      dirty = true; logEvent("Feedback", "", d > 0 ? "Daumen hoch" : "Daumen runter");
      return json(res, 200, { ok: true });
    });
  }

  /* News: Beitraege fuer alle Runden oder nur die eigene. */
  if (req.method === "GET" && url === "/api/app/news") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    const ich = findInvite(q.get("t"));
    if (!ich || !imKreis(ich)) return json(res, 403, { error: "kein Zugang" });
    const liste = (state.news || []).filter(n => n.veroeffentlicht && (n.sichtbar === "alle" || n.sichtbar === rundeVon(ich)))
      .sort((a, b) => b.t - a.t).map(n => ({ id: n.id, t: n.t, titel: n.titel, text: n.text, link: n.link || "", linkText: n.linkText || "", bild: n.bild || "" }));
    return json(res, 200, { ok: true, news: liste });
  }

  /* Galerie: gemeinsame Bilder der Runde plus die eigenen Highlights. */
  if (req.method === "GET" && url === "/api/app/galerie") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    const ich = findInvite(q.get("t"));
    if (!ich || !imKreis(ich)) return json(res, 403, { error: "kein Zugang" });
    const r = rundeVon(ich), g = galerie(r);
    if (!g.offen) return json(res, 200, { ok: true, offen: false, highlights: [], fotos: [], anzahl: 0 });
    const alle = Object.values(g.fotos).sort((a, b) => a.t - b.t);
    const mach = f => ({ id: f.id, m: galerieUrl(r, f.id, "m"), w: galerieUrl(r, f.id, "w"), t: f.t, breit: !!f.breit });
    const meine = alle.filter(f => (f.wer || []).includes(gid(ich))).map(mach);
    const seite = Math.max(0, parseInt(q.get("seite"), 10) || 0), GR = 60;
    return json(res, 200, { ok: true, offen: true, highlights: meine, fotos: alle.slice(seite * GR, (seite + 1) * GR).map(mach),
                            anzahl: alle.length, seiten: Math.ceil(alle.length / GR) });
  }

  /* "Ich bin da." Der erste Moment, in dem der Gast die App benutzt. */
  if (req.method === "POST" && url === "/api/app/da") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    return readBody(req, res, body => {
      const inv = findInvite(body.t);
      if (!inv || !imKreis(inv)) return json(res, 403, { error: "kein Zugang" });
      if (!inv.da) { inv.da = Date.now(); logEvent("da", inv.name, inv.pool); dirty = true; revHoch(); broadcast(); }
      return json(res, 200, { ok: true, da: inv.da });
    });
  }

  /* Mein Tisch: je Gang der Tisch, und fuer den laufenden Gang die
   * Nachbarn - mit Bild, damit "wer sitzt links und rechts" kein Raetsel ist,
   * sondern ein Gespraechsanfang. */
  if (req.method === "GET" && url === "/api/app/tisch") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    const ich = findInvite(q.get("t"));
    if (!ich || !imKreis(ich)) return json(res, 403, { error: "kein Zugang" });
    const t = tische();
    const gangNr = parseInt(q.get("gang"), 10) || t.gang || 1;
    const s = t.sitz[gid(ich)] || [];
    return json(res, 200, { ok: true,
      gaenge: t.gaenge, gang: t.gang,
      meine: t.gaenge.map((g, i) => ({ gang: i + 1, name: g, tisch: s[i] || 0,
        tischName: (t.liste.find(x => x.nr === s[i]) || {}).name || "" })),
      angezeigt: gangNr,
      tisch: meinTisch(ich, gangNr),
      nachbarn: tischnachbarn(ich, gangNr)
    });
  }

  /* Der ganze Plan - damit nicht 100 Gaeste vor dem Bildschirm stehen. */
  if (req.method === "GET" && url === "/api/app/tischplan") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    const ich = findInvite(q.get("t"));
    if (!ich || !imKreis(ich)) return json(res, 403, { error: "kein Zugang" });
    const t = tische();
    const gangNr = parseInt(q.get("gang"), 10) || t.gang || 1;
    const g = gangNr - 1;
    const plan = t.liste.map(tisch => ({
      nr: tisch.nr, name: tisch.name || "",
      gaeste: Object.values(state.invites)
        .filter(inv => imKreis(inv) && gleicheRunde(inv, ich) && t.sitz[gid(inv)] && t.sitz[gid(inv)][g] === tisch.nr)
        .map(inv => ({ id: gid(inv), name: inv.name, foto: fotoUrl(inv, true), ich: inv === ich }))
        .sort((x, y) => x.name.localeCompare(y.name))
    }));
    return json(res, 200, { ok: true, gaenge: t.gaenge, gang: t.gang, angezeigt: gangNr, tische: plan });
  }

  /* Push-Abonnement des Gastes. Kommt erst aus der installierten App (iOS). */
  if (req.method === "POST" && url === "/api/app/push") {
    if (!rateLimit(req, res, "app", LIMIT_APP[0], LIMIT_APP[1])) return;
    return readBody(req, res, body => {
      const inv = findInvite(body.t);
      if (!inv || !imKreis(inv)) return json(res, 403, { error: "kein Zugang" });
      const s = body.subscription;
      if (s === null) { inv.push = null; dirty = true; return json(res, 200, { ok: true, push: false }); }
      if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) ||
          !s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string") {
        return json(res, 400, { error: "kein gültiges Abonnement" });
      }
      inv.push = { endpoint: s.endpoint.slice(0, 500), keys: { p256dh: s.keys.p256dh.slice(0, 200), auth: s.keys.auth.slice(0, 100) }, t: Date.now() };
      dirty = true;
      return json(res, 200, { ok: true, push: true });
    });
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
  if (req.method === "GET" && (url === "/datenschutz" || url === "/impressum")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    return res.end(rechtsSeite(url.slice(1)));
  }

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
        app: kreisZahlen(),
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
      /* Nur eigene Schluessel: state.invites["__proto__"] waere sonst das
         Object-Prototyp, und inv.whatsapp = {} stuende auf jedem Objekt. */
      const tk = String(q.get("token") || "");
      const inv = Object.prototype.hasOwnProperty.call(state.invites, tk) ? state.invites[tk] : null;
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
      req.on("data", c => { roh += c; if (roh.length > 500_000 && !zuGross) { zuGross = true; zuGrossAbbruch(req, res); } });
      req.on("end", () => {
        if (zuGross) return;
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
    /* Zeiten des Abends aendern.
     *
     * Erwartet {appfrei:[...], gates:{...}, jetzt:...} - alles einzeln
     * optional, damit ein Knopf im Monitor nur das schicken muss, was er
     * anfasst. Ein Aufruf, der versehentlich nur die Gates enthaelt, darf
     * nicht die app-freien Stellen loeschen.
     *
     * Jede Uhrzeit wird geprueft. Eine "19:6O" mit einem O statt einer Null
     * faellt am Abend niemandem auf: Das Fenster ginge einfach nie auf, und
     * alle wuerden auf eine Kachel starren, die geschlossen bleibt. Lieber
     * hier ein Fehler, den ein Mensch liest. */
    if (req.method === "POST" && url === "/api/admin/zeiten") {
      return readBody(req, res, body => {
        const UHR = /^([01]\d|2[0-3]):([0-5]\d)$/;
        const fehler = [];
        const neu = JSON.parse(JSON.stringify(state.zeiten));

        if (Array.isArray(body.appfrei)) {
          neu.appfrei = body.appfrei.map((f, i) => {
            if (!UHR.test(String(f.from))) fehler.push("appfrei[" + i + "].from: " + f.from);
            if (!UHR.test(String(f.to)))   fehler.push("appfrei[" + i + "].to: " + f.to);
            if (UHR.test(String(f.from)) && UHR.test(String(f.to)) && String(f.to) <= String(f.from)) {
              fehler.push("appfrei[" + i + "]: Ende liegt nicht nach dem Anfang");
            }
            return {
              id: clean(f.id, 40) || ("fenster" + i),
              from: String(f.from), to: String(f.to),
              was: cleanText(f.was, 80), hinweis: cleanText(f.hinweis, 200),
              aus: !!f.aus
            };
          });
        }

        if (body.gates && typeof body.gates === "object") {
          const g = {};
          for (const k of Object.keys(body.gates)) {
            const w = body.gates[k] || {};
            if (!UHR.test(String(w.from))) fehler.push("gates." + k + ".from: " + w.from);
            if (!UHR.test(String(w.to)))   fehler.push("gates." + k + ".to: " + w.to);
            g[clean(k, 40)] = { from: String(w.from), to: String(w.to) };
          }
          neu.gates = g;
        }

        if (Array.isArray(body.timeline)) {
          neu.timeline = body.timeline.map((p, i) => {
            if (!UHR.test(String(p.time))) fehler.push("timeline[" + i + "].time: " + p.time);
            return { id: clean(p.id, 30) || ("p" + i), time: String(p.time), title: cleanText(p.title, 80),
                     ort: cleanText(p.ort, 60), desc: cleanText(p.desc, 240),
                     moment: clean(p.moment, 20) || undefined, momentLabel: cleanText(p.momentLabel, 40) || undefined };
          });
        }
        /* "Alles ab jetzt +15": Ablauf, app-freie Fenster und Live-Fenster
         * gemeinsam schieben - nur, was noch vor uns liegt. Das ist der
         * eine Knopf, den man am Abend am sichersten braucht. */
        if (Number.isInteger(body.verschieben) && body.verschieben !== 0) {
          const min = Math.max(-120, Math.min(120, body.verschieben));
          const ab = body.ab && UHR.test(String(body.ab)) ? String(body.ab) : berlinJetzt().hhmm;
          const schieb = hhmm => {
            if (!UHR.test(hhmm) || hhmm < ab) return hhmm;
            const [h, m] = hhmm.split(":").map(Number);
            const ges = Math.max(0, Math.min(23 * 60 + 59, h * 60 + m + min));
            return String(Math.floor(ges / 60)).padStart(2, "0") + ":" + String(ges % 60).padStart(2, "0");
          };
          for (const p of neu.timeline || []) p.time = schieb(p.time);
          for (const f of neu.appfrei || []) { f.from = schieb(f.from); f.to = schieb(f.to); }
          for (const k of Object.keys(neu.gates || {})) { neu.gates[k].from = schieb(neu.gates[k].from); neu.gates[k].to = schieb(neu.gates[k].to); }
          logEvent("Ablauf verschoben", wer, (min > 0 ? "+" : "") + min + " Min ab " + ab);
        }

        /* Handschalter. "jetzt": true schaltet an, false/null wieder aus. */
        if ("jetzt" in body) {
          if (!body.jetzt) neu.jetzt = null;
          else neu.jetzt = {
            was: cleanText(body.jetzt.was, 80) || "Jetzt im Raum",
            hinweis: cleanText(body.jetzt.hinweis, 200) || "Gleich geht es weiter.",
            seit: Date.now()
          };
        }

        if (fehler.length) return json(res, 400, { error: "Ungültige Zeiten", felder: fehler });

        state.zeiten = neu;
        dirty = true;
        zeitenSenden();
        logEvent("Zeiten geändert", wer, "");
        return json(res, 200, { ok: true, zeiten: state.zeiten });
      });
    }

    /* --- Tischordnung ---
     * CSV mit Kopfzeile. Erkannt werden: email ODER name (zum Finden des
     * Gastes), dann gang1, gang2, gang3 (Tischnummern). Die Maske steht
     * damit vorher; am 14.09. kommen nur noch die Namen von Jonan hinein.
     * Ohne ?senden=1 ein Probelauf: wer gefunden wurde, wer nicht. */
    if (req.method === "POST" && url === "/api/admin/tischplan") {
      let roh = "", zuGross = false;
      req.on("data", c => { roh += c; if (roh.length > 200_000 && !zuGross) { zuGross = true; zuGrossAbbruch(req, res); } });
      req.on("end", () => {
        if (zuGross) return;
        let rows;
        try { rows = parseCSV(roh); } catch (e) { return json(res, 400, { error: "CSV unlesbar" }); }
        if (!rows.length) return json(res, 400, { error: "leer" });
        const header = rows[0].map(h => h.trim().toLowerCase());
        const col = n => header.indexOf(n);
        const iMail = col("email") >= 0 ? col("email") : col("e-mail"), iName = col("name");
        const iGang = [col("gang1"), col("gang2"), col("gang3")];
        if (iMail < 0 && iName < 0) return json(res, 400, { error: "Spalte 'email' oder 'name' fehlt" });
        if (iGang[0] < 0) return json(res, 400, { error: "Spalte 'gang1' fehlt" });
        const byMail = {}, byName = {};
        for (const inv of Object.values(state.invites)) {
          if (inv.email) byMail[inv.email.toLowerCase()] = inv;
          byName[(inv.name || "").trim().toLowerCase()] = inv;
        }
        const neu = {}, gefunden = [], unbekannt = [], tischNrn = new Set();
        for (const r of rows.slice(1)) {
          const mail = iMail >= 0 ? clean(r[iMail], 120).toLowerCase() : "";
          const name = iName >= 0 ? clean(r[iName], 80).trim().toLowerCase() : "";
          const inv = (mail && byMail[mail]) || (name && byName[name]) || null;
          const plaetze = iGang.map(i => i >= 0 ? (parseInt(r[i], 10) || 0) : 0);
          if (!inv) { unbekannt.push(mail || name); continue; }
          neu[gid(inv)] = plaetze;
          plaetze.forEach(n => { if (n) tischNrn.add(n); });
          gefunden.push({ name: inv.name, plaetze });
        }
        /* Wer im Kreis ist, aber in der CSV nicht vorkommt, faellt sonst
         * niemandem auf - er sieht "–" und bekommt eine Push ins Leere. */
        const ohnePlatz = Object.values(state.invites).filter(i => imKreis(i) && rundeVon(i) === RUNDE && !neu[gid(i)]).map(i => i.name).sort();
        if (q.get("senden") !== "1") {
          return json(res, 200, { ok: true, probelauf: true, gefunden: gefunden.length, unbekannt, ohnePlatz, tische: [...tischNrn].sort((a, b) => a - b) });
        }
        const t = tische();
        t.sitz = neu;
        /* Tische, die im Plan vorkommen, aber noch keinen Eintrag haben,
         * anlegen - ohne Namen. Namen kommen ueber /api/admin/tische. */
        for (const nr of tischNrn) if (!t.liste.find(x => x.nr === nr)) t.liste.push({ nr, name: "" });
        t.liste.sort((a, b) => a.nr - b.nr);
        dirty = true;
        logEvent("Tischplan importiert", wer, gefunden.length + " Gäste");
        return json(res, 200, { ok: true, gefunden: gefunden.length, unbekannt, tische: t.liste });
      });
      return;
    }

    /* Ein einzelner Platz - zehn Sekunden statt einer neuen CSV.
     * {email|name|gid, gang, tisch} */
    if (req.method === "POST" && url === "/api/admin/sitz") {
      return readBody(req, res, body => {
        const t = tische();
        const suche = String(body.email || body.name || "").trim().toLowerCase();
        const inv = findByGid(body.gid) || Object.values(state.invites).find(i =>
          (i.email && i.email.toLowerCase() === suche) || (i.name || "").trim().toLowerCase() === suche);
        if (!inv) return json(res, 404, { error: "Gast nicht gefunden" });
        const gang = parseInt(body.gang, 10), nr = parseInt(body.tisch, 10) || 0;
        if (!(gang >= 1 && gang <= t.gaenge.length)) return json(res, 400, { error: "gang 1–" + t.gaenge.length });
        const s = t.sitz[gid(inv)] || (t.sitz[gid(inv)] = t.gaenge.map(() => 0));
        s[gang - 1] = nr;
        if (nr && !t.liste.find(x => x.nr === nr)) { t.liste.push({ nr, name: "" }); t.liste.sort((a, b) => a.nr - b.nr); }
        dirty = true;
        logEvent("Platz gesetzt", wer, inv.name + " · Gang " + gang + " · Tisch " + nr);
        return json(res, 200, { ok: true, name: inv.name, sitz: s });
      });
    }
    /* Wer hat noch keinen Platz (laufende Runde)? */
    if (req.method === "GET" && url === "/api/admin/ohneplatz") {
      const t = tische();
      const liste = Object.values(state.invites).filter(i => imKreis(i) && rundeVon(i) === RUNDE && !(t.sitz[gid(i)] || []).some(Boolean))
        .map(i => ({ name: i.name, email: i.email || "", id: gid(i) })).sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, { ok: true, anzahl: liste.length, gaeste: liste });
    }

    /* Gaenge und Tischnamen. {gaenge:[...], liste:[{nr,name}]} */
    if (req.method === "POST" && url === "/api/admin/tische") {
      return readBody(req, res, body => {
        const t = tische();
        if (Array.isArray(body.gaenge) && body.gaenge.length) t.gaenge = body.gaenge.slice(0, 5).map(g => cleanText(g, 40));
        if (Array.isArray(body.liste)) t.liste = body.liste
          .map(x => ({ nr: parseInt(x.nr, 10) || 0, name: cleanText(x.name, 40) }))
          .filter(x => x.nr > 0).sort((a, b) => a.nr - b.nr);
        dirty = true;
        return json(res, 200, { ok: true, tische: t });
      });
    }

    /* --- Steuerung des Abends ---
     * Alle Signale kommen aus dem Monitor, THE CIRCLE loest sie selbst aus.
     *   wechsel   {gang}   -> Tischwechsel: SSE an alle + Push (Handys in der Tasche)
     *   naechstes {text}   -> "Als Naechstes": nur SSE, wird im Raum angesagt
     *   frei               -> Signal zuruecknehmen */
    if (req.method === "POST" && url === "/api/admin/signal") {
      return readBody(req, res, async body => {
        const art = String(body.art || "");
        const t = tische();
        if (art === "wechsel") {
          const gang = parseInt(body.gang, 10) || 0;
          if (gang < 1 || gang > t.gaenge.length) return json(res, 400, { error: "gang 1–" + t.gaenge.length });
          /* Zweimal gedrueckt = zweimal 130 Pushes. Innerhalb von 30 s
           * gilt der zweite Druck als der erste. */
          if (state.letzterPush && state.letzterPush.laeuft && Date.now() - state.letzterPush.t < 30_000) {
            return json(res, 409, { error: "Der Tischwechsel läuft gerade schon – einen Moment." });
          }
          const vorher = t.gang;
          t.gang = gang;
          state.signal = { art: "wechsel", gang, text: t.gaenge[gang - 1], t: Date.now(), wer, vorherGang: vorher };
          dirty = true; signalSenden();
          logEvent("Tischwechsel", wer, t.gaenge[gang - 1]);
          /* SOFORT antworten. Die Pushes laufen im Hintergrund; ihr Ergebnis
           * steht in state.letzterPush und damit im Monitor - der Knopf darf
           * nicht minutenlang haengen, sonst drueckt jemand nochmal. */
          state.letzterPush = { art: "wechsel", gang, t: Date.now(), wer, laeuft: true, gesendet: 0, tot: 0, fehler: 0,
                                erreichbar: pushbar(), grund: "" };
          const gangName = t.gaenge[gang - 1];
          pushJeGast(inv => {
            const nr = meinTisch(inv, gang);
            /* Der Tischwechsel nennt die Menschen, nicht nur die Nummer:
             * Man geht nicht zu "Tisch 7", man geht zu Anna und Jonas. */
            const nachbarn = nr ? tischnachbarn(inv, gang).map(n => n.name.split(" ")[0]) : [];
            const wer3 = nachbarn.slice(0, 3).join(", ") + (nachbarn.length > 3 ? " und " + (nachbarn.length - 3) + " weitere" : "");
            return { titel: gangName + " – Tischwechsel",
                     text: nr ? "Dein nächster Gang: Tisch " + nr + (tischName(nr) ? " · " + tischName(nr) : "") + (wer3 ? " – mit " + wer3 + "." : ".")
                              : "Der nächste Gang beginnt – schau in der App nach deinem Tisch.",
                     url: "/?t=" + inv.token + "#tisch" };
          }, { trotzAppfrei: !!body.trotzAppfrei }).then(e => {
            Object.assign(state.letzterPush, e, { laeuft: false }); dirty = true;
            logEvent("Push Tischwechsel", wer, (e.gesendet || 0) + " gesendet" + (e.grund ? " – " + e.grund : "") + (e.tot ? ", " + e.tot + " tote Abos" : ""));
          }).catch(err => { Object.assign(state.letzterPush, { laeuft: false, fehler: 1, grund: String(err && err.message || err) }); });
          return json(res, 200, { ok: true, signal: state.signal, push: state.letzterPush });
        }
        if (art === "naechstes" || art === "raum") {
          /* "raum": ein Satz an alle, auch als Push - fuer das, was in keiner
           * Liste steht. "naechstes": nur in die offenen Apps. */
          const text = cleanText(body.text, 120) || "Gleich geht es weiter.";
          state.signal = { art: "naechstes", text, t: Date.now(), wer };
          dirty = true; signalSenden();
          logEvent(art === "raum" ? "An den Raum" : "Als Nächstes", wer, text);
          if (art === "raum") {
            state.letzterPush = { art: "raum", t: Date.now(), wer, laeuft: true, gesendet: 0, tot: 0, fehler: 0, erreichbar: pushbar(), grund: "" };
            pushAnAlle({ titel: "THE CIRCLE", text, url: "/" }, { trotzAppfrei: !!body.trotzAppfrei })
              .then(e => { Object.assign(state.letzterPush, e, { laeuft: false }); dirty = true; })
              .catch(() => { state.letzterPush.laeuft = false; });
          }
          return json(res, 200, { ok: true, signal: state.signal, push: state.letzterPush || null });
        }
        if (art === "frei") {
          /* "Rueckgaengig" nach einem falschen Gang: der Gang geht mit
           * zurueck, sonst rechnen Tischansichten und der naechste Push
           * weiter mit dem falschen. */
          if (state.signal && state.signal.art === "wechsel" && body.rueckgaengig && typeof state.signal.vorherGang === "number") {
            t.gang = state.signal.vorherGang;
            logEvent("Tischwechsel zurückgenommen", wer, "");
          }
          state.signal = null; dirty = true; signalSenden();
          return json(res, 200, { ok: true, signal: null, gang: t.gang });
        }
        return json(res, 400, { error: "art: wechsel | naechstes | raum | frei" });
      });
    }

    /* Phase von Hand: vor | abend | danach | "" (= automatisch). */
    if (req.method === "POST" && url === "/api/admin/phase") {
      return readBody(req, res, body => {
        const p = String(body.phase || "");
        state.phaseHand = ["vor", "abend", "danach"].includes(p) ? p : "";
        if (body.no2 && typeof body.no2 === "object") state.no2 = { datum: clean(body.no2.datum, 10), ort: cleanText(body.no2.ort, 60), text: cleanText(body.no2.text, 160) };
        if (body.no2 === null) state.no2 = null;
        dirty = true; zeitenSenden(); broadcast();
        logEvent("Phase", wer, state.phaseHand || "automatisch");
        return json(res, 200, { ok: true, phase: phaseJetzt(), phaseHand: state.phaseHand, no2: state.no2 || null });
      });
    }

    /* News anlegen, aendern, veroeffentlichen, loeschen. */
    if (req.method === "GET" && url === "/api/admin/news") {
      return json(res, 200, { ok: true, news: (state.news || []).sort((a, b) => b.t - a.t) });
    }
    if (req.method === "POST" && url === "/api/admin/news") {
      return readBody(req, res, body => {
        if (!state.news) state.news = [];
        if (body.loeschen && body.id) { state.news = state.news.filter(n => n.id !== body.id); dirty = true; return json(res, 200, { ok: true }); }
        let n = body.id ? state.news.find(x => x.id === body.id) : null;
        if (!n) { n = { id: crypto.randomBytes(6).toString("hex"), t: Date.now(), autor: wer }; state.news.push(n); }
        if (body.titel !== undefined) n.titel = cleanText(body.titel, 120);
        if (body.text !== undefined) n.text = cleanText(body.text, 2000);
        if (body.link !== undefined) n.link = String(body.link || "").slice(0, 300).replace(/[<>"']/g, "");
        if (body.linkText !== undefined) n.linkText = cleanText(body.linkText, 60);
        if (body.sichtbar !== undefined) n.sichtbar = body.sichtbar === "alle" ? "alle" : (clean(body.sichtbar, 20) || RUNDE);
        if (body.veroeffentlicht !== undefined) { n.veroeffentlicht = !!body.veroeffentlicht; if (n.veroeffentlicht && !n.seit) n.seit = Date.now(); }
        if (!n.sichtbar) n.sichtbar = "alle";
        dirty = true;
        return json(res, 200, { ok: true, news: n });
      });
    }

    /* Galerie: Upload (vom Browser verkleinert), Zuordnung, oeffnen. */
    if (req.method === "POST" && url === "/api/admin/galerie/upload") {
      return readBodyGross(req, res, body => {
        const r = clean(body.runde, 20) || RUNDE, g = galerie(r);
        const m = jpegAusDataUrl(body.mini, 120_000), w = jpegAusDataUrl(body.bild, 900_000);
        if (!m || !w) return json(res, 400, { error: "Bild nicht lesbar (zwei JPEG-Groessen erwartet)" });
        const id = crypto.randomBytes(8).toString("hex");
        try {
          fs.mkdirSync(path.join(GALERIE_DIR, r), { recursive: true });
          fs.writeFileSync(path.join(GALERIE_DIR, r, id + "-m.jpg"), m);
          fs.writeFileSync(path.join(GALERIE_DIR, r, id + "-w.jpg"), w);
        } catch (e) { return json(res, 500, { error: "konnte nicht speichern" }); }
        const datei = cleanText(body.datei, 120);
        /* Zuordnung ueber den Dateinamen: <email>_01.jpg - lokaler Teil und
         * Domain werden gegen die Adressen im Register gehalten. */
        const wer = [];
        const mm = /^([^_\s]+@[^_\s]+?)(?:_\d+)?\.(?:jpe?g|png|heic)$/i.exec(datei);
        if (mm) { const inv = Object.values(state.invites).find(i => i.email && i.email.toLowerCase() === mm[1].toLowerCase()); if (inv) wer.push(gid(inv)); }
        g.fotos[id] = { id, t: Date.now(), datei, wer, breit: !!body.breit };
        dirty = true;
        return json(res, 200, { ok: true, id, zugeordnet: wer.length, anzahl: Object.keys(g.fotos).length });
      });
    }
    /* Zuordnung per Liste: "datei;email,email" je Zeile. Ohne ?senden=1 nur zaehlen. */
    if (req.method === "POST" && url === "/api/admin/galerie/zuordnung") {
      let roh = "", zuGross = false;
      req.on("data", c => { roh += c; if (roh.length > 500_000 && !zuGross) { zuGross = true; zuGrossAbbruch(req, res); } });
      req.on("end", () => {
        if (zuGross) return;
        const r = clean(q.get("runde"), 20) || RUNDE, g = galerie(r);
        const byMail = {}; for (const i of Object.values(state.invites)) if (i.email) byMail[i.email.toLowerCase()] = i;
        const byDatei = {}; for (const f of Object.values(g.fotos)) if (f.datei) byDatei[f.datei.toLowerCase()] = f;
        let zugeordnet = 0; const unbekannt = new Set(), keineDatei = [];
        const plan = [];
        for (const zeile of roh.split(/\r?\n/)) {
          const [datei, mails] = zeile.split(";").map(x => (x || "").trim());
          if (!datei || !mails) continue;
          const f = byDatei[datei.toLowerCase()];
          if (!f) { keineDatei.push(datei); continue; }
          for (const m of mails.split(",").map(x => x.trim().toLowerCase()).filter(Boolean)) {
            const inv = byMail[m]; if (!inv) { unbekannt.add(m); continue; }
            plan.push([f, gid(inv)]); zugeordnet++;
          }
        }
        if (q.get("senden") === "1") {
          for (const [f, id] of plan) { if (!f.wer) f.wer = []; if (!f.wer.includes(id)) f.wer.push(id); }
          dirty = true;
        }
        return json(res, 200, { ok: true, probelauf: q.get("senden") !== "1", zugeordnet, unbekannt: [...unbekannt], keineDatei });
      });
      return;
    }
    if (req.method === "POST" && url === "/api/admin/galerie") {
      return readBody(req, res, body => {
        const r = clean(body.runde, 20) || RUNDE, g = galerie(r);
        if (body.offen !== undefined) g.offen = body.offen ? Date.now() : 0;
        if (body.loeschen) { const f = g.fotos[clean(body.loeschen, 16)]; if (f) { for (const a of ["m", "w"]) { try { fs.unlinkSync(path.join(GALERIE_DIR, r, f.id + "-" + a + ".jpg")); } catch (e) {} } delete g.fotos[f.id]; } }
        dirty = true;
        const fotos = Object.values(g.fotos);
        return json(res, 200, { ok: true, offen: !!g.offen, anzahl: fotos.length, zugeordnet: fotos.filter(f => (f.wer || []).length).length,
                                ohne: fotos.filter(f => !(f.wer || []).length).length, liste: fotos.slice(-30).map(f => ({ id: f.id, datei: f.datei, wer: (f.wer || []).length, m: galerieUrl(r, f.id, "m") })) });
      });
    }
    if (req.method === "GET" && url === "/api/admin/galerie") {
      const r = clean(q.get("runde"), 20) || RUNDE, g = galerie(r), fotos = Object.values(g.fotos);
      return json(res, 200, { ok: true, offen: !!g.offen, anzahl: fotos.length, zugeordnet: fotos.filter(f => (f.wer || []).length).length,
                              ohne: fotos.filter(f => !(f.wer || []).length).length, liste: fotos.slice(-30).map(f => ({ id: f.id, datei: f.datei, wer: (f.wer || []).length, m: galerieUrl(r, f.id, "m") })) });
    }

    /* Feedback-Auswertung. */
    if (req.method === "GET" && url === "/api/admin/feedback") {
      const im = Object.values(state.invites).filter(i => imKreis(i) && rundeVon(i) === RUNDE);
      const mit = im.filter(i => i.feedback);
      const liste = mit.map(i => ({ name: i.name, daumen: i.feedback.daumen, satz: i.feedback.satz || "", t: i.feedback.t })).sort((a, b) => b.t - a.t);
      const saetze = im.filter(i => i.abend && i.abend.satz).map(i => ({ name: i.name, satz: i.abend.satz }));
      if (q.get("csv") === "1") {
        const z = ["name;daumen;satz"].concat(liste.map(x => [x.name, x.daumen > 0 ? "hoch" : "runter", x.satz].map(v => String(v).replace(/;/g, ",")).join(";")));
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="feedback.csv"' });
        return res.end("\uFEFF" + z.join("\r\n"));
      }
      return json(res, 200, { ok: true, im: im.length, anzahl: mit.length, hoch: mit.filter(i => i.feedback.daumen > 0).length, runter: mit.filter(i => i.feedback.daumen < 0).length, liste, erkenntnisse: saetze });
    }

    /* --- Der Sendekanal: eine Nachricht an die Runde, als Push und/oder
     * Mail. Galerie, News, Feedback, Verbunden, Save-the-Date sind nur
     * Anlaesse fuer dieselbe Funktion. kanal: push | mail | beide | luecke
     * (Mail nur an die ohne Push - die iOS-Abbrecher). Laeuft im
     * Hintergrund; das Protokoll steht in state.sendungen. */
    if (req.method === "POST" && url === "/api/admin/senden") {
      return readBody(req, res, async body => {
        const art = clean(body.art, 30) || "nachricht", titel = cleanText(body.titel, 120), text = cleanText(body.text, 1200);
        const kanal = ["push", "mail", "beide", "luecke"].includes(body.kanal) ? body.kanal : "beide";
        const zielPfad = String(body.url || "/").replace(/[^\w\/#?=&.-]/g, "").slice(0, 120) || "/";
        const ctaText = cleanText(body.ctaText, 40) || "In der App ansehen";
        const runde = clean(body.runde, 20) || RUNDE;
        if (!titel || !text) return json(res, 400, { error: "titel und text" });
        const empf = Object.values(state.invites).filter(i => imKreis(i) && rundeVon(i) === runde && !i.abgemeldet);
        /* Probe: nur an einen Gast (per E-Mail oder gid). */
        const probeInv = body.probe ? (findByGid(body.probe) || empf.find(i => i.email && i.email.toLowerCase() === String(body.probe).toLowerCase())) : null;
        if (body.probe && !probeInv) return json(res, 404, { error: "Probe-Gast nicht gefunden" });
        const liste = probeInv ? [probeInv] : empf;
        const vorher = (state.sendungen || []).find(x => x.art === art && x.runde === runde && !x.probe);
        if (vorher && !body.trotzdem && !probeInv) return json(res, 409, { error: "Schon gesendet: " + art + " am " + new Date(vorher.t).toLocaleString("de-DE") + " an " + vorher.empfaenger + " Gäste. Mit trotzdem=true erneut." });
        const sendung = { id: crypto.randomBytes(5).toString("hex"), art, runde, titel, text, url: zielPfad, kanal, t: Date.now(), wer, probe: !!probeInv,
                          empfaenger: liste.length, laeuft: true, push: { gesendet: 0, tot: 0, fehler: 0, ohne: 0 }, mail: { gesendet: 0, fehler: 0, ohne: 0 } };
        if (!state.sendungen) state.sendungen = [];
        state.sendungen.unshift(sendung); state.sendungen = state.sendungen.slice(0, 50); dirty = true;
        logEvent("Sendung gestartet", wer, art + " · " + kanal + " · " + liste.length);
        json(res, 200, { ok: true, sendung });
        /* Ab hier im Hintergrund. */
        for (const inv of liste) {
          const url = "/?t=" + inv.token + (zielPfad.startsWith("/") ? zielPfad.replace(/^\/\??/, zielPfad.includes("#") ? "" : "") : "");
          const appUrl = "/?t=" + inv.token + (zielPfad.includes("#") ? zielPfad.slice(zielPfad.indexOf("#")) : "");
          let pushOk = false;
          if (kanal === "push" || kanal === "beide" || kanal === "luecke") {
            if (inv.push) {
              try {
                const a = await webpush.senden({ subscription: inv.push, payload: JSON.stringify({ titel, text: text.slice(0, 160), url: appUrl, tag: art }), vapid: VAPID, ttl: 86400 });
                if (a.status === 404 || a.status === 410) { inv.push = null; sendung.push.tot++; dirty = true; }
                else if (a.status < 300) { sendung.push.gesendet++; pushOk = true; } else sendung.push.fehler++;
              } catch (e) { sendung.push.fehler++; }
            } else sendung.push.ohne++;
          }
          const mailNoetig = kanal === "mail" || kanal === "beide" || (kanal === "luecke" && !pushOk);
          if (mailNoetig) {
            if (inv.email && LETTERMINT_TOKEN) {
              await new Promise(ok => {
                let html, txt;
                try {
                  html = renderMail(inv, "nachricht.html", { titel, text_html: text.replace(/\n/g, "<br>"), cta_text: ctaText, cta_url: PUBLIC_URL + appUrl });
                  txt = inv.anrede + " " + (inv.name || "").split(" ")[0] + ",\n\n" + titel + "\n\n" + text + "\n\n" + ctaText + ": " + PUBLIC_URL + appUrl + "\n";
                } catch (e) { sendung.mail.fehler++; return ok(); }
                lettermintSenden({ to: inv.email, subject: titel, html, text: txt }, err => { if (err) sendung.mail.fehler++; else sendung.mail.gesendet++; setTimeout(ok, 200); });
              });
            } else sendung.mail.ohne++;
          }
        }
        sendung.laeuft = false; dirty = true;
        logEvent("Sendung fertig", wer, art + " · Push " + sendung.push.gesendet + " · Mail " + sendung.mail.gesendet);
      });
    }
    if (req.method === "GET" && url === "/api/admin/sendungen") {
      return json(res, 200, { ok: true, sendungen: state.sendungen || [] });
    }

    /* Die Wand im Raum: was der Beamer zeigt. modus auto folgt dem Abend
     * (Signal, Fenster); enthuellt ist der Vorhang fuer das AV8-Votum -
     * erst "87 Rueckmeldungen", dann auf Knopfdruck die Balken. */
    if (req.method === "POST" && url === "/api/admin/wand") {
      return readBody(req, res, body => {
        if (!state.wand) state.wand = { modus: "auto", enthuellt: false };
        const modi = ["auto", "ruhe", "av8", "auktion", "kreis", "aus"];
        if (body.modus !== undefined) state.wand.modus = modi.includes(body.modus) ? body.modus : "auto";
        if (body.enthuellt !== undefined) state.wand.enthuellt = !!body.enthuellt;
        if (body.satz !== undefined) state.wand.satz = cleanText(body.satz, 120);
        dirty = true; broadcast();
        return json(res, 200, { ok: true, wand: state.wand });
      });
    }

    /* Ein Gebot aus dem Saal - der Auktionator ruft es rein. Ohne den
     * 5.000er-Deckel, mit Karte oder Name. */
    if (req.method === "POST" && url === "/api/admin/gebot") {
      return readBody(req, res, body => {
        if (state.auktion && state.auktion.zu) return json(res, 409, { error: "Auktion ist beendet" });
        const amount = parseInt(body.amount, 10) || 0;
        if (amount <= 0 || amount > 2_000_000) return json(res, 400, { error: "Betrag" });
        state.bid = { amount, paddle: clean(body.paddle, 6), name: clean(body.name, 30), t: Date.now(), quelle: "saal" };
        state.bids.unshift(state.bid); state.bids = state.bids.slice(0, 20);
        dirty = true; broadcast();
        logEvent("Saal-Gebot", wer, amount + " € · Karte " + (state.bid.paddle || "–"));
        return json(res, 200, { ok: true, bid: state.bid });
      });
    }
    /* Letztes Gebot zuruecknehmen (Scherzgebot, Vertipper). */
    if (req.method === "POST" && url === "/api/admin/gebot-zurueck") {
      state.bids.shift(); state.bid = state.bids[0] || null;
      dirty = true; broadcast();
      logEvent("Gebot zurückgenommen", wer, "");
      return json(res, 200, { ok: true, bid: state.bid });
    }
    /* Der Hammer. Friert das Hoechstgebot ein, loest das Schaetzspiel auf
     * und schickt dem Gewinner eine Push. {erloes} optional, sonst das
     * Hoechstgebot. */
    if (req.method === "POST" && url === "/api/admin/zuschlag") {
      return readBody(req, res, async body => {
        const erloes = parseInt(body.erloes, 10) || (state.bid && state.bid.amount) || 0;
        const tipps = Object.values(state.invites).filter(i => imKreis(i) && i.tipp)
          .map(i => ({ id: gid(i), name: i.name, wert: i.tipp.wert, abstand: Math.abs(i.tipp.wert - erloes), karte: String(i.ticketNr || "").replace(/\D/g, ""), inv: i }))
          .sort((a, b) => a.abstand - b.abstand);
        state.auktion = { zu: Date.now(), erloes, wer, karte: state.bid ? state.bid.paddle : "",
          sieger: tipps.slice(0, 3).map(x => ({ name: x.name, vorname: x.name.split(" ")[0], wert: x.wert, abstand: x.abstand, karte: x.karte })), tipps: tipps.length };
        dirty = true; broadcast();
        logEvent("Zuschlag", wer, erloes + " €");
        if (tipps[0]) pushAnEinen(tipps[0].inv, { titel: "Dein Tipp war am nächsten", text: erloes.toLocaleString("de-DE") + " € – du lagst " + tipps[0].abstand.toLocaleString("de-DE") + " € daneben. Komm nach vorn.", url: "/?t=" + tipps[0].inv.token + "#live", tag: "tipp" });
        return json(res, 200, { ok: true, auktion: state.auktion });
      });
    }
    /* Zuschlag zuruecknehmen - falls zu frueh gedrueckt. */
    if (req.method === "POST" && url === "/api/admin/zuschlag-zurueck") {
      state.auktion = null; dirty = true; broadcast();
      return json(res, 200, { ok: true });
    }
    /* Live-Zahlen fuer die Buehnen-Karte - mit Namen, deshalb hinter dem
     * Schluessel; die Gaeste bekommen im Stream nur Betrag und Karte. */
    if (req.method === "GET" && url === "/api/admin/live") {
      return json(res, 200, { ok: true, votes: state.votes, sterne: state.sterne, interesse: state.interesse,
        bid: state.bid, bids: state.bids.slice(0, 8), auktion: state.auktion || null, wand: state.wand || { modus: "auto", enthuellt: false },
        tipps: Object.values(state.invites).filter(i => i.tipp).length, ringe: ringeZahlen(), kreis: kreisZahlen(),
        signalGesehen: state.signal && state.signal.gesehen ? Object.keys(state.signal.gesehen).length : 0 });
    }

    /* AV8-Blatt: wer hat was gedrueckt. Das ist das, was die Gruender am
     * Morgen danach bekommen - und der Grund, warum das Versprechen in der
     * App haltbar ist. */
    if (req.method === "GET" && url === "/api/admin/av8") {
      const liste = Object.values(state.invites).filter(i => imKreis(i) && i.av8 && (i.av8.stern || i.av8.intro || i.av8.investor))
        .map(i => ({ name: i.name, firma: i.firma || "", rolle: i.rolle || "", email: i.email || "",
                     stern: i.av8.stern || 0, intro: !!i.av8.intro, investor: !!i.av8.investor }))
        .sort((a, b) => (b.investor - a.investor) || (b.intro - a.intro) || (b.stern - a.stern) || a.name.localeCompare(b.name));
      if (q.get("csv") === "1") {
        const z = ["name;firma;rolle;email;sterne;intro;investor"].concat(liste.map(x =>
          [x.name, x.firma, x.rolle, x.email, x.stern, x.intro ? "ja" : "", x.investor ? "ja" : ""].map(v => String(v).replace(/;/g, ",")).join(";")));
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="av8-rueckmeldungen.csv"' });
        return res.end("\uFEFF" + z.join("\r\n"));
      }
      return json(res, 200, { ok: true, liste, votes: state.votes, sterne: state.sterne, interesse: state.interesse });
    }

    /* Schaetzspiel aufloesen: die drei, die dem Zuschlag am naechsten lagen. */
    if (req.method === "GET" && url === "/api/admin/tipps") {
      const ziel = parseInt(q.get("erloes"), 10) || (state.bid && state.bid.amount) || 0;
      const liste = Object.values(state.invites).filter(i => imKreis(i) && i.tipp)
        .map(i => ({ name: i.name, wert: i.tipp.wert, abstand: Math.abs(i.tipp.wert - ziel), karte: String(i.ticketNr || "").replace(/\D/g, "") }))
        .sort((a, b) => a.abstand - b.abstand);
      return json(res, 200, { ok: true, ziel, anzahl: liste.length, beste: liste.slice(0, 3), alle: liste });
    }

    /* Probe-Push an einen Gast (den, der gerade testet). */
    if (req.method === "POST" && url === "/api/admin/push-probe") {
      return readBody(req, res, async body => {
        const inv = findByGid(body.wen) || (body.email && Object.values(state.invites).find(i => i.email && i.email.toLowerCase() === String(body.email).toLowerCase()));
        if (!inv || !inv.push) return json(res, 404, { error: "Gast ohne Push-Abonnement" });
        try {
          const a = await webpush.senden({ subscription: inv.push, vapid: VAPID, ttl: 300,
            payload: JSON.stringify({ titel: "THE CIRCLE", text: "Probe – die Push kommt an.", url: "/?t=" + inv.token }) });
          return json(res, 200, { ok: a.status < 300, status: a.status, body: String(a.body || "").slice(0, 200) });
        } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
      });
    }

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

    /* Rechnungen nachholen - fuer alle, die bezahlt haben, BEVOR es die
     * Rechnung gab, und als Netz, falls Lettermint einmal nicht erreichbar
     * war. Ohne ?senden=1 nur die Liste. Wer schon eine Nummer hat, behaelt
     * sie: dieselbe Leistung wird nicht zweimal berechnet. */
    if (req.method === "POST" && url === "/api/admin/rechnungen") {
      if (!rechnungMoeglich()) {
        return json(res, 503, {
          error: "Rechnungsversand ist nicht eingerichtet. Nötig: RECHNUNG_AKTIV=1, " +
                 "RECHNUNG_FIRMA, RECHNUNG_ANSCHRIFT (und RECHNUNG_USTSATZ bzw. RECHNUNG_HINWEIS)."
        });
      }
      const dran = Object.values(state.invites).filter(rechnungFaellig);
      const liste = dran.map(inv => ({
        name: inv.name, email: inv.email, ticketNr: inv.ticketNr,
        betrag: euroText((inv.zahlung && inv.zahlung.amount) || preisVon(inv)),
        nummer: (inv.rechnung && inv.rechnung.nr) || "(wird vergeben)"
      }));
      if (q.get("senden") !== "1") {
        return json(res, 200, { ok: true, probelauf: true, anzahl: dran.length,
                                aussteller: RECHNUNG_FIRMA,
                                ustsatz: RECHNUNG_USTSATZ, hinweis: RECHNUNG_HINWEIS,
                                gaeste: liste });
      }
      if (!LETTERMINT_TOKEN) return json(res, 503, { error: "LETTERMINT_TOKEN fehlt in der App" });
      dran.forEach((inv, i) => setTimeout(() => rechnungSenden(inv), i * 600));
      return json(res, 200, { ok: true, verschickt: dran.length, gaeste: liste });
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
  /* Die Wand fuer den Beamer im Raum. Oeffentlich wie der Stream - sie
   * zeigt nur, was ohnehin an alle Handys geht. */
  if (req.method === "GET" && (url === "/upload" || url === "/upload.html")) {
    return serveFile(res, "upload.html", "text/html; charset=utf-8", { "Cache-Control": "no-cache" });
  }
  if (req.method === "GET" && (url === "/wand" || url === "/wand.html")) {
    return serveFile(res, "wand.html", "text/html; charset=utf-8", { "Cache-Control": "no-cache" });
  }
  if (req.method === "GET" && (url === "/monitor" || url === "/monitor.html")) {
    return serveFile(res, "monitor.html", "text/html; charset=utf-8");
  }
  if (req.method === "GET" && (url === "/station" || url === "/station.html")) {
    return serveFile(res, "station.html", "text/html; charset=utf-8");
  }
  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    return serveFile(res, "index.html", "text/html; charset=utf-8", { "Cache-Control": "no-cache" });
  }

  /* --- Die App auf dem Startbildschirm --- */

  /* Das Manifest bekommt den Token des Gastes in die start_url: Sonst
   * startet die App vom Startbildschirm unter "/" - ohne Token, ohne
   * Gaestebuch, ohne Tisch, ohne Push. Genau das Symbol, zu dem wir jeden
   * Gast zweimal draengen, waere dann eine leere Huelle. */
  if (req.method === "GET" && url === "/manifest.webmanifest") {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.webmanifest"), "utf8")); }
    catch (e) { res.writeHead(500); return res.end("Manifest fehlt"); }
    const inv = findInvite(q.get("t"));
    if (inv) { m.start_url = "/?t=" + encodeURIComponent(inv.token); m.id = "/?t=" + encodeURIComponent(inv.token); }
    res.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(JSON.stringify(m));
  }

  /* Der Service Worker MUSS unter / liegen, sonst gilt er nur fuer einen
   * Unterordner und die Startseite faellt aus seiner Zustaendigkeit.
   *
   * Und er darf NICHT zwischengespeichert werden: Der Browser holt genau
   * diese Datei, um zu erkennen, ob es eine neue Fassung gibt. Liegt sie
   * aus dem Cache vor, bleibt die App auf dem Stand von gestern - und man
   * sieht es ihr nicht an, weil sie ja laedt. Deshalb no-store. */
  if (req.method === "GET" && url === "/sw.js") {
    return serveFile(res, "sw.js", "text/javascript; charset=utf-8",
                     { "Cache-Control": "no-store" });
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

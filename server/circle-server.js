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
try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch (e) { /* frischer Start */ }
if (!state.guests) state.guests = {};
if (!state.invites) state.invites = {};
if (!state.feed) state.feed = [];

let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  fs.writeFile(STATE_FILE, JSON.stringify(state), () => {});
}, 2000).unref();

/* ---------- SSE ---------- */
const clients = new Set();

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
 * ohnehin nur ueber textContent bzw. JSON, nie ueber innerHTML. */
const cleanText = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

function paddleFrom(band) {       // stabile Bieterkarten-Nummer aus der Band-ID
  let h = 0;
  for (const c of band) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 11 + (h % 88);
}

function pubGuest(band) {
  const g = state.guests[band];
  if (!g) return null;
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
/* Welle 2: derselbe Token, aber direkt in die App - sie holt sich Name,
 * Kontakt und Ernaehrung selbst aus der Zusage (kein Onboarding-Formular). */
function appLink(token) { return PUBLIC_URL + "/?t=" + token; }

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
  return t && state.invites[t] ? state.invites[t] : null;
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

  let neu = 0, aktualisiert = 0;
  for (const r of rows.slice(1)) {
    const email = clean(r[iMail], 120).toLowerCase();
    if (!email || email.indexOf("@") < 0) continue;
    const pool = cleanText(iPool >= 0 ? r[iPool] : "", 40) || "Allgemein";
    const typRaw = clean(iTyp >= 0 ? r[iTyp] : "", 20).toLowerCase();
    const typ = (typRaw === "ehrengast" || typRaw === "zusage" || typRaw === "gast des hauses")
      ? "ehrengast" : (typRaw === "ticket" ? "ticket" : poolTyp(pool));

    let inv = byMail[email];
    if (inv) {
      inv.pool = pool; inv.typ = typ;
      inv.name = cleanText(r[iName], 60) || inv.name;
      if (iFirma >= 0) inv.firma = cleanText(r[iFirma], 80);
      if (iAnrede >= 0) inv.anrede = cleanText(r[iAnrede], 12);
      if (iPartner >= 0) inv.partner = cleanText(r[iPartner], 60);
      if (iPartnerLogo >= 0) inv.partnerLogo = cleanText(r[iPartnerLogo], 200);
      aktualisiert++;
    } else {
      const token = newToken();
      inv = state.invites[token] = {
        token, pool, typ,
        name: cleanText(r[iName], 60), email,
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
      byMail[email] = inv;
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
  return {
    gesamt: all.length,
    versendet: zaehl(i => i.mail.sent),
    zugestellt: zaehl(i => i.mail.delivered),
    geoeffnet: zaehl(i => i.mail.opened),
    geklickt: zaehl(i => i.mail.clicked),
    zugesagt: zaehl(i => i.status === "zugesagt" || i.status === "bezahlt"),
    bezahlt: zaehl(i => i.status === "bezahlt"),
    abgesagt: zaehl(i => i.status === "abgesagt"),
    umsatz: all.reduce((s, i) => s + ((i.zahlung && i.zahlung.amount) || 0), 0)
  };
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
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;         // Replay-Schutz
  const erwartet = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(ts + "." + rawBody).digest("hex");
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
      stripe: !!STRIPE_KEY
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
    return readBody(req, res, body => {
      const n = Math.min(Math.max(parseInt(body.n, 10) || 0, 0), 30);
      state.applause += n;
      dirty = true; broadcast();
      json(res, 200, { ok: true });
    });
  }

  if (req.method === "POST" && url === "/api/live/vote") {
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
    return readBody(req, res, body => {
      const amount = parseInt(body.amount, 10) || 0;
      const current = state.bid ? state.bid.amount : 0;
      if (amount <= current || amount > 2_000_000) {
        return json(res, 409, { error: "zu niedrig", bid: state.bid });
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
      if (!band || !name) return json(res, 400, { error: "band und name nötig" });
      const g = state.guests[band] || (state.guests[band] = { name, table: "", moments: {}, applause: 0, vote: null, t: Date.now() });
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
      if (!band) return json(res, 400, { error: "kein band" });

      let g = state.guests[band];
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
    if (!inv.mail.clicked) { inv.mail.clicked = Date.now(); logEvent("geklickt", inv.name, inv.pool); }
    return json(res, 200, { ok: true, gast: pubInvite(inv) });
  }

  // Zusagen / absagen (+ die Angaben des Gastes)
  if (req.method === "POST" && url === "/api/invite/rsvp") {
    return readBody(req, res, body => {
      const inv = findInvite(body.t);
      if (!inv) return json(res, 404, { error: "unbekannte Einladung" });

      if (body.absage) {
        inv.status = "abgesagt";
        logEvent("abgesagt", inv.name, inv.pool);
        dirty = true;
        return json(res, 200, { ok: true, gast: pubInvite(inv) });
      }

      if (body.name)   inv.name = cleanText(body.name, 60);
      if (body.firma !== undefined) inv.firma = cleanText(body.firma, 80);
      inv.daten = {
        phone:   cleanText(body.phone, 30),
        diet:    cleanText(body.diet, 20),
        allergy: cleanText(body.allergy, 120)
      };

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
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on("end", () => {
      if (!webhookGueltig(req.headers["stripe-signature"], raw)) {
        return json(res, 400, { error: "Signatur ungültig" });
      }
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

  // Lettermint-Webhook: Versand-/Öffnungs-/Klickstatus in die Liste schreiben
  if (req.method === "POST" && url === "/api/lettermint/webhook") {
    return readBody(req, res, body => {
      const email = String(body.email || body.recipient || "").toLowerCase();
      const typ = String(body.event || body.type || "").toLowerCase();
      const inv = Object.values(state.invites).find(i => i.email === email);
      if (!inv) return json(res, 200, { ok: true, ignoriert: true });
      const map = { sent: "sent", delivered: "delivered", opened: "opened", open: "opened", clicked: "clicked", click: "clicked" };
      const feld = map[typ];
      if (feld && !inv.mail[feld]) {
        inv.mail[feld] = Date.now();
        logEvent(feld === "sent" ? "versendet" : feld === "delivered" ? "zugestellt" : feld === "opened" ? "geöffnet" : "geklickt", inv.name, inv.pool);
        dirty = true;
      }
      json(res, 200, { ok: true });
    });
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
    // Versandliste für Lettermint: Name, E-Mail, Typ, persönlicher Link
    if (url === "/api/admin/versandliste") {
      const zeilen = [["pool", "typ", "anrede", "vorname", "name", "email", "partner_name", "partner_logo_url", "platz_satz", "link", "app_link", "ticket_nr", "status"]];
      for (const inv of Object.values(state.invites)) {
        zeilen.push([inv.pool, inv.typ, inv.anrede || "Hallo", (inv.name || "").split(" ")[0],
                     inv.name, inv.email, inv.partner || "", inv.partnerLogo || "",
                     platzSatz(inv), inviteLink(inv.token), appLink(inv.token), inv.ticketNr, inv.status]);
      }
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
      return res.end(zeilen.map(r => r.map(f => '"' + String(f).replace(/"/g, '""') + '"').join(",")).join("\n"));
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
                  ".svg": "image/svg+xml", ".webp": "image/webp" };
    const typ = TYP[path.extname(name).toLowerCase()];
    if (!name || !typ) { res.writeHead(404); return res.end("nicht gefunden"); }
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
const [befehl, arg] = process.argv.slice(2);

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
  const zeilen = [["pool", "typ", "anrede", "vorname", "name", "email", "partner_name", "partner_logo_url", "platz_satz", "link", "app_link", "ticket_nr", "status"]];
  for (const inv of Object.values(state.invites)) {
    zeilen.push([inv.pool, inv.typ, inv.anrede || "Hallo", (inv.name || "").split(" ")[0],
                     inv.name, inv.email, inv.partner || "", inv.partnerLogo || "",
                     platzSatz(inv), inviteLink(inv.token), appLink(inv.token), inv.ticketNr, inv.status]);
  }
  process.stdout.write(zeilen.map(r => r.map(f => '"' + String(f).replace(/"/g, '""') + '"').join(",")).join("\n") + "\n");
  process.exit(0);
}

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

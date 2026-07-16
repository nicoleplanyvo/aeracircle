#!/usr/bin/env node
/*
 * THE CIRCLE – Live-Server
 * Eine Datei, keine Abhängigkeiten. Dient App + Stations-Seite aus und liefert
 * die Echtzeit-Ebene: Raum-Applaus, Live-Votum, Auktions-Board, Gäste-Zähler.
 *
 * NFC-Armbänder ("nur Band, Handy optional"):
 *   Jeder Gast trägt ein passives NFC-Armband (nur eine ID). Stationen sind
 *   Android-Tablets im Browser (station.html), die das Band per Web-NFC lesen
 *   und den Tap an den Server melden. Der Server führt ein Gäste-Register
 *   (Band-ID -> Gast) und bucht Check-in, Applaus, Votum, Gebot und Momente.
 *
 *   node server/circle-server.js          → http://localhost:8080
 *   PORT=3000 node server/circle-server.js
 *
 * Zustand liegt im Speicher und wird alle 2 s nach live-state.json
 * gesichert (übersteht Neustarts). Kein Auth – gedacht für den privaten
 * Event-Abend hinter einer nicht erratbaren URL.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, "..");
const STATE_FILE = path.join(__dirname, "live-state.json");

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
  guests: {}            // bandId -> { name, table, moments:{}, applause, vote, t }
};
try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch (e) { /* frischer Start */ }
if (!state.guests) state.guests = {};

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
  if (url === "/api/live/health") return json(res, 200, { ok: true });

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

  /* --- Statik --- */
  if (req.method === "GET" && (url === "/station" || url === "/station.html")) {
    return serveFile(res, "station.html", "text/html; charset=utf-8");
  }
  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    return serveFile(res, "index.html", "text/html; charset=utf-8");
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log("THE CIRCLE Live-Server läuft auf http://localhost:" + PORT);
  console.log("  App:       http://localhost:" + PORT + "/");
  console.log("  Stationen: http://localhost:" + PORT + "/station");
});

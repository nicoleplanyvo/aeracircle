#!/usr/bin/env node
/*
 * THE CIRCLE – Live-Server
 * Eine Datei, keine Abhängigkeiten. Dient die App aus und liefert die
 * Echtzeit-Ebene: Raum-Applaus, Live-Votum, Auktions-Board, Gäste-Zähler.
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

let state = {
  applause: 0,
  votes: { ja: 0, vielleicht: 0, nein: 0 },
  bid: null,            // { amount, paddle, name, t }
  bids: []              // letzte Gebote, neueste zuerst
};
try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch (e) { /* frischer Start */ }

let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  fs.writeFile(STATE_FILE, JSON.stringify(state), () => {});
}, 2000).unref();

/* ---------- SSE ---------- */
const clients = new Set();

function snapshot() {
  return JSON.stringify({
    applause: state.applause,
    votes: state.votes,
    bid: state.bid,
    bids: state.bids.slice(0, 5),
    guests: clients.size
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

const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>&"']/g, "").trim().slice(0, n);

/* ---------- Server ---------- */
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  /* --- API --- */
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

  /* --- Statik: die App selbst --- */
  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    return fs.readFile(path.join(ROOT, "index.html"), (err, buf) => {
      if (err) { res.writeHead(500); return res.end("index.html fehlt"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(buf);
    });
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log("THE CIRCLE Live-Server läuft auf http://localhost:" + PORT);
});

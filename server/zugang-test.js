#!/usr/bin/env node
"use strict";
/*
 * Selbsttest fuer Zugangswege und Schnittstellen – laeuft ohne Netz.
 *
 * Startet den Server in einem leeren Arbeitsordner mit den Gaesten aus der
 * Vorlage (server/gaesteliste-vorlage.csv) und prueft per HTTP in beide
 * Richtungen: was angenommen werden muss und was nicht. Der Mailversand
 * wird abgefangen (nichts verlaesst den Rechner), die Mail landet in einer
 * Datei, aus der der Test Link und Code liest.
 *
 *   node server/zugang-test.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

let fehler = 0, gut = 0;
function pruefe(bedingung, text, mehr) {
  if (bedingung) { gut++; console.log("ok      " + text); }
  else { fehler++; console.log("FEHLER  " + text + (mehr ? "  -> " + mehr : "")); }
}

const wurzel = path.resolve(__dirname, "..");
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), "circle-test-"));
function kopiere(von, nach) {
  const st = fs.statSync(von);
  if (st.isDirectory()) { fs.mkdirSync(nach, { recursive: true }); for (const f of fs.readdirSync(von)) kopiere(path.join(von, f), path.join(nach, f)); }
  else fs.copyFileSync(von, nach);
}
for (const n of ["server", "email", "public"]) if (fs.existsSync(path.join(wurzel, n))) kopiere(path.join(wurzel, n), path.join(ordner, n));
for (const f of fs.readdirSync(wurzel)) if (/\.(html|js|webmanifest)$/.test(f)) fs.copyFileSync(path.join(wurzel, f), path.join(ordner, f));
for (const f of ["live-state.json", "versand-log.json"]) try { fs.unlinkSync(path.join(ordner, "server", f)); } catch (e) {}

/* Mailversand abfangen: statt einer Verbindung nach aussen eine Zeile in mails.jsonl. */
const mailDatei = path.join(ordner, "mails.jsonl");
fs.writeFileSync(path.join(ordner, "mail-fang.js"), `
const https = require("https"), { EventEmitter } = require("events"), fs = require("fs");
const echt = https.request;
https.request = function (opt, cb) {
  if (!opt || opt.hostname !== "api.lettermint.co") return echt.apply(this, arguments);
  const req = new EventEmitter(); let body = "";
  req.write = c => { body += c; };
  req.end = () => {
    fs.appendFileSync(${JSON.stringify(mailDatei)}, body + "\\n");
    const res = new EventEmitter(); res.statusCode = 200;
    setImmediate(() => { cb(res); res.emit("data", "{}"); res.emit("end"); });
  };
  req.destroy = () => {};
  return req;
};
`);

const srv = path.join(ordner, "server", "circle-server.js");
const imp = spawnSync(process.execPath, [srv, "import", path.join(ordner, "server", "gaesteliste-vorlage.csv")], { encoding: "utf8" });
pruefe(imp.status === 0, "Vorlage laesst sich einlesen", imp.stderr);
const zustandDatei = path.join(ordner, "server", "live-state.json");
const zustand = JSON.parse(fs.readFileSync(zustandDatei, "utf8"));
const gaeste = Object.values(zustand.invites);
const gast = gaeste[0], offen = gaeste[2];
gast.status = "zugesagt"; gaeste[1].status = "bezahlt";
fs.writeFileSync(zustandDatei, JSON.stringify(zustand));
const nachname = gast.name.split(" ").pop();

const PORT = 18000 + Math.floor(Math.random() * 2000);
const ADMIN = "test-" + Math.random().toString(36).slice(2);
function anfrage(methode, pfad, rumpf, kopf) {
  return new Promise((resolve, reject) => {
    const daten = rumpf === undefined ? null : JSON.stringify(rumpf);
    const req = http.request({ host: "127.0.0.1", port: PORT, method: methode, path: pfad,
      headers: Object.assign(daten ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(daten) } : {}, kopf || {}) }, res => {
      let roh = ""; res.on("data", c => roh += c);
      res.on("end", () => { let j = null; try { j = JSON.parse(roh); } catch (e) {} resolve({ status: res.statusCode, json: j || {}, roh }); });
    });
    req.on("error", reject);
    if (daten) req.write(daten);
    req.end();
  });
}
const warte = ms => new Promise(r => setTimeout(r, ms));
const mails = () => fs.existsSync(mailDatei) ? fs.readFileSync(mailDatei, "utf8").trim().split("\n").filter(Boolean).map(z => JSON.parse(z)) : [];

(async () => {
  const kind = spawn(process.execPath, ["-r", path.join(ordner, "mail-fang.js"), srv], {
    env: Object.assign({}, process.env, { PORT: String(PORT), PUBLIC_URL: "http://127.0.0.1:" + PORT, LETTERMINT_TOKEN: "test", ADMIN_TOKEN: ADMIN, TRUST_PROXY: "1", STRIPE_SECRET_KEY: "" }),
    stdio: "ignore"
  });
  try {
    let oben = false;
    for (let i = 0; i < 60 && !oben; i++) { try { oben = (await anfrage("GET", "/api/app/ich?t=" + gast.token)).status === 200; } catch (e) {} if (!oben) await warte(100); }
    pruefe(oben, "Server laeuft, Gast kommt mit seinem Link in die App");

    /* ---- Zugang wiederfinden ---- */
    const fremd = await anfrage("POST", "/api/app/finden", { email: "niemand@example.de", nachname: "Niemand" }, { "X-Forwarded-For": "198.51.100.1" });
    const echt = await anfrage("POST", "/api/app/finden", { email: gast.email, nachname }, { "X-Forwarded-For": "198.51.100.2" });
    const nichtImKreis = await anfrage("POST", "/api/app/finden", { email: offen.email, nachname: offen.name.split(" ").pop() }, { "X-Forwarded-For": "198.51.100.3" });
    pruefe(fremd.status === 200 && echt.status === 200 && nichtImKreis.status === 200, "finden antwortet immer mit 200");
    pruefe(fremd.roh === echt.roh && echt.roh === nichtImKreis.roh, "finden antwortet in allen Faellen wortgleich");
    pruefe(!echt.roh.includes(gast.token) && echt.json.token === undefined, "die Antwort enthaelt keinen Zugang");
    await warte(300);
    let post = mails();
    pruefe(post.length === 1 && post[0].to[0] === gast.email, "genau eine Mail, an die Adresse aus dem Register", "Mails: " + post.length);
    const text = post[0] ? post[0].text : "";
    pruefe(text.includes("/?t=" + gast.token), "die Mail traegt den Zugangslink");
    const code = (text.match(/Code ein: ([A-Z0-9]{4}-[A-Z0-9]{4})/) || [])[1] || "";
    pruefe(!!code, "die Mail traegt den Code fuer die installierte App");

    let r = await anfrage("POST", "/api/app/finden-code", { email: gast.email, nachname, code: "AAAA-AAAA" }, { "X-Forwarded-For": "198.51.100.4" });
    pruefe(r.status === 404 && !r.roh.includes(gast.token), "falscher Code: abgewiesen");
    r = await anfrage("POST", "/api/app/finden-code", { email: gaeste[1].email, nachname: gaeste[1].name.split(" ").pop(), code }, { "X-Forwarded-For": "198.51.100.4" });
    pruefe(r.status === 404, "Code eines anderen Gastes: abgewiesen");
    r = await anfrage("POST", "/api/app/finden-code", { email: gast.email, nachname, code: code.toLowerCase() }, { "X-Forwarded-For": "198.51.100.4" });
    pruefe(r.status === 200 && r.json.token === gast.token, "richtiger Code: die App bekommt ihren Zugang", "Status " + r.status);
    r = await anfrage("POST", "/api/app/finden-code", { email: gast.email, nachname, code }, { "X-Forwarded-For": "198.51.100.4" });
    pruefe(r.status === 404, "Code gilt nur einmal");

    /* fuenf Fehlversuche verbrauchen den Code */
    await anfrage("POST", "/api/app/finden", { email: gast.email, nachname }, { "X-Forwarded-For": "198.51.100.5" });
    await warte(300);
    const code2 = ((mails()[1] || {}).text || "").match(/Code ein: ([A-Z0-9]{4}-[A-Z0-9]{4})/);
    for (let i = 0; i < 5; i++) await anfrage("POST", "/api/app/finden-code", { email: gast.email, nachname, code: "BBBB-BBB" + i }, { "X-Forwarded-For": "198.51.100.6" });
    r = await anfrage("POST", "/api/app/finden-code", { email: gast.email, nachname, code: code2 ? code2[1] : "" }, { "X-Forwarded-For": "198.51.100.6" });
    pruefe(!!code2 && r.status === 404, "nach fuenf Fehlversuchen ist der Code verbraucht");

    /* hoechstens drei Mails je Gast und Stunde */
    for (let i = 0; i < 4; i++) await anfrage("POST", "/api/app/finden", { email: gast.email, nachname }, { "X-Forwarded-For": "198.51.100." + (20 + i) });
    await warte(300);
    pruefe(mails().length === 3, "hoechstens drei Mails je Gast und Stunde", "Mails: " + mails().length);

    /* ---- Limit je Adresse: nur der vom Proxy angehaengte Wert zaehlt ---- */
    let letzter = 0;
    for (let i = 0; i < 12; i++) letzter = (await anfrage("POST", "/api/app/finden", { email: "x" + i + "@example.de", nachname: "Niemand" }, { "X-Forwarded-For": "10.1." + i + ".1, 203.0.113.9" })).status;
    pruefe(letzter === 429, "Limit greift auch bei wechselndem ersten X-Forwarded-For-Wert", "Status " + letzter);
    r = await anfrage("POST", "/api/app/finden", { email: "y@example.de", nachname: "Niemand" }, { "X-Forwarded-For": "10.1.0.1, 203.0.113.10" });
    pruefe(r.status === 200, "eine andere Adresse ist davon nicht betroffen");

    /* ---- Stationen ---- */
    r = await anfrage("POST", "/api/station/register", { band: "band-1", name: "Test" });
    pruefe(r.status === 401, "Station ohne Zugang: register abgewiesen");
    r = await anfrage("POST", "/api/station/tap", { band: "band-1", station: "bid", inc: 5000 });
    pruefe(r.status === 401, "Station ohne Zugang: tap abgewiesen");
    r = await anfrage("POST", "/api/station/tap", { band: "band-1", station: "applause", k: "0".repeat(32) });
    pruefe(r.status === 401, "Station mit falschem Zugang: abgewiesen");
    r = await anfrage("GET", "/api/admin/station-key");
    pruefe(r.status === 401 || r.status === 403, "Stations-Zugang ohne Anmeldung nicht lesbar", "Status " + r.status);
    const zugang = await anfrage("GET", "/api/admin/station-key?key=" + ADMIN);
    const k = zugang.json.key;
    pruefe(zugang.status === 200 && /^[a-f0-9]{32}$/.test(k || "") && String(zugang.json.link).endsWith("/station?k=" + k), "Veranstalter liest den Stations-Zugang");
    r = await anfrage("POST", "/api/station/register", { band: "band-1", name: "Test", k });
    pruefe(r.status === 200 && r.json.ok === true, "Station mit Zugang: register geht");
    r = await anfrage("POST", "/api/station/tap", { band: "band-1", station: "applause" }, { "X-Station-Key": k });
    pruefe(r.status === 200 && r.json.ok === true, "Station mit Zugang (Kopfzeile): tap geht");
    const neu = await anfrage("POST", "/api/admin/station-key?key=" + ADMIN, {});
    r = await anfrage("POST", "/api/station/tap", { band: "band-1", station: "applause", k });
    pruefe(neu.json.key !== k && r.status === 401, "nach dem Erneuern gilt der alte Zugang nicht mehr");
    r = await anfrage("POST", "/api/station/tap", { band: "band-1", station: "applause", k: neu.json.key });
    pruefe(r.status === 200, "der neue Zugang gilt");

    /* ---- Gebote ---- */
    r = await anfrage("POST", "/api/live/bid", { amount: 500, name: "Fremd", paddle: "7" });
    pruefe(r.status === 401, "Gebot ohne Zugang: abgewiesen");
    r = await anfrage("POST", "/api/live/bid", { amount: 500, t: "gibtesnicht12" });
    pruefe(r.status === 401, "Gebot mit unbekanntem Zugang: abgewiesen");
    r = await anfrage("POST", "/api/live/bid", { amount: 500, t: offen.token });
    pruefe(r.status === 401, "Gebot eines Gastes ohne Zusage: abgewiesen");
    r = await anfrage("POST", "/api/live/bid", { amount: 500, t: gast.token });
    pruefe(r.status === 200 && r.json.bid && r.json.bid.amount === 500 && r.json.bid.name === gast.name.split(" ")[0], "Gebot eines Gastes im Kreis: angenommen", "Status " + r.status);
    let st = 0;
    for (let i = 0; i < 14; i++) st = (await anfrage("POST", "/api/live/bid", { amount: 600 + i * 100, t: gast.token })).status;
    pruefe(st === 429, "Gebote je Gast sind begrenzt", "Status " + st);

    /* ---- Bild vom Stand: interne Ziele bleiben zu ---- */
    r = await anfrage("GET", "/api/stand/bild?u=" + encodeURIComponent("http://127.0.0.1:" + PORT + "/checkin-qr.png"));
    pruefe(r.status === 403, "Bild-Adresse im eigenen Netz: abgewiesen", "Status " + r.status);
  } catch (e) {
    fehler++; console.log("FEHLER  Ablauf: " + e.message);
  } finally {
    kind.kill();
    await warte(100);
    try { fs.rmSync(ordner, { recursive: true, force: true }); } catch (e) {}
  }
  console.log("\n" + gut + " ok, " + fehler + " Fehler");
  process.exit(fehler ? 1 : 0);
})();

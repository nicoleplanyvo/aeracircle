/* Prueft das Matching fuer das Business Speed Dating.
 *   node --test server/speed-dating-test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const SD = require("../speed-dating-matching.js");

const TAGS = ["Personal", "Vertrieb", "Investoren", "Standort", "Digitalisierung", "Nachfolge", "Marketing", "Kooperation"];

/** Baut n Demo-Teilnehmer, deterministisch. */
function leute(n) {
  const z = SD.rng(7);
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = TAGS[Math.floor(z() * TAGS.length)], b = TAGS[Math.floor(z() * TAGS.length)];
    out.push({ id: "g" + i, name: "Gast " + i, firma: "Firma " + (i % 9), sucht: [s], bietet: [b] });
  }
  return out;
}

test("Jeder trifft in jeder Runde hoechstens einen, niemanden zweimal, nie die eigene Firma", () => {
  const l = leute(40);
  const byId = Object.fromEntries(l.map(p => [p.id, p]));
  const plan = SD.planen(l, { runden: 6, seed: "test" });
  assert.equal(plan.runden.length, 6);
  const gesehen = {};
  plan.runden.forEach(r => {
    const inRunde = new Set();
    r.paare.forEach(p => {
      assert.ok(!inRunde.has(p.anker) && !inRunde.has(p.laeufer), "doppelt in einer Runde");
      inRunde.add(p.anker); inRunde.add(p.laeufer);
      const k = SD.matchKey(p.anker, p.laeufer);
      assert.ok(!gesehen[k], "Wiedersehen " + k);
      gesehen[k] = true;
      assert.notEqual(byId[p.anker].firma, byId[p.laeufer].firma, "gleiche Firma");
    });
    r.frei.forEach(id => assert.ok(!inRunde.has(id), "frei und gepaart zugleich"));
    assert.equal(inRunde.size + r.frei.length, l.length, "jemand fehlt in der Runde");
  });
});

test("Erkennungszeichen sind je Runde eindeutig", () => {
  const plan = SD.planen(leute(60), { runden: 4, seed: 1 });
  plan.runden.forEach(r => {
    const z = new Set(r.paare.map(p => p.zeichen.farbe + "|" + p.zeichen.symbol));
    assert.equal(z.size, r.paare.length);
    r.paare.forEach(p => assert.match(p.zeichen.hex, /^#[0-9a-f]{6}$/));
  });
});

test("Anker und Laeufer wechseln sich ab", () => {
  const l = leute(24);
  const plan = SD.planen(l, { runden: 6, seed: 3 });
  l.forEach(p => {
    const anker = plan.ankerZaehler[p.id];
    const gepaart = plan.runden.filter(r => r.paare.some(x => x.anker === p.id || x.laeufer === p.id)).length;
    assert.ok(Math.abs(anker - (gepaart - anker)) <= 2, p.id + " ist " + anker + "x Anker bei " + gepaart + " Runden");
  });
});

test("Ungerade Zahl: genau eine Person setzt aus, und nicht immer dieselbe", () => {
  const l = leute(21);
  const plan = SD.planen(l, { runden: 6, seed: 5 });
  const aussetzer = plan.runden.map(r => { assert.equal(r.frei.length, 1); return r.frei[0]; });
  assert.ok(new Set(aussetzer).size >= 5, "immer dieselben setzen aus: " + aussetzer.join(","));
});

test("Gleicher Seed, gleicher Plan", () => {
  const l = leute(30);
  assert.deepEqual(SD.planen(l, { seed: "x" }), SD.planen(l, { seed: "x" }));
  assert.notDeepEqual(SD.planen(l, { seed: "x" }).runden[0], SD.planen(l, { seed: "y" }).runden[0]);
});

test("Passung: beidseitiger Nutzen schlaegt einseitigen, Firma schliesst aus", () => {
  const a = { id: "a", firma: "A", sucht: ["Vertrieb"], bietet: ["Personal"] };
  const b = { id: "b", firma: "B", sucht: ["Personal"], bietet: ["Vertrieb"] };
  const c = { id: "c", firma: "C", sucht: ["Marketing"], bietet: ["Vertrieb"] };
  const d = { id: "d", firma: "A", sucht: ["Personal"], bietet: ["Vertrieb"] };
  assert.ok(SD.passung(a, b) > SD.passung(a, c));
  assert.ok(SD.passung(a, c) > 0);
  assert.ok(SD.passung(a, d) < 0);
  assert.match(SD.grund({ ...a, name: "Anna Ast" }, { ...b, name: "Ben Beispiel" }), /^Ben bietet, was du suchst: Vertrieb\.$/);
  assert.match(SD.grund({ ...a, name: "Anna Ast", sucht: [] }, { ...c, name: "Carl" }), /^Frage zum Einstieg: /);
});

test("Nachpaaren: der freie Pool wird gepaart, Zeichen kollidieren nicht mit der Runde", () => {
  const l = leute(20);
  const plan = SD.planen(l, { runden: 1, seed: 2 });
  const runde = plan.runden[0];
  // Vier Leute haben sich nicht gefunden - ihre Paare loesen sich, sie landen im Pool.
  const pool = [l[0], l[1], l[2], l[3]];
  const neu = SD.nachpaaren(pool, runde, plan, "pool");
  assert.equal(neu.paare.length + neu.frei.length / 2, 2);
  const belegt = new Set(runde.paare.map(p => p.zeichen.farbe + "|" + p.zeichen.symbol));
  neu.paare.forEach(p => assert.ok(!belegt.has(p.zeichen.farbe + "|" + p.zeichen.symbol), "Zeichen doppelt"));
});

test("Nachpaaren: spaeter geplante Partner sperren nicht, schon getroffene schon", () => {
  const l = leute(30);
  const plan = SD.planen(l, { runden: 6, seed: 11 });
  const r1 = plan.runden[0];
  const byId = Object.fromEntries(l.map(p => [p.id, p]));
  // Vier Leute aus zwei Paaren der ersten Runde landen im Pool. Ihre
  // kuenftigen Partner (Runde 2-6) stehen schon in plan.getroffen.
  const [p1, p2] = r1.paare;
  const pool = [p1.anker, p1.laeufer, p2.anker, p2.laeufer].map(id => byId[id]);
  const neu = SD.nachpaaren(pool, r1, plan, "pool", [p1.anker]);
  assert.equal(neu.paare.length, 2, "beide Paare neu gebildet: " + JSON.stringify(neu));
  neu.paare.forEach(p => {
    const k = SD.matchKey(p.anker, p.laeufer);
    assert.ok(k !== SD.matchKey(p1.anker, p1.laeufer) && k !== SD.matchKey(p2.anker, p2.laeufer), "altes Paar wiederholt");
  });
  // Ein zweites Nachpaaren in derselben Runde kennt die erste Nachpaarung.
  const neu2 = SD.nachpaaren(pool, r1, plan, "pool2");
  neu2.paare.forEach(p => neu.paare.forEach(q => assert.notEqual(SD.matchKey(p.anker, p.laeufer), SD.matchKey(q.anker, q.laeufer), "Nachpaarung wiederholt")));
});

test("Vorschlaege: drei Leute, ohne Verbundene und eigene Firma", () => {
  const l = leute(30);
  const v = SD.vorschlaege(l[0], l, { verbunden: ["g1", "g2"] });
  assert.equal(v.length, 3);
  const byId = Object.fromEntries(l.map(p => [p.id, p]));
  v.forEach(x => {
    assert.ok(!["g0", "g1", "g2"].includes(x.id));
    assert.notEqual(byId[x.id].firma, l[0].firma);
    assert.ok(x.grund.length > 10);
  });
});

test("Auswertung zaehlt Begegnungen, Matches und Themen", () => {
  const l = leute(20);
  const plan = SD.planen(l, { runden: 3, seed: 9 });
  const p = plan.runden[0].paare[0];
  const matches = {}; matches[SD.matchKey(p.anker, p.laeufer)] = { a: p.anker, b: p.laeufer };
  const a = SD.auswertung(plan, l, matches);
  assert.equal(a.teilnehmer, 20);
  assert.equal(a.begegnungen, 30);
  assert.equal(a.matches, 1);
  assert.equal(a.quote, 3);
  assert.ok(Array.isArray(a.themen));
});

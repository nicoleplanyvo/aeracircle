/* Business Speed Dating · Matching ohne Tische.
 *
 * Ein Modul fuer beide Seiten: im Browser als window.SpeedDating (die Demo
 * in speed-dating.html rechnet damit), in Node als require("./speed-dating-
 * matching.js") (der Server plant damit die Runden, server/speed-dating-
 * test.js prueft es).
 *
 * Grundidee: Es gibt keine Tische. Eine Begegnung haengt an der Person,
 * nicht am Ort. Pro Runde bekommt jedes Paar
 *   - einen Anker (bleibt stehen, haelt das Handy hoch) und einen Laeufer
 *     (geht hin),
 *   - ein Erkennungszeichen (Farbe + Symbol, auf beiden Handys gleich,
 *     in der Runde eindeutig),
 *   - einen Gespraechsoeffner (warum die beiden zusammenpassen).
 *
 * Alle Funktionen sind rein: gleicher Input, gleicher Output. Zufall gibt
 * es nur ueber einen Seed, damit Demo und Probelauf reproduzierbar sind.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SpeedDating = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * @typedef {Object} Teilnehmer
   * @property {string} id        Eindeutig, stabil (Gast-ID).
   * @property {string} name
   * @property {string} firma
   * @property {string} [rolle]
   * @property {string[]} sucht   Tags: was die Person heute sucht.
   * @property {string[]} bietet  Tags: was die Person heute bietet.
   */

  /**
   * @typedef {Object} Zeichen
   * @property {string} farbe     Name der Farbe (fuer die Ansage).
   * @property {string} hex       Farbe fuer den Vollbild-Screen.
   * @property {string} symbol    Name des Symbols.
   * @property {string} glyph     Unicode-Glyphe des Symbols.
   */

  /**
   * @typedef {Object} Paar
   * @property {string} anker     Teilnehmer-ID: bleibt stehen.
   * @property {string} laeufer   Teilnehmer-ID: geht hin.
   * @property {Zeichen} zeichen
   * @property {string} grund     Gespraechsoeffner, fertig formuliert.
   * @property {number} score     Passung (nur zur Diagnose).
   */

  /**
   * @typedef {Object} Runde
   * @property {number} nr        1-basiert.
   * @property {Paar[]} paare
   * @property {string[]} frei    Teilnehmer ohne Partner in dieser Runde.
   */

  /**
   * @typedef {Object} Plan
   * @property {Runde[]} runden
   * @property {Object<string, string[]>} getroffen  ID -> IDs, die die Person schon hatte.
   * @property {Object<string, number>} ankerZaehler ID -> wie oft Anker.
   * @property {Object<string, number>} freiZaehler  ID -> wie oft ohne Partner.
   * @property {Object<string, number>} balance      ID -> Anker minus Laeufer.
   * @property {Object<string, string>} zuletzt      ID -> "anker" | "laeufer".
   * @property {Object<string, string[]>} [nachgetroffen]  ID -> IDs aus Nachpaarungen.
   */

  /** Acht Farben, die sich auf einem hochgehaltenen Display auf Distanz
   *  unterscheiden lassen - auch bei Buehnenlicht. Bewusst keine zwei
   *  Blautoene, kein Grau. */
  const FARBEN = [
    { farbe: "Koralle", hex: "#f28c7c" },
    { farbe: "Olive", hex: "#92b36b" },
    { farbe: "Gold", hex: "#ffb347" },
    { farbe: "Himmel", hex: "#5aa9e6" },
    { farbe: "Flieder", hex: "#b48ee0" },
    { farbe: "Minze", hex: "#5ed6b3" },
    { farbe: "Terracotta", hex: "#c15c42" },
    { farbe: "Nacht", hex: "#3a2e2a" }
  ];

  /** Acht Symbole, die auch ohne Farbsehen auseinanderzuhalten sind. */
  const SYMBOLE = [
    { symbol: "Kreis", glyph: "●" },
    { symbol: "Dreieck", glyph: "▲" },
    { symbol: "Quadrat", glyph: "■" },
    { symbol: "Stern", glyph: "★" },
    { symbol: "Herz", glyph: "♥" },
    { symbol: "Raute", glyph: "◆" },
    { symbol: "Welle", glyph: "≈" },
    { symbol: "Blitz", glyph: "⚡" }
  ];

  /** Wenn zwei Menschen keinen gemeinsamen Tag haben, bekommen sie eine
   *  Impuls-Karte. Dieselbe Idee wie im Connect-Bereich von THE CIRCLE. */
  const IMPULSE = [
    "Was war dieses Jahr die beste Entscheidung in deinem Unternehmen?",
    "Welches Problem wuerdest du morgen abgeben, wenn du koenntest?",
    "Wen in Duesseldorf sollte man unbedingt kennen, und warum?",
    "Was hat dich zuletzt in deiner Branche ueberrascht?",
    "Welche Zusammenarbeit hat dich in den letzten zwoelf Monaten am weitesten gebracht?",
    "Was wuerdest du einem Gruender heute anders raten als vor fuenf Jahren?"
  ];

  /* ---------- Hilfen ---------- */

  /** Deterministischer Zufall (mulberry32): gleicher Seed, gleiche Folge. */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seedAus(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  function mische(liste, zufall) {
    const a = liste.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(zufall() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function norm(s) { return String(s || "").trim().toLowerCase(); }

  function schnitt(a, b) {
    const setB = new Set((b || []).map(norm));
    return (a || []).filter(function (t) { return setB.has(norm(t)); });
  }

  function gleicheFirma(a, b) {
    return norm(a.firma) !== "" && norm(a.firma) === norm(b.firma);
  }

  /* ---------- Passung ---------- */

  /**
   * Wie gut passen zwei Menschen fuer eine Begegnung zusammen?
   * Beidseitiger Nutzen zaehlt am meisten, ein gemeinsames Thema etwas,
   * dieselbe Firma schliesst aus, ein Wiedersehen ebenso.
   * @param {Teilnehmer} a
   * @param {Teilnehmer} b
   * @param {Object<string, string[]>} [getroffen]  Harte Sperre: schon getroffen.
   * @param {Object<string, string[]>} [meiden]     Weiche Strafe: fuer spaeter geplant.
   * @returns {number}
   */
  function passung(a, b, getroffen, meiden) {
    if (a.id === b.id) return -Infinity;
    if (gleicheFirma(a, b)) return -1000;
    if (getroffen && (getroffen[a.id] || []).indexOf(b.id) >= 0) return -500;
    let s = 1; // jede Begegnung ist besser als keine
    // Fuer spaeter geplante Partner: lieber nicht, aber besser als niemand.
    if (meiden && (meiden[a.id] || []).indexOf(b.id) >= 0) s -= 3;
    s += 3 * schnitt(a.sucht, b.bietet).length;
    s += 3 * schnitt(b.sucht, a.bietet).length;
    s += 1 * schnitt(a.sucht, b.sucht).length;
    return s;
  }

  /**
   * Der Gespraechsoeffner aus Sicht von `ich`.
   * @param {Teilnehmer} ich
   * @param {Teilnehmer} andere
   * @param {number} [impulsIndex]
   * @returns {string}
   */
  function grund(ich, andere, impulsIndex) {
    const vorname = (andere.name || "").split(" ")[0] || andere.name;
    const bekommt = schnitt(ich.sucht, andere.bietet);
    if (bekommt.length) return vorname + " bietet, was du suchst: " + bekommt[0] + ".";
    const gibt = schnitt(andere.sucht, ich.bietet);
    if (gibt.length) return vorname + " sucht genau das, was du bietest: " + gibt[0] + ".";
    const thema = schnitt(ich.sucht, andere.sucht);
    if (thema.length) return "Ihr habt beide " + thema[0] + " als Thema.";
    const i = Math.abs(impulsIndex || 0) % IMPULSE.length;
    return "Frage zum Einstieg: " + IMPULSE[i];
  }

  /* ---------- Eine Runde paaren ---------- */

  /**
   * Greedy-Paarung: die besten Paare zuerst, jeder hoechstens einmal.
   * Wer uebrig bleibt, landet in `frei`. Bei ungerader Zahl bleibt genau
   * eine Person frei - die, die bisher am seltensten frei war.
   * @param {Teilnehmer[]} leute
   * @param {Plan} plan
   * @param {function(): number} zufall
   * @returns {{ paare: Array<[Teilnehmer, Teilnehmer, number]>, frei: Teilnehmer[] }}
   */
  function paareRunde(leute, plan, zufall, bevorzugt, getroffen, meiden) {
    getroffen = getroffen || plan.getroffen;
    let pool = mische(leute, zufall);
    const bev = new Set(bevorzugt || []);
    // Bei ungerader Zahl setzt die Person aus, die bisher am seltensten frei
    // war - nie eine bevorzugte (die steht schon am Schild und wartet).
    let aussetzer = null;
    if (pool.length % 2 === 1) {
      pool.sort(function (x, y) {
        return (bev.has(x.id) ? 1 : 0) - (bev.has(y.id) ? 1 : 0)
          || (plan.freiZaehler[x.id] || 0) - (plan.freiZaehler[y.id] || 0);
      });
      aussetzer = pool[0];
      pool = pool.slice(1);
    }
    const kandidaten = [];
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const s = passung(pool[i], pool[j], getroffen, meiden);
        if (s > -500) kandidaten.push([pool[i], pool[j], s]);
      }
    }
    // Beste Passung zuerst; Gleichstand entscheidet der Seed, nicht die Reihenfolge der Liste.
    const jitter = new Map();
    kandidaten.forEach(function (k) { jitter.set(k, zufall()); });
    kandidaten.sort(function (x, y) { return (y[2] - x[2]) || (jitter.get(x) - jitter.get(y)); });
    const vergeben = new Set();
    const paare = [];
    kandidaten.forEach(function (k) {
      if (vergeben.has(k[0].id) || vergeben.has(k[1].id)) return;
      vergeben.add(k[0].id); vergeben.add(k[1].id);
      paare.push(k);
    });
    let frei = pool.filter(function (p) { return !vergeben.has(p.id); });
    // Greedy laesst Leute frei, die direkt nicht zusammenpassen (gleiche
    // Firma, schon getroffen), obwohl ein Tausch mit einem bestehenden Paar
    // beide unterbringen wuerde: x-p und y-q statt p-q. Solange so ein
    // Tausch existiert, wird er gemacht - der beste zuerst.
    for (;;) {
      if (frei.length < 2) break;
      let bester = null;
      for (let i = 0; i < frei.length; i++) for (let j = i + 1; j < frei.length; j++) {
        const x = frei[i], y = frei[j];
        for (let k = 0; k < paare.length; k++) {
          const p = paare[k][0], q = paare[k][1];
          const v1 = [passung(x, p, getroffen, meiden), passung(y, q, getroffen, meiden)];
          const v2 = [passung(x, q, getroffen, meiden), passung(y, p, getroffen, meiden)];
          if (v1[0] > -500 && v1[1] > -500 && (!bester || v1[0] + v1[1] > bester.summe))
            bester = { summe: v1[0] + v1[1], k: k, neu: [[x, p, v1[0]], [y, q, v1[1]]], raus: [x, y] };
          if (v2[0] > -500 && v2[1] > -500 && (!bester || v2[0] + v2[1] > bester.summe))
            bester = { summe: v2[0] + v2[1], k: k, neu: [[x, q, v2[0]], [y, p, v2[1]]], raus: [x, y] };
        }
      }
      if (!bester) break;
      paare.splice(bester.k, 1);
      paare.push(bester.neu[0], bester.neu[1]);
      frei = frei.filter(function (p) { return bester.raus.indexOf(p) < 0; });
    }
    if (aussetzer) frei.push(aussetzer);
    return { paare: paare, frei: frei };
  }

  /**
   * Erkennungszeichen fuer eine Runde: Farbe x Symbol, keine zwei Paare
   * gleich, keine zwei Paare mit gleicher Farbe solange es reicht (8 Paare),
   * danach unterschiedliche Symbole je Farbe. 64 Kombinationen reichen fuer
   * 128 Teilnehmer je Block.
   * @param {number} anzahl
   * @param {function(): number} zufall
   * @returns {Zeichen[]}
   */
  function zeichenFuer(anzahl, zufall) {
    const farben = mische(FARBEN, zufall);
    const symbole = mische(SYMBOLE, zufall);
    const out = [];
    for (let i = 0; i < anzahl; i++) {
      const f = farben[i % farben.length];
      const s = symbole[(Math.floor(i / farben.length) + i) % symbole.length];
      out.push({ farbe: f.farbe, hex: f.hex, symbol: s.symbol, glyph: s.glyph });
    }
    return out;
  }

  /* ---------- Der ganze Block ---------- */

  /**
   * Plant alle Runden eines Speed-Dating-Blocks.
   * @param {Teilnehmer[]} leute
   * @param {{ runden?: number, seed?: string|number }} [opt]
   * @returns {Plan}
   */
  function planen(leute, opt) {
    opt = opt || {};
    const anzahlRunden = Math.max(1, opt.runden || 6);
    const zufall = rng(typeof opt.seed === "number" ? opt.seed : seedAus(String(opt.seed || "duesseldorf-in")));
    /** @type {Plan} */
    const plan = { runden: [], getroffen: {}, ankerZaehler: {}, freiZaehler: {}, balance: {}, zuletzt: {} };
    leute.forEach(function (p) { plan.getroffen[p.id] = []; plan.ankerZaehler[p.id] = 0; plan.freiZaehler[p.id] = 0; plan.balance[p.id] = 0; });

    for (let r = 1; r <= anzahlRunden; r++) {
      const roh = paareRunde(leute, plan, zufall);
      const zeichen = zeichenFuer(roh.paare.length, zufall);
      const paare = roh.paare.map(function (k, i) {
        return baueRaar(k[0], k[1], k[2], zeichen[i], plan, r + i, zufall);
      });
      roh.frei.forEach(function (p) { plan.freiZaehler[p.id]++; });
      plan.runden.push({ nr: r, paare: paare, frei: roh.frei.map(function (p) { return p.id; }) });
    }
    return plan;
  }

  /** Aus zwei Leuten ein Paar mit Rollen, Zeichen und Grund; schreibt den Plan fort. */
  function baueRaar(a, b, score, zeichen, plan, impulsIndex, zufall) {
    // Wer haeufiger Laeufer als Anker war, wird Anker (Balance). Gleichstand:
    // wer zuletzt gelaufen ist. Immer noch gleich: der Seed, nicht die ID.
    const ba = plan.balance[a.id] || 0, bb = plan.balance[b.id] || 0;
    let anker = a, laeufer = b;
    if (bb < ba) { anker = b; laeufer = a; }
    else if (bb === ba) {
      const la = plan.zuletzt[a.id] || "", lb = plan.zuletzt[b.id] || "";
      if (lb === "laeufer" && la !== "laeufer") { anker = b; laeufer = a; }
      else if (la === lb && zufall() < 0.5) { anker = b; laeufer = a; }
    }
    plan.ankerZaehler[anker.id] = (plan.ankerZaehler[anker.id] || 0) + 1;
    plan.balance[anker.id] = (plan.balance[anker.id] || 0) + 1;
    plan.balance[laeufer.id] = (plan.balance[laeufer.id] || 0) - 1;
    plan.zuletzt[anker.id] = "anker"; plan.zuletzt[laeufer.id] = "laeufer";
    plan.getroffen[a.id] = (plan.getroffen[a.id] || []).concat([b.id]);
    plan.getroffen[b.id] = (plan.getroffen[b.id] || []).concat([a.id]);
    return {
      anker: anker.id,
      laeufer: laeufer.id,
      zeichen: zeichen,
      grund: grund(anker, laeufer, impulsIndex),
      score: score
    };
  }

  /**
   * Nachpaaren waehrend einer laufenden Runde: Wer sich nicht gefunden hat
   * oder ohne Partner ist, kommt in den freien Pool und wird sofort neu
   * gepaart. Vergibt Zeichen, die in der Runde noch frei sind.
   * @param {Teilnehmer[]} pool     Die freien Leute.
   * @param {Runde} runde           Die laufende Runde (wird nicht veraendert).
   * @param {Plan} plan             Wird fortgeschrieben (getroffen, Anker).
   * @param {string|number} [seed]
   * @param {string[]} [bevorzugt]  IDs, die nicht aussetzen sollen (stehen am Schild).
   * @returns {{ paare: Paar[], frei: string[] }}
   */
  function nachpaaren(pool, runde, plan, seed, bevorzugt) {
    plan.balance = plan.balance || {}; plan.zuletzt = plan.zuletzt || {};
    plan.nachgetroffen = plan.nachgetroffen || {};
    const zufall = rng(typeof seed === "number" ? seed : seedAus(String(seed || "pool") + runde.nr));
    // plan.getroffen kennt schon alle Runden. Gesperrt ist nur, wer sich
    // BIS JETZT getroffen hat (geplante Runden bis zu dieser plus alle
    // Nachpaarungen); die Partner spaeterer Runden werden nur gemieden.
    const bisher = {};
    const merke = function (a, b) { (bisher[a] = bisher[a] || []).push(b); (bisher[b] = bisher[b] || []).push(a); };
    (plan.runden || []).forEach(function (r) { if (r.nr <= runde.nr) r.paare.forEach(function (p) { merke(p.anker, p.laeufer); }); });
    Object.keys(plan.nachgetroffen).forEach(function (a) { plan.nachgetroffen[a].forEach(function (b) { if ((bisher[a] || []).indexOf(b) < 0) merke(a, b); }); });
    const roh = paareRunde(pool, plan, zufall, bevorzugt, bisher, plan.getroffen);
    const belegt = new Set(runde.paare.map(function (p) { return p.zeichen.farbe + "|" + p.zeichen.symbol; }));
    const alle = [];
    FARBEN.forEach(function (f) { SYMBOLE.forEach(function (s) {
      const k = f.farbe + "|" + s.symbol;
      if (!belegt.has(k)) alle.push({ farbe: f.farbe, hex: f.hex, symbol: s.symbol, glyph: s.glyph });
    }); });
    const zeichen = mische(alle, zufall);
    const paare = roh.paare.map(function (k, i) {
      (plan.nachgetroffen[k[0].id] = plan.nachgetroffen[k[0].id] || []).push(k[1].id);
      (plan.nachgetroffen[k[1].id] = plan.nachgetroffen[k[1].id] || []).push(k[0].id);
      return baueRaar(k[0], k[1], k[2], zeichen[i % zeichen.length], plan, runde.nr * 7 + i, zufall);
    });
    return { paare: paare, frei: roh.frei.map(function (p) { return p.id; }) };
  }

  /* ---------- Vorschlaege fuer den ganzen Abend ---------- */

  /**
   * "Drei Menschen, die du heute treffen solltest" - ohne Runden, fuer alle
   * Gaeste, nicht nur den Block. Schon Verbundene und die eigene Firma
   * bleiben draussen.
   * @param {Teilnehmer} ich
   * @param {Teilnehmer[]} alle
   * @param {{ anzahl?: number, verbunden?: string[] }} [opt]
   * @returns {Array<{ id: string, score: number, grund: string }>}
   */
  function vorschlaege(ich, alle, opt) {
    opt = opt || {};
    const raus = new Set(opt.verbunden || []);
    return alle
      .filter(function (p) { return p.id !== ich.id && !raus.has(p.id) && !gleicheFirma(ich, p); })
      .map(function (p, i) { return { id: p.id, score: passung(ich, p), grund: grund(ich, p, i) }; })
      .filter(function (v) { return v.score > 0; })
      .sort(function (x, y) { return y.score - x.score || x.id.localeCompare(y.id); })
      .slice(0, opt.anzahl || 3);
  }

  /* ---------- Auswertung ---------- */

  /**
   * Zahlen fuer den Veranstalter: Begegnungen, Matches, Quote, welche
   * Themen zusammenfinden.
   * @param {Plan} plan
   * @param {Teilnehmer[]} leute
   * @param {Object<string, {a: string, b: string}>} matches  Schluessel "a|b", beidseitiges Ja.
   * @returns {{ teilnehmer: number, begegnungen: number, matches: number, quote: number, themen: Array<{tag: string, treffer: number}> }}
   */
  function auswertung(plan, leute, matches) {
    const byId = {};
    leute.forEach(function (p) { byId[p.id] = p; });
    let begegnungen = 0;
    plan.runden.forEach(function (r) { begegnungen += r.paare.length; });
    const m = Object.keys(matches || {}).length;
    const themen = {};
    Object.keys(matches || {}).forEach(function (k) {
      const a = byId[matches[k].a], b = byId[matches[k].b];
      if (!a || !b) return;
      schnitt(a.sucht, b.bietet).concat(schnitt(b.sucht, a.bietet)).forEach(function (t) {
        themen[t] = (themen[t] || 0) + 1;
      });
    });
    return {
      teilnehmer: leute.length,
      begegnungen: begegnungen,
      matches: m,
      quote: begegnungen ? Math.round((m / begegnungen) * 100) : 0,
      themen: Object.keys(themen).map(function (t) { return { tag: t, treffer: themen[t] }; })
        .sort(function (x, y) { return y.treffer - x.treffer || x.tag.localeCompare(y.tag); })
    };
  }

  /** Schluessel fuer ein Match, unabhaengig von der Reihenfolge. */
  function matchKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }

  return {
    FARBEN: FARBEN, SYMBOLE: SYMBOLE, IMPULSE: IMPULSE,
    passung: passung, grund: grund, planen: planen, nachpaaren: nachpaaren,
    vorschlaege: vorschlaege, auswertung: auswertung, matchKey: matchKey,
    rng: rng, seedAus: seedAus
  };
});

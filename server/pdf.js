/* Ein kleiner PDF-Schreiber ohne Abhaengigkeiten - genug fuer ein Blatt:
 * Text in den Standardschriften, Linien, Flaechen, JPEG-Bilder. Mehr braucht
 * eine Rechnung nicht, und mehr wollen wir hier nicht warten.
 *
 * Warum selbst geschrieben: Der Server hat keinen Browser und kein npm. Eine
 * Rechnung ist ein Blatt mit Text, zwei Bildern und ein paar Linien - dafuer
 * eine Bibliothek mit Tausenden Zeilen zu ziehen, waere das falsche Risiko.
 *
 * Koordinaten: Punkte (1/72 Zoll), Ursprung OBEN links - wie auf dem Blatt
 * gedacht, nicht wie PDF sie speichert (das dreht die Funktion selbst um).
 * Schriften: Helvetica (F1), Helvetica-Bold (F2), Times-Roman (F3) - die
 * Standardschriften, die jeder PDF-Leser mitbringt; nichts wird eingebettet.
 * Zeichen: WinAnsi. Umlaute, ß, €, Gedankenstrich und Anfuehrungszeichen
 * sind dabei; was darueber hinausgeht, wird zu "?". */
"use strict";

const A4 = { b: 595.28, h: 841.89 };

/* Breiten je 1000 Einheiten (aus den AFM-Dateien) fuer 32..126 - fuer
 * rechtsbuendige Spalten. Umlaute und Sonderzeichen stehen einzeln. */
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELVB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const SONDER = { "ä":556,"ö":556,"ü":556,"Ä":667,"Ö":778,"Ü":722,"ß":611,"€":556,"–":556,"·":278,"„":333,"“":333,"”":333,"’":222,"é":556,"è":556,"á":556,"à":556 };
const SONDERB = { "ä":556,"ö":611,"ü":611,"Ä":722,"Ö":778,"Ü":722,"ß":611,"€":556,"–":556,"·":278,"„":500,"“":500,"”":500,"’":278,"é":556,"è":556,"á":556,"à":556 };

/* WinAnsi: die Zeichen, die in Latin-1 nicht an derselben Stelle liegen. */
const WINANSI = { "€":0x80,"‚":0x82,"„":0x84,"…":0x85,"‘":0x91,"’":0x92,"“":0x93,"”":0x94,"•":0x95,"–":0x96,"—":0x97,"™":0x99 };

function breite(text, fett, groesse) {
  const tab = fett ? HELVB : HELV, sonder = fett ? SONDERB : SONDER;
  let w = 0;
  for (const c of String(text)) {
    const k = c.charCodeAt(0);
    w += (k >= 32 && k <= 126) ? tab[k - 32] : (sonder[c] || 556);
  }
  return w * groesse / 1000;
}

function kodieren(text) {
  const bytes = [];
  for (const c of String(text)) {
    const k = c.charCodeAt(0);
    let b;
    if (WINANSI[c] !== undefined) b = WINANSI[c];
    else if (k < 256) b = k;
    else b = 63;                                    // "?"
    if (b === 0x28 || b === 0x29 || b === 0x5c) bytes.push(0x5c);   // ( ) \ maskieren
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/* Bildmasse aus dem JPEG-Kopf (SOF-Marker). */
function jpegMasse(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      return { h: buf.readUInt16BE(i + 5), b: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("JPEG ohne SOF");
}

function neuesPdf() {
  const teile = [];        // Inhaltsstrom des Blatts
  const bilder = [];       // { name, buf, b, h }
  const y = v => (A4.h - v).toFixed(2);
  const f = v => Number(v).toFixed(2);
  const farbe = c => c.map(v => (v / 255).toFixed(3)).join(" ");

  return {
    /* Text an x, y (Oberkante-Ursprung). Optionen: fett, serif, groesse,
     * farbe [r,g,b], rechts (rechtsbuendig an x), spatium (Zeichenabstand). */
    text(x, yy, str, o) {
      o = o || {};
      const groesse = o.groesse || 10;
      const font = o.serif ? "F3" : (o.fett ? "F2" : "F1");
      let xx = x;
      if (o.rechts) xx = x - breite(str, !!o.fett, groesse) - (o.spatium ? o.spatium * String(str).length : 0);
      teile.push("BT /" + font + " " + f(groesse) + " Tf " +
                 (o.spatium ? f(o.spatium) + " Tc " : "0 Tc ") +
                 farbe(o.farbe || [18, 38, 72]) + " rg " +
                 f(xx) + " " + y(yy + groesse * 0.78) + " Td (" + kodieren(str).toString("latin1") + ") Tj ET");
    },
    /* Gefuellte Flaeche - fuer Linien (h = Strichstaerke) und Kaesten. */
    flaeche(x, yy, b, h, c) {
      teile.push(farbe(c) + " rg " + f(x) + " " + y(yy + h) + " " + f(b) + " " + f(h) + " re f");
    },
    /* JPEG einbetten und an x, y in Breite b setzen (Hoehe folgt). */
    bild(buf, x, yy, b) {
      const m = jpegMasse(buf);
      const h = b * m.h / m.b;
      const name = "Im" + (bilder.length + 1);
      bilder.push({ name, buf, b: m.b, h: m.h });
      teile.push("q " + f(b) + " 0 0 " + f(h) + " " + f(x) + " " + y(yy + h) + " cm /" + name + " Do Q");
      return h;
    },
    breite,
    /* Die fertige Datei. */
    bytes() {
      const inhalt = Buffer.from(teile.join("\n"), "latin1");
      const objekte = [];
      const add = s => { objekte.push(Buffer.isBuffer(s) ? s : Buffer.from(s, "latin1")); return objekte.length; };
      add("<< /Type /Catalog /Pages 2 0 R >>");
      add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
      const bildRefs = bilder.map((b, i) => "/" + b.name + " " + (8 + i) + " 0 R").join(" ");
      add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + f(A4.b) + " " + f(A4.h) + "] " +
          "/Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> /XObject << " + bildRefs + " >> >> " +
          "/Contents 4 0 R >>");
      add(Buffer.concat([Buffer.from("<< /Length " + inhalt.length + " >>\nstream\n", "latin1"), inhalt, Buffer.from("\nendstream", "latin1")]));
      add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
      add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
      add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>");
      for (const b of bilder) {
        add(Buffer.concat([
          Buffer.from("<< /Type /XObject /Subtype /Image /Width " + b.b + " /Height " + b.h +
                      " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + b.buf.length + " >>\nstream\n", "latin1"),
          b.buf, Buffer.from("\nendstream", "latin1")]));
      }
      const kopf = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1");
      const stuecke = [kopf]; const offsets = []; let pos = kopf.length;
      objekte.forEach((o, i) => {
        offsets.push(pos);
        const s = Buffer.concat([Buffer.from((i + 1) + " 0 obj\n", "latin1"), o, Buffer.from("\nendobj\n", "latin1")]);
        stuecke.push(s); pos += s.length;
      });
      const xref = ["xref", "0 " + (objekte.length + 1), "0000000000 65535 f "]
        .concat(offsets.map(o => String(o).padStart(10, "0") + " 00000 n "))
        .concat(["trailer", "<< /Size " + (objekte.length + 1) + " /Root 1 0 R >>", "startxref", String(pos), "%%EOF", ""]).join("\n");
      stuecke.push(Buffer.from(xref, "latin1"));
      return Buffer.concat(stuecke);
    }
  };
}

module.exports = { neuesPdf, breite, A4 };

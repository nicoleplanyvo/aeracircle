/* DIE APP, DIE AM STAND ENTSTEHT - und die dem Gast danach bleibt.
 *
 * Diese Datei ist der gemeinsame Kern von zwei Seiten:
 *   stand.html    Der Touchscreen am Stand. Das Telefon rechts zeigt die App.
 *   vorschau.html Dieselbe App, bildschirmfuellend auf dem Handy des Gastes,
 *                 unter einem Link, der ihm per Mail zugeht.
 *
 * Warum eine eigene Datei: Der Gast soll am Stand nicht eine Zeichnung sehen
 * und danach eine andere bekommen. Es ist dieselbe App - einmal im Rahmen
 * eines Telefons, einmal in echt.
 *
 * Drei Regeln, aus denen alles Uebrige folgt:
 *
 * 1. JEDER BAUSTEIN TUT ETWAS. Eine Kachel mit "Einlass mit QR" darauf
 *    verkauft nichts. Ein gruener Haken auf dem eigenen Namen schon. Jede
 *    Ansicht hier laesst sich antippen und antwortet.
 * 2. DIE EVENT-ART AENDERT DIE APP. Eine Gala braucht Tische und Gaenge,
 *    eine Konferenz Sessions und Raeume. Wer beim Typ etwas anderes waehlt
 *    und dieselbe App bekommt, glaubt zu Recht nicht, dass hier etwas
 *    Eigenes entsteht.
 * 3. NICHTS WIRD ERFUNDEN, WAS DER GAST NICHT GESAGT HAT. Name, Monat,
 *    Stadt, Gaestezahl, Ansprache, Farbe, Logo - alles kommt aus seinen
 *    Eingaben. Wo eine Ansicht Beispielinhalt braucht (Sessionnamen,
 *    Abfahrtszeiten), steht Beispielhaftes, das als solches lesbar ist.
 */
(function (global) {
"use strict";

/* ---------- Was es gibt ---------- */

const TYPEN = [
  { k:"dinner",    ico:"restaurant",     t:"Dinner & Gala",      s:"Tische, Gänge, Programm" },
  { k:"konferenz", ico:"mic",            t:"Konferenz",          s:"Sessions, Speaker, Räume" },
  { k:"kunden",    ico:"handshake",      t:"Kundenevent",        s:"Einladung mit Zusage" },
  { k:"launch",    ico:"rocket_launch",  t:"Produktlaunch",      s:"Presse, Partner, Live" },
  { k:"team",      ico:"celebration",    t:"Team- & Sommerfest", s:"Familie willkommen" },
  { k:"jubilaeum", ico:"cake",           t:"Jubiläum",           s:"Ein Abend, der bleibt" }
];

/* Der ganze Katalog. Die Reihenfolge hier ist die Reihenfolge in der App -
 * erst was vor dem Event passiert, dann der Abend selbst, dann danach. */
const BAUSTEINE = [
  { k:"savethedate", ico:"calendar_month",       t:"Save the Date",        s:"Wochen vorher, ein Klick in den Kalender" },
  { k:"einladung",   ico:"mail",                 t:"Einladung & Zusage",   s:"Persönlich, mit Frist und Erinnerung" },
  { k:"tickets",     ico:"credit_card",          t:"Tickets & Bezahlung",  s:"Stripe, Rechnung automatisch" },
  { k:"anmeldung",   ico:"how_to_reg",           t:"Anmeldung",            s:"Formular, Kontingent, Warteliste" },
  { k:"hotel",       ico:"hotel",                t:"Hotel & Anreise",      s:"Zimmerkontingent, Wegbeschreibung" },
  { k:"shuttle",     ico:"directions_bus",       t:"Shuttle & Parken",     s:"Abfahrten, Plätze, Erinnerung" },
  { k:"familie",     ico:"escalator_warning",    t:"Begleitung & Kinder",  s:"Wer kommt mit, wer wird betreut" },
  { k:"app",         ico:"phone_iphone",         t:"Event-App",            s:"Aufs Handy, ohne App-Store" },
  { k:"programm",    ico:"event_note",           t:"Programm",             s:"Ablauf mit Zeiten" },
  { k:"sessions",    ico:"view_agenda",          t:"Sessions & Tracks",    s:"Auswählen, merken, voll ist voll" },
  { k:"speaker",     ico:"record_voice_over",    t:"Speaker & Bühne",      s:"Wer spricht wann, worüber" },
  { k:"raeume",      ico:"meeting_room",         t:"Räume & Wegweiser",    s:"Wo bin ich, wo muss ich hin" },
  { k:"menue",       ico:"restaurant_menu",      t:"Menü & Wünsche",       s:"Gänge, Allergien, vegetarisch" },
  { k:"einlass",     ico:"qr_code_scanner",      t:"Einlass mit QR",       s:"Scanner in der App, Abhakliste" },
  { k:"tischplan",   ico:"table_restaurant",     t:"Tischplan & Rotation", s:"Wer sitzt wann bei wem" },
  { k:"netzwerk",    ico:"groups",               t:"Teilnehmer & Kontakte", s:"Sehen, wer da ist, Karte tauschen" },
  { k:"unterlagen",  ico:"description",          t:"Unterlagen & Folien",  s:"Alles zum Mitnehmen, an einer Stelle" },
  { k:"presse",      ico:"newspaper",            t:"Presse & Medien",      s:"Mappe, Sperrfrist, Bildmaterial" },
  { k:"livestream",  ico:"live_tv",              t:"Livestream",           s:"Für alle, die nicht im Raum sind" },
  { k:"push",        ico:"notifications_active", t:"Push-Nachrichten",     s:"„Der nächste Gang kommt“" },
  { k:"wand",        ico:"tv",                   t:"Live-Wand",            s:"Bühne, Abstimmung, Stimmung" },
  { k:"rueckblick",  ico:"history",              t:"Rückblick",            s:"Die Jahre davor, zum Durchblättern" },
  { k:"gaestebuch",  ico:"edit_note",            t:"Gästebuch",            s:"Ein Satz, der bleibt" },
  { k:"galerie",     ico:"photo_library",        t:"Fotogalerie",          s:"Gäste laden hoch, alle sehen" },
  { k:"feedback",    ico:"rate_review",          t:"Feedback",             s:"Ein Tippen am Ende des Abends" }
];
const NACH_K = {};
BAUSTEINE.forEach(b => { NACH_K[b.k] = b; });

/* Je Event-Art: welche Bausteine zur Auswahl stehen (neun - genau ein
 * Raster) und welche davon vorgeschlagen sind. Das ist der Unterschied
 * zwischen "wir haben Module" und "wir wissen, was ein Jubilaeum braucht".
 * Die Vorauswahl ist ein Vorschlag, kein Zwang: der Gast aendert sie in
 * Schritt 3 mit einem Fingertipp. */
const TYP_BAUSTEINE = {
  dinner:    { hat:["einladung","tickets","menue","tischplan","einlass","app","wand","galerie","feedback"],
               vor:["einladung","menue","tischplan","einlass","app"] },
  konferenz: { hat:["anmeldung","tickets","sessions","speaker","raeume","netzwerk","unterlagen","app","feedback"],
               vor:["anmeldung","sessions","speaker","app","netzwerk"] },
  kunden:    { hat:["savethedate","einladung","programm","einlass","tischplan","app","push","galerie","feedback"],
               vor:["einladung","programm","einlass","app"] },
  launch:    { hat:["savethedate","einladung","presse","livestream","programm","wand","app","galerie","push"],
               vor:["einladung","presse","livestream","app"] },
  team:      { hat:["einladung","familie","shuttle","menue","programm","app","wand","galerie","feedback"],
               vor:["einladung","familie","shuttle","app","galerie"] },
  jubilaeum: { hat:["savethedate","einladung","menue","tischplan","rueckblick","gaestebuch","app","galerie","feedback"],
               vor:["einladung","rueckblick","gaestebuch","tischplan","app"] }
};
/* Solange noch keine Art gewaehlt ist (Startbild, alte Entwuerfe). */
const STANDARD = { hat:["savethedate","einladung","tickets","programm","app","einlass","tischplan","galerie","feedback"],
                   vor:["einladung","app","einlass"] };
function typBausteine(typ){ return TYP_BAUSTEINE[typ] || STANDARD; }

/* Schriften. Keine Downloads: Ein Stand haengt am Messe-WLAN, und eine
 * Schrift, die nicht ankommt, macht aus der Vorfuehrung eine Systemschrift
 * in Grau. Manrope liegt auf unserem Server, die uebrigen sind auf jedem
 * Geraet da. Benannt nach ihrer Wirkung, nicht nach ihrem Namen - "Georgia"
 * sagt einem Gast am Stand nichts, "Klassisch" schon. */
const SCHRIFTEN = [
  { k:"modern",    t:"Modern",    s:"klar, freundlich",    css:'"Manrope","Avenir Next",system-ui,sans-serif', sp:"-.02em", w:"800" },
  { k:"klassisch", t:"Klassisch", s:"Serifen, Abend",      css:'Georgia,"Times New Roman",serif',              sp:"-.01em", w:"700" },
  { k:"sachlich",  t:"Sachlich",  s:"nüchtern, Konferenz", css:'"Helvetica Neue",Helvetica,Arial,sans-serif',  sp:"-.02em", w:"700" },
  /* Kein Monospace mehr an dieser Stelle: "Technisch" klang nach Launch,
   * sah auf dem Handy aber aus wie ein Terminalfenster - Fliesstext in
   * Schreibmaschine liest sich billig, egal wie gut die Marke ist. */
  { k:"weich",     t:"Weich",     s:"rund, persönlich",    css:'"Avenir Next","Segoe UI",system-ui,-apple-system,sans-serif', sp:"-.01em", w:"700" }
];
const NACH_SCHRIFT = {};
SCHRIFTEN.forEach(s => { NACH_SCHRIFT[s.k] = s; });

/* Buehnenbilder ohne Bilddatei: Verlaeufe, die zur gewaehlten Farbe passen.
 * Sie sind der Rueckfall, wenn auf der Website des Gastes nichts Brauchbares
 * steht - und sie laden immer, auch wenn das WLAN steht. Echte Fotos kommen
 * von seiner eigenen Seite; die sind ohnehin die besseren. */
const STIMMUNGEN = [
  { k:"farbe", t:"Deine Farbe", css:(c) => "radial-gradient(120% 80% at 85% 0%,rgba(255,255,255,.22),rgba(255,255,255,0) 60%),linear-gradient(150deg," + c + " 0%,color-mix(in srgb," + c + " 62%,#ffb347) 100%)" },
  { k:"nacht", t:"Nacht",       css:(c) => "linear-gradient(155deg,#1b1410 0%," + c + " 120%)" },
  { k:"sand",  t:"Sand",        css:(c) => "linear-gradient(150deg,color-mix(in srgb," + c + " 35%,#f5e3cf) 0%,color-mix(in srgb," + c + " 85%,#c98b5a) 100%)" },
  { k:"tiefe", t:"Tiefe",       css:(c) => "radial-gradient(100% 120% at 10% 110%,color-mix(in srgb," + c + " 70%,#ffffff) 0%,rgba(0,0,0,0) 55%),linear-gradient(160deg," + c + " 0%,#2b2118 130%)" }
];
const NACH_STIMMUNG = {};
STIMMUNGEN.forEach(s => { NACH_STIMMUNG[s.k] = s; });

const FARBEN = [
  { k:"terracotta", c:"#c15c42", t:"Terracotta" }, { k:"honey", c:"#e2a45f", t:"Honig" }, { k:"navy", c:"#122648", t:"Nachtblau" },
  { k:"olive", c:"#6e8f4b", t:"Olive" }, { k:"coral", c:"#f28c7c", t:"Koralle" }, { k:"darkbrown", c:"#3a2e2a", t:"Espresso" }
];
const MONATE = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];

/* ---------- Kleinkram ---------- */

function esc(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c])); }
function farbeVon(E){ return E.farbe === "ci" && E.ciFarbe ? E.ciFarbe : ((FARBEN.find(f => f.k === E.farbe) || FARBEN[0]).c); }
function duSie(E, du, sie){ return E.ton === "sie" ? sie : du; }
function evName(E){ const t = TYPEN.find(x => x.k === E.typ); return (E.name || "").trim() || (t ? t.t : "Dein Event"); }
function evWann(E){ return MONATE[E.monat] + " " + E.jahr; }
function gewaehlt(E){ return BAUSTEINE.filter(b => (E.bausteine || []).indexOf(b.k) >= 0); }

/* Ein Knopf, der sich merkt, dass er gedrueckt wurde. Mehr Zustand braucht
 * eine Vorschau nicht - und weniger waere wieder nur ein Bild. */
function taste(PH, k, ico, vorher, nachher){
  const an = PH[k];
  return '<button class="pbtn' + (an ? " fertig" : "") + '" data-tap="akt:' + k + '">' +
         '<span class="ms">' + (an ? "check" : ico) + '</span>' + esc(an ? nachher : vorher) + '</button>';
}
function zeile(ico, fett, klein){
  return '<div class="pz"><span class="ms">' + ico + '</span><span class="tx"><b>' + esc(fett) + '</b>' +
         (klein ? '<small>' + esc(klein) + '</small>' : "") + '</span></div>';
}
function karte(kicker, titel, sub){
  return '<div class="pk"><div class="pk-k">' + esc(kicker) + '</div><div class="pk-t">' + esc(titel) + '</div>' +
         (sub ? '<div class="pk-s">' + esc(sub) + '</div>' : "") + '</div>';
}
function gruen(titel, klein){
  return '<div class="pgruen"><span class="ms">check_circle</span>' + esc(titel) +
         (klein ? '<small>' + esc(klein) + '</small>' : "") + '</div>';
}
function note(t){ return '<div class="pnote">' + esc(t) + '</div>'; }

/* ---------- Die Ansichten ----------
 * Jede gibt [Titel, HTML] zurueck. Der Inhalt haengt an E (was der Gast
 * gesagt hat) und PH (was er in der Vorschau schon angetippt hat). */
const ANSICHTEN = {

  savethedate: (E, PH) =>
    ["Save the Date",
     karte(evWann(E), evName(E), E.stadt + " · " + E.gaeste + " Gäste") +
     taste(PH, "kalender", "event_available", duSie(E, "In deinen Kalender", "In Ihren Kalender"), "Im Kalender gespeichert") +
     note("Ein Druck, und der Termin steht im Kalender – mit Ort, Uhrzeit und dem Link zur App. Kein Anhang, der niemanden erreicht.")],

  einladung: (E, PH) =>
    ["Einladung",
     karte((E.wer || "").trim() || "Persönliche Einladung", evName(E), evWann(E) + " · " + E.stadt) +
     (PH.zusage === 1 ? gruen(duSie(E, "Du bist dabei", "Sie sind dabei"), duSie(E, "Dein Platz ist reserviert.", "Ihr Platz ist reserviert."))
      : PH.zusage === 2 ? karte("Abgesagt", duSie(E, "Schade.", "Schade."), duSie(E, "Bis zur Frist kannst du es ändern.", "Bis zur Frist können Sie es ändern."))
      : '<div class="pzeile"><button class="pbtn" data-tap="akt:ja"><span class="ms">check</span>' + duSie(E, "Ich komme", "Ich komme") + '</button>' +
        '<button class="pbtn zweit" data-tap="akt:nein">Absagen</button></div>') +
     note("Jeder Gast bekommt seinen eigenen Link. Die Zusage steht in derselben Sekunde in deiner Liste – niemand sammelt Mails ab.")],

  anmeldung: (E, PH) =>
    ["Anmeldung",
     karte(evWann(E) + " · " + E.stadt, evName(E), E.gaeste + " Plätze · noch offen") +
     (PH.zusage === 1 ? gruen("Angemeldet", "Bestätigung ist unterwegs.")
      : '<div class="pliste">' + zeile("badge", "Name und Firma", "einmal eintragen") + zeile("restaurant", "Verpflegung", "vegetarisch / vegan / alles") + '</div>' +
        '<button class="pbtn" data-tap="akt:ja"><span class="ms">how_to_reg</span>Anmeldung abschicken</button>') +
     note("Ist das Kontingent voll, rückt die Warteliste von allein nach. Niemand muss eine Tabelle pflegen.")],

  tickets: (E, PH) =>
    ["Ticket",
     karte("Dein Ticket", evName(E), "1 Platz · " + (E.gaeste > 200 ? "49,00 €" : "100,00 €")) +
     (PH.bezahlt ? gruen("Bezahlt", "Rechnung mit fortlaufender Nummer ist unterwegs.")
                 : '<button class="pbtn" data-tap="akt:bezahlt"><span class="ms">credit_card</span>Jetzt bezahlen</button>') +
     note("Kartenzahlung über Stripe, Rechnung automatisch per Mail. Wer nicht kommt, gibt den Platz frei – der Nächste rückt nach.")],

  hotel: (E, PH) =>
    ["Hotel & Anreise",
     '<div class="pliste">' + zeile("hotel", "Partnerhotel · " + E.stadt, "Kontingent bis 6 Wochen vorher") +
                              zeile("directions_walk", "5 Minuten zu Fuß", "Weg in der App, auch offline") + '</div>' +
     taste(PH, "zimmer", "bookmark_add", "Zimmer vormerken", "Zimmer vorgemerkt") +
     note("Kontingent, Weg und Anreise stehen in der App – nicht in einer PDF, die im Anhang verloren geht.")],

  shuttle: (E, PH) =>
    ["Shuttle & Parken",
     '<div class="pliste">' + zeile("directions_bus", "17:30 · " + E.stadt + " Hbf", "Abfahrt am Haupteingang") +
                              zeile("directions_bus", "18:15 · Parkplatz West", "Zubringer alle 15 Minuten") +
                              zeile("local_parking", "Parken", "Stellplätze reserviert") + '</div>' +
     taste(PH, "shuttle", "event_seat", "Platz im Shuttle sichern", "Platz gesichert") +
     note("Verschiebt sich eine Abfahrt, bekommen genau die Gäste eine Nachricht, die sie gebucht haben.")],

  familie: (E, PH) =>
    ["Begleitung & Kinder",
     karte("Für " + duSie(E, "dich", "Sie") + " reserviert", "1 Platz", evName(E)) +
     (PH.begleitung ? gruen("Begleitung angemeldet", "Wir planen mit einem Platz mehr.")
      : '<div class="pzeile"><button class="pbtn" data-tap="akt:begleitung"><span class="ms">person_add</span>+1</button>' +
        '<button class="pbtn zweit" data-tap="akt:kinder">Kinder</button></div>') +
     (PH.kinder ? '<div class="pliste">' + zeile("child_care", "Betreuung angemeldet", "14:00 – 20:00 Uhr, eigener Raum") + '</div>' : "") +
     note("Wer wen mitbringt, steht in der Planung – und die Küche weiß es rechtzeitig.")],

  app: (E) =>
    ["Deine App",
     '<div class="pliste">' + (gewaehlt(E).length
        ? gewaehlt(E).slice(0, 5).map(b => zeile(b.ico, b.t, b.s)).join("")
        : zeile("add_circle", "Noch nichts gewählt", "links antippen")) + '</div>' +
     note("Ohne App-Store: Der Gast öffnet seinen Link, legt ihn auf den Startbildschirm – fertig. In deinen Farben, mit deinem Logo.")],

  programm: (E) => {
    const p = E.typ === "konferenz" ? [["09:00","Ankommen","Registrierung & Kaffee"],["10:00","Eröffnung","Bühne 1"],["12:30","Mittag","Foyer"],["16:00","Abschluss","Bühne 1"]]
            : E.typ === "launch"    ? [["17:00","Doors","Empfang"],["18:00","Die Premiere","Bühne"],["18:45","Hands-on","Stationen"],["20:00","Get-together","Bar"]]
            : E.typ === "team"      ? [["14:00","Start","Ankommen & Spiele"],["16:00","Für die Kinder","Eigener Bereich"],["18:00","Grillen","Terrasse"],["21:00","Musik","Bis open end"]]
            :                         [["18:00","Ankommen","Empfang & Musik"],["19:00","Begrüßung","Bühne"],["20:00","Dinner","Drei Gänge"],["22:00","Danach","Musik & Bar"]];
    return ["Programm",
      '<div class="pliste">' + p.map(z => '<div class="pz"><span class="puhr">' + z[0] + '</span><span class="tx"><b>' + esc(z[1]) + '</b><small>' + esc(z[2]) + '</small></span></div>').join("") + '</div>' +
      note("Verschiebt sich etwas, verschiebt es sich hier – bei allen Gästen gleichzeitig, ohne neue Mail.")];
  },

  sessions: (E, PH) =>
    ["Sessions",
     '<div class="pliste">' +
       ['<div class="pz' + (PH.session === 1 ? " an" : "") + '" data-tap="akt:session1"><span class="puhr">10:30</span><span class="tx"><b>Track A · Praxis</b><small>' + (PH.session === 1 ? "gemerkt · Platz sicher" : "noch 12 Plätze") + '</small></span></div>',
        '<div class="pz' + (PH.session === 2 ? " an" : "") + '" data-tap="akt:session2"><span class="puhr">10:30</span><span class="tx"><b>Track B · Werkstatt</b><small>' + (PH.session === 2 ? "gemerkt · Platz sicher" : "noch 4 Plätze") + '</small></span></div>',
        '<div class="pz voll"><span class="puhr">13:00</span><span class="tx"><b>Track C · Deep Dive</b><small>ausgebucht</small></span></div>'].join("") +
     '</div>' +
     note("Antippen reserviert den Platz. Ist eine Session voll, sieht das jeder sofort – und niemand steht vor einem vollen Raum.")],

  speaker: (E, PH) =>
    ["Speaker",
     '<div class="pliste">' +
       zeile("record_voice_over", "Eröffnungsvortrag", "10:00 · Bühne 1") +
       zeile("forum", "Panel", "14:00 · Bühne 2") +
       zeile("mic", "Abschluss", "16:00 · Bühne 1") + '</div>' +
     taste(PH, "frage", "help", "Frage an die Bühne", "Frage ist eingereicht") +
     note("Fragen aus dem Publikum laufen in der App auf, die Moderation sortiert sie – statt Zetteln und Handzeichen.")],

  raeume: (E, PH) =>
    ["Räume",
     '<div class="pliste">' + zeile("meeting_room", "Bühne 1 · Erdgeschoss", "400 Plätze") +
                              zeile("meeting_room", "Werkstatt · 1. OG", "40 Plätze") +
                              zeile("restaurant", "Foyer", "Catering & Aussteller") + '</div>' +
     taste(PH, "weg", "navigation", "Weg zu Bühne 1", "Wegbeschreibung offen") +
     note("Der Plan liegt offline in der App. Im Keller ohne Empfang findet trotzdem jeder den Raum.")],

  menue: (E, PH) => {
    const wahl = PH.menue;
    const k = (n, t, s) => '<div class="pz' + (wahl === n ? " an" : "") + '" data-tap="akt:menue' + n + '"><span class="ms">' +
      (n === 1 ? "restaurant" : n === 2 ? "eco" : "spa") + '</span><span class="tx"><b>' + t + '</b><small>' + s + '</small></span></div>';
    return ["Menü",
      '<div class="pliste">' + k(1, "Alles", "drei Gänge, klassisch") + k(2, "Vegetarisch", "drei Gänge") + k(3, "Vegan", "drei Gänge") + '</div>' +
      (wahl ? gruen("Notiert", "Die Küche plant mit " + E.gaeste + " Gästen – und mit deiner Wahl.") : note("Antippen – der Wunsch steht sofort in der Küchenliste.")) +
      (wahl ? note("Allergien trägt der Gast im Profil ein, einmal, für alle Veranstaltungen.") : "")];
  },

  einlass: (E, PH) =>
    ["Einlass",
     (PH.scan
       ? gruen("Willkommen!", evName(E) + ((E.bausteine || []).indexOf("tischplan") >= 0 ? " · Tisch 4" : ""))
       : '<div class="pqr"><img src="/qr-text.png?t=' + encodeURIComponent("https://www.planyvo.com/") + '" alt=""></div>' +
         '<button class="pbtn" data-tap="akt:scan"><span class="ms">qr_code_scanner</span>Code scannen</button>') +
     note("Am Eingang steht ein Handy, kein Laptop. Grün heißt willkommen, orange heißt nachfragen – und die Liste stimmt in Echtzeit.")],

  tischplan: (E, PH) => {
    const n = Math.max(4, Math.min(9, Math.round(E.gaeste / 10) || 6));
    let t = "";
    for (let i = 1; i <= n; i++) t += '<div class="ptisch' + (i === 4 ? " dein" : "") + '">' + (i === 4 ? duSie(E, "Dein Tisch", "Ihr Tisch") : "Tisch " + i) + '</div>';
    return ["Tischplan",
      '<div class="ptische">' + t + '</div>' +
      taste(PH, "tisch", "person_search", duSie(E, "Wer sitzt bei dir?", "Wer sitzt bei Ihnen?"), "Tisch 4 · 8 Plätze") +
      note(E.typ === "jubilaeum" ? "Nach jedem Gang rotiert, wer will – so redet nicht jeder nur mit seinem Nachbarn."
                                 : "Wer neben wem sitzt, planst du per Drag & Drop. Der Gast sieht nur seinen Platz.")];
  },

  netzwerk: (E, PH) =>
    ["Teilnehmer",
     '<div class="pliste">' + zeile("groups", E.gaeste + " angemeldet", "Profile mit Firma und Thema") +
                              zeile("interests", "3 Vorschläge für " + duSie(E, "dich", "Sie"), "gleiches Thema, anderer Blick") + '</div>' +
     taste(PH, "kontakt", "share", "Kontakt teilen", "Karte ist geteilt") +
     note("Kein Zettelstapel: Zwei Gäste tippen sich an, beide haben die Kontaktdaten – auch am Tag danach noch.")],

  unterlagen: (E, PH) =>
    ["Unterlagen",
     '<div class="pliste">' + zeile("picture_as_pdf", "Folien Eröffnung", "PDF · 2,4 MB") +
                              zeile("picture_as_pdf", "Handout Werkstatt", "PDF · 800 KB") +
                              zeile("link", "Weiterführende Links", "4 Einträge") + '</div>' +
     taste(PH, "unterlagen", "download", "Alles mitnehmen", "Liegt im Download-Ordner") +
     note("Nach dem Event bleibt die App stehen – die Unterlagen auch. Niemand sucht sie in alten Mails.")],

  presse: (E, PH) =>
    ["Presse",
     karte("Sperrfrist", evWann(E) + ", 11:00 Uhr", evName(E)) +
     '<div class="pliste">' + zeile("newspaper", "Pressemitteilung", "DE / EN") +
                              zeile("image", "Bildmaterial", "12 Motive, druckfähig") + '</div>' +
     taste(PH, "presse", "lock_open", "Mappe anfordern", "Zugang ist unterwegs") +
     note("Jeder Journalist bekommt seinen eigenen Zugang. Wer wann heruntergeladen hat, steht in der Auswertung.")],

  livestream: (E, PH) =>
    ["Livestream",
     (PH.stream
       ? '<div class="pstream an"><span class="ms">play_circle</span><b>Wir sind live</b><small>' + esc(E.gaeste) + ' im Raum · 1.240 zusehend</small></div>'
       : '<div class="pstream"><span class="ms">live_tv</span><b>Beginnt ' + esc(evWann(E)) + '</b><small>ohne Anmeldung zusehen</small></div>' +
         '<button class="pbtn" data-tap="akt:stream"><span class="ms">play_arrow</span>Stream starten</button>') +
     note("Derselbe Link für Saal und Zuhause. Wer nicht kommen kann, ist trotzdem dabei – und zählt in derselben Statistik.")],

  push: (E, PH) =>
    ["Nachrichten",
     karte("An alle Gäste", "„Es geht gleich los“", E.gaeste + " Empfänger · sofort") +
     taste(PH, "push", "send", "Nachricht senden", "Zugestellt an " + E.gaeste + " Gäste") +
     note("Läuft das Programm 20 Minuten später, wissen es alle in 20 Sekunden – ohne dass jemand durch den Saal ruft.")],

  wand: (E, PH) =>
    ["Live-Wand",
     '<div class="pzahl">' + (82 + (PH.applaus || 0) * 7) + '</div>' +
     '<div class="pmitte">Applaus im Saal</div>' +
     '<button class="pbtn" data-tap="akt:applaus"><span class="ms">celebration</span>' + duSie(E, "Klatschen", "Applaudieren") + '</button>' +
     note("Auf der Leinwand zählt es live mit. Abstimmungen, Auktion und Stimmung laufen über dieselbe Wand.")],

  rueckblick: (E, PH) =>
    ["Rückblick",
     '<div class="pliste">' +
       ['<div class="pz"><span class="puhr">' + (E.jahr - 25) + '</span><span class="tx"><b>Der Anfang</b><small>zwei Leute, ein Raum</small></span></div>',
        '<div class="pz"><span class="puhr">' + (E.jahr - 10) + '</span><span class="tx"><b>Der Umzug</b><small>und der erste große Auftrag</small></span></div>',
        '<div class="pz an"><span class="puhr">' + E.jahr + '</span><span class="tx"><b>' + esc(evName(E)) + '</b><small>' + esc(E.gaeste + " Gäste in " + E.stadt) + '</small></span></div>'].join("") + '</div>' +
     taste(PH, "rueck", "add_a_photo", "Eigenes Bild beisteuern", "Danke – liegt in der Auswahl") +
     note("Die Gäste füllen den Zeitstrahl selbst. Was dabei zusammenkommt, hat noch niemand im Archiv.")],

  gaestebuch: (E, PH) =>
    ["Gästebuch",
     (PH.eintrag
       ? gruen("Eingetragen", duSie(E, "Dein Satz steht im Buch.", "Ihr Satz steht im Buch."))
       : '<div class="pk"><div class="pk-k">' + esc(duSie(E, "Dein Eintrag", "Ihr Eintrag")) + '</div><div class="pschreib">Ein Satz, der bleiben soll …</div></div>' +
         '<button class="pbtn" data-tap="akt:eintrag"><span class="ms">edit_note</span>Eintragen</button>') +
     '<div class="pliste">' + zeile("format_quote", "„Auf die nächsten 25.“", "vor 2 Minuten") + '</div>' +
     note("Am Ende des Abends steht ein Buch da, das niemand herumreichen musste – und das man drucken kann.")],

  galerie: (E, PH) =>
    ["Fotos",
     '<div class="pgal">' + "<i></i>".repeat(9) + '</div>' +
     taste(PH, "upload", "add_a_photo", "Foto hochladen", "Hochgeladen · wartet auf Freigabe") +
     note("Gäste laden hoch, du gibst frei. Am nächsten Morgen liegt alles beisammen statt in 80 Kameras.")],

  feedback: (E, PH) =>
    ["Feedback",
     '<div class="psterne">' + [1,2,3,4,5].map(n =>
        '<span class="ms' + (n <= (PH.sterne || 0) ? " an" : "") + '" data-tap="akt:stern' + n + '">star</span>').join("") + '</div>' +
     (PH.sterne ? '<div class="pmitte">Danke! ' + PH.sterne + ' von 5.</div>' + note("Die Auswertung steht am nächsten Morgen bereit – nach Tischen, Sessions und Uhrzeit getrennt.")
                : '<div class="pmitte">' + duSie(E, "Wie war dein Abend?", "Wie war Ihr Abend?") + '</div>' +
                  note("Eine Frage, ein Tippen. Deshalb antworten hier 60 Prozent statt der üblichen 8.")) ],

  profil: (E, PH) =>
    ["Profil",
     karte(duSie(E, "Dein Profil", "Ihr Profil"), (E.kontaktName || "").trim() || duSie(E, "Dein Name", "Ihr Name"), (E.firma || "").trim() || "Firma") +
     '<div class="pliste">' + zeile("qr_code", "Dein Einlasscode", "liegt schon bereit") +
                              zeile("badge", "Sichtbar für andere Gäste", "Name und Firma") + '</div>' +
     note("Einmal ausgefüllt, gilt für jede Veranstaltung. Der Gast pflegt seine Daten selbst – das spart dir die Nachfragen.")]
};

/* ---------- Zeichnen ---------- */

/* Der Startbildschirm der App: Kopf mit Marke, Gruss, Kacheln. Die Kacheln
 * sind keine Zierde - jede fuehrt in ihren Baustein. */
/* Der Kopf der App: Buehnenbild oder Verlauf, darauf Logo und Titel.
 * Steht ein Bild dahinter, legt sich ein dunkler Schleier darueber - sonst
 * ist weisse Schrift auf einem hellen Foto unlesbar, und genau das ist der
 * Unterschied zwischen "sieht gebaut aus" und "sieht gebastelt aus". */
/* Eine Bildadresse in ein style-Attribut zu schreiben ist heikler, als es
 * aussieht: Anfuehrungszeichen beenden das Attribut, Klammern die url().
 * Die Adresse kommt von einer fremden Website - also alles, was beides
 * kann, prozentkodieren und die url() ohne Anfuehrungszeichen lassen.
 * (Der erste Versuch stand mit " in url(...) da und liess den Kopf grau.) */
function cssUrl(u){
  return "url(" + String(u == null ? "" : u).replace(/['"()\\\s<>]/g,
    c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")) + ")";
}
function heroStil(E){
  const c = farbeVon(E);
  if (E.bild) return "background-image:linear-gradient(180deg,rgba(20,14,11,.30) 0%,rgba(20,14,11,.74) 100%)," +
                     cssUrl(E.bild) + ";background-size:cover;background-position:center";
  const st = NACH_STIMMUNG[E.stimmung] || STIMMUNGEN[0];
  return "background-image:" + st.css(c);
}
function homeHtml(E){
  const anrede = duSie(E, "Schön, dass du dabei bist.", "Wir freuen uns auf Sie.");
  const gs = gewaehlt(E);
  const kacheln = gs.length
    ? gs.map((b, i) => '<div class="kachel' + (i === 0 ? " gross" : "") + '" data-tap="view:' + b.k + '">' +
        '<span class="ms">' + b.ico + '</span>' + esc(b.t) + '</div>').join("")
    : '<div class="leer">Noch keine Bausteine – wähle links aus, und die App füllt sich.</div>';
  /* Freigestellt oder auf weisser Karte: Ein PNG oder SVG mit durchsichtigem
     Grund steht direkt auf der Flaeche - so, wie es der Markenauftritt
     vorsieht. Ein JPEG hat immer einen Kasten; der bekommt seine weisse
     Karte, sonst klebt ein weisses Rechteck mitten im Bild. Faellt das Bild
     aus, verschwindet nur die Stelle. */
  const logo = E.ciLogo
    ? '<div class="mlogo' + (E.logoFrei ? " frei" : "") + '"><img src="' + esc(E.ciLogo) + '" alt="" onerror="this.parentNode.style.display=\'none\'"></div>'
    : "";
  return '<div class="hero" style="' + heroStil(E) + '">' + logo +
    '<div class="marke">' + esc((E.wer || "").trim() || "Einladung") + '</div>' +
    '<div class="titel">' + esc(evName(E)) + '</div>' +
    '<div class="wann"><span class="ms">calendar_month</span>' + esc(evWann(E) + " · " + E.stadt) + '</div>' +
    '<div class="wann"><span class="ms">group</span>' + esc(E.gaeste) + ' Gäste</div></div>' +
    '<div class="gruss"><span class="ms">waving_hand</span>' + esc(anrede) + '</div>' +
    '<div class="kacheln">' + kacheln + '</div>' +
    /* Ein Abschluss unter den Kacheln - sonst steht auf einem hohen Schirm
       eine leere Flaeche zwischen Kacheln und Fussleiste, und die App sieht
       aus, als fehlte noch etwas. */
    (gs.length ? '<div class="homefuss"><span class="ms">touch_app</span>' +
       esc(duSie(E, "Tipp eine Kachel an – jeder Baustein läuft.", "Tippen Sie eine Kachel an – jeder Baustein läuft.")) + '</div>' : "");
}

/* Die Fussleiste. Immer dieselben vier - so wie in einer App, die man
 * kennt. Sie fuehren auch in Bausteine, die nicht gewaehlt sind; dann sagt
 * die Ansicht das (siehe unten), statt so zu tun, als gaebe es sie nicht.
 * Mit Beschriftung: Vier nackte Symbole sind ein Raetsel, und am Stand
 * steht niemand daneben, der es aufloest. qr_code_2 statt qr_code - das
 * gepunktete Eck des ersten sieht klein gerendert aus wie ein Fehler. */
const TABS = [["home","home","Start"],["programm","event_note","Programm"],
              ["einlass","qr_code_2","Einlass"],["profil","person","Profil"]];

/* Der Startbildschirm gehoert in einen BLAETTERBAREN Bereich. Ohne den
 * drueckt das Fussleisten-Layout alles darueber zusammen, sobald die
 * Kacheln nicht mehr auf den Schirm passen: Der Kopf verliert sein unteres
 * Polster, "80 Gaeste" klebt an der Kante, und es sieht aus wie
 * abgeschnitten - auf einem Handy mit Adressleiste schon bei fuenf
 * Bausteinen. Nicht die Hoehe war das Problem, sondern dass nichts
 * nachgeben durfte ausser dem Inhalt. */
function inhaltHtml(E, PH){
  if (PH.view === "home") return '<div class="blaettern">' + homeHtml(E) + '</div>';
  const f = ANSICHTEN[PH.view];
  if (!f) { PH.view = "home"; return '<div class="blaettern">' + homeHtml(E) + '</div>'; }
  const r = f(E, PH);
  const fehlt = NACH_K[PH.view] && (E.bausteine || []).indexOf(PH.view) < 0;
  return '<div class="pbar"><span class="ms" data-tap="view:home">arrow_back</span>' + esc(r[0]) + '</div>' +
         '<div class="inhalt">' + r[1] +
         (fehlt ? '<div class="pnote fehlt"><span class="ms">add_circle</span>Noch nicht gewählt – ein Tipp links, und der Baustein gehört dazu.</div>' : "") +
         '</div>';
}

/* Malt die App in jedes Ziel. Nur bei Aenderung, sonst flackert das Logo
 * bei jedem Tastendruck neu. */
function zeichne(ziele, E, PH){
  const html = inhaltHtml(E, PH) +
    '<div class="tab">' + TABS.map(t =>
      '<span class="tabknopf' + (PH.view === t[0] ? " an" : "") + '" data-tap="view:' + t[0] + '">' +
      '<i class="ms">' + t[1] + '</i><em>' + esc(t[2]) + '</em></span>').join("") +
    '<u class="griff"></u></div>';
  ziele.forEach(z => { if (z.dataset.html !== html) { z.innerHTML = html; z.dataset.html = html; } });
}

/* Ein Fingertipp in der App. Gibt zurueck, ob sich etwas geaendert hat. */
function tippen(ziel, E, PH){
  const z = ziel.closest ? ziel.closest("[data-tap]") : null;
  if (!z) return false;
  const teil = z.dataset.tap.split(":"), art = teil[0], wert = teil[1];
  if (art === "view") { PH.view = wert; return true; }
  if (art !== "akt") return false;
  if (wert === "ja") PH.zusage = 1;
  else if (wert === "nein") PH.zusage = 2;
  else if (wert === "applaus") PH.applaus = (PH.applaus || 0) + 1;
  else if (wert.indexOf("stern") === 0) PH.sterne = parseInt(wert.slice(5), 10);
  else if (wert.indexOf("menue") === 0) PH.menue = parseInt(wert.slice(5), 10);
  else if (wert.indexOf("session") === 0) PH.session = parseInt(wert.slice(7), 10);
  else PH[wert] = 1;
  return true;
}

function frisch(){ return { view:"home" }; }

/* Farbe und Schrift setzt der Aufrufer auf das Element, in dem die App
 * steht - so gilt beides fuer den Rahmen am Stand wie fuer die ganze Seite
 * der Vorschau, ohne dass eine der beiden Seiten das noch einmal weiss. */
function stilSetzen(el, E){
  const s = NACH_SCHRIFT[E.schrift] || SCHRIFTEN[0];
  el.style.setProperty("--accent", farbeVon(E));
  el.style.setProperty("--appfont", s.css);
  el.style.setProperty("--appsperr", s.sp);
  el.style.setProperty("--appfett", s.w);
}

global.PV = { TYPEN, BAUSTEINE, NACH_K, FARBEN, MONATE, SCHRIFTEN, NACH_SCHRIFT, STIMMUNGEN, NACH_STIMMUNG,
              TYP_BAUSTEINE, typBausteine, ANSICHTEN, esc, farbeVon, duSie, evName, evWann, gewaehlt,
              zeichne, tippen, frisch, homeHtml, heroStil, stilSetzen };

})(window);

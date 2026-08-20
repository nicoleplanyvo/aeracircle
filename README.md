# THE CIRCLE · Teilnehmer-App

Die digitale Begleiterin für **THE CIRCLE – connecting generations**
(THE CIRCLE N°1 · 16. September 2026 · 18:00–23:00 Uhr · Playa Cologne): eine
mobile Web-App für die Gäste des Abends – im **offiziellen CI von
the-circle-cologne.de**: Trajan-Kapitalis für Headlines (im Web als
eingebettetes Cinzel, Fallback Trajan Pro 3/Georgia), Montserrat als
Grundschrift, das offizielle Spiral-Logo (horizontal, negativ), Pill-Buttons –
und die Farbwelten der Website: Navy `#122648` als Grund, Koralle `#ff6b6c`
für Headlines/Akzente, Bordeaux `#741a33` für die Einladung, Sand `#d8d3c3`
mit dunklem Bordeaux für das Menü, Blau `#13a4ef` für Info-Pills. Wie auf der
Website gibt es keine kursiven Serifen – nur Trajan-Kapitalis und Montserrat.
Dazu das Tusche-Enso (Canvas-gerendert).

> **CI-Quelle:** Homepage + Logo kamen von Anne Schäfer (IMW); die exakten
> Regeln stehen im Minimanual – Feinheiten (z. B. weitere Farbpaarungen,
> Logo-Schutzraum) bitte damit abgleichen. Trajan Pro 3 ist eine
> Adobe-Fonts-Lizenz und kann nicht eingebettet werden; Cinzel ist das freie
> Äquivalent im gleichen Kapitalis-Duktus.

## Das Konzept: „Schließe deinen Kreis“

Die Marke wird zur Mechanik. Jeder Gast sammelt über den Abend **sechs Momente**,
die einen goldenen Ring um sein Profil füllen:

| Moment | Wie er gesammelt wird |
|---|---|
| Angekommen | Check-in auf der Startseite |
| Impuls | Beim Impuls-Vortrag im Programm |
| Applaus | 5× Applaus beim Start-Up-Pitch |
| Erkenntnis | Nach den Mentor-Minuten |
| Kunst | Beim Live Painting / der Versteigerung |
| Verbindung | Beim Teilen der eigenen Karte |

Der Ring ist ein **Enso** – ein Tusche-Kreis, der pro Moment ein gemaltes
Segment bekommt. Ist der Kreis geschlossen, wird er zu einem durchgehenden
Schwung gemalt.

## Features

- **Heute Abend** – persönliche Begrüßung, live tickender Countdown (Tage/Std/Min/Sek), Editorial-Laufband, „Der Abend in Zahlen“ mit Count-up, „Als Nächstes“-Karte, Kreis-Fortschritt, „Gut zu wissen“ (Einlass, Ort mit Routen-Link, Dresscode, Foto-Hinweis)
- **Programm** – Timeline des Abends mit Live-Indikator (Empfang → Vortrag → Pitch → Mentor-Minuten → Live Painting → DJ)
- **Menü** – das bewegte 3-Gang-Menü, elegant gesetzt (Beispielinhalte)
- **Live** – Applaus-Meter für den Start-Up-Pitch (mit Haptik und Tusche-Spritzern), **Pitch-Votum** („Würdest du investieren?“), digitale **Bieterkarte** mit persönlicher Nummer und **Schätzspiel** zum Erlös der Live-Painting-Versteigerung (Max Leinfelder, Erlös wird gespendet)
- **Connect** – digitale Visitenkarte zum Teilen (Web Share / Zwischenablage), **Impuls-Karten** (Fragen, die Generationen ins Gespräch bringen), **Circle-Bingo** (3×3-Icebreaker: „Finde im Raum …“, volle Reihe = Bingo + Moment), **Mein Kreis** (Begegnungen des Abends festhalten), **Erkenntnis-Notiz** mit Autosave und **„Meinen Abend teilen“** (Recap aus Momenten, Applaus, Verbindungen, Bingo und Notiz)
- **Swipe-Navigation** – zwischen den Bereichen wischen wie in einer nativen App

**Motion:** Scroll-Reveals mit Stagger auf allen Blöcken, Parallax auf der
Skyline, seitlich driftende Geister-Uhrzeiten in der Timeline, animiert
gemalte Enso-Segmente beim Sammeln, pulsierender Applaus-Button.
`prefers-reduced-motion` wird durchgängig respektiert.

**Einladung in der App** – der Flow als Vorführung im Demo-Modus (`?invite=…`).
Im Livebetrieb läuft die Einladung über die **Landing Page** (siehe unten);
die App ist Welle 2 und öffnet erst kurz vor dem Abend. Der Ablauf:
die Einladung kommt von **THE CIRCLE selbst**, nie von einer einzelnen Person.
Zwei Varianten (`?typ=ticket` mit 100-€-Beitrag über Stripe, `?typ=ehrengast`
nur Zusage), Zusage/Absage, Daten-Schritt und Ticket-Nummer. Der Daten-Schritt
erfasst neben Name und Unternehmen auch **E-Mail** (Pflicht – dorthin geht
später der App-Zugang), **Mobilnummer**, **bevorzugte Ernährung** (Alles /
Vegetarisch / Vegan / Pescetarisch) und **Unverträglichkeiten** – diese
Angaben wandern automatisch in die App: Kontaktdaten auf die Connect-Karte
(inkl. Teilen-Text), die Ernährungsnotiz ans Menü („Für dich notiert … die
Küche weiß Bescheid.“). Dazu die **Platz-Vergabe** auf der Startseite (Demo):
drei persönliche Slots, Status zugesagt/offen/abgesagt, Link kopieren, frei
gewordene Plätze neu vergeben – die Einladung selbst versendet immer das Haus.

## Einladungsmanagement (Pools · Landing Page · Stripe · Lettermint)

Die Kommunikation läuft **in Wellen, nicht in einem Rutsch** – und die App
wird erst spät kommuniziert, ausschließlich an Gäste, die zugesagt haben:

| Welle | Template | Empfänger | Zeitpunkt |
|---|---|---|---|
| 0 · Save the Date | `email/save-the-date.html` | Verteiler „Bezahlgäste" | Di, 11.08. |
| 1 · Einladung | `einladung-ticket.html` (zahlt) / `einladung-ehrengast[-partner].html` (zahlt nicht) | Gästeliste (alle Pools) | Wochen vorher |
| 2 · App-Zugang | `app-zugang[-partner].html` | **nur Zusagen / bezahlte Tickets** | wenige Tage vorher |
| 3 · Erinnerung | (folgt) | nur Gäste im Kreis | Vortag |

**Welle 0** kommt vor dem Ticketverkauf: erste Infos zum Format, CTA auf die
Website, noch kein persönlicher Link und keine Zusage. Das Wording kommt aus
der Runde – im Template sind vier Blöcke als `TEXT 1` bis `TEXT 4` markiert,
alles andere (Layout, CI, Merge-Variablen) bleibt unangetastet.

Alle Templates sind tabellenbasiert, e-mail-sicher und im offiziellen CI:
Welle 1 in der Bordeaux-Welt (#741a33, Koralle-Headline, Koralle-Pill-CTA),
Welle 2 in der Navy-Welt (#122648), S/W-Köln-Header
`email/assets/circle-header.jpg`, Schrift-Stack Trajan Pro 3/Cinzel/Georgia
(E-Mails können keine Webfonts laden – Georgia ist der sichere Fallback).

### Die Gästeliste kommt in Pools

Jeder Veranstalter und Partner liefert seine eigene Liste. Der Import legt sie
als **Pools** ab und vergibt pro Gast einen unerratbaren Token:

```bash
node server/circle-server.js import gaesteliste.csv     # Vorlage: server/gaesteliste-vorlage.csv
node server/circle-server.js export > versand.csv       # Kontrollliste (enthält die persönlichen Links)
```

Ein zweiter Import derselben Liste aktualisiert, statt zu verdoppeln.
Wiedererkannt wird ein Gast in dieser Reihenfolge:

1. **über die Mailadresse** – der Normalfall
2. **über Name + Pool**, wenn er bisher keine Adresse hatte (WhatsApp-Gast, der
   jetzt eine bekommt)
3. **über Name + Pool**, wenn seine Adresse sich geändert hat – aber nur, wenn
   dort **genau ein** Gast steht

Fall 3 ist die korrigierte Adresse. Sie behält Token, Ticketnummer und eine
bereits erteilte Zusage, und die Bounce-Sperre der alten Adresse fällt weg –
die neue hat sie nicht verdient. Jede solche Änderung meldet der Import als
Zeile „Adresse geändert: …", denn es ist die einzige stille Änderung am
Register.

Stehen zwei Gäste mit demselben Namen im selben Pool, wird **nicht** geraten:
dann entsteht ein neuer Eintrag, und `pruefen` warnt „steht 2× im Register".

Spalten (Semikolon oder Komma, Reihenfolge egal):

| Spalte | Pflicht | Bedeutung |
|---|---|---|
| `name`, `email` | ja | Gast |
| `pool` | – | Liste, aus der er kommt (Default „Allgemein") |
| `typ` | – | `ticket` (100 € über Stripe) oder `ehrengast` (zahlt nicht) – **Partner-Gäste sind `ehrengast`** |
| `anrede` | – | „Liebe" / „Lieber" für die persönliche Anrede |
| `firma` | – | Unternehmen / Rolle |
| `partner`, `partner_logo` | – | wenn ein Partner eingeladen hat: Name + URL des Logos (negativ weiß) |

Fehlt `typ`, leitet der Import ihn aus dem Pool-Namen ab (alles mit
„Ehrengast", „Presse", „Jury", „Speaker" **oder „Partner"** wird Ehrengast,
der Rest Ticket). Denn wen ein Partner einlädt, ist **Gast dieses Partners**:
zahlt nichts und sieht dessen Logo in der Einladung. Bezahlgäste kommen aus
dem eigenen Netzwerk und sehen kein fremdes Logo.
Fehlt `anrede`, steht in der Mail „Hallo <Vorname>" – bitte die Spalte füllen,
damit es „Liebe Anne" heißt. Ein erneuter Import aktualisiert bestehende Gäste
– Schlüssel ist die E-Mail, Tokens und Zusagen bleiben erhalten.

`versand.csv` ist zum **Nachlesen**, nicht zum Hochladen: Verschickt wird
direkt aus dem Register (siehe unten). Die Datei zeigt je Gast alle Werte, die
in seiner Mail landen – gut, um vor einer Welle einmal quer zu prüfen, ob
Anreden und Partnerzuordnungen stimmen.

### Der Versand

Lettermint ist ein reiner Versanddienst ohne Vorlagen-Editor. Deshalb setzt
**der Server** für jeden Gast Anrede, Namen, persönlichen Link, Ticketnummer
und Partnerlogo ein und übergibt Lettermint die fertige Mail. Damit gibt es nur
eine Quelle für die Zuordnung: das Register. Über eine hochgeladene Tabelle
könnte sie verrutschen – und ein Gast bekäme den Link eines anderen.

```bash
node server/circle-server.js welle 1                          # Trockenlauf
node server/circle-server.js welle 1 --vorschau=probe.html    # eine Mail ansehen
node server/circle-server.js welle 1 --nur=du@example.de --senden
node server/circle-server.js welle 1 --senden                 # die ganze Welle
```

**Ohne `--senden` geht nichts raus.** Der Trockenlauf rendert trotzdem jede
Mail vollständig durch und bricht ab, sobald ein Platzhalter offen bliebe –
lieber hier ein Fehler als 200 Gäste, die „{{vorname}}" in der Anrede lesen.
Weitere Schalter: `--pool="…"`, `--typ=ehrengast|ticket`, `--limit=n`.

`--typ=` trennt die beiden Gästearten. Das ist der Notausgang, solange Stripe
noch nicht scharf ist: Ehrengäste können raus, Bezahlgäste warten – bei ihnen
liefe „Weiter zur Zahlung" sonst ins Leere.

### Vorflugkontrolle

Der Trockenlauf beantwortet „bricht das Rendern?". Dieser Befehl beantwortet
„stimmt, was da rausgeht?":

```bash
node server/circle-server.js pruefen 1                    # Register + Vorlagen
node server/circle-server.js pruefen 1 --bilder           # ruft jede Bild-URL ab
node server/circle-server.js pruefen 1 --beleg            # Liste zum Gegenlesen
```

Geprüft wird je Gast: Name und Anrede vorhanden, Adresse formal gültig und
ohne Leerzeichen, Typ bekannt, Partner und Logo zusammen gesetzt, jeder
Platzhalter ersetzt, der persönliche Link vorhanden **und kein Link mit dem
Token eines anderen Gastes**. Über das Register hinweg: dieselbe Adresse
zweimal (Fehler), derselbe Name zweimal (Warnung). Mit `--bilder` wird jede
Bild-Adresse einmal wirklich abgerufen – ein fehlendes Partnerlogo fällt sonst
erst auf, wenn dreißig Gäste ein leeres Kästchen sehen.

`FEHLER` heißt: nicht senden. `WARNUNG` heißt: ein Mensch soll es gesehen
haben. Der Befehl endet mit Exit-Code 1, sobald ein Fehler dabei ist – er
lässt sich also vor den Versand hängen.

Was er **nicht** kann: erkennen, dass jemand in der Gästeliste als Ehrengast
steht, der eigentlich zahlen soll. Das ist keine technische Frage. Dafür gibt
es `--beleg`: eine Liste „Name → Typ → Partner → Vorlage" zum Gegenlesen.

### Gäste ohne Mailadresse

Manche Gäste kommen über WhatsApp statt über eine Adresse. Sie bekommen
denselben persönlichen Link, nur von Hand:

```bash
node server/circle-server.js whatsapp          # nur Gäste ohne Adresse
node server/circle-server.js whatsapp --alle   # alle
```

Der Befehl schreibt je Gast eine fertige Nachricht zum Kopieren. Der Link ist
derselbe wie in der Mail – die Zusage landet also im selben Register, mit
derselben Ticketnummer. **Auf dem Server ausführen**, nicht lokal: die Tokens
stehen im Register, ein lokales Register erzeugt andere und damit tote Links.

Ins Versand-Gedächtnis trägt der Befehl bewusst nichts ein. Ob die Nachricht
wirklich rausging, weiß nur der Mensch, der sie verschickt hat – und wer
später eine Adresse nachträgt, soll die Mail trotzdem bekommen.

Wer welche Vorlage bekommt, entscheidet der Server: Ehrengäste die
Ehrengast-Fassung, Gäste eines Partners die Fassung mit dem Logo ihres
Gastgebers. Welle 1 geht nur an Offene, Welle 2 nur an bestätigte Gäste (der
App-Link zeigt persönliche Daten). Wer sich über den Abmeldelink im Fuß
austrägt, ist aus allen Wellen raus – die Zusage bleibt davon unberührt.

### Die Landing Page (`landing.html`)

Der Link aus der Einladungsmail führt **nicht** direkt in die App, sondern auf
die Landing Page: `https://thecircle.planyvo.com/einladung?t=<TOKEN>`. Sie ist im
Farbkapitel-Rhythmus der Website aufgebaut (Bordeaux → Sand → Navy → Bordeaux)
und trägt alle Infos zum Abend:

01 Das Event · 02 Der Abend (die fünf Programmpunkte) · 03 Die Köpfe (Amiaz
Habtu, Ien Svea Bäumler, Max Leinfelder – als Kreisporträts) · 04 Ort & Zeit ·
05 Deine Antwort.

Im letzten Kapitel passiert die eigentliche Arbeit – abhängig vom Pool-Typ:

- **Ehrengast** → Formular, Zusage, fertig.
- **Ticket** → Formular, dann **Stripe Checkout** über 100 €. Nach der Zahlung
  kommt der Gast auf die Landing Page zurück und sieht seine Ticket-Nummer.

Erfasst werden Name, E-Mail (Pflicht – dorthin geht später der App-Zugang),
Mobil, Unternehmen, **bevorzugte Ernährung** und **Unverträglichkeiten**. Diese
Angaben wandern automatisch in die App zum Abend (Kontaktdaten auf die
Connect-Karte, Ernährung als Notiz ans Menü).

Kommt der Gast aus einem Partner-Pool, steht über der Zusage
„Du bist eingeladen von unserem Partner" samt Logo (aus `partner_logo`).

Ohne Server geöffnet (`landing.html?demo=1`, optional `&typ=ehrengast`) läuft
alles als Vorführung – es wird nichts berechnet.

### Stripe

Der Server erzeugt die Checkout-Session direkt über die Stripe-API (kein SDK,
keine Abhängigkeit) und verbucht die Zahlung über den Webhook:

```bash
PUBLIC_URL=https://thecircle.planyvo.com \
STRIPE_SECRET_KEY=sk_live_… \
STRIPE_WEBHOOK_SECRET=whsec_… \
ADMIN_TOKENS=anne:…,desi:…,nicole:… \
node server/circle-server.js
```

Im Stripe-Dashboard einen Webhook auf `https://thecircle.planyvo.com/api/stripe/webhook`
anlegen und das Ereignis `checkout.session.completed` abonnieren. Die
Signatur wird geprüft (HMAC-SHA256, 5-Minuten-Fenster gegen Replays), die
Buchung ist idempotent – ein doppelt zugestelltes Ereignis zählt nicht doppelt.
`TICKET_PRICE` (in Cent, Default `10000`) ändert den Beitrag an einer Stelle.

Ohne `STRIPE_SECRET_KEY` läuft alles andere weiter; der Zahlungsschritt meldet
dann sauber, dass er noch nicht scharf geschaltet ist.

### Lettermint

Versendet wird über `POST https://api.lettermint.co/v1/send` – kein SDK, eine
HTTPS-Anfrage je Mail, nacheinander mit kurzer Pause (das schont die
Zustellbarkeit einer jungen Absenderdomain). Nötig sind vier Variablen:
`LETTERMINT_TOKEN`, `MAIL_FROM`, `MAIL_REPLY_TO`, `LETTERMINT_WEBHOOK_SECRET`.

Für die Öffnungs- und Klickraten einen Webhook auf
`https://thecircle.planyvo.com/api/lettermint/webhook` legen
(`sent`/`delivered`/`opened`/`clicked`). Er wird **nur mit gültiger Signatur**
angenommen – sonst könnte jeder Fremde Zustellzahlen erfinden. Zugeordnet wird
über den Token aus den Metadaten, nicht über die Adresse. Klicks erkennt der
Server ohnehin selbst, sobald der Gast die Landing Page öffnet.

### Der Monitor (`monitor.html`)

Der Blick für alle Beteiligten – aufgebaut in der Reihenfolge, in der man ihn
liest: **was jetzt zu tun ist**, dann die Zahlen, dann der Einzelfall.

| Block | Was dort steht |
|---|---|
| **Handlungsbedarf** | Was auf jemanden wartet: unzustellbare Adressen, Zusagen ohne Zahlung, Gäste ohne Mailadresse (WhatsApp-Weg), noch nie Angeschriebene, Abmeldungen – und wie viele Gäste die nächste Welle bekämen. Jede Kachel springt gefiltert in die Gästeliste; die Wellen-Kachel nennt den Befehl, der sie rausschickt. |
| Kennzahlen | Versendet, zugestellt, geöffnet, geklickt, zugesagt, bezahlt, abgesagt |
| Die Wellen | Je Welle: verschickt, offen, gesperrt – aus dem **Versand-Gedächtnis** und derselben `gilt()`-Regel, nach der der Versand entscheidet. Was hier „offen" heißt, geht beim nächsten `welle n --senden` wirklich raus. Keine handgepflegten Termine mehr. |
| Die Pools | Wer wie viele Gäste eingeladen hat und wie viele davon zugesagt bzw. bezahlt haben |
| Funnel & Fassungen | Der Weg vom Versand zum Ticket, dazu je Vorlage (Ticket, Ehrengast, Ehrengast-Partner, App-Zugang) |
| Ticketumsatz | Stripe-Summe und die letzten Zahlungen |
| Zuletzt passiert | Die Ereigniskette aus Register und Lettermint |
| Gästeliste | Jede Mail einzeln, mit Filterchips und Suche |

Läuft der Server, holt sich der Monitor die echten Zahlen über
`https://thecircle.planyvo.com/monitor?key=<zugang>` und **aktualisiert sich
alle 60 Sekunden selbst** (im Hintergrundtab ruht er, beim Zurückwechseln lädt
er sofort nach).

**Demo oder live – nie dazwischen.** Ohne erreichbaren Server oder ohne
gültigen Zugang gelten die Platzhalterzahlen aus dem HTML, und der Kopf sagt
das: *Demo · Platzhalterdaten*, *Kein Zugriff* oder *Monitor nicht
eingerichtet*. Mit gültigem Zugang wird **jeder** Block aus dem Register
gespeist – auch Wellen, Fassungen, Umsatz und der Fußtext. Reißt die
Verbindung später ab, bleiben die letzten echten Zahlen stehen, aber der Kopf
meldet *Zahlen frieren ein*. Halb Demo, halb echt wäre die gefährlichste
Anzeige von allen: niemand wüsste, welche Zahl gilt.

> **Zur Deutung von „Nach Fassung":** Gezählt werden Gäste, die diese Fassung
> bekommen haben. Geöffnet/geklickt/zugesagt/bezahlt sind der **heutige Stand
> des Gastes**, nicht die Reaktion auf genau diese eine Mail – das Register
> führt einen Stand pro Gast, nicht pro Sendung. Wer zwei Wellen bekommen hat,
> steht in beiden Zeilen. Der Monitor schreibt das unter die Tabelle.

**Zugänge je Person.** `ADMIN_TOKENS` nimmt eine Liste im Format
`name:token,name:token` – jede Person bekommt ihren eigenen Link. Fällt einer
in falsche Hände, wird genau dieser Eintrag entfernt; alle anderen behalten
ihren Link. Token erzeugen mit `openssl rand -hex 16`. Der Vergleich läuft
zeitkonstant (`crypto.timingSafeEqual`). `ADMIN_TOKEN` bleibt als einzelner
gemeinsamer Zugang zusätzlich gültig.

> **Datenschutz:** Im Register stehen Namen, E-Mail-Adressen und – wenn Gäste
> sie angeben – Unverträglichkeiten, also personenbezogene und teils
> Gesundheitsdaten. Deshalb: Zugänge setzen, nur über HTTPS betreiben,
> `server/live-state.json` bleibt aus dem Repo (`.gitignore`) und wird nach dem
> Event gelöscht bzw. auf das Nötige eingedampft.

**Demo-Modus** (`?demo=1` oder `CONFIG.demo`): simulierte Raum-Daten (Applaus,
Votum, Auktion mit Gegenbietern, Geräte-Zähler), Vorspul-Chip durch die Phasen
des Abends und automatisch aktiver Einladungsflow – die „Demo-PWA mit
Platzhalterdaten“ für die Abstimmung mit dem Event-Team.

**Screentime-Steuerung** (`CONFIG.gates`): Live-Funktionen öffnen nur in ihrem
Programmfenster (Applaus/Votum zum Pitch, Bieten zur Versteigerung); außerhalb
zeigt die App elegante Pausen-Overlays („Der Raum hat Pause – bis dahin: gute
Gespräche.“).

Alles läuft ohne Backend – der Stand jedes Gastes liegt lokal auf seinem Gerät
(`localStorage`). Kein Login, keine Datenweitergabe, kein Tracking.

> Platzhalter neben dem Menü: der **Dresscode** („Smart Elegant“) und die
> Programm-Uhrzeiten sind Vorschläge – bitte final bestätigen.

## Logos

Das **offizielle THE-CIRCLE-Logo** (`logo-horizontal-neg-rgb.svg` von der
Website) ist als SVG-Data-URI eingebettet (JS-Konstante `BRANDLOGO`, wird an
alle `img.brandlogo` verteilt). Die **Veranstalter-Logos** (Ihre Marken
Werkstatt, AERA, Public Cologne) stammen aus der Event-Präsentation. Die
**Partner** (Stand Website: neuland.ai, Conrad, Dein Dach, DEKRA, jto,
Merzenich, sion, SKS) stehen als Wortmarken-Kacheln im `partner-grid` – die
echten Logo-Dateien liegen auf the-circle-cologne.de unter
`/wp-content/uploads/` (weiße Hintergründe; für die dunkle App am besten
negative Varianten anfragen).

## Die Dateien

| Datei | Wofür |
|---|---|
| `landing.html` | **Welle 1** – Landing Page mit Event-Infos, Zusage und Stripe-Checkout (Ziel der Einladungsmail) |
| `index.html` | **Welle 2** – die App zum Abend (Programm, Menü, Live, Connect) |
| `monitor.html` | Einladungs-Monitor: Handlungsbedarf, Wellen, Pools, Funnel, Umsatz, Gästeliste |
| `email/*.html` | Mailvorlagen der drei Wellen (der Server füllt sie und verschickt) |
| `server/circle-server.js` | Gästeregister mit Pools, Stripe, Webhooks, Live-Ebene |
| `server/gaesteliste-vorlage.csv` | Spaltenvorlage für die Pool-Listen |
| `pitch/einladungsmanagement.html` | Konzeptdokument für die Veranstalter (Workflow + Monitor), Quelle des PDFs |
| `pitch/THE-CIRCLE-Einladungsmanagement.pdf` | 10 Seiten A4 – Wellen, Mailings, Landing Page, Zahlung, Pools, Monitor, nächste Schritte |

## Setup & Betrieb

Das vollständige technische Setup steht Schritt für Schritt in
**[`DEPLOY.md`](DEPLOY.md)** – in der Reihenfolge, in der es gemacht wird:
Subdomain sichern und unter **Plesk** deployen → Lettermint → Monitor und
Admin-Zugänge → Stripe → Gästeliste → Livegang-Checkliste.

In `deploy/` liegen `env.example` (die Umgebungsvariablen, unter Plesk im
Node.js-Panel gepflegt) sowie `Caddyfile` und `thecircle.service` – die beiden
letzten braucht es nur, falls THE CIRCLE später auf einen selbstverwalteten
Server umzieht.

## Wo alles läuft

Alles Digitale liegt unter der Subdomain **`thecircle.planyvo.com`** (von planyvo
bereitgestellt) – die Event-Website bleibt unberührt:

| Adresse | Was dort liegt |
|---|---|
| `/einladung?t=…` | Landing Page (Welle 1) – Infos, Zusage, Zahlung |
| `/` | die App zum Abend (Welle 2) |
| `/monitor?key=…` | Einladungs-Monitor |
| `/assets/…` | Bilder für die Mailings (aus `email/assets/`) |
| `/api/stripe/webhook` | Stripe meldet Zahlungen hierher |
| `/api/lettermint/webhook` | Lettermint meldet Öffnungen/Klicks hierher (signiert) |
| `/abmelden?t=…` | Abmeldelink aus dem Fuß jeder Mail |

Stripe- und Lettermint-Konten laufen ebenfalls über planyvo.

## Bilder & Logos in den Mailings

E-Mails können keine Data-URIs laden – die Bilder müssen gehostet werden. Sie
liegen unter `thecircle.planyvo.com/assets/`; die Adressen setzt der Server
beim Versand selbst ein. Die Dateien liegen in `email/assets/`:

| Datei | Merge-Variable | Inhalt |
|---|---|---|
| `circle-header.jpg` | `{{header_img_url}}` | S/W-Köln-Header, 1200×520 |
| `logo-neg.svg` | `{{logo_url}}` | offizielles Logo, horizontal negativ |
| `portrait-amiaz.jpg` | `{{portrait_amiaz_url}}` | Amiaz Habtu, Kreis auf Bordeaux, 360×360 |
| `portrait-ien.jpg` | `{{portrait_ien_url}}` | Ien Svea Bäumler |
| `portrait-max.jpg` | `{{portrait_max_url}}` | Max Leinfelder |
| `partnerwand-bordeaux.jpg` | `{{partnerwand_url}}` | alle zehn Partner, negativ weiß, 1000×300 |
| `partner-deindach-neg.png` | `{{partner_logo_url}}` | Beispiel-Partnerlogo, transparent |

Die Kreise sind **fertig auf den Bordeaux-Grund gerechnet** – so brauchen sie
kein `border-radius`, das viele Mail-Clients ignorieren.

> Die Partner-Logos sind aus den Website-Dateien freigestellt und auf Weiß
> umgesetzt. Sobald die Partner echte Negativ-Logos liefern (am besten SVG oder
> PNG mit Transparenz), einfach die Dateien in `email/assets/` ersetzen –
> besonders SKS und Merzenich gewinnen dadurch.

## Anpassen

Alle Inhalte stehen in `index.html`:

- **Datum & Ablauf**: im `CONFIG`-Block am Anfang des `<script>` (`eventDate` steht auf dem 16.09.2026, die Uhrzeiten der `timeline` sind ein Vorschlag im offiziellen Rahmen 18:00–23:00 Uhr)
- **Gastgeber & Partner**: im Abschnitt `colophon` auf der Startseite (Stand Website: neuland.ai, Conrad, Dein Dach, DEKRA, jto, Merzenich, sion, SKS)
- **Menü**: im Abschnitt `<!-- MENÜ -->` (aktuell ein Beispielmenü)
- **Impuls-Fragen**: Array `IMPULSE`
- **Momente**: Array `MOMENTS`

## Live-Modus (alle Gäste gemeinsam)

Mit dem mitgelieferten Mini-Server wird aus der App eine Echtzeit-Erfahrung
für den ganzen Raum – **eine Node-Datei, null Abhängigkeiten**:

```bash
node server/circle-server.js        # dient App + Live-API auf Port 8080
PORT=3000 node server/circle-server.js
```

Damit kommen dazu:

- **Applaus im ganzen Raum** – alle Geräte zählen zusammen (Live-Zähler)
- **Live-Votum** – „Würdest du investieren?“ mit Balken und echten Stimmen
- **Auktions-Board** – Höchstgebot mit Bieterkarten-Nummer, Bieten per
  +100/+250/+500-Buttons direkt vom Platz
- **„Gerade im Kreis“** – Zähler der verbundenen Geräte

Die App erkennt den Server automatisch (gleiche Domain) – ohne Server läuft
alles unverändert lokal weiter. Alternativ eine externe Server-URL in
`CONFIG.liveServer` eintragen (z. B. Render/Railway/Fly, oder ein Laptop im
Venue-WLAN). Der Zustand wird in `server/live-state.json` gesichert und
übersteht Neustarts. Kein Login – gedacht für den privaten Abend hinter einer
nicht erratbaren URL.

## NFC-Armbänder & Stationen (Handy in der Tasche)

Für minimale Screentime: Jeder Gast trägt ein **passives NFC-Armband** (nur eine
ID, kein Akku). Im Raum stehen **Stationen** – günstige Android-Tablets im Browser,
die `station.html` im Vollbild zeigen und das Armband per **Web-NFC** lesen. Der
Gast legt nur auf, das Handy kann in der Tasche bleiben.

- **Aufruf:** `…/station` zeigt die Stationsauswahl; `…/station?station=applause`
  öffnet eine konkrete Station (checkin · applause · vote-ja/-vielleicht/-nein ·
  bid · impuls · mentor · kunst · verbindung).
- **Ablauf:** Am Check-in tippt der Gast seinen Namen einmal ein (Band → Gast).
  Danach genügt an jeder Station das Auflegen: Applaus zählt, das Votum wird zur
  physischen Abstimmung (drei Stelen), Gebote steigen um 250 €, Momente füllen den Kreis.
- **Server:** führt ein Gäste-Register (`Band-ID → Gast` mit Namen, Momenten,
  Applaus, Votum). Stations-Taps speisen zugleich die aggregierte Live-Ansicht der App.
- **Hardware:** Silikon-NFC-Armbänder (~0,50–2 €, brandbar) + je Station ein
  Android-Tablet. Kein Custom-Gerät, keine App im Store. iPhones können *nicht* als
  Leser dienen (kein Web-NFC) – Stationen daher Android; Gäste-Handys sind egal.
- **Demo:** Jede Station hat einen Knopf „Tap simulieren“ (rotierende Demo-Gäste),
  um die Stationen ohne Armband vorzuführen – ideal fürs Pitch-Gespräch.

Endpunkte: `POST /api/station/register {band,name}` · `POST /api/station/tap
{band,station[,inc]}` · `GET /api/guest?band=…`.

## Deployment

Eine einzige Datei, keine Abhängigkeiten, kein Build:

- **GitHub Pages**: Repo-Settings → Pages → Branch wählen, fertig
- oder jeden beliebigen Static-Host (Netlify, Vercel, S3 …)
- lokal testen: `python3 -m http.server` und `http://localhost:8000` öffnen

Am besten teilt ihr die URL als QR-Code auf den Tischkarten – die App ist
mobile-first gebaut und für iPhone/Android-Browser optimiert.

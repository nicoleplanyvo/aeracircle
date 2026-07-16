# THE CIRCLE · Teilnehmer-App

Die digitale Begleiterin für **THE CIRCLE – connecting generations**
(16. September 2026 · ab 18:30 Uhr · Playa Cologne): eine mobile Web-App für die
Gäste des Abends, im monochromen Editorial-Look des Events – rauchige
Schwarz-Weiß-Verläufe, Display-Typo in Clash Display (Uppercase, Silber-Verlauf,
Solid/Outline-Mix), Cormorant kursiv als leiser Kontrapunkt, Tusche-Enso
(Canvas-gerendert), das Menü als helles Blatt mit schwarzer Schrift.

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

Alles läuft ohne Backend – der Stand jedes Gastes liegt lokal auf seinem Gerät
(`localStorage`). Kein Login, keine Datenweitergabe, kein Tracking.

> Platzhalter neben dem Menü: der **Dresscode** („Smart Elegant“) und die
> Programm-Uhrzeiten sind Vorschläge – bitte final bestätigen.

## Logos

Die **Veranstalter-Logos** (Ihre Marken Werkstatt, AERA, Public Cologne) und
das Spiral-Logo stammen aus der Event-Präsentation und sind als WebP-Data-URIs
eingebettet. Die **Partner** stehen als einheitliche Wortmarken-Kacheln im
`partner-grid` – sobald die echten Logo-Dateien der Partner vorliegen, einfach
in einer Kachel das `<b>…</b>` durch `<img src="data:image/webp;base64,…">`
ersetzen (max-height 30 px empfohlen, am besten weiße/negative Logovarianten).

## Anpassen

Alle Inhalte stehen in `index.html`:

- **Datum & Ablauf**: im `CONFIG`-Block am Anfang des `<script>` (`eventDate` steht auf dem 16.09.2026, die Uhrzeiten der `timeline` sind ein Vorschlag rund um den 18:30-Uhr-Einlass)
- **Gastgeber & Partner**: im Abschnitt `colophon` auf der Startseite (Stand: neuland.ai, Conrad SE, Smart Velo, Dein Dach, Radeberger Gruppe / Haus Kölscher Brautradition, Merzenich Bäckereien, SKS (Yellowhive Group), fuchsrohrbach Rechtsanwälte)
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

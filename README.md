# THE CIRCLE · Teilnehmer-App

Die digitale Begleiterin für **THE CIRCLE – connecting generations**
(16. September 2026 · ab 18:30 Uhr · Playa Cologne): eine mobile Web-App für die
Gäste des Abends, im monochromen Editorial-Look des Events – rauchige
Schwarz-Weiß-Verläufe, Uppercase-Didone mit Silber-Verlauf (Cormorant),
Tusche-Enso (Canvas-gerendert), das Menü als helles Blatt mit schwarzer Schrift.

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

- **Heute Abend** – persönliche Begrüßung, Countdown bzw. Live-Status, „Als Nächstes“-Karte, Kreis-Fortschritt
- **Programm** – Timeline des Abends mit Live-Indikator (Empfang → Vortrag → Pitch → Mentor-Minuten → Live Painting → DJ)
- **Menü** – das bewegte 3-Gang-Menü, elegant gesetzt (Beispielinhalte)
- **Live** – Applaus-Meter für den Start-Up-Pitch, digitale **Bieterkarte** für die Versteigerung des Live Paintings (Max Leinfelder, Erlös wird gespendet)
- **Connect** – digitale Visitenkarte zum Teilen (Web Share / Zwischenablage) und **Impuls-Karten**: Fragen, die Generationen ins Gespräch bringen

Alles läuft ohne Backend – der Stand jedes Gastes liegt lokal auf seinem Gerät
(`localStorage`). Kein Login, keine Datenweitergabe, kein Tracking.

## Anpassen

Alle Inhalte stehen in `index.html`:

- **Datum & Ablauf**: im `CONFIG`-Block am Anfang des `<script>` (`eventDate` steht auf dem 16.09.2026, die Uhrzeiten der `timeline` sind ein Vorschlag rund um den 18:30-Uhr-Einlass)
- **Gastgeber & Partner**: im Abschnitt `colophon` auf der Startseite (Stand: neuland.ai, Conrad SE, Smart Velo, Dein Dach, Radeberger Gruppe / Haus Kölscher Brautradition, Merzenich Bäckereien, SKS (Yellowhive Group), fuchsrohrbach Rechtsanwälte)
- **Menü**: im Abschnitt `<!-- MENÜ -->` (aktuell ein Beispielmenü)
- **Impuls-Fragen**: Array `IMPULSE`
- **Momente**: Array `MOMENTS`

## Deployment

Eine einzige Datei, keine Abhängigkeiten, kein Build:

- **GitHub Pages**: Repo-Settings → Pages → Branch wählen, fertig
- oder jeden beliebigen Static-Host (Netlify, Vercel, S3 …)
- lokal testen: `python3 -m http.server` und `http://localhost:8000` öffnen

Am besten teilt ihr die URL als QR-Code auf den Tischkarten – die App ist
mobile-first gebaut und für iPhone/Android-Browser optimiert.

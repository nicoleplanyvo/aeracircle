# Modul „Vernetzung" — Spezifikation

Das Herzstück der App zum Abend (#5, #6). Diese Spezifikation ist so geschrieben,
dass sie als **Plattform-Modul in `planyvo_AI`** umgesetzt werden kann — sie ist
nicht auf THE CIRCLE zugeschnitten. Was hier steht, gilt für jedes Netzwerk-Event:
Teilnehmerliste, beidseitiges Verbinden, Visitenkarten-Tausch.

Status: **Entwurf, wartet auf die Entscheidung aus #4** (Plattform-Feature oder
Workaround für N°1). Das Datenmodell und die Zustände unten ändern sich durch
diese Entscheidung nicht — nur, wo sie leben.

---

## 1. Datenmodell

Drei Entitäten. Die Teilnehmer selbst existieren in der Plattform bereits
(`Participant`); das Modul hängt zwei Dinge daran.

### `ParticipantProfile` — was der Gast über sich zeigt

| Feld | Typ | Herkunft | Anmerkung |
|---|---|---|---|
| `participantId` | FK | Plattform | 1:1 |
| `displayName` | String | vorbefüllt aus der Zusage | änderbar |
| `company` | String? | vorbefüllt | änderbar |
| `role` | String? | vorbefüllt | änderbar |
| `photoUrl` | String? | Upload bei der Registrierung | siehe §4 |
| `visibility` | Enum | **Gast entscheidet** | `CONTACT_VISIBLE` \| `CONTACTABLE_ONLY` |
| `email` / `phone` | String? | aus dem Register | nur ausgespielt bei `CONTACT_VISIBLE` |
| `registeredAt` | DateTime? | gesetzt beim Abschluss | `null` = noch nie geöffnet |

`visibility` ist der Kern der Einwilligung. Sie wird **bei der Registrierung in
der App** gesetzt, im selben Schritt wie das Foto — nicht im Zusage-Formular.
Default vor der Registrierung: `CONTACTABLE_ONLY`, also die datensparsame Variante.

### `Connection` — die Verbindung zwischen zwei Gästen

| Feld | Typ | Anmerkung |
|---|---|---|
| `id` | ID | |
| `eventId` | FK | Verbindungen gelten je Event |
| `requesterId` / `addresseeId` | FK Participant | Richtung nur für die Anfrage relevant |
| `state` | Enum | siehe §2 |
| `requestedAt` / `respondedAt` | DateTime | |

**Eindeutigkeit:** ein Paar, eine Zeile. Unique-Index auf
`(eventId, least(requesterId, addresseeId), greatest(...))` — sonst entstehen
zwei Zeilen, wenn beide gleichzeitig anfragen, und „Mein Kreis" zeigt Dubletten.
Wenn B anfragt, während A schon angefragt hat, ist das **kein Konflikt, sondern
die Zustimmung**: direkt nach `ACCEPTED`.

### `ConnectionNote` — optional, gehört nur dem Schreibenden

| Feld | Typ | Anmerkung |
|---|---|---|
| `connectionId` / `authorId` | FK | |
| `body` | Text | „Wollte mir was zu … schicken" |

Ersetzt das heutige rein lokale „Mein Kreis" in `index.html`, das die Notizen nur
auf dem Gerät hält und beim Wechsel verloren geht.

---

## 2. Zustände einer Verbindung

```
                 ┌────────── zurückziehen ──────────┐
                 ▼                                  │
   (keine)  ──► PENDING ──── annehmen ────► ACCEPTED
                 │  ▲                          │
       ablehnen  │  │ später erneut fragen     │ trennen
                 ▼  │                          ▼
              DECLINED                      (keine)
                 │
                 └── „Lass uns später sprechen" ──► LATER
```

- **`PENDING`** — angefragt, noch keine Antwort. Für den Angefragten sichtbar,
  für Dritte nie.
- **`ACCEPTED`** — beide einverstanden. **Erst jetzt** werden Kontaktdaten
  ausgetauscht, und zwar in beide Richtungen.
- **`DECLINED`** — abgelehnt. Der Anfragende sieht **keine** Ablehnung, nur dass
  nichts passiert ist. Eine Ablehnung, die ankommt, vergiftet den Abend.
- **`LATER`** — der leise zweite Weg aus dem Call. Nicht abgelehnt, nicht
  verbunden: taucht bei beiden unter „später sprechen" auf, ohne Kontaktdaten.

**Regel, die nirgends verletzt werden darf:** Kontaktdaten verlassen den Server
nur bei `ACCEPTED` **und** wenn das Gegenüber `CONTACT_VISIBLE` gesetzt hat. Zwei
Bedingungen, nicht eine — Zustimmung zur Verbindung ist nicht dasselbe wie
Freigabe der Daten.

---

## 3. Teilnehmerliste

Sichtbar ist **jeder** Gast des Events, auch wer noch nie die App geöffnet hat —
sonst ist die Liste am Anfang des Abends leer und niemand kommt wieder.

| Zustand des Gastes | Was andere sehen |
|---|---|
| registriert, `CONTACT_VISIBLE` | Name, Unternehmen, Rolle, Bild, Kontaktdaten nach `ACCEPTED` |
| registriert, `CONTACTABLE_ONLY` | Name, Unternehmen, Rolle, Bild — Kontaktdaten nie |
| noch nicht registriert | Name, Unternehmen aus der Zusage; Platzhalter statt Bild |

Sortierung: registrierte Gäste mit Bild zuerst. Das belohnt das Hochladen und
macht die Liste beim ersten Öffnen brauchbar.

---

## 4. Foto-Upload

- Annahme: JPEG, PNG, HEIC (iPhone liefert HEIC).
- Serverseitig auf **zwei Größen** rechnen: 96 px für die Liste, 512 px für das
  Kurzprofil. Originale nicht ausliefern — 100 Gäste × iPhone-Fotos sind sonst
  zweistellige Megabyte pro Listenaufruf, im Veranstaltungs-WLAN.
- EXIF strippen. Fotos tragen Ort und Zeit.
- Rotation aus EXIF vorher anwenden, sonst stehen die Bilder quer.
- Kein Bild ist ein gültiger Zustand, keine Blockade.

---

## 5. API-Oberfläche

Aus Sicht der App, unabhängig davon, wo das Modul liegt:

| Route | Zweck |
|---|---|
| `GET /profile` | eigenes Profil inkl. `visibility` |
| `PUT /profile` | Registrierung abschließen: Felder, Foto, `visibility` |
| `GET /participants` | Teilnehmerliste, gefiltert nach §3 |
| `GET /participants/:id` | Kurzprofil (für die Tischdarstellung, #7) |
| `POST /connections` | Anfrage stellen — idempotent je Paar |
| `PATCH /connections/:id` | `accept` \| `decline` \| `later` \| `disconnect` |
| `GET /connections` | „Mein Kreis" |
| `PUT /connections/:id/note` | eigene Notiz |

Alles hängt am persönlichen Token des Gastes, wie schon in Welle 1. Kein Login,
kein Passwort.

**Rate-Limit auf `POST /connections`.** Ohne Bremse kann ein Gast die gesamte
Liste anfragen; das ist kein Angriff, sondern der Reflex „ich sammle mal alle" —
und er macht das Modul wertlos.

---

## 6. Was das Modul nicht tut

- **Kein Chat.** Messaging ist ein eigenes Plattform-Modul; wer schreiben will,
  hat nach `ACCEPTED` die Mailadresse.
- **Keine automatische Vernetzungsmail an beide (CC).** Im Call bewusst als
  Ausbaustufe zurückgestellt — lässt sich später ergänzen, ohne dass sich am
  Abend etwas ändert.
- **Keine Sichtbarkeit von Verbindungen Dritter.** Wer mit wem verbunden ist,
  sieht nur, wer beteiligt ist.

---

## 7. Offene Punkte

1. **Wo gebaut wird** — #4. Das Datenmodell oben ist davon unberührt, die
   Integration nicht.
2. **Was nach dem Event mit den Verbindungen passiert.** Sie sind an `eventId`
   gebunden. Wenn dieselben Gäste zu N°2 kommen: neue Verbindungen oder
   bestehende weiterführen? Für N°1 irrelevant, für die Plattform nicht.
3. **Löschung.** Ein Gast muss sein Profil samt Foto löschen können. Was
   passiert dann mit `ACCEPTED`-Verbindungen, über die andere seine Daten schon
   erhalten haben? Vorschlag: Verbindung bleibt, Profil wird anonymisiert,
   Foto gelöscht.

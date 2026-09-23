# THE CIRCLE → planyvo-Plattform

Was die Circle-App kann, was die Plattform davon schon kann, und was gebaut
werden muss, damit der nächste Circle aus dem Dashboard läuft statt aus
diesem Repo.

Stand: 23.09.2026 · Grundlage: `aeracircle` (21.000 Zeilen, 107 API-Routen)
gegen `planyvo_ai` (256 Datenmodelle, 49 App-Bausteine, 10 Plattform-Module)

---

## 1 · Was die Circle-App ist

Kein Baukasten, sondern ein Abend. Die Funktionen sind entlang von drei
Phasen gewachsen – **vorher**, **am Abend**, **danach** –, und die App
schaltet zwischen ihnen selbst um. Das ist der rote Faden, der beim Umzug
nicht verloren gehen darf: Nicht die Einzelfunktion trägt, sondern dass
zur richtigen Zeit das Richtige sichtbar ist.

### Der Gast (`index.html`, 4.480 Zeilen)

| Funktion | Was sie tut |
|---|---|
| Persönlicher Link | `/?t=TOKEN` – kein Passwort, kein Konto. Der Link ist der Zugang |
| PWA + Push | Startbildschirm, eigener Service Worker, Web-Push über VAPID |
| Zwei Stufen | Erst nur Profil, nach der Zusage die ganze App (`data-stufe`) |
| Drei Phasen | vorher / Abend / danach – Startseite, Leiste und Inhalte wechseln (`data-phase`) |
| Profil | Foto, Firma, Rolle, „Worüber ich gern spreche" |
| Gästebuch | Alle Gäste mit Profil, schon **vor** dem Abend – der halbe Grund zu kommen |
| Verbindungen | Zwei Gäste verbinden sich, Kontakt bleibt danach – Export als vCard |
| Mein Tisch | Tisch je Gang, Tischwechsel zwischen den Gängen |
| Programm | Ablauf mit „Als Nächstes", Menü, Unverträglichkeiten |
| Momente | Fünf Chips (Da · Impuls · Start-up · Kunst · Kontakt) als Enso-Ring |
| Live | Applaus, Votum, Sterne, Interesse, Tipps – während es passiert |
| Auktion | Blind-Gebote auf das Live-Painting, Zuschlag, Erlös |
| Werkname | Titelvorschläge fürs Werk, gesammelt aus dem Raum |
| News | Feed mit Open-Graph-Linkvorschau |
| Galerie | Bilder des Abends, eigene oben, Teilen und Speichern |
| Feedback | Daumen plus ein Satz |
| Löschen | Der Gast löscht seine Daten selbst (DSGVO) |
| Offline | Drei Cache-Regeln: Seite netz-zuerst, Bilder cache-zuerst, `/api/` nie |

### Der Raum

| Seite | Wofür |
|---|---|
| `akkreditierung.html` | Einlass am Tablet, QR-Scan, eigener Zugang ohne Admin-Rechte |
| `wand.html` | Beamer im Saal: Modi auto / Ruhe / Votum / Auktion / Kreis, mit Vorhang |
| `station.html` | NFC-Station zum Antippen |
| `stand.html` | Messestand-Modul (eigene Marke, Entwurf, Vorschau) |

### Das Backoffice (`monitor.html`, 3.582 Zeilen)

Anmeldung mit Name und Passwort, vier Rollen (Admin · Veranstalter · Team ·
Einlass), mehrere Runden nebeneinander.

- **Gäste**: CSV-Import, Pools, Nummern, Nachrücken, Absagen, Gast-Editor
- **Tischplan**: Zuweisung je Gang per CSV, Probelauf vor dem Übernehmen
- **Versand**: Push / Mail / beides, Ziel `alle` oder eine der drei Lücken
  oder eine **Auswahl von Adressen**, Kopie sichtbar (CC) oder still (BCC),
  Doppelversand-Sperre je Anlass, Protokoll mit Empfängern
- **App-Lücke**: wer nicht registriert ist, wer die App nicht auf dem
  Startbildschirm hat, wer keine Push erlaubt – mit Namen und Telefonnummer
- **Wellen**: drei Einladungswellen plus Einzelversand an einen Gast
- **Geld**: Stripe, Rechnung als PDF im CI, Erlös der Auktion
- **Regie**: Signal an alle Handys, Wandsteuerung, Votum enthüllen, Zuschlag
- **Danach**: Galerie-Upload und Zuordnung, News, Feedback-Auswertung

### Die Mails

Zehn Vorlagen im CI, Platzhalter aus der Runde (`{{datum_lang}}`,
`{{ort}}`, `{{beginn}}` …), Versand über Lettermint, One-Click-Abmeldung
nach RFC 8058, Bounce-Sperre, Webhook für Zustellung und Öffnung.

---

## 2 · Was die Plattform davon schon kann

Der Abgleich fällt deutlich aus: **Die Plattform ist der Circle-App in fast
allem voraus.** Was dort fehlt, ist selten die Substanz, meist die letzte
Meile zum Gast.

| Circle | planyvo | Stand |
|---|---|---|
| Persönlicher Link ohne Passwort | Magic Link (`/api/magic/*`, `/m`) | **da** |
| Teilnehmer, Import, Warteliste | `Participant`, `ImportBatch`, `EventWaitlist`, `GuestCompanion` | **da, reicher** |
| Einlass per QR | `CheckIn` + Terminal-Modus mit Offline | **da, reicher** |
| Programm | `Session`, `Track`, `PersonalAgenda`, `AgendaConfig` | **da, reicher** |
| Tischplan je Gang | `TableRotation` mit KI-Optimierung, Timer, PDF/CSV/Tischkarten | **da, deutlich reicher** |
| Verbindungen | `Connection`, `Meeting`, Networking-Matcher | **da** |
| Galerie | `Gallery` mit Ordnern, FTP, Batches, Download-Protokoll | **da, reicher** |
| Push | `PushSubscription`, `push_tokens`, Vorlagen | **da** |
| Mail | Templates, Versionen, Scheduling, Automation, Logs, Resend | **da, deutlich reicher** |
| Feedback, Umfragen, Votum, Q&A | `Feedback`, `Survey`, `SessionPoll`, `QAQuestion`, `Interaction*` | **da, reicher** |
| Momente als Fortschritt | `Point`, `Badge`, `Challenge`, `GamificationConfig` | **Bausteine da** |
| Signal an alle | `announcements`, `Broadcast` | **da** |
| Geld | `TicketCategory`, `Payment`, `Invoice`, Stripe | **da** |
| NFC | `NfcPillar`, `NfcBand`, `NfcScan`, `NfcCommand` | **da, reicher** |
| Rollen im Backoffice | `Role`, `RolePermission`, `EventTeamMember`, 2FA | **da, reicher** |
| App selbst | App-Builder: `EventApp`, `AppPage`, 49 Bausteine, native Builds (iOS/Android) | **da** |

Dazu Module, die der Circle gar nicht hat: Hotels, Shuttle, Aussteller,
Sponsoren, Zertifikate, Papers, Marktplatz, KI-Assistent, DSGVO-Werkzeuge.

---

## 3 · Die echten Lücken

Elf Punkte. Nach Wert sortiert, nicht nach Aufwand.

### A · Was jedem Event nützt

**1. App-Lücken-Report** (klein, hoher Wert)
Wer ist nicht registriert, wer hat die App nicht installiert, wer hat Push
nicht erlaubt – mit Namen, Adresse, Telefon. Und: an genau diese Gruppe
senden können. Beim Circle hat das drei Tage vor dem Abend die
Installationsquote getragen und danach die Galerie zu 91 von 94 gebracht.
Die Plattform hat alle Daten (`PushSubscription`, `Participant.lastSeen`),
aber keine Auswertung und keinen Zielgruppen-Versand.
→ Ein Endpoint, eine Dashboard-Karte, drei Zielgruppen im Versand.

**2. „Mein Tisch" für den Gast** (klein, hoher Wert)
`TableRotation` weiß, wer wo sitzt – der Gast erfährt es nicht. Es fehlt
der App-Baustein und der Gäste-Endpoint. Der Kern des Circle-Abends.
→ Ein Baustein `my-table`, ein Endpoint, Push bei Tischwechsel.

**3. Event-Phasen** (mittel, hoher Wert)
vorher / während / danach als Zustand des Events, an dem Module hängen.
Heute gibt es `publishAt`/`unpublishAt` je Modul – das ist Handarbeit für
jedes einzelne. Mit einer Phase am Event schaltet die ganze App um, und
zwar automatisch am Morgen danach.
→ Feld am Event, Sichtbarkeitsregel je Modul, Automatik über die Zeiten.

**4. Zwei Stufen vor der Zusage** (klein)
Wer noch nicht zugesagt hat, sieht nur sein Profil. Verhindert, dass die
Gästeliste vor der Zusage offen liegt.
→ Sichtbarkeitsregel am Modul, gebunden an den Teilnehmerstatus.

**5. Linkvorschau im Feed** (klein)
Open-Graph-Titel, -Text und -Bild für Links in Ankündigungen. Im Circle
serverseitig gelöst, mit Schutz gegen interne Adressen (SSRF).
→ `lib/link-preview.ts`, Code aus `server/marke.js` übernehmbar.

### B · Was den Circle ausmacht

**6. Saal-Ansicht / Beamer** (mittel)
Eine Seite für die Leinwand: Live-Zahlen, aktuelles Thema, Votum mit
Vorhang, Auktion, der Kreis. Vom Backoffice umschaltbar.
→ Neues Modul `stage`, Socket.IO ist vorhanden.

**7. Live-Signale** (klein)
Applaus, Sterne, Interesse – leichtgewichtige Rückmeldung aus dem Raum,
die auf der Wand sichtbar wird. Nicht dasselbe wie eine Umfrage.
→ Erweiterung von `Interaction`.

**8. Votum mit Enthüllung** (klein)
Erst „87 Rückmeldungen", dann auf Knopfdruck die Balken. Umfragen gibt es,
die Dramaturgie fehlt.
→ Feld `revealedAt` an `SessionPoll` plus Regie-Knopf.

**9. Auktion** (mittel bis groß)
Blind-Gebote, Zuschlag, Erlös, Rechnung an den Höchstbietenden. Fehlt
komplett. Braucht kein anderer Kunde – bis der nächste eine Charity-Auktion
will.
→ Eigenes Modul `auction`, an `Invoice` angeschlossen.

**10. Foto-Zuordnung zu Personen** (mittel)
„Deine Fotos" – Zuordnung über den Dateinamen oder eine Liste. In der
Galerie gibt es Tags, aber keine Verbindung zum Teilnehmer.
→ Verknüpfungstabelle `GalleryMedia` ↔ `Participant` plus Zuordnungs-UI.

**11. vCard-Export der Verbindungen** (klein)
Wer sich verbunden hat, nimmt den Kontakt ins Telefon mit. Ohne das endet
das Netzwerken am Ausgang.
→ Ein Endpoint, ein Knopf.

### Nicht übernehmen

- **Eigener Service Worker mit drei Cache-Regeln**: Die Plattform hat einen.
  Ob er das Playa-WLAN unter 130 Gästen aushält, ist eine Prüfung wert –
  aber kein neues Modul.
- **Rechnung als PDF**: Die Plattform hat `Invoice` und erzeugt PDFs
  (`lib/dpa-pdf.ts`). Es fehlt höchstens die CI-Vorlage.
- **`stand.html`**: eigenständiges planyvo-Produkt, gehört nicht in die
  Event-Migration.

---

## 4 · Vorschlag für die Reihenfolge

**Zuerst A1 bis A5.** Zusammen etwa eine Woche, und jedes Stück nützt
*jedem* Event im Dashboard, nicht nur dem Circle. Der Lücken-Report und
„Mein Tisch" sind dabei die zwei, die man am selben Tag im Betrieb merkt.

**Dann B6 bis B8.** Die Saal-Ansicht mit Signalen und Votum ist ein
zusammenhängendes Stück – einmal bauen, dann steht die Regie.

**B9 bis B11 nach Bedarf.** Die Auktion lohnt, sobald ein zweiter Kunde
danach fragt; vorher ist sie ein Sonderwunsch, der als Agenturleistung
sauberer aufgehoben ist.

### Wie es in die Plattform kommt

Jede Lücke wird ein Modul, kein Sonderweg:

1. `PlatformModule`-Eintrag (`circle-stage`, `circle-auction` …), Status
   erst `TESTPHASE`, dann `BETA`, dann `ACTIVE`
2. Prisma-Modelle plus Migration
3. API unter `/api/events/[eventId]/<modul>`
4. Wo der Gast es sieht: `FeatureComponent` für den App-Builder
5. Wo das Team es bedient: Dashboard-Seite
6. Externe API und MCP-Tool nachziehen, wo es Sinn ergibt

### Was danach mit diesem Repo passiert

Es bleibt bis No2 in Betrieb – die laufende Runde zieht nicht mitten im
Jahr um. Sobald A1 bis A5 und B6 bis B8 stehen, wird No2 im Dashboard
angelegt, die 151 Gäste aus No1 importiert, und dieses Repo archiviert.
Bis dahin ist es die Referenz: Was hier funktioniert hat, ist die
Anforderung an das Modul.

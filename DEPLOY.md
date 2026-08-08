# Technisches Setup · thecircle.planyvo.com

Schritt für Schritt in der abgestimmten Reihenfolge:

1. **Domain sichern und unter Plesk deployen**
2. **Lettermint aufsetzen**
3. **Monitor aufsetzen und Admin-Zugänge verteilen**
4. **Stripe aufsetzen**

Danach: Gästeliste einlesen, Livegang-Checkliste, Betrieb.

Der Server ist eine einzelne Node-Datei ohne Abhängigkeiten – kein Build,
kein `npm install`, keine Datenbank. Der ganze Zustand liegt in
`server/live-state.json`.

> **Was zuerst anstoßen?** Schritt 1 und 2 hängen beide an DNS-Einträgen, und
> die Verifizierung der Absenderdomain bei Lettermint kann sich ziehen. Wenn
> Welle 0 zeitnah rausgehen soll: die DNS-Einträge für beides gleich zu Beginn
> setzen, dann läuft die Wartezeit parallel.

---

## 1 · Domain sichern und unter Plesk deployen

### 1.1 Subdomain anlegen

Plesk → **Websites & Domains** → beim Abo `planyvo.com` → **Subdomain hinzufügen**

- Subdomain-Name: `thecircle`
- Dokumentstamm: Vorschlag `/thecircle` (Plesk legt ihn an)

### 1.2 DNS prüfen

Liegt die DNS-Zone bei Plesk, ist der A-Record automatisch da. Wird DNS
woanders verwaltet (Registrar, Cloudflare), dort von Hand anlegen:

| Typ | Name | Wert |
|---|---|---|
| A | `thecircle` | IP des Plesk-Servers |

Kontrolle:

```bash
dig +short thecircle.planyvo.com
```

### 1.3 SSL

Plesk → Subdomain → **SSL/TLS-Zertifikate** → *Let's Encrypt* → ausstellen.
„Sichere die Website" und die Weiterleitung von HTTP auf HTTPS aktivieren.

Erst wenn Schritt 1.2 greift, sonst schlägt die Ausstellung fehl.

### 1.4 Code aufspielen

**Variante A – Git in Plesk** (bequem für spätere Updates):
Subdomain → **Git** → Repository hinzufügen → Repository-URL, Branch
`claude/event-participant-app-k66kf2`, Zielverzeichnis z. B. `/thecircle`.
Bei jedem „Jetzt aktualisieren" holt Plesk den neuen Stand.

**Variante B – hochladen:** Dateien per SFTP in das Verzeichnis der Subdomain.

Wichtig ist nur, dass am Ende `server/circle-server.js`, `index.html`,
`landing.html`, `monitor.html` und `email/assets/` dort liegen.

### 1.5 Node.js-Anwendung einrichten

Subdomain → **Node.js**. Ist der Punkt nicht da: unter *Erweiterungen* die
Node.js-Erweiterung installieren.

| Feld | Wert |
|---|---|
| Node.js-Version | 18 oder neuer |
| Anwendungsmodus | `production` |
| Anwendungsstammverzeichnis | Verzeichnis mit `server/` und den HTML-Dateien |
| Anwendungsstartdatei | `server/circle-server.js` |
| Dokumentstamm | siehe Hinweis unten |

**NPM install nicht nötig** – es gibt keine Abhängigkeiten.

> **Zum Dokumentstamm:** Zeigt er direkt auf die Dateien, kann der Webserver
> `landing.html` & Co. selbst ausliefern und die Anwendung wird umgangen –
> dann funktionieren `/einladung` und die API nicht. Sicherer: einen leeren
> Unterordner (z. B. `public/`) als Dokumentstamm setzen, damit alles durch
> Node läuft. Ob es stimmt, zeigt die Probe in 1.7.

**Umgebungsvariablen** (im selben Bildschirm unter *Benutzerdefinierte
Umgebungsvariablen*) – Vorlage: `deploy/env.example`

```
PUBLIC_URL     = https://thecircle.planyvo.com
TICKET_PRICE   = 10000
ADMIN_TOKENS   = (kommt in Schritt 3)
STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET  (kommen in Schritt 4)
```

`PORT` **nicht** setzen – den vergibt Plesk selbst, die Anwendung übernimmt ihn.

Danach **Anwendung neu starten**.

### 1.6 Eine Zeile, die man leicht übersieht

Am Abend hält die App eine dauerhafte Verbindung offen (Server-Sent Events) für
Applaus, Votum und Auktion. Puffert nginx sie, bleiben die Zähler stehen –
und das merkt man erst im Saal.

Subdomain → **Apache & nginx Einstellungen** → *Zusätzliche nginx-Direktiven*:

```nginx
location /api/live/stream {
    proxy_pass http://127.0.0.1:$node_port;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
}
```

Nimmt Plesk `$node_port` nicht an, den konkreten Port aus dem Node.js-Bildschirm
eintragen. Alternativ genügt oft schon:

```nginx
proxy_buffering off;
```

### 1.7 Prüfen

```bash
curl -s https://thecircle.planyvo.com/api/live/health      # {"ok":true}
curl -sI https://thecircle.planyvo.com/assets/portrait-amiaz.jpg | head -1
```

Im Browser:

- `…/einladung?demo=1` → die Landing Page als Vorführung
- `…/` → die App

Kommt stattdessen ein Verzeichnislisting, ein 403 oder der Rohtext einer
HTML-Datei, zeigt der Dokumentstamm auf die Dateien statt auf die Anwendung
→ zurück zu 1.5.

**Damit ist die Domain live.**

---

## 2 · Lettermint aufsetzen

### 2.1 Absenderdomain verifizieren

Konto anlegen, Absenderdomain hinterlegen (z. B. `thecircle.planyvo.com` oder
eine Adresse der Veranstalter). Lettermint nennt DNS-Einträge – **SPF**, **DKIM**,
meist **DMARC**. Diese in der DNS-Verwaltung der jeweiligen Domain eintragen.

*Ohne verifizierte Domain landen die Mailings im Spam.* Das ist der Schritt mit
der unklarsten Wartezeit – deshalb früh anstoßen.

### 2.2 Templates anlegen

Für jede Datei aus `email/` ein Template, Inhalt komplett hineinkopieren:

| Datei | Template | Wann |
|---|---|---|
| `save-the-date.html` | Welle 0 · Save the Date | vor dem Ticketverkauf |
| `einladung-ticket.html` | Welle 1 · Ticket | Einladung mit Beitrag |
| `einladung-ehrengast.html` | Welle 1 · Ehrengast | Einladung ohne Beitrag |
| `app-zugang.html` | Welle 2 · App-Zugang | wenige Tage vor dem Abend |

### 2.3 Bild-Adressen eintragen

Die Bilder liegen bereits auf der Subdomain. In den Templates bekommen die
Variablen feste Werte:

```
header_img_url      https://thecircle.planyvo.com/assets/circle-header.jpg
logo_url            https://thecircle.planyvo.com/assets/logo-neg.svg
portrait_amiaz_url  https://thecircle.planyvo.com/assets/portrait-amiaz.jpg
portrait_ien_url    https://thecircle.planyvo.com/assets/portrait-ien.jpg
portrait_max_url    https://thecircle.planyvo.com/assets/portrait-max.jpg
partnerwand_url     https://thecircle.planyvo.com/assets/partnerwand-bordeaux.jpg
```

Die übrigen Variablen (`anrede`, `vorname`, `link`, `partner_logo_url`,
`platz_satz` …) kommen aus der Versandliste – siehe Schritt 5.

### 2.4 Webhook

Adresse: `https://thecircle.planyvo.com/api/lettermint/webhook`
Ereignisse: *sent, delivered, opened, clicked*

Damit füllen sich Öffnungs- und Klickraten im Monitor. Klicks erkennt der
Server auch selbst, sobald ein Gast die Landing Page öffnet – der Webhook macht
es nur genauer.

### 2.5 Testversand

Ein Template an die eigene Adresse schicken und **in Gmail und in Outlook**
ansehen: Bilder da? Schrift in Ordnung? Button klickbar?

---

## 3 · Monitor aufsetzen und Admin-Zugänge verteilen

Der Monitor liegt unter `https://thecircle.planyvo.com/monitor` und zieht seine
Zahlen aus `/api/admin/pools`. Dort stehen Namen, E-Mail-Adressen und
Unverträglichkeiten – **ohne Schlüssel wäre das offen im Netz.**

### 3.1 Je Person einen Schlüssel

Nicht ein gemeinsames Geheimnis, sondern einen pro Person. Dann lässt sich ein
Zugang entziehen, ohne allen anderen den Link zu ändern.

Schlüssel erzeugen (je Person einmal):

```bash
openssl rand -hex 16
```

Als Umgebungsvariable im Plesk-Node.js-Bildschirm, Format `name:schlüssel`:

```
ADMIN_TOKENS = anne:1f3c…,desi:9ab2…,renate:4d7e…,dylan:c821…,nicole:77af…
```

Danach **Anwendung neu starten**. Im Log steht dann, wie viele Zugänge aktiv
sind und auf welche Namen sie laufen.

### 3.2 Links verteilen

Jede Person bekommt ihren eigenen Link:

```
https://thecircle.planyvo.com/monitor?key=<ihr-schlüssel>
```

Am besten mit einem Satz dazu: *Bitte nicht weiterleiten – der Link enthält
Gästedaten. Auf dem Handy als Lesezeichen speichern.*

### 3.3 Prüfen

```bash
# ohne Schlüssel: abgewiesen
curl -s https://thecircle.planyvo.com/api/admin/pools
# → {"error":"kein Zugriff"}

# mit Schlüssel: Zahlen
curl -s "https://thecircle.planyvo.com/api/admin/pools?key=<schlüssel>" | head -c 200
```

Der Monitor zeigt Demo-Daten, solange keine Gästeliste eingelesen ist – das ist
richtig so. Mit den echten Zahlen wechselt oben rechts die Kennzeichnung von
*Demo* auf *Live-Daten*.

**Einen Zugang entziehen:** den Eintrag aus `ADMIN_TOKENS` löschen, Anwendung
neu starten. Alle anderen Links gelten weiter.

---

## 4 · Stripe aufsetzen

### 4.1 Konto

Firmendaten und Bankverbindung hinterlegen. Bis zur Freischaltung im
**Testmodus** arbeiten (Schalter oben rechts im Dashboard).

Vorher klären: **auf welches Konto der Ticketerlös fließen soll** – das ist der
einzige Punkt, an dem die Veranstalter mitentscheiden müssen.

### 4.2 Schlüssel

**Entwickler → API-Schlüssel** → *Geheimer Schlüssel* (`sk_test_…`) als
`STRIPE_SECRET_KEY` in die Umgebungsvariablen.

### 4.3 Webhook

**Entwickler → Webhooks → Endpunkt hinzufügen**

- Adresse: `https://thecircle.planyvo.com/api/stripe/webhook`
- Ereignis: `checkout.session.completed` (nur dieses)
- Nach dem Anlegen das **Signing secret** (`whsec_…`) als
  `STRIPE_WEBHOOK_SECRET` eintragen

Anwendung neu starten.

### 4.4 Testzahlung

```bash
# Testgäste einlesen (auf dem Server, im Anwendungsverzeichnis)
node server/circle-server.js import server/gaesteliste-vorlage.csv
node server/circle-server.js export | head -3      # einen Link kopieren
```

Link öffnen → zusagen → im Checkout die Testkarte `4242 4242 4242 4242` mit
beliebigem künftigen Datum und CVC.

Danach muss der Gast seine Ticket-Nummer sehen und im Monitor auf **bezahlt**
stehen. Bleibt er auf „zugesagt, nicht bezahlt", kam der Webhook nicht an →
Stripe → *Webhooks → Versuche* zeigt die Antwort des Servers.

### 4.5 Auf Live umstellen

Nach der Freischaltung: Live-Schlüssel holen (`sk_live_…`) **und einen zweiten
Webhook-Endpunkt im Live-Modus anlegen** – dessen Signing secret ist ein
anderes. Beide Werte eintragen, Anwendung neu starten.

Danach eine echte Zahlung über 100 € durchführen und in Stripe wieder
erstatten – der einzige Weg, den Live-Betrieb wirklich zu prüfen.

> Der Server prüft jede Webhook-Signatur (HMAC-SHA256, 5-Minuten-Fenster gegen
> Replays) und bucht idempotent: ein doppelt zugestelltes Ereignis zählt nicht
> doppelt.

---

## 5 · Gästeliste einlesen

CSV der Veranstalter auf den Server legen, dann im Anwendungsverzeichnis:

```bash
node server/circle-server.js import gaesteliste.csv
node server/circle-server.js export > versand.csv
```

`versand.csv` enthält je Gast `pool, typ, anrede, vorname, name, email, partner,
partner_logo, platz_satz, link, status` – die Spaltennamen entsprechen genau den
Merge-Variablen der Templates. Diese Datei wird in Lettermint importiert.

**Ein erneuter Import überschreibt keine Zusagen.** Schlüssel ist die E-Mail;
Token, Status und Zahlungen bleiben erhalten. Nachzügler lassen sich also
jederzeit nachschieben.

> Nach dem Import über Plesk **Anwendung neu starten**, damit der laufende
> Prozess die neue Liste kennt – er hält sie im Speicher.

---

## 6 · Vor dem ersten echten Versand

- [ ] `dig +short thecircle.planyvo.com` zeigt die richtige IP
- [ ] `/api/live/health` antwortet über HTTPS
- [ ] Alle sieben Bilder unter `/assets/…` laden im Browser
- [ ] `/einladung?demo=1` zeigt die Landing Page (kein Verzeichnislisting)
- [ ] `/api/admin/pools` ohne Schlüssel gibt `{"error":"kein Zugriff"}`
- [ ] Jede Person hat ihren Monitor-Link und kommt rein
- [ ] Absenderdomain in Lettermint verifiziert (SPF/DKIM grün)
- [ ] Testmailing in Gmail **und** Outlook angesehen
- [ ] Persönlicher Link aus der Testmail zeigt den richtigen Namen
- [ ] Testzahlung durchgelaufen, Monitor steht auf „bezahlt"
- [ ] Stripe auf Live umgestellt, zweiter Webhook angelegt, echte Zahlung geprüft

---

## Betrieb

**Änderungen ausrollen:** Plesk → Git → *Jetzt aktualisieren*, danach
**Anwendung neu starten**. Ohne Neustart läuft der alte Stand weiter.

**Sicherung.** Der gesamte Zustand liegt in `server/live-state.json`. Ein
täglicher Cron in Plesk (**Geplante Aufgaben**) genügt:

```bash
cp ~/thecircle/server/live-state.json ~/backups/circle-$(date +\%F).json
```

**Logs:** Plesk → Subdomain → *Logs*. Die Ausgaben der Anwendung stehen im
Node.js-Bildschirm bzw. in `logs/`.

**Nach dem Event.** In `live-state.json` stehen Namen, E-Mail-Adressen und
Unverträglichkeiten – personenbezogene und teils Gesundheitsdaten. Sobald die
Abrechnung durch ist: Datei und Sicherungen löschen. Was für die Nachbereitung
gebraucht wird, vorher anonymisiert sichern (Zahlen je Pool statt Namen). Für
die Zahlungsbelege genügt Stripe.

---

## Wenn etwas klemmt

| Symptom | Ursache | Lösung |
|---|---|---|
| Let's Encrypt schlägt fehl | DNS zeigt noch nicht auf den Server | `dig` prüfen, warten, erneut ausstellen |
| Verzeichnislisting statt Landing Page | Dokumentstamm zeigt auf die Dateien | leeren Unterordner als Dokumentstamm setzen (1.5) |
| 502 / Anwendung startet nicht | falsche Startdatei oder Node zu alt | Startdatei `server/circle-server.js`, Node ≥ 18 |
| Live-Zähler steht am Abend | nginx puffert die SSE-Verbindung | Direktiven aus 1.6 eintragen |
| „Zahlung ist noch nicht scharf geschaltet" | `STRIPE_SECRET_KEY` fehlt | Variable setzen, Anwendung neu starten |
| Zahlung bleibt auf „zugesagt" | Webhook kommt nicht an | Stripe → Webhooks → Versuche; Adresse und Modus prüfen |
| „Signatur ungültig" im Log | falsches Signing secret | Test- und Live-Endpunkt haben verschiedene |
| Bilder fehlen in der Mail | Adresse falsch oder Bild nicht erreichbar | `curl -I …/assets/<datei>` |
| Mailing landet im Spam | Domain nicht verifiziert | SPF/DKIM in Lettermint prüfen |
| Monitor zeigt Demo-Daten | keine Liste eingelesen oder Schlüssel fehlt | importieren, mit `?key=…` öffnen |
| Neue Gästeliste wirkt nicht | Prozess hält die alte im Speicher | Anwendung neu starten |

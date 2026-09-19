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

**Absender: `hello@the-circle-cologne.de`** (von Desi bestätigt)

> ✅ **ERLEDIGT — Domain ist verifiziert.** Alle vier Records stehen und wurden
> von Lettermint bestätigt („Your domain is ready"): `_dmarc` (war vorhanden),
> `lm-bounces`, `lm1._domainkey`, `lm2._domainkey`. Am bestehenden SPF wurde
> nichts geändert. Die Schritte unten sind zur Nachvollziehbarkeit dokumentiert.

Konto anlegen, diese Absenderdomain hinterlegen. Lettermint nennt dann
DNS-Einträge – **SPF**, **DKIM**, meist **DMARC**.

Die DNS-Zone liegt bei **IONOS** (Nameserver `ui-dns.*`), Zugang vorhanden –
wir setzen die Einträge selbst. Die Bilder in den Mails liegen weiterhin auf
`thecircle.planyvo.com`; das ist unabhängig vom Absender.

**Bestandsaufnahme der Zone (geprüft):**

| Eintrag | Bestand |
|---|---|
| SPF (TXT) | `v=spf1 include:_spf-eu.ionos.com ~all` – **existiert bereits** |
| MX | `mx00.ionos.de`, `mx01.ionos.de` – Mailempfang läuft über IONOS |
| DMARC | `v=DMARC1; p=none;` – existiert, blockiert nichts |

> ### Kein SPF-Eingriff noetig (geprueft in der Lettermint-Oberflaeche)
>
> Lettermint arbeitet **CNAME-basiert** und verlangt **keine Aenderung am
> bestehenden SPF-Record**. Verlangt werden nur drei CNAMEs auf eigenen
> Subdomains:
>
> | Typ | Hostname | Wert / Ziel |
> |---|---|---|
> | CNAME | `lm-bounces` | `bounces.lmta.net` |
> | CNAME | `lm1._domainkey` | `lm1.mwe5cqblic7azkezwvo6z74nzq.dkim.lmta.net` |
> | CNAME | `lm2._domainkey` | `lm2.mwe5cqblic7azkezwvo6z74nzq.dkim.lmta.net` |
>
> (Die DKIM-Kennung `mwe5cq…` gilt fuer diese Domain. Wird der DKIM-Key in
> Lettermint rotiert, aendern sich die Werte und muessen hier nachgezogen werden.)
>
> Das ist die gute Nachricht: Der vorhandene `v=spf1 include:_spf-eu.ionos.com
> ~all` bleibt **unangetastet**, das Risiko fuer die bestehende `hello@`-Adresse
> entfaellt. `_dmarc` war bereits vorhanden und wurde von Lettermint sofort als
> **verified** erkannt.
>
> **Achtung, zwei aehnliche Domains im selben IONOS-Konto:** Es gibt
> `the-circle-cologne.de` (mit Bindestrichen, die echte Mail-Domain) und
> `thecirclecologne.de` (ohne, nur eine Weiterleitung). Beide haben MX auf
> IONOS. Die Records gehoeren in die Variante **mit Bindestrichen** - in der
> anderen haetten sie keine Wirkung.
>
> **IONOS-Detail:** Im Hostname-Feld nur den **Subdomain-Teil** eintragen
> (`lm1._domainkey`), nicht die volle Adresse - IONOS haengt die Domain selbst
> an. Sonst entsteht `lm1._domainkey.the-circle-cologne.de.the-circle-cologne.de`.
>
> **Schneller Weg:** Lettermint bietet auf der DNS-Seite einen **"Connect IONOS"**
> Knopf (One-click IONOS setup), der die Records direkt in die Zone schreibt.
> Da alle drei Records auf neuen Subdomains liegen und nichts Bestehendes
> ueberschreiben, ist das der risikoarme und schnellste Weg.

**In IONOS:** Domains & SSL → `the-circle-cologne.de` → DNS → die drei CNAMEs
oben **neu anlegen** (am bestehenden SPF nichts ändern). Nach dem Speichern in
Lettermint auf „Verify all" – meist wenige Minuten, manchmal länger.

Zusätzlich festlegen: **Reply-To** (wohin Antworten der Gäste gehen).

### 2.2 Kein Template-Import — der Server verschickt selbst

**Lettermint hat keinen Vorlagen-Editor mit Serienbrief-Feldern.** Es ist ein
reiner Versanddienst mit einer Schnittstelle. Deshalb werden die Vorlagen aus
`email/` **nicht** irgendwo hochgeladen: Unser Server setzt für jeden Gast
selbst Anrede, Namen, persönlichen Link und Partnerlogo ein und
übergibt Lettermint die fertige Mail.

Das ist auch der sicherere Weg. Ginge die Zuordnung über eine hochgeladene
Tabelle, könnte sie beim nächsten Import verrutschen — und ein Gast bekäme den
persönlichen Link eines anderen und damit Einblick in dessen Daten. So gibt es
nur eine Quelle: das Gästeregister auf dem Server.

Welche Vorlage wer bekommt, entscheidet der Server nach Typ und Partner:

| Welle | Gast | Vorlage |
|---|---|---|
| 0 · Save the Date | alle | `save-the-date.html` |
| 1 · Einladung | Bezahlgast aus dem eigenen Netzwerk (100 €) | `einladung-ticket.html` |
| 1 · Einladung | Gast eines Partners (zahlt nicht, mit Partnerlogo) | `einladung-ehrengast-partner.html` |
| 1 · Einladung | Ehrengast des Hauses (zahlt nicht, ohne Logo) | `einladung-ehrengast.html` |
| 2 · App-Zugang | ohne Partner | `app-zugang.html` |
| 2 · App-Zugang | Gast eines Partners | `app-zugang-partner.html` |

Der Partner-Block steckt in einer **eigenen Vorlage**, nicht in einer Bedingung.
Ein Gast ohne Partner sähe sonst eine leere Überschrift mit gebrochenem Bild.

> **Wer zahlt, wer nicht** (Festlegung Desi/Nicole, 19.08.): Gäste, die ein
> **Partner** eingeladen hat, sind **Gäste dieses Partners** — sie zahlen nichts
> und sehen sein Logo. **Bezahlgäste** kommen aus dem eigenen Netzwerk (IMW,
> AERA, Public Cologne), zahlen 100 € und sehen **kein** fremdes Logo — die
> Einladung kommt ja vom Haus selbst. Deshalb steht in den Partnerlisten
> `typ = ehrengast`, und Pools mit „Partner" im Namen werden beim Import
> automatisch als Ehrengäste geführt. Ein Partner-Gast, der versehentlich als
> `ticket` importiert wird, fällt im Trockenlauf mit einer Warnung auf.

Wer schon zu- oder abgesagt hat, bekommt keine Einladung mehr; Welle 2 geht
**nur** an bestätigte Gäste, weil der App-Link persönliche Daten zeigt. Wer sich
abgemeldet hat, ist aus **allen** Wellen raus.

Die zehn Partnerlogos liegen negativ-weiß unter:

```
https://thecircle.planyvo.com/assets/partner-neuland-neg.png
https://thecircle.planyvo.com/assets/partner-conrad-neg.png
https://thecircle.planyvo.com/assets/partner-deindach-neg.png
https://thecircle.planyvo.com/assets/partner-dekra-neg.png
https://thecircle.planyvo.com/assets/partner-jto-neg.png
https://thecircle.planyvo.com/assets/partner-merzenich-neg.png
https://thecircle.planyvo.com/assets/partner-sion-neg.png
https://thecircle.planyvo.com/assets/partner-sks-neg.png
https://thecircle.planyvo.com/assets/partner-fuchsrohrbach-neg.png
https://thecircle.planyvo.com/assets/partner-smartvelo-neg.png
```

Vorlage für die Partner-Gästeliste: `server/gaesteliste-partner-vorlage.csv`
(10 Partner × 4 Zeilen, Pool/Partner/Logo schon gesetzt – nur Anrede, Name und
E-Mail eintragen). Dann wie in §5 importieren.

### 2.3 API-Schlüssel und Absender hinterlegen

In Lettermint unter **API tokens** einen Schlüssel erzeugen. Er wird **nur
einmal angezeigt** — sofort in Plesk eintragen, unter *Node.js → Custom
environment variables*:

```
LETTERMINT_TOKEN            der Schlüssel aus Lettermint
MAIL_FROM                   THE CIRCLE <hello@the-circle-cologne.de>
MAIL_REPLY_TO               wohin Antworten der Gäste gehen sollen
LETTERMINT_WEBHOOK_SECRET   „Signing secret" aus den Webhook-Einstellungen
WEBSITE_URL                 Ziel des Welle-0-Buttons (Default: https://www.the-circle-cologne.de)
MAIL_ROUTE                  optional: benannte Lettermint-Route (leer = Standard)
```

> **Wichtig für den Versand per Kommandozeile:** Die Variablen aus dem
> Plesk-Panel gelten **nur für die laufende App** — eine SSH- oder
> Cron-Shell sieht sie nicht. Beim `welle`-Befehl deshalb immer
> `PUBLIC_URL=… LETTERMINT_TOKEN=…` direkt davorschreiben (Beispiele
> in §2.5). Vergisst man `PUBLIC_URL`, verweigert `--senden` von selbst,
> statt Mails mit localhost-Links zu verschicken.

Der Schlüssel gehört **nie ins Repository** — nur in die Plesk-Umgebung. Taucht
er versehentlich in einem Screenshot, einer Mail oder einem Commit auf: in
Lettermint löschen und einen neuen erzeugen. Danach *Restart App*.

Bilder, Links und Abmeldeadresse setzt der Server selbst ein (aus `PUBLIC_URL`
und dem Gästeregister) — hier ist nichts einzutragen. Nur zur Kontrolle, was
in den Mails steht:

```
header_img_url      https://thecircle.planyvo.com/assets/circle-header.jpg
logo_url            https://thecircle.planyvo.com/assets/logo-zentriert-neg.png
portrait_*_url      https://thecircle.planyvo.com/assets/portrait-*.jpg
partnerwand_url     https://thecircle.planyvo.com/assets/partnerwand-bordeaux.jpg
link                https://thecircle.planyvo.com/einladung?t=TOKEN   (je Gast)
app_link            https://thecircle.planyvo.com/?t=TOKEN            (je Gast)
abmelden_url        https://thecircle.planyvo.com/abmelden?t=TOKEN    (je Gast)
```

**Die Logos sind PNG, kein SVG.** Gmail und Outlook filtern SVG in `<img>`
heraus – dann fehlt die Wortmarke.

Impressum und Datenschutz stehen fest im Fuß jeder Vorlage und zeigen auf
`the-circle-cologne.de`. Beides ist **Pflicht** für werblichen Versand
(§5 DDG / DSGVO); fehlt die ladungsfähige Anschrift, ist das Mailing
abmahnfähig. Vor dem ersten echten Versand einmal beide Links anklicken.

### 2.4 Webhook

Adresse: `https://thecircle.planyvo.com/api/lettermint/webhook`
Ereignisse: *sent, delivered, opened, clicked* — **und unbedingt auch
*bounced* und *complained*** (bzw. wie die Bounce-/Beschwerde-Ereignisse im
Konto heißen; alle verfügbaren anhaken schadet nicht, Unbekanntes ignoriert
der Server einfach).

Warum die zwei letzten wichtig sind: Ein **Bounce** markiert die Adresse als
unzustellbar — sie wird in künftigen Wellen automatisch übersprungen, statt
die Reputation der jungen Absenderdomain weiter zu belasten. Eine
**Beschwerde** („als Spam markiert") zählt als Abmeldung: der Gast fällt aus
allen weiteren Wellen. Beides erscheint im Monitor.

Das **Signing secret** aus derselben Maske gehört als
`LETTERMINT_WEBHOOK_SECRET` nach Plesk (§2.3). Ohne dieses Secret weist der
Server jeden Webhook ab — sonst könnte jeder Fremde „zugestellt" und
„geöffnet" in unser Register schreiben und die Zahlen im Monitor verfälschen.

Jede Mail trägt außerdem die **One-Click-Abmelde-Header** (RFC 8058):
Gmail und Outlook zeigen damit ihren eigenen „Abmelden"-Knopf — bei
Bulk-Versand verlangen sie das inzwischen, und es schützt vor
Spam-Markierungen.

### 2.5 Versand — erst Trockenlauf, dann Testmail, dann Welle

**Wo tippt man das ein?** Der Versand ist ein Kommandozeilen-Befehl im
Anwendungsverzeichnis. Zwei Wege auf einem Plesk-Server:

- **SSH:** Websites & Domains → Hosting-Einstellungen → *Zugriff auf den
  Server über SSH* auf `/bin/bash` stellen (steht oft auf „verboten"), dann
  per SSH einloggen und ins Anwendungsverzeichnis wechseln.
- **Geplante Aufgaben:** Plesk → *Geplante Aufgaben* → „Befehl ausführen",
  einmalig jetzt — derselbe Mechanismus wie beim Backup (§ Betrieb). Für
  den Trockenlauf die Ausgabe per Mail zuschicken lassen.

Das Node.js-Panel selbst hat keinen passenden Knopf („Run script" braucht
eine package.json, die es hier bewusst nicht gibt).

**Die Variablen gehören vor den Befehl** — das Plesk-Panel reicht sie nur an
die App durch, nicht an deine Shell:

```bash
# Zuerst in das Anwendungsverzeichnis - das SSH-Terminal in Plesk startet
# eine Ebene hoeher, und dort gibt es kein server/.
cd /var/www/vhosts/planyvo.com/thecircle.planyvo.com

export PUBLIC_URL=https://thecircle.planyvo.com
export LETTERMINT_TOKEN=lm_...          # und ggf. MAIL_REPLY_TO

# 1. Trockenlauf: Wer bekäme was? Rendert jede Mail komplett durch.
node server/circle-server.js welle 1

# 2. Eine davon ansehen, so wie sie beim Gast ankäme
node server/circle-server.js welle 1 --vorschau=vorschau.html

# 3. Testmail an die eigene Adresse
node server/circle-server.js welle 1 --nur=deine@adresse.de --senden

# 4. Erst ein Pool, wenn die Testmail sitzt (findet alle Pools, die das Wort enthalten)
node server/circle-server.js welle 1 --pool=neuland --senden

# 5. Die ganze Welle
node server/circle-server.js welle 1 --senden
```

**Ohne `--senden` geht garantiert nichts raus.** Und `--senden` verweigert von
selbst, wenn `PUBLIC_URL` fehlt — sonst stünden localhost-Links in den Mails.
Werte immer mit `=` anhängen (`--nur=adresse`, nicht `--nur adresse`); bei
falscher Schreibweise bricht der Befehl ab, statt still die ganze Welle zu
nehmen.

Wellen: `0` Save the Date · `1` Einladung · `2` App-Zugang.
Weitere Schalter: `--limit=5` (höchstens fünf Mails), `--erneut` (siehe unten).

**Doppelt schickt er nicht.** Jeder Erfolg landet sofort im Versand-Gedächtnis
(`server/versand-log.json`). Bricht ein Lauf bei Mail 120 von 200 ab, schickt
der nächste Aufruf nur an die 80, die noch fehlen — bereits Angeschriebene
werden übersprungen und im Kopf ausgewiesen. `--erneut` übersteuert das
bewusst (z. B. korrigierte Vorlage nochmal an einen Pool). `--nur=` ignoriert
das Gedächtnis ohnehin — Testmails an sich selbst gehen immer.

**Die App darf dabei weiterlaufen.** Der Versand schreibt `live-state.json`
nicht an; Zusagen, Zahlungen und Webhooks laufen während des Versands normal
weiter. (Nur beim **Import** gilt weiterhin: App stoppen, §5.)

Der Trockenlauf ist kein Ritual: Er rendert jede einzelne Mail wirklich fertig
und bricht ab, wenn ein Platzhalter offen bliebe oder ein Gast keinen Namen
hat („Hallo ," wäre die Anrede). Lieber hier ein Fehler als 200 Gäste, die
ihn im Postfach sehen.

Die Testmail **in Gmail und in Outlook** ansehen: Bilder da? Schrift in
Ordnung? Button klickbar? Und den persönlichen Link einmal wirklich anklicken.

Verschickt wird nacheinander mit kurzer Pause — das schont die Zustellbarkeit
einer noch jungen Absenderdomain. Bei ein paar hundert Gästen dauert eine Welle
darum ein bis zwei Minuten; das Fenster offen lassen, bis die Schlusszeile
kommt.

---

## 3 · Monitor aufsetzen und Admin-Zugänge verteilen

Der Monitor liegt unter `https://thecircle.planyvo.com/monitor` und zieht seine
Zahlen aus `/api/admin/pools`. Dort stehen Namen, E-Mail-Adressen und
Unverträglichkeiten – **ohne Schlüssel wäre das offen im Netz.**

### 3.0 Anmeldung mit Name und Passwort (seit 19.09.2026)

Der Schlüssel im Link (`?key=`) ist nur noch der Notzugang. Im Alltag melden
sich alle unter `/monitor` mit Name und Passwort an – das Cookie hält 30 Tage.

1. Einmal mit dem Schlüssel-Link hinein: `/monitor?key=…`
2. Reiter **Verwaltung → Nutzer**: sich selbst als *admin* anlegen (Name,
   E-Mail, Passwort oder leer = wird erzeugt), dann die anderen. Das
   Startpasswort steht genau einmal auf dem Schirm.
3. Ab dann: `/monitor` ohne Schlüssel → Anmeldemaske. Weitere Nutzer legt ein
   Veranstalter dort an.

Rollen: **admin** (planyvo – Nicole, Mathis) und **veranstalter** (der Kunde –
Desi) dürfen alles; Admins legt nur ein Admin an. **team** pflegt Gäste, Tische, Links,
Fotos – kein Versand an alle, keine Regie, keine Zahlungen, keine Verwaltung
(der Server lehnt das mit 403 ab, der Monitor blendet es aus). **einlass**
landet nach der Anmeldung direkt auf `/akkreditierung` und sieht nur die Liste.

Passwort vergessen: ein Veranstalter setzt unter Verwaltung ein neues. Ein
neues Passwort meldet alle alten Sitzungen dieses Nutzers ab.

### 3.1 Je Person einen Schlüssel (Notzugang)

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

Der Monitor aktualisiert sich alle 60 Sekunden selbst – die Seite muss nicht
neu geladen werden. Ganz oben steht, **was zu tun ist** (unzustellbare
Adressen, Zusagen ohne Zahlung, Gäste ohne Mailadresse, wer auf die nächste
Welle wartet); jede Kachel springt gefiltert in die Gästeliste ganz unten.

### 3.3 Prüfen

```bash
# ohne Schlüssel: abgewiesen
curl -s https://thecircle.planyvo.com/api/admin/pools
# → {"error":"kein Zugriff"}

# mit Schlüssel: Zahlen
curl -s "https://thecircle.planyvo.com/api/admin/pools?key=<schlüssel>" | head -c 200
```

Oben rechts steht immer, woher die Zahlen kommen – **darauf ist Verlass**:

| Kennzeichnung | Was sie bedeutet |
|---|---|
| *Live-Daten* | Zugang gültig, jede Zahl auf der Seite kommt aus dem Register |
| *Demo · Platzhalterdaten* | Kein Server erreichbar – nichts auf der Seite ist echt |
| *Kein Zugriff* | Schlüssel fehlt oder gilt nicht → Link mit `?key=…` prüfen |
| *Monitor nicht eingerichtet* | `ADMIN_TOKENS` fehlt → 3.1 |
| *Zahlen frieren ein* | Verbindung während des Betriebs abgerissen; die letzten echten Zahlen stehen noch da, sind aber alt |

Ist der Zugang gültig und das Register noch leer, stehen alle Zahlen auf null
und unter den Pools steht, dass die erste Liste noch fehlt (§5) – das ist
richtig so und nicht der Demo-Modus.

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

Danach muss der Gast die Bestätigung sehen und im Monitor auf **bezahlt**
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

> **Reihenfolge ist entscheidend.** Der laufende Prozess hält den Stand im
> Speicher und schreibt ihn alle 2 s nach `live-state.json` – ein Import bei
> laufender Anwendung wird also sofort wieder überschrieben. Deshalb:
> **1. Anwendung im Node.js-Panel stoppen → 2. importieren → 3. wieder starten.**

CSV der Veranstalter auf den Server legen, dann im Anwendungsverzeichnis:

```bash
node server/circle-server.js import gaesteliste.csv
node server/circle-server.js export > versand.csv
```

Der Import genügt — **`versand.csv` wird nirgends hochgeladen.** Der Versand
läuft über §2.5 direkt aus dem Register. Die Datei ist nur zum Nachsehen: sie
zeigt je Gast `pool, typ, anrede, vorname, name, email, partner_name,
partner_logo_url, platz_satz, link, app_link, ticket_nr, status, abgemeldet` und
damit genau die Werte, die der Server in die Mails einsetzt. Gut, um vor einer
Welle einmal quer zu lesen, ob Anreden und Partnerzuordnungen stimmen.

Statt der CLI geht der Export auch über den Browser:
`https://thecircle.planyvo.com/api/admin/versandliste?key=<zugang>` – dann
entfällt das Autosave-Risiko oben, weil nichts importiert wird.

**Ein erneuter Import überschreibt keine Zusagen.** Schlüssel ist die E-Mail;
Token, Status und Zahlungen bleiben erhalten. Nachzügler lassen sich also
jederzeit nachschieben.

---

## 6 · Vor dem ersten echten Versand

- [ ] `dig +short thecircle.planyvo.com` zeigt die richtige IP
- [ ] `/api/live/health` antwortet über HTTPS
- [ ] Alle Bilder unter `/assets/…` laden im Browser
- [ ] `/einladung?demo=1` zeigt die Landing Page (kein Verzeichnislisting)
- [ ] `/api/admin/pools` ohne Schlüssel gibt `{"error":"kein Zugriff"}`
- [ ] Jede Person hat ihren Monitor-Link und kommt rein
- [ ] Absenderdomain in Lettermint verifiziert (SPF/DKIM grün)
- [ ] `LETTERMINT_TOKEN`, `MAIL_FROM`, `MAIL_REPLY_TO`,
      `LETTERMINT_WEBHOOK_SECRET` in Plesk gesetzt, Anwendung neu gestartet
- [ ] Trockenlauf `welle 1` läuft ohne Abbruch durch
- [ ] Testmailing in Gmail **und** Outlook angesehen
- [ ] Persönlicher Link aus der Testmail zeigt den richtigen Namen
- [ ] Abmeldelink im Fuß der Testmail einmal angeklickt (führt auf „Abgemeldet")
- [ ] Impressum und Datenschutz im Fuß führen auf echte Seiten
- [ ] Testzahlung durchgelaufen, Monitor steht auf „bezahlt"
- [ ] Stripe auf Live umgestellt, zweiter Webhook angelegt, echte Zahlung geprüft

---

## 7 · Die App am Abend – und danach

Die App (`/?t=…`) ist mit dem persönlichen Link aus Welle 2 erreichbar.
Was sie am Abend kann, steuert der Monitor; was sie danach am Leben hält,
auch. Vier Dinge vorher, ein Ablauf für den Tag, einer für die Wochen danach.

### 7.1 Vorher in Plesk (einmalig)

| Variable | Wozu |
|---|---|
| `VAPID_PUBLIC`, `VAPID_PRIVATE`, `VAPID_SUBJECT` | Web Push – gebraucht **nach** dem Abend (Fotos, News, nächste Runde). Am 16.09. selbst geht keine Push raus, siehe 7.3a. Ohne die drei ist Push ganz aus; der Monitor sagt es unter „Vorbereitung“ → „Die App“. Einmal erzeugen (unten), **nie wechseln**: ein neuer Schlüssel macht alle Abos der Gäste ungültig. |
| `TZ=Europe/Berlin` | Logs und Serveruhr in Kölner Zeit. Die App-frei-Fenster rechnen ohnehin in Kölner Zeit. |
| `VERANTWORTLICH`, `DATENSCHUTZ_KONTAKT` | Impressum und Datenschutz unter `/impressum`, `/datenschutz`. Solange sie fehlen, steht dort „noch einzutragen“. |
| `RUNDE=no1` | In welche Runde neue Importe fallen. Gästebuch, Galerie und News sind je Runde getrennt – die Gäste von No2 sehen die von No1 nicht. |

Schlüssel erzeugen, auf dem Server, im Anwendungsverzeichnis:

```bash
node -e "console.log(require('./server/webpush').schluesselErzeugen())"
```

Die beiden Werte **nur** in Plesk eintragen (nicht in eine Mail, nicht in
einen Chat), dann Anwendung neu starten. Prüfen: Monitor → „Vorbereitung“ → „Die App“ zeigt
keine VAPID-Warnung mehr; Knopf „Push-Probe“ schickt eine an alle, die sie
erlaubt haben.

### 7.2 Tischplan (Jonan)

CSV mit Kopfzeile, eine Zeile je Gast:

```
email,gang1,gang2,gang3
anna@beispiel.de,1,3,2
```

Statt `email` geht auch `name` (muss dem Namen im Register entsprechen).
In den Gang-Spalten darf statt der Nummer der **Tischname** stehen
(`Merzenich`, `Tisch Merzenich`, `SKS`). Die zehn Tische sind vorbelegt, in
der Reihenfolge der gedruckten Tischordnung:

| Nr | Tisch | Nr | Tisch |
|---|---|---|---|
| 1 | DeinDach | 6 | neuland.ai |
| 2 | Conrad | 7 | Sion |
| 3 | jto | 8 | SKS |
| 4 | fuchsrohrbach | 9 | SMARTVÉLO |
| 5 | Merzenich | 10 | DEKRA |

Die App zeigt am Tisch das Partnerlogo, wie auf dem Schild im Raum. Andere
Namen im Monitor unter Tischordnung, eine je Zeile: `1;Dom`. Ablauf im
Monitor → „Vorbereitung“ → „Tischordnung“: **Probelauf** (zeigt unbekannte
Adressen, unbekannte Tischnamen und Gäste ohne Platz), dann **Übernehmen**.
Einzelne Plätze am Abend über „Platz setzen“ – ohne die ganze Datei neu zu
laden. Der Tisch steht in der App als eckige Karte mit zwei Reihen; die
Reihenfolge darin ist alphabetisch, nicht die Sitzordnung.

### 7.1a Demo für das Team

Monitor → „Vorbereitung“ → „Die App“ → **Demo für das Team**: eine Zeile je Person
(`Name;E-Mail;Firma;Rolle`), dann „Demo-Gäste anlegen“. Jede Person bekommt
einen echten persönlichen Link und geht durch dieselbe Registrierung wie ein
Gast (Profil, Bild, Freigabe, Startbildschirm, Push). Die Demo-Gäste bilden
eine eigene Runde: Sie sehen im Gästebuch nur einander, haben einen kleinen
Tischplan mit Wechsel je Gang und bekommen Signale, Tischwechsel und Push
aus dem Monitor wie alle. In Pools, Funnel, Wellen und „Wer fehlt noch“
tauchen sie nicht auf.

Das Team steht meist auch auf der echten Gästeliste. Deshalb ist die
Demo-Kopie ein getrennter Eintrag ohne Mailadresse (die Adresse steht nur
zur Anzeige im Monitor): Der nächste Import der Gästeliste würde sonst die
Kopie statt des echten Eintrags aktualisieren. Der echte Eintrag und der
echte Link bleiben unberührt.

Links nur persönlich weitergeben (WhatsApp an die Person, nicht in die
Gruppe). Nach der Demo: „Alle Demo-Gäste löschen“ nimmt Profile, Bilder,
Verbindungen und Plätze wieder heraus. Wer die App mit dem Demo-Link auf
den Startbildschirm gelegt hat, öffnet sie danach einmal mit dem echten
Link und legt sie neu ab – das Symbol startet sonst mit dem gelöschten
Demo-Zugang.

**Den Abend vorab ohne Grauschleier sehen:** an den eigenen Demo-Link
`&demo=1` anhängen. Ein Chip oben springt durch die Uhrzeiten des Abends
(17:30 · 19:36 Impuls · 19:55 AV8 · 21:40 Live Painting · 22:50 Auktion),
die Karten öffnen sich wie am echten Abend. Was man dort anklickt, zählt
in die echten Zähler – danach im App-Panel **AV8-Zähler auf null**.

**Die Glocke** (oben rechts in der App, ab Stufe „alles“): Anfragen an
mich und alle Meldungen des Abends (Tischwechsel mit eigenem Tisch,
Ansagen) zum Nachlesen, auch wenn das Banner längst weg ist. Eine neue
Anfrage kommt live an: Toast, Vibration, Zahl an der Glocke – kein
Neuladen nötig.

### 7.1a2 Stand des Abends (10.09., nach Desis Durchsicht)

- **Das vorgestellte Start-up ist planyvo.** AV8 hat abgesagt. Der Punkt im
  Ablauf heißt „planyvo stellt sich vor“, die drei Fragen an den Raum
  (investieren, Sterne, Interesse) bleiben. Die Kennung im Code ist weiter
  `av8` – daran hängen die gespeicherten Momente.
- **Der Ring mit den fünf Momenten ist wieder da**, ebenso der Reiter
  „Live“. Zurücknehmen ließe sich das mit `const LIVE_AN = false;` in
  `index.html`.
- **Die Auktion läuft nur im Raum** (Blind-Auktion). Wand und Monitor
  behalten sie. In der App gibt es dafür weder Bieterkarte noch Gebote noch
  Schätzspiel. An ihrer Stelle steht **„Wie soll das Werk heißen?“**: Ab
  22:45 schlägt jeder Gast einen Titel für Max Leinfelders Bild vor, und
  damit schließt sich für ihn der Kunst-Moment. Die Vorschläge stehen im
  Monitor unter „Regie → Auktion & Wand → Titel für das Werk“, dort auch
  als CSV für Max.
- **Kein Banner beim Tischwechsel.** Der Plan aktualisiert sich still, der
  Wechsel steht auch nicht in der Glocke. Ansagen erscheinen weiter.
- **Zwei Gänge mit Tischwechsel** (Vorspeise, Hauptspeise). Das Dessert
  wird ohne Wechsel serviert. Die Tischplan-CSV hat nur noch `gang1,gang2`;
  eine ältere Spalte `gang3` wird gelesen und ignoriert.
- **Der Abend ist offen.** Nirgends steht mehr „bis 23:00 Uhr“, sondern
  „ab 18:00 Uhr“; in „Gut zu wissen“ heißt es „Beginn 18:00 Uhr · Ende
  offen“. Der Kalendereintrag (ICS) bleibt bei 18–23 Uhr, weil ein Termin
  ohne Ende in vielen Kalendern gar nicht erst angelegt wird.
- **Foto und Video:** Wer in den Kreis eintritt, hakt vorher ab, dass
  Aufnahmen entstehen und verwendet werden dürfen. Ohne Haken kein
  Eintritt; der Zeitpunkt wird am Gast gespeichert.

### 7.1a3 Check-in am Einlass per QR-Code

Jeder Gast bekommt **mit Welle 2 seinen eigenen Code** in der Mail
(`{{qr_url}}`, ein PNG vom Server). Er steht außerdem in der App ganz oben
unter „Dein Check-in“ – am Einlass sucht niemand in seinen Mails.

**Am Abend:** Ein Handy oder Tablet am Einlass, Kamera auf den Code. Der
Code führt auf `…/einlass?g=TOKEN`; die Seite zeigt groß den Namen und den
Knopf **„Einchecken“** – erst der Tipp darauf checkt ein. Das Aufrufen der
Adresse allein tut nichts mehr: Mail-Scanner in Firmennetzen (Microsoft
Defender u. a.) lesen den QR-Code aus der Welle-2-Mail aus und rufen die
Adresse auf – am 14.09. standen so neun Gäste zwei Tage vor dem Abend „im
Haus“. Der Scanner im Monitor (Reiter *Einlass*) ist davon nicht betroffen,
er läuft über die Admin-API.

| Farbe | Bedeutung |
|---|---|
| Hell | Gast erkannt, Knopf „Einchecken“ |
| Grün | Willkommen – oder „Ist schon eingecheckt“ |
| Orange | Steht nicht auf der Gästeliste für heute (Status dabei) |
| Rot | Code gehört zu keinem Gast |

Darunter „Nächsten Gast scannen“ – so läuft es ohne Zurücktippen weiter.

Der eingecheckte Gast sieht es sofort in seiner App: Die Karte dreht sich
auf „Eingecheckt“, und der erste Moment im Kreis ist gesetzt.

Den Encoder dafür liefert `server/qr.js` – eine einzelne gebündelte Datei
(qrcode, MIT), kein `npm install`. Selbst gerechnet wäre der Code das
falsche Risiko: Ob er stimmt, merkt man erst, wenn 130 Leute vor der Tür
stehen.

### 7.1a4 Der Reiter „Einlass“ im Monitor

An der Tür steht jemand anderes als in der Regie. Deshalb hat der Einlass
einen **eigenen Reiter**: `/monitor?key=…#einlass`. Dort gibt es genau
zwei Dinge und keinen Knopf, der in alle Apps durchschlägt.

**Der Scanner.** „Scanner öffnen“ macht die Kamera an und liest die Codes
der Gäste am Stück – ohne dass sich zwischendurch eine Seite öffnet. Jeder
Treffer färbt den Schirm groß: grün „Willkommen“ bzw. „War schon
eingecheckt“, orange „Steht nicht auf der Gästeliste für heute“, rot
„Unbekannt“. Derselbe Code zählt drei Sekunden lang nur einmal, damit ein
Gast, der seinen Code stehen lässt, nicht zehnmal gemeldet wird.

Browser mit eigenem Codeleser (Android) nehmen den; alle anderen – jedes
iPhone – holen sich `/jsqr.js` von uns (jsQR, Apache-2.0, `server/jsqr.js`,
131 KB, wird nur bei Bedarf geladen). **Kein CDN:** Am Abend darf der
Einlass nicht daran hängen, ob ein fremder Server erreichbar ist.

Wenn die Kamera nicht freigegeben ist oder gar nicht existiert, sagt es
der Scanner und schließt sich – die Liste bleibt.

**Die Liste zum Abhaken.** Alle Gäste des Abends, alphabetisch, mit Suche
nach Name und Firma und drei Filtern (Noch nicht da · Schon da · Alle).
Eine Zeile antippen setzt den Haken samt Uhrzeit; noch einmal antippen
nimmt ihn nach Rückfrage zurück. Oben steht „X von Y im Haus“.

Scanner, Liste und die Seite `/einlass` schreiben **dasselbe Feld**. Der
Einlass kann also jederzeit wechseln: Kamera streikt → abhaken. Gast hat
sein Handy nicht dabei → abhaken. Beides sieht die App des Gastes sofort.

**Demo-Gäste zählen mit, aber nicht in der Zahl.** Sie stehen in der Liste
mit dem Vermerk „Probe“, damit sich der ganze Weg – Code scannen, Name auf
dem Schirm, Haken in der Liste – vorher üben lässt. In „X von Y im Haus“
tauchen sie nicht auf. Vor dem Abend löschen: Reiter Vorbereitung → „Alle
Demo-Gäste löschen“.

### 7.1b Welle 2: erst nur das Profil, dann alles

Der App-Zugang (Welle 2) geht Tage vor dem Abend raus – aber die Gäste
sollen zunächst nur eines tun: ihr Profil ergänzen. Deshalb hat die App vor
dem Abend zwei Stufen:

| Stufe | Der Gast sieht | Wann |
|---|---|---|
| **Nur das Profil** (Vorgabe) | Registrierung wie bisher (Bild, Rolle, Kontaktfreigabe, Startbildschirm, Push), danach die Startseite mit Profilkarte, Countdown und „Gut zu wissen“. Keine Leiste, kein Programm, kein Tischplan, kein Gästebuch. | ab Welle 2 |
| **Alles freischalten** | Die ganze App. Öffnet sich sofort in allen offenen Apps, mit einem Hinweis „Jetzt offen: Programm, Tischplan und Gästebuch“. | kurz vor dem Abend, wenn der Tischplan steht |

Der Schalter: Monitor → „Vorbereitung“ → „Die App“ → **Was die Gäste
sehen**. Nach dem Neustart steht er auf „Nur das Profil“, es ist nichts zu
tun. Am 16.09. und danach ist die App **immer** ganz offen, egal wie der
Schalter steht – ein vergessener Klick nimmt am Abend niemandem den
Tischplan.

Die Mail zu Welle 2 (`app-zugang.html`, `app-zugang-partner.html`) sagt
das auch so: heute nur das Profil, Programm und Tischplan folgen kurz vor
dem 16. September. Hochladen muss man nichts (§2.2): Der Server setzt die
Vorlagen aus `email/` beim Versand selbst zusammen, mit dem Pull sind sie
aktuell. Vor dem Versand einmal anschauen:
`node server/circle-server.js welle 2 --vorschau=welle2.html`.

Per Hand, ohne Monitor:

```
curl -X POST -H 'Content-Type: application/json' -d '{"stufe":"voll"}' \
  'https://thecircle.planyvo.com/api/admin/app-stufe?key=SCHLÜSSEL'
```

### 7.2a Drei Tage vorher: die Lücke schließen

Erzwingen lässt sich die Installation auf keinem Handy. Sehen und
schließen lässt sie sich:

1. Monitor → „Vorbereitung“ → „Die App“ → **Wer fehlt noch?** zeigt drei Namenslisten:
   nicht registriert, registriert aber nicht auf dem Startbildschirm,
   installiert aber ohne Push. Mit Adresse und Telefon.
2. Monitor → „Danach“ → Nachricht, Anlass **Erinnerung · App
   einrichten**. Das Ziel springt auf „nur an die ohne App“ und der Kanal
   auf Mail (Push erreicht diese Gruppe per Definition nicht). Probe an die
   eigene Adresse, dann an alle. Für die Nicht-Registrierten dasselbe mit
   Ziel „noch nicht registriert“.
3. Wer danach noch auf der Liste steht, bekommt einen Anruf von Anne oder
   Hilfe am Einlass (siehe 7.3).

### 7.3 Am 16.09. – Checkliste für 17:00 (Mathis)

- [ ] Monitor auf dem Handy offen, Reiter „Regie“ (`/monitor?key=…#regie`)
- [ ] Optional, nur wenn die Playa einen Bildschirm hat: die Wand (`/wand`, Vollbild) zeigt AV8-Votum, Auktion und den Kreis; ohne Bildschirm stehen dieselben Zahlen im Monitor
- [ ] Regie: Uhr (Köln) stimmt auf die Minute; unter „Vorbereitung“ → „Zeiten“ steht die Phase auf **Automatik**
- [ ] Zeiten-Tabelle gegen den Ablauf von Desi geprüft (App-frei: 19:30 Impuls I, 21:15 Impuls II, 22:45 Auktion)
- [ ] Tischplan übernommen, „Ohne Platz“ leer oder bekannt
- [ ] Regie, Zeile unter der Uhr: „x im Haus“ gelesen. Der Tischwechsel erscheint in **jeder offenen App** als Banner und im Reiter Tisch – wer die App zu hat, sieht ihn beim nächsten Öffnen
- [ ] „Wer fehlt noch?“ offen auf dem Handy am Einlass: Name des Gastes suchen, Mail öffnen lassen, auf dem iPhone „In Safari öffnen“ → Teilen → „Zum Home-Bildschirm“, dann Push erlauben
- [ ] Regie zeigt „Push: heute Abend aus“ – so ist es gewollt (7.3a). Die Push-Probe gehört vor den 16.09.
- [ ] Ein Signal testen und zurücknehmen: „Nur in die App“ mit einem Satz → erscheint im eigenen Handy → „Zurücknehmen“
- [ ] Falls Wand im Einsatz: einmal durch Ruhe → AV8 (Vorhang zu) → Auktion → Kreis → Automatik
- [ ] Wissen, wo **Notfall: alles frei** ist (nimmt Signal, Handschalter und alle Fenster zurück)

Am Abend selbst: Tischwechsel je Gang über die drei Knöpfe in der Regie
(fragt nach). Verschiebt sich alles: **+15 Min** schiebt Ablauf, App-frei-
und Live-Fenster gemeinsam – nur, was noch vor uns liegt.

### 7.3a Am 16.09. geht keine Push raus

So abgestimmt mit den Veranstaltern: An diesem Abend bekommt niemand eine
Benachrichtigung, auch nicht zum Tischwechsel. Der Server sperrt Push
automatisch, solange die Phase „abend" läuft – niemand muss daran denken.

Was stattdessen passiert: Der Tischwechsel steht **sofort in jeder offenen
App** als Banner über dem Bild und im Reiter Tisch. Wer die App gerade zu
hat, sieht ihn beim nächsten Öffnen. Dasselbe gilt für Ansagen.

Die Regie zeigt den Zustand über den Tischwechsel-Knöpfen. Muss doch einmal
etwas dringend aufs Handy, gibt es dort „Push freigeben" – danach wieder
sperren. Nach dem Abend (Phase „danach") sind Push wieder normal erlaubt;
genau dafür liegt die App auf dem Startbildschirm.

**Fünf Minuten vor jedem app-freien Fenster** zeigt die App eine Leiste mit
Countdown: „Impuls · Ien Bäumler – schließ ab, was offen ist." Im Fenster
selbst steht, bis wann es dauert. So weiß jeder, dass er sein Votum oder
seinen Tipp noch abgeben kann.

### 7.4 Danach – Fotos, News, Feedback

1. **Phase.** Am Morgen des 17. steht die App von selbst auf „danach“
   (Startseite ohne Countdown, Leiste mit Galerie und News). Wenn nicht:
   Monitor → „Vorbereitung“ → „Zeiten“ → Phase **Danach**.
2. **Feedback-Frage** (24–36 h danach): Monitor → „Danach“ →
   Nachricht, Anlass *Feedback-Frage*, erst **Probe** an die eigene Adresse,
   dann **An alle**. Antworten stehen darunter, CSV zum Herunterladen.
3. **Fotos.** Fotograf liefert JPEGs; wer auf einem Bild ist, steht am
   besten im Dateinamen (`anna@beispiel.de_01.jpg` → landet bei Anna als
   „Deine Fotos“). Hochladen unter `/upload?key=…` (verkleinert im Browser,
   Originale bleiben lokal). Restliche Zuordnung im Monitor per Liste
   `datei;email,email` – Probelauf, dann Übernehmen. Dann **Galerie öffnen**,
   dann Nachricht *Galerie ist offen* (Push + Mail).
4. **News** jederzeit: Entwurf speichern, veröffentlichen, zurückziehen.
   Steht in der App unter „News“ mit Zähler am Reiter. Für ein Datum von
   No2 die Karte unter „THE CIRCLE No2“ füllen – sie steht dann auf der
   Startseite jedes Gastes.

Jeder Anlass geht **einmal** an die Runde; ein zweiter Versand fragt nach.
Das Protokoll (Push gesendet / ohne Abo, Mail gesendet / ohne Adresse) steht
unter dem Formular.

**Sicherung nach dem Abend:** neben `live-state.json` auch die Ordner
`server/fotos/` (Profilbilder) und `server/galerie/` (Galerie) – beide
sind nicht im Repo.

---

## 7b · Die nächste Runde anlegen

Im Monitor unter **Verwaltung → Runden**: Name (z. B. `THE CIRCLE No2`),
Datum, Beginn, Einlass, Ort, Adresse – „Anlegen und aktiv schalten“.

Was „aktiv“ bedeutet: Neue Gäste (Import, Nachtrag, Stand) fallen in diese
Runde; Phase (vor · abend · danach), app-freie Fenster, Mail-Platzhalter
(`{{datum_lang}}`, `{{beginn}}`, `{{ort}}`, `{{adresse}}`, `{{runde_name}}`),
Kalenderdatei, Rechnung und die Startseite der App richten sich nach ihr.
Gäste, Tischplan, Galerie, Verbindungen und die Sendungs-Sperre bleiben je
Runde getrennt – die Gäste von No1 sehen weiter ihre Runde. Handschalter
(Phase, App-Stufe, Push-Freigabe, Live-Bereiche) werden beim Umschalten
zurückgesetzt. Zurückschalten geht jederzeit.

`RUNDE` in der Umgebung gilt nur noch, solange der Zustand keine aktive Runde
kennt.

## 8 · Der Stand auf showoff.planyvo.com

Der Touchscreen am planyvo-Stand gehört nicht zu diesem Abend – er gehört
planyvo. Deshalb läuft er als **eigene Anwendung auf einer eigenen
Subdomain**: eigener Absender, eigener Zustand, eigene Adresse. Von
THE CIRCLE steht dort nichts mehr fest im Code; der Anlass ist eine
Umgebungsvariable und beim nächsten Stand eine andere.

Dieselben Dateien, ein Schalter: `APP_MODE=stand`. In dieser Betriebsart
antwortet der Server nur noch auf den Stand und seine Schnittstellen –
Gäste-App, Monitor, Wand, Einlass, Stripe und die Wellen sind dort gar
nicht erst erreichbar.

### 8.1 Subdomain und Code

Plesk → beim Abo `planyvo.com` → **Subdomain hinzufügen** → `showoff`
(angelegt am 14.09.). Danach wie in Schritt 1:

- **SSL:** Subdomain → *SSL/TLS-Zertifikate* → Let's Encrypt, HTTP→HTTPS an
- **Git:** Repository hinzufügen, Branch `claude/event-participant-app-k66kf2`,
  Zielverzeichnis `/showoff` – **ein eigenes Verzeichnis**, nicht das von
  `thecircle`. Zwei Node-Prozesse im selben Ordner würden sich beim
  Schreiben von `live-state.json` gegenseitig überschreiben.
- **Node.js:** Startdatei `server/circle-server.js`, Anwendungsmodus
  `production`, kein `npm install`

### 8.2 Umgebungsvariablen (nur diese)

| Variable | Wert | wofür |
|---|---|---|
| `APP_MODE` | `stand` | schaltet auf den Stand-Betrieb |
| `PUBLIC_URL` | `https://showoff.planyvo.com` | eigene Adresse |
| `STAND_ANLASS` | `THE CIRCLE No1` | der Anlass, an dem der Stand gerade steht – **leer lassen, sobald er woanders steht** |
| `STAND_QUELLE` | `showoff` | landet als `?stand=…` im QR-Code, damit planyvo sieht, woher der Besuch kam |
| `STAND_STADT` | `Köln` | vorbelegte Stadt im Formular |
| `STAND_MAIL_FROM` | `planyvo <hello@planyvo.com>` | Absender der Entwurfsmail |
| `LETTERMINT_TOKEN` | derselbe wie beim Abend | Versand |
| `ADMIN_TOKENS` | derselbe Eintrag wie beim Abend | um die Entwürfe zu lesen – mit demselben Schlüssel holt der CSV-Knopf im Monitor sie von dort |
| `PLANYVO_API_KEY` | optional | legt jeden Entwurf direkt im Dashboard an |

Nicht setzen: Stripe-Schlüssel, Webhook-Secrets, VAPID. Der Stand braucht
nichts davon, und was nicht da ist, kann auch nicht verloren gehen.

`STAND_KICKER` und `STAND_MAIL_ROUTE`/`STAND_MAIL_REPLY_TO` gibt es
zusätzlich, falls die Zeile über der Überschrift oder die Lettermint-Route
einmal abweichen soll. Ohne Angabe: aus dem Anlass abgeleitet bzw. wie beim
Abend.

### 8.3 Absender prüfen – **vor** dem Abend

`hello@planyvo.com` muss in Lettermint als Absenderdomain eingerichtet sein,
sonst lehnt der Versand die Mail ab und der Gast am Stand bekommt nichts.
Einmal prüfen:

```bash
curl -X POST "https://showoff.planyvo.com/api/admin/stand-probe?key=DEIN_SCHLUESSEL&an=deine@adresse.de"
```

- `{"ok":true,…}` – die Mail ist unterwegs, Absender steht in der Antwort
- `{"error":"Lettermint 4xx …"}` – Domain fehlt dort. Dann entweder in
  Lettermint nachtragen oder `STAND_MAIL_FROM` auf den bisherigen Absender
  zurücksetzen, bis das erledigt ist.

Die Probe legt nichts an und verbraucht nichts. Kontrolle, dass alles
angekommen ist:

```bash
curl -s https://showoff.planyvo.com/api/live/health
# modus: "stand" · standAnlass: "THE CIRCLE No1" · standAbsender: "planyvo <…>"
```

### 8.4 Durchspielen ohne Spuren

`https://showoff.planyvo.com/stand?probe=1` läuft genau wie der echte
Stand – Website auslesen, Logo und Farbe ziehen, Telefonvorschau –, legt
aber keinen Entwurf an und schickt keine Mail. Oben rechts steht ein Band
„Probelauf". Für den Abend die Adresse **ohne** `?probe=1` öffnen.

### 8.5 Die alte Adresse

Auf der Circle-Anwendung `STAND_URL=https://showoff.planyvo.com` setzen:
`thecircle.planyvo.com/stand` leitet dann dorthin weiter, damit nichts aus
der Vorbereitung ins Leere läuft.

### 8.6 Die Entwürfe abholen

```bash
curl -s "https://showoff.planyvo.com/api/admin/stand-entwuerfe.csv?key=DEIN_SCHLUESSEL" -o stand.csv
```

Sie liegen jetzt in der `live-state.json` der Stand-Anwendung, nicht mehr in
der des Abends.

---

## Betrieb

**Änderungen ausrollen:** Plesk → Git → *Jetzt aktualisieren*, danach
**Anwendung neu starten**. Ohne Neustart läuft der alte Stand weiter.

**Eine Absage vermerken.** Die meisten Absagen kommen per Mail, über Dylan
oder am Telefon – nicht über den persönlichen Link. Im Monitor unter
*Einladung → Gästeliste · Mailstatus* steht in der Spalte **Stand** bei
jedem Gast „Absage vermerken". Eine Rückfrage, ein Druck, fertig: Der Gast
fällt aus Welle 2 und aus der Gästeliste am Einlass, sein QR-Code zeigt
dort ab dann orange statt grün.

Bei einem Abgesagten heißt derselbe Knopf **„Absage zurücknehmen"** und
setzt ihn auf *offen* – er kann dann wieder über seinen Link zusagen.

**Bezahlte Teilnahmen haben keinen Knopf**, dort steht „erst in Stripe
erstatten". Da hängt Geld dran; die Erstattung gehört nach Stripe, danach
lässt sich der Stand ändern.

Wer es lieber auf der Kommandozeile macht, kann weiterhin:

```bash
curl -s -X POST 'https://thecircle.planyvo.com/api/admin/absage?key=…&email=gast@example.com'
```

**Einen einzelnen Gast anlegen oder ändern.** `/api/admin/gast` legt einen
Gast an, wenn die Adresse neu ist, und ändert ihn sonst. Die Antwort
enthält seinen persönlichen Link – praktisch, wenn ein Partner kurzfristig
einen Platz weitergibt:

```bash
curl -s -X POST 'https://thecircle.planyvo.com/api/admin/gast?key=…&name=Uwe%20Rießler&email=uwe@example.com&pool=DEKRA&typ=ehrengast&anrede=Lieber&firma=DEKRA%20SE&rolle=Bereichsleiter&partner=DEKRA&partner_logo=partner-dekra-neg.png'
```

Die Regel dabei: **Was du nicht mitschickst, bleibt, wie es war.** Wer nur
den Partner nachträgt, verliert Firma, Rolle und Pool nicht. Ein Feld
*bewusst* leeren geht, indem man es leer mitgibt – `&firma=` löscht die
Firma. Angelegt wird der Gast mit Status *offen*; zugesagt ist er erst,
wenn er über seinen Link zusagt.

**Etwas an einem bestehenden Gast ändern – immer mit `gid`.** Die gid
steht in der Gästeliste des Monitors (`/api/admin/gaeste`) an jedem Gast.
Mit ihr trifft der Aufruf genau diesen einen Menschen, egal was in Adresse
oder Name steht; Token, Link, Nummer, Zusage und Zahlung bleiben, eine neue
Adresse löscht die Bounce-Sperre der alten:

```bash
curl -s -X POST 'https://thecircle.planyvo.com/api/admin/gast?key=…&gid=c3472f87dce4&email=max@example.de'
```

Ohne `gid` sucht der Aufruf über die Adresse und – bei neuer Adresse – über
Name **und Pool**. Wer dann den Pool weglässt, legt einen zweiten Gast im
Pool „Allgemein“ an. So ist am 14.09. ein Doppelgänger entstanden; deshalb
für Korrekturen die gid.

**Einen Gast entfernen** geht nur, solange er nichts erlebt hat – keine
Mail, keine Zusage, keine Zahlung. Alles andere bleibt als Absage stehen,
damit die Zahlen stimmen:

```bash
curl -s -X POST 'https://thecircle.planyvo.com/api/admin/gast-entfernen?key=…&gid=8438ceec00ca'
```

Dasselbe gilt für ganze Listen über `/api/admin/import`: Spalten, die die
Liste nicht hat, bleiben unangetastet. Eine Liste ohne `pool`-Spalte wirft
also niemanden mehr in den Pool „Allgemein".

**Rechnungen.** Die Angaben stehen in **`deploy/rechnung.json`** – Ausstellerin
(Ihre Markenwerkstatt mit Anschrift und Steuernummer), Umsatzsteuersatz,
Nummernkreis, Zahlungsempfänger (THE CIRCLE) und Bankverbindung. Nichts davon
muss in Plesk eingetragen werden; mit dem nächsten Pull und Restart ist die
Rechnung scharf. Die `RECHNUNG_*`-Variablen aus `deploy/env.example`
überschreiben einzelne Werte nur, falls ein Server andere braucht.

Sobald `aktiv` auf `true` steht, bekommt **jede neue Zahlung** ihre Rechnung
von selbst, wenige Sekunden nach der Bestätigungsmail. Wer *vor* dem
Einschalten bezahlt hat, steht im Monitor unter *Einladung → Rechnungen* als
„fällig" – ein Knopf schickt sie nach. Jede Rechnung bekommt eine feste
Nummer (`CIRCLE-2026-0001` …), die auch bei einem gescheiterten Versand am
Gast bleibt; ein zweiter Anlauf schickt dieselbe Rechnung noch einmal.

Das Blatt ist ein Geschäftsbrief in der CI von THE CIRCLE, ausgestellt von
der Agentur: oben rechts die Rechnungsstellerin, unten im Fuß der
Zahlungsempfänger mit Bankverbindung – als Angabe, nicht als Aufforderung,
denn über Stripe ist beim Versand längst bezahlt. **Die Mail trägt die
Rechnung zusätzlich als A4-PDF im Anhang** (`Rechnung-CIRCLE-2026-0001.pdf`),
vom Server selbst gezeichnet – ohne Browser, ohne Bibliothek.

**Richtige Rechnung, fortlaufende Nummer.** Mail, Text und PDF entstehen aus
denselben Werten des Gastes (Name, Firma, gezahlter Betrag aus Stripe, Datum
der Zahlung) und gehen an die E-Mail-Adresse, an die auch die Einladung ging.
Die Nummer zählt der Server hoch (`rechnungZaehler` in `live-state.json`)
und schreibt sie beim ersten Anlauf fest an den Gast; ein zweiter Anlauf
verbraucht keine neue Nummer und ein Gast kann keine zweite Rechnung
bekommen, solange die erste zugestellt ist. Lücken entstehen so nicht: eine
Nummer wird erst vergeben, wenn das Blatt tatsächlich gebaut wird, und bleibt
auch dann am Gast, wenn Lettermint gerade nicht antwortet.

Jede ausgestellte Rechnung liegt zusätzlich als Datei in
**`server/rechnungen/<Nummer>.pdf`** (nicht im Repo) – die Kopie für die
Buchhaltung, bitte mit sichern. Im Monitor steht an jedem bezahlten Gast der
Link *Rechnung … (PDF)*, der das Blatt genau so ausgibt, wie es verschickt
wurde; *PDF-Muster ansehen* im Rechnungsblock zeigt das Layout mit
erfundenem Gast, ohne eine Nummer zu verbrauchen. *Probemail an mich*
schickt die komplette Rechnungsmail mit Musterdaten und PDF-Anhang an
eine beliebige Adresse (Betreff mit „[Muster]“), ebenfalls ohne Nummer.
Von Hand:

```
https://thecircle.planyvo.com/api/admin/rechnung.pdf?key=KEY            # Muster
https://thecircle.planyvo.com/api/admin/rechnung.pdf?key=KEY&gid=GID    # echte Rechnung eines Gastes
curl -s -X POST 'https://thecircle.planyvo.com/api/admin/rechnung-probe?key=KEY&an=du@example.de'   # Probemail
```

**Rechnungsanschrift nachreichen, Rechnung berichtigt schicken.** Bei
100 € ist die Anschrift des Empfängers keine Pflicht, aber Firmen wollen
sie für ihre Buchhaltung. Im Monitor steht an jedem bezahlten Gast
*Anschrift nachtragen & erneut senden*: Anschrift eingeben (Zeilen mit `|`),
dann geht dieselbe Rechnung mit derselben Nummer noch einmal raus, auf dem
Blatt mit dem Vermerk „berichtigte Fassung … ergänzt um die
Rechnungsanschrift“ – so, wie § 31 Abs. 5 UStDV das vorsieht. Das erste
PDF bleibt als `<Nummer>-v1.pdf` liegen. Von Hand:

```bash
curl -s -X POST 'https://thecircle.planyvo.com/api/admin/gast?key=KEY&gid=GID&rechnungsanschrift=Dreischeibenhaus|40211%20D%C3%BCsseldorf'
curl -s -X POST 'https://thecircle.planyvo.com/api/admin/rechnung-erneut?key=KEY&gid=GID'
```

**Der Stand (Touchscreen).** `https://thecircle.planyvo.com/stand` ist die
Seite für den planyvo-Stand: „Bau dein Event. In drei Minuten.” Vier
Schritte (Was, Wann, Bausteine, Look), rechts entsteht die App als
Vorschau, am Ende Name und Mail.

**Die Marke aus der Website.** In Schritt 1 gibt der Gast seine Adresse
ein („deinefirma.de”), und der Server liest daraus Logo, Farbe und
Markennamen: die Vorschau steht sofort in seinem Look. Gelesen werden
`theme-color`, CSS-Variablen mit *brand/primary/accent* im Namen, Farben
an Knöpfen und Kopfzeilen sowie bis zu drei Stylesheets; als Logo zählt
zuerst ein `<img>` mit „logo” im Namen, dann das App-Symbol, dann das
Vorschaubild. Die weiteren gefundenen Farben stehen in Schritt 4 zur
Auswahl – die Heuristik trifft oft, aber nicht immer, und Antippen ist
schneller als Diskutieren. Gefunden wird nichts bei Logos, die als SVG im
Seitenquelltext stehen; dann bleibt es bei Farbe und Name.

Die Adresse kommt von einem Fremden an einem öffentlichen Bildschirm,
deshalb ist der Abruf eng geführt (`server/marke.js`): nur http und https,
jede Zieladresse wird aufgelöst und gegen private Netze geprüft – auch nach
jeder Weiterleitung –, sechs Sekunden Zeitlimit, 600 KB für die Seite,
400 KB je Stylesheet. Logos laufen über `/api/stand/bild`, damit sie auch
von http-Seiten und trotz Hotlink-Schutz erscheinen; dort gelten dieselben
Regeln plus: nur Bilder, höchstens 2 MB. Der Entwurf geht als Mail an den Gast
(`email/stand-entwurf.html`) und steht im Monitor unter *Einladung →
Event-Entwürfe* mit CSV-Export. Steht in Plesk ein **`PLANYVO_API_KEY`**
(Agentur-Schlüssel aus dem planyvo-Dashboard, Zahnrad → API Keys), legt
der Server den Entwurf zusätzlich sofort als **DRAFT im planyvo-Dashboard**
an: erst die Company (Firma des Gastes oder sein Name, seine Adresse als
Ansprechpartner), dann das Event mit Beschreibung aus den gewählten
Bausteinen. Ohne Schlüssel bleibt es beim Eintrag im Monitor, und das Event
wird von Hand bzw. über den MCP-Server angelegt. Der Stand ist die
Aufnahme, kein zweiter Baukasten. Ohne Berührung springt die Seite nach 90 s zum
Startbild zurück, nichts vom Vorgänger bleibt stehen. Auf dem Monitor am
Stand: Browser im Vollbild (Chrome: F11, Kiosk-Modus `--kiosk`), Bildschirm-
Ruhezustand aus, Adresse `/stand`. Eigene Bildschirmtastatur ist eingebaut.

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
| `LETTERMINT_TOKEN fehlt` beim Versand | Variable fehlt in der Shell (Plesk-Panel reicht nur an die App durch) | `export LETTERMINT_TOKEN=…` vor dem Befehl, §2.5 |
| Mails mit localhost-Links | `PUBLIC_URL` fehlte in der Shell | `--senden` bricht dann von selbst ab; `export PUBLIC_URL=…` setzen |
| „0 Empfänger" trotz voller Liste | alle schon angeschrieben (Versand-Gedächtnis) oder Pool-Filter trifft nicht | Kopfzeile lesen; `--erneut` bzw. `--pool=` als Wortteil |
| Trockenlauf bricht mit „unbekannte Platzhalter" ab | Vorlage nutzt ein Feld, das der Server nicht kennt | Feldnamen in `renderMail()` und Vorlage abgleichen |
| Öffnungsraten bleiben bei null | Webhook wird mit 401 abgewiesen | Im Monitor unten „Webhook-Eingang" lesen; bei „401 Signatur" muss `LETTERMINT_WEBHOOK_SECRET` dem Signing secret entsprechen |
| Webhook-Eingang bleibt ganz leer | Lettermint schickt nichts hierher | Endpunkt bei Lettermint prüfen: `…/api/lettermint/webhook`, Ereignisse sent/delivered/opened/clicked |
| Zweite Welle bleibt im Monitor „nicht zugestellt" | war der alte Sammelstand je Gast | behoben – der Server führt den Stand je Welle; oben in der Gästeliste die Welle wählen |
| Monitor zeigt Demo-Daten | Server nicht erreichbar | Läuft die Anwendung? Stimmt die Adresse? |
| Monitor meldet „Kein Zugriff" | Schlüssel fehlt oder gilt nicht | Link mit `?key=…` öffnen, Eintrag in `ADMIN_TOKENS` prüfen |
| Monitor meldet „Monitor nicht eingerichtet" | `ADMIN_TOKENS` fehlt | §3.1 |
| Live, aber alle Zahlen auf null | keine Gästeliste eingelesen | importieren (§5) |
| Neue Gästeliste wirkt nicht | Prozess hält die alte im Speicher | Anwendung neu starten |

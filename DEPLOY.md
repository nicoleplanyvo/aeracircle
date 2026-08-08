# Technisches Setup · thecircle.planyvo.com

Schritt für Schritt von null bis zum ersten versendeten Mailing. Gedacht für
planyvo – die Veranstalter brauchen davon nichts.

Der Server ist **eine Node-Datei ohne Abhängigkeiten**. Es gibt keinen Build,
kein npm install, keine Datenbank. Deshalb reicht ein kleiner Linux-Server.

**Zeitbedarf:** Schritt 1–8 rund eine Stunde, danach ist die Seite live.
Stripe und Lettermint je etwa 30 Minuten, plus Wartezeit für DNS-Einträge.

---

## Was gebraucht wird

| Zugang | Wofür | Kosten |
|---|---|---|
| Server (Hetzner Cloud CX22 o. ä.) | Landing Page, App, Monitor, API | ~4 €/Monat |
| DNS-Verwaltung von `planyvo.com` | Subdomain `thecircle` | – |
| Stripe-Konto | Ticketzahlungen | 1,5 % + 0,25 € je Zahlung |
| Lettermint-Konto | Versand der Mailings | je nach Volumen |

> **Warum ein eigener Server und kein Static-Hosting?** Die Stripe-Checkout-Session
> muss serverseitig erzeugt werden (der geheime Schlüssel darf nie in den Browser),
> und die Webhooks von Stripe und Lettermint brauchen eine erreichbare Adresse.

> **Warum Hetzner?** Rechenzentrum in Deutschland – bei personenbezogenen Daten
> das einfachste Argument. Jeder andere Anbieter, auf dem Node dauerhaft läuft,
> tut es genauso.

---

## 1 · Server anlegen

Hetzner Cloud → neues Projekt → Server erstellen:

- **Standort:** Nürnberg oder Falkenstein
- **Image:** Ubuntu 24.04
- **Typ:** CX22 (2 vCPU, 4 GB) – reicht mit großem Abstand
- **SSH-Key** hinterlegen (kein Passwort-Login)

IPv4-Adresse notieren, danach einloggen:

```bash
ssh root@<SERVER-IP>
```

## 2 · Grundsetup

```bash
apt update && apt upgrade -y
apt install -y nodejs git ufw
node -v                     # sollte v18 oder neuer sein

# Firewall: nur SSH und Web
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw --force enable

# Eigener Benutzer für den Dienst, ohne Login-Shell
adduser --system --group --home /opt/thecircle circle
```

Ist Node älter als v18:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

## 3 · Code aufspielen

```bash
cd /opt
git clone <REPO-URL> thecircle
cd thecircle
chown -R circle:circle /opt/thecircle
```

Ohne Git-Zugang auf dem Server geht auch:

```bash
# lokal
rsync -av --exclude node_modules --exclude .git ./ root@<SERVER-IP>:/opt/thecircle/
```

## 4 · Konfiguration

```bash
cp deploy/env.example /opt/thecircle/.env
openssl rand -hex 24        # Ergebnis als ADMIN_TOKEN eintragen
nano /opt/thecircle/.env

chown circle:circle /opt/thecircle/.env
chmod 600 /opt/thecircle/.env
```

Stripe-Schlüssel bleiben zunächst leer bzw. auf Test – die kommen in Schritt 9.

**Der `ADMIN_TOKEN` ist der Schlüssel zum Monitor.** Ohne ihn kämen alle
Gästedaten über `/api/admin/pools` ins Netz. Nicht leer lassen.

## 5 · Als Dienst einrichten

```bash
cp deploy/thecircle.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now thecircle
systemctl status thecircle      # muss "active (running)" zeigen
```

Prüfen, ob er antwortet:

```bash
curl -s localhost:8080/api/live/health     # {"ok":true}
```

Log bei Problemen: `journalctl -u thecircle -f`

## 6 · DNS

In der DNS-Verwaltung von `planyvo.com` einen A-Record anlegen:

| Typ | Name | Wert | TTL |
|---|---|---|---|
| A | `thecircle` | `<SERVER-IP>` | 300 |

Danach warten, bis es greift:

```bash
dig +short thecircle.planyvo.com     # muss die Server-IP zeigen
```

## 7 · HTTPS mit Caddy

Caddy holt das Zertifikat automatisch und erneuert es selbst.

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

cp /opt/thecircle/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

Der DNS-Eintrag muss **vorher** greifen, sonst schlägt die Zertifikatsausstellung fehl.

## 8 · Erste Prüfung

```bash
curl -s https://thecircle.planyvo.com/api/live/health          # {"ok":true}
curl -sI https://thecircle.planyvo.com/assets/portrait-amiaz.jpg | head -1
```

Im Browser:

- `https://thecircle.planyvo.com/einladung?demo=1` → Landing Page als Vorführung
- `https://thecircle.planyvo.com/monitor?key=<ADMIN_TOKEN>` → Monitor
- `https://thecircle.planyvo.com/` → die App

**Damit ist die Seite live.** Der Rest ist Anbindung.

---

## 9 · Stripe

1. Konto anlegen, Firmendaten und Bankverbindung hinterlegen. Bis zur
   Freischaltung im **Testmodus** arbeiten (Schalter oben rechts).
2. **Entwickler → API-Schlüssel** → *Geheimer Schlüssel* (`sk_test_…`) kopieren,
   in die `.env` als `STRIPE_SECRET_KEY`.
3. **Entwickler → Webhooks → Endpunkt hinzufügen**
   - Adresse: `https://thecircle.planyvo.com/api/stripe/webhook`
   - Ereignis: `checkout.session.completed` (nur dieses)
   - Nach dem Anlegen das **Signing secret** (`whsec_…`) kopieren, in die `.env`
     als `STRIPE_WEBHOOK_SECRET`
4. Dienst neu starten: `systemctl restart thecircle`

**Testzahlung:**

```bash
# Testgast anlegen
cd /opt/thecircle
sudo -u circle node server/circle-server.js import server/gaesteliste-vorlage.csv
sudo -u circle node server/circle-server.js export | head -3     # Link kopieren
```

Den Link im Browser öffnen, zusagen, im Checkout die Testkarte
`4242 4242 4242 4242` mit beliebigem künftigen Datum und CVC verwenden.
Danach muss der Gast auf der Seite seine Ticket-Nummer sehen und im Monitor
auf **bezahlt** stehen. Steht er auf „zugesagt, nicht bezahlt", kam der Webhook
nicht an → in Stripe unter *Webhooks → Versuche* nachsehen.

**Auf Live umstellen:** Nach der Freischaltung durch Stripe die Live-Schlüssel
holen (`sk_live_…`) und einen **zweiten Webhook-Endpunkt** im Live-Modus anlegen –
das Signing secret ist ein anderes. Beide Werte in die `.env`, dann neu starten.

> Der Server prüft jede Webhook-Signatur (HMAC, 5-Minuten-Fenster) und bucht
> idempotent – ein doppelt zugestelltes Ereignis zählt nicht doppelt.

## 10 · Lettermint

1. Konto anlegen, **Absenderdomain verifizieren**. Dafür trägt man in der
   DNS-Verwaltung die von Lettermint genannten Einträge ein (SPF, DKIM,
   meist auch DMARC). Das dauert je nach Anbieter ein paar Minuten bis Stunden.
   *Ohne verifizierte Domain landen die Mailings im Spam.*
2. **Templates anlegen** – der Inhalt der vier Dateien aus `email/` wird jeweils
   in ein neues Template kopiert:

   | Datei | Template | Wann |
   |---|---|---|
   | `save-the-date.html` | Welle 0 | vor dem Ticketverkauf |
   | `einladung-ticket.html` | Welle 1 · Ticket | Einladung mit Beitrag |
   | `einladung-ehrengast.html` | Welle 1 · Ehrengast | Einladung ohne Beitrag |
   | `app-zugang.html` | Welle 2 | kurz vor dem Abend |

3. **Bild-Adressen eintragen.** Die Merge-Variablen für Bilder bekommen feste
   Werte (die Dateien liegen bereits auf dem Server):

   ```
   header_img_url      https://thecircle.planyvo.com/assets/circle-header.jpg
   logo_url            https://thecircle.planyvo.com/assets/logo-neg.svg
   portrait_amiaz_url  https://thecircle.planyvo.com/assets/portrait-amiaz.jpg
   portrait_ien_url    https://thecircle.planyvo.com/assets/portrait-ien.jpg
   portrait_max_url    https://thecircle.planyvo.com/assets/portrait-max.jpg
   partnerwand_url     https://thecircle.planyvo.com/assets/partnerwand-bordeaux.jpg
   ```

4. **Webhook** auf `https://thecircle.planyvo.com/api/lettermint/webhook`
   für die Ereignisse *sent, delivered, opened, clicked*. Damit füllen sich die
   Öffnungs- und Klickraten im Monitor. (Klicks erkennt der Server auch selbst,
   sobald ein Gast die Landing Page öffnet – der Webhook macht es nur genauer.)

## 11 · Gästeliste einlesen

Die CSV der Veranstalter auf den Server legen und importieren:

```bash
cd /opt/thecircle
sudo -u circle node server/circle-server.js import /tmp/gaesteliste.csv
```

Ausgabe zeigt neu/aktualisiert je Pool. Danach die Versandliste erzeugen:

```bash
sudo -u circle node server/circle-server.js export > /tmp/versand.csv
```

Diese Datei enthält je Gast: `pool, typ, anrede, vorname, name, email, partner,
partner_logo, platz_satz, link, status`. Sie wird in Lettermint importiert – die
Spaltennamen entsprechen genau den Merge-Variablen der Templates.

**Ein erneuter Import überschreibt keine Zusagen.** Schlüssel ist die E-Mail;
Token, Status und Zahlungen bleiben erhalten. Nachzügler lassen sich also
jederzeit nachschieben.

## 12 · Vor dem ersten echten Versand

- [ ] `dig +short thecircle.planyvo.com` zeigt die richtige IP
- [ ] `https://thecircle.planyvo.com/api/live/health` antwortet über HTTPS
- [ ] Alle sieben Bilder unter `/assets/…` laden im Browser
- [ ] Testzahlung im Stripe-Testmodus durchgelaufen, Monitor zeigt „bezahlt"
- [ ] Absenderdomain in Lettermint verifiziert (SPF/DKIM grün)
- [ ] Testmailing an eine eigene Adresse – **einmal in Gmail, einmal in Outlook**
      ansehen (Bilder da? Schrift ok? Button klickbar?)
- [ ] Persönlicher Link aus der Testmail führt auf die Landing Page mit dem
      richtigen Namen
- [ ] Stripe auf **Live** umgestellt, zweiter Webhook angelegt
- [ ] `ADMIN_TOKEN` gesetzt und `/api/admin/pools` ohne Schlüssel abgewiesen:
      ```bash
      curl -s https://thecircle.planyvo.com/api/admin/pools   # {"error":"kein Zugriff"}
      ```

---

## Betrieb

**Änderungen ausrollen**

```bash
cd /opt/thecircle
git pull
systemctl restart thecircle       # Ausfall < 1 Sekunde
```

**Sicherung.** Der gesamte Stand liegt in einer Datei. Ein täglicher Cron reicht:

```bash
# crontab -e
0 3 * * * cp /opt/thecircle/server/live-state.json /var/backups/circle-$(date +\%F).json
```

**Logs**

```bash
journalctl -u thecircle -f          # Anwendung
journalctl -u caddy -f              # HTTPS / Zugriffe
```

**Nach dem Event.** In `live-state.json` stehen Namen, E-Mail-Adressen und
Unverträglichkeiten – also personenbezogene und teils Gesundheitsdaten. Sobald
die Abrechnung durch ist:

```bash
systemctl stop thecircle
rm /opt/thecircle/server/live-state.json /var/backups/circle-*.json
```

Was für die Nachbereitung gebraucht wird, vorher als anonymisierte Auswertung
sichern (Zahlen je Pool statt Namen). Für die Zahlungsbelege genügt Stripe.

---

## Wenn etwas klemmt

| Symptom | Ursache | Lösung |
|---|---|---|
| Caddy bekommt kein Zertifikat | DNS zeigt noch nicht auf den Server | `dig` prüfen, ein paar Minuten warten, `systemctl reload caddy` |
| Zahlung bleibt auf „zugesagt" | Webhook kommt nicht an | Stripe → Webhooks → Versuche; stimmt die Adresse? richtiger Modus (Test/Live)? |
| „Zahlung ist noch nicht scharf geschaltet" | `STRIPE_SECRET_KEY` fehlt | `.env` prüfen, `systemctl restart thecircle` |
| Signatur ungültig im Log | falsches `STRIPE_WEBHOOK_SECRET` | Test- und Live-Endpunkt haben verschiedene Secrets |
| Bilder fehlen in der Mail | Adressen falsch oder Bild nicht erreichbar | `curl -I https://thecircle.planyvo.com/assets/<datei>` |
| Mailing landet im Spam | Domain nicht verifiziert | SPF/DKIM in Lettermint prüfen |
| Monitor zeigt Demo-Daten | Server antwortet nicht oder Schlüssel fehlt | mit `?key=<ADMIN_TOKEN>` öffnen |
| Live-Zähler in der App steht | SSE wird gepuffert | im Caddyfile muss `flush_interval -1` stehen |

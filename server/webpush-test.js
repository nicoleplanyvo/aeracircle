#!/usr/bin/env node
"use strict";
/*
 * Selbsttest fuer server/webpush.js – laeuft ohne Netz.
 *
 * Der Browser wird hier simuliert: eigenes P-256-Paar plus 16 Byte auth.
 * Entscheidend ist der Rueckweg – was das Modul verschluesselt, muss mit dem
 * Browser-Privatschluessel nach RFC 8291 wieder zum Klartext werden. Erst das
 * beweist, dass HKDF-Infos, Salt-Reihenfolge und AES-Parameter stimmen; ein
 * reiner "wirft keinen Fehler"-Test wuerde das nicht.
 *
 *   node server/webpush-test.js
 */

const crypto = require("node:crypto");
const wp = require("./webpush.js");

let fehler = 0;
function pruefe(bedingung, text) {
  if (bedingung) {
    console.log("ok      " + text);
  } else {
    console.log("FEHLER  " + text);
    fehler++;
  }
}

/* 1) VAPID-Schluessel */
const vapidKeys = wp.schluesselErzeugen();
const pubRoh = wp.vonBase64url(vapidKeys.publicKey);
const privRoh = wp.vonBase64url(vapidKeys.privateKey);
pruefe(pubRoh.length === 65 && pubRoh[0] === 0x04, "VAPID Public Key ist 65-Byte-Punkt mit 0x04");
pruefe(privRoh.length === 32, "VAPID Private Key ist 32 Byte");
pruefe(
  !/[+/=]/.test(vapidKeys.publicKey + vapidKeys.privateKey),
  "Schluessel sind base64url ohne +/=",
);

/* 2) simulierter Browser */
const browser = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const uaPublic = wp.publicKeyRoh(browser.publicKey);
const auth = crypto.randomBytes(16);
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: wp.base64url(uaPublic), auth: wp.base64url(auth) },
};

/* 3) Verschluesseln und als Browser wieder entschluesseln */
const klartext = JSON.stringify({ title: "THE CIRCLE", body: "Türen öffnen – bis gleich!" });
const { body, salt, asPublic } = wp.verschluesseln(klartext, subscription.keys.p256dh, subscription.keys.auth);

pruefe(body.subarray(0, 16).equals(salt), "Body beginnt mit dem Salt");
pruefe(body.readUInt32BE(16) === 4096, "Record-Size im Header ist 4096");
pruefe(body[20] === 65 && body.subarray(21, 86).equals(asPublic), "keyid im Header ist der ephemere Public Key");
pruefe(
  body.length === 86 + Buffer.byteLength(klartext) + 1 + 16,
  "Body-Laenge = Header + Klartext + Delimiter + GCM-Tag",
);

let entschluesselt = null;
try {
  const { cek, nonce } = wp.schluesselAbleiten({
    privateKey: browser.privateKey,
    publicKey: wp.publicKeyObjekt(asPublic),
    uaPublic,
    asPublic,
    auth,
    salt,
  });
  const chiffre = body.subarray(86);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(chiffre.subarray(chiffre.length - 16));
  const record = Buffer.concat([decipher.update(chiffre.subarray(0, chiffre.length - 16)), decipher.final()]);
  pruefe(record[record.length - 1] === 0x02, "letztes Record-Byte ist Delimiter 0x02");
  entschluesselt = record.subarray(0, record.length - 1).toString("utf8");
} catch (err) {
  pruefe(false, "Entschluesselung wirft: " + err.message);
}
pruefe(entschluesselt === klartext, "Browser-Seite entschluesselt zum Original-Klartext");

/* 4) Manipulation muss auffallen (GCM-Tag) */
{
  const kaputt = Buffer.from(body);
  kaputt[90] ^= 0x01;
  let erkannt = false;
  try {
    const { cek, nonce } = wp.schluesselAbleiten({
      privateKey: browser.privateKey,
      publicKey: wp.publicKeyObjekt(asPublic),
      uaPublic,
      asPublic,
      auth,
      salt,
    });
    const chiffre = kaputt.subarray(86);
    const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
    d.setAuthTag(chiffre.subarray(chiffre.length - 16));
    d.update(chiffre.subarray(0, chiffre.length - 16));
    d.final();
  } catch {
    erkannt = true;
  }
  pruefe(erkannt, "manipulierter Body wird beim Entschluesseln abgelehnt");
}

/* 5) Grenzen */
{
  let geworfen = false;
  try {
    wp.verschluesseln("x".repeat(wp.MAX_PAYLOAD + 1), subscription.keys.p256dh, subscription.keys.auth);
  } catch {
    geworfen = true;
  }
  pruefe(geworfen, `Payload ueber ${wp.MAX_PAYLOAD} Byte wird abgelehnt`);
  const grenze = wp.verschluesseln("x".repeat(wp.MAX_PAYLOAD), subscription.keys.p256dh, subscription.keys.auth);
  pruefe(grenze.body.length === 86 + 4096, "Payload an der Grenze fuellt genau einen Record");
}

/* 6) VAPID-JWT */
const vapid = { ...vapidKeys, subject: "mailto:hello@the-circle-cologne.de" };
const { authorization } = wp.vapidHeader(subscription.endpoint, vapid);
const m = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
pruefe(!!m, "Authorization-Header hat Form 'vapid t=…, k=…'");
if (m) {
  const [, jwt, k] = m;
  const teile = jwt.split(".");
  pruefe(teile.length === 3, "JWT hat drei Teile");
  pruefe(k === vapidKeys.publicKey, "k= ist der VAPID Public Key");

  const header = JSON.parse(wp.vonBase64url(teile[0]).toString("utf8"));
  pruefe(header.alg === "ES256" && header.typ === "JWT", "JWT-Header ist {typ:JWT, alg:ES256}");

  const claims = JSON.parse(wp.vonBase64url(teile[1]).toString("utf8"));
  const jetzt = Math.floor(Date.now() / 1000);
  pruefe(claims.aud === "https://fcm.googleapis.com", "aud ist Origin des Endpoints");
  pruefe(claims.sub === vapid.subject, "sub ist das VAPID-Subject");
  pruefe(
    claims.exp > jetzt + 11 * 3600 && claims.exp <= jetzt + 12 * 3600 + 5,
    "exp liegt ~12 h in der Zukunft",
  );

  const signatur = wp.vonBase64url(teile[2]);
  pruefe(signatur.length === 64, "Signatur ist 64 Byte R||S (kein DER)");
  const gueltig = crypto.verify(
    "sha256",
    Buffer.from(teile[0] + "." + teile[1]),
    { key: wp.publicKeyObjekt(pubRoh), dsaEncoding: "ieee-p1363" },
    signatur,
  );
  pruefe(gueltig, "Signatur verifiziert mit dem VAPID Public Key");

  const fremd = wp.schluesselErzeugen();
  const falsch = crypto.verify(
    "sha256",
    Buffer.from(teile[0] + "." + teile[1]),
    { key: wp.publicKeyObjekt(wp.vonBase64url(fremd.publicKey)), dsaEncoding: "ieee-p1363" },
    signatur,
  );
  pruefe(!falsch, "Signatur verifiziert NICHT mit fremdem Schluessel");
}

/* 7) senden() lehnt kaputte Eingaben ab, ohne ins Netz zu gehen */
wp.senden({ subscription: { endpoint: "https://example.invalid/x" }, payload: "{}", vapid })
  .then(() => pruefe(false, "senden() ohne keys muss ablehnen"))
  .catch(() => pruefe(true, "senden() ohne keys lehnt vor dem Netz ab"))
  .then(() =>
    wp.senden({ subscription, payload: "{}", vapid: { ...vapid, privateKey: "AAAA" } })
      .then(() => pruefe(false, "senden() mit kaputtem VAPID-Key muss ablehnen"))
      .catch(() => pruefe(true, "senden() mit kaputtem VAPID-Key lehnt vor dem Netz ab")),
  )
  .then(() => {
    console.log(fehler ? `\n${fehler} Fehler` : "\nalles ok");
    process.exit(fehler ? 1 : 0);
  });

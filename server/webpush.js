"use strict";
/*
 * Web Push ohne Fremdpaket.
 *
 * Verschluesselung nach RFC 8291 (aes128gcm, RFC 8188 fuer das Body-Format),
 * Absender-Nachweis nach RFC 8292 (VAPID, JWT mit ES256). Alles mit
 * node:crypto und node:https – das Repo hat bewusst keine Abhaengigkeiten,
 * und die npm-Bibliothek "web-push" bringt fuer diese eine Aufgabe zu viel mit.
 *
 * Ablauf einer Nachricht:
 *   1) ephemerer P-256-Schluessel, ECDH mit dem Browser-Schluessel (p256dh)
 *   2) HKDF: auth-Secret + beide Public Keys -> IKM, dann mit zufaelligem
 *      Salt -> Content-Encryption-Key (16 Byte) und Nonce (12 Byte)
 *   3) AES-128-GCM ueber "payload | 0x02" (0x02 = letzter Record)
 *   4) Body = Salt | Record-Size | Laenge Public Key | Public Key | Ciphertext
 *   5) POST an den Push-Dienst, signiert mit dem VAPID-JWT
 */

const crypto = require("node:crypto");
const https = require("node:https");

const KURVE = "prime256v1";
const RECORD_SIZE = 4096;
// RFC 8188: der Record ist Klartext + 1 Byte Delimiter + 16 Byte GCM-Tag und
// muss in die Record-Size passen. Mehr geht nur mit mehreren Records, und die
// Push-Dienste selbst deckeln bei 4 KB – darum bleibt es bei einem Record.
const MAX_PAYLOAD = RECORD_SIZE - 1 - 16;
const TIMEOUT_MS = 10000;
const JWT_LAUFZEIT_S = 12 * 60 * 60;

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function vonBase64url(str) {
  return Buffer.from(String(str), "base64url");
}

/* ---------- Schluessel ---------- */

// Public Key als roher 65-Byte-Punkt (0x04 | X | Y): so erwarten ihn Browser
// (applicationServerKey) und Push-Dienste (k=… im Authorization-Header).
function publicKeyRoh(keyObject) {
  const jwk = keyObject.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([0x04]),
    vonBase64url(jwk.x),
    vonBase64url(jwk.y),
  ]);
}

function schluesselErzeugen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: KURVE,
  });
  const jwk = privateKey.export({ format: "jwk" });
  return {
    publicKey: base64url(publicKeyRoh(publicKey)),
    privateKey: jwk.d, // ist bereits base64url, 32 Byte
  };
}

// Baut aus den rohen base64url-Werten (wie sie in den Env-Variablen stehen)
// wieder ein KeyObject – ueber JWK, weil das der einzige Import-Weg fuer rohe
// Koordinaten ohne DER-Bastelei ist.
function privateKeyObjekt(publicKeyB64, privateKeyB64) {
  const pub = vonBase64url(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID Public Key muss ein unkomprimierter 65-Byte-P-256-Punkt sein");
  }
  const priv = vonBase64url(privateKeyB64);
  if (priv.length !== 32) {
    throw new Error("VAPID Private Key muss 32 Byte lang sein");
  }
  return crypto.createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: base64url(pub.subarray(1, 33)),
      y: base64url(pub.subarray(33, 65)),
      d: base64url(priv),
    },
  });
}

function publicKeyObjekt(rohPunkt) {
  if (rohPunkt.length !== 65 || rohPunkt[0] !== 0x04) {
    throw new Error("p256dh muss ein unkomprimierter 65-Byte-P-256-Punkt sein");
  }
  return crypto.createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: base64url(rohPunkt.subarray(1, 33)),
      y: base64url(rohPunkt.subarray(33, 65)),
    },
  });
}

/* ---------- Verschluesselung (RFC 8291) ---------- */

function hkdf(salt, ikm, info, laenge) {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, laenge));
}

// Schluesselableitung ist fuer Sender und Empfaenger identisch – nur welcher
// Private Key mit welchem Public Key kombiniert wird, unterscheidet sich.
// Deshalb hier zentral, damit der Test dieselbe Funktion zum Entschluesseln
// nutzen kann und ein Fehler nicht auf beiden Seiten symmetrisch versteckt bleibt.
function schluesselAbleiten({ privateKey, publicKey, uaPublic, asPublic, auth, salt }) {
  const gemeinsam = crypto.diffieHellman({ privateKey, publicKey });
  const ikm = hkdf(
    auth,
    gemeinsam,
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
    32,
  );
  return {
    cek: hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
    nonce: hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12),
  };
}

function verschluesseln(payload, p256dh, auth) {
  const klartext = Buffer.from(String(payload), "utf8");
  if (klartext.length > MAX_PAYLOAD) {
    throw new Error(`Payload zu gross (${klartext.length} Byte, maximal ${MAX_PAYLOAD})`);
  }
  const uaPublic = vonBase64url(p256dh);
  const authSecret = vonBase64url(auth);
  if (authSecret.length !== 16) {
    throw new Error("auth-Secret muss 16 Byte lang sein");
  }

  const ephemer = crypto.generateKeyPairSync("ec", { namedCurve: KURVE });
  const asPublic = publicKeyRoh(ephemer.publicKey);
  const salt = crypto.randomBytes(16);

  const { cek, nonce } = schluesselAbleiten({
    privateKey: ephemer.privateKey,
    publicKey: publicKeyObjekt(uaPublic),
    uaPublic,
    asPublic,
    auth: authSecret,
    salt,
  });

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const chiffre = Buffer.concat([
    cipher.update(klartext),
    cipher.update(Buffer.from([0x02])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(16 + 4 + 1 + 65);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  asPublic.copy(header, 21);

  return { body: Buffer.concat([header, chiffre]), salt, asPublic };
}

/* ---------- VAPID (RFC 8292) ---------- */

function vapidHeader(endpoint, vapid) {
  if (!vapid || !vapid.publicKey || !vapid.privateKey || !vapid.subject) {
    throw new Error("vapid braucht publicKey, privateKey und subject");
  }
  const url = new URL(endpoint);
  const jetzt = Math.floor(Date.now() / 1000);
  const teil = (obj) => base64url(Buffer.from(JSON.stringify(obj)));
  const unsigniert =
    teil({ typ: "JWT", alg: "ES256" }) +
    "." +
    teil({ aud: url.origin, exp: jetzt + JWT_LAUFZEIT_S, sub: vapid.subject });

  // JWS verlangt R||S (64 Byte), Node signiert standardmaessig DER – daher
  // ieee-p1363 erzwingen, sonst lehnen die Push-Dienste mit 401/403 ab.
  const signatur = crypto.sign("sha256", Buffer.from(unsigniert), {
    key: privateKeyObjekt(vapid.publicKey, vapid.privateKey),
    dsaEncoding: "ieee-p1363",
  });

  return {
    authorization: `vapid t=${unsigniert}.${base64url(signatur)}, k=${vapid.publicKey}`,
  };
}

/* ---------- Versand ---------- */

function senden({ subscription, payload, vapid, ttl, urgency }) {
  return new Promise((resolve, reject) => {
    let body, authorization;
    try {
      if (!subscription || !subscription.endpoint || !subscription.keys) {
        throw new Error("subscription braucht endpoint und keys");
      }
      ({ body } = verschluesseln(payload, subscription.keys.p256dh, subscription.keys.auth));
      ({ authorization } = vapidHeader(subscription.endpoint, vapid));
    } catch (err) {
      reject(err);
      return;
    }

    const url = new URL(subscription.endpoint);
    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        timeout: TIMEOUT_MS,
        headers: {
          Authorization: authorization,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          "Content-Length": body.length,
          TTL: String(ttl == null ? 86400 : ttl),
          Urgency: urgency || "normal",
        },
      },
      (res) => {
        const stuecke = [];
        res.on("data", (d) => stuecke.push(d));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(stuecke).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Push-Dienst antwortet nicht (Timeout)")));
    req.on("error", reject);
    req.end(body);
  });
}

module.exports = {
  schluesselErzeugen,
  senden,
  verschluesseln,
  vapidHeader,
  base64url,
  vonBase64url,
  // fuer den Test: Gegenseite (Browser) nachbauen
  schluesselAbleiten,
  publicKeyObjekt,
  publicKeyRoh,
  MAX_PAYLOAD,
};

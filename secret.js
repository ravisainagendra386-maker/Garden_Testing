// src/htlc/secret.js
// Generates cryptographically secure HTLC secrets.
const crypto = require("crypto");

function generateSecret() {
  const secret = crypto.randomBytes(32);
  const hash = crypto.createHash("sha256").update(secret).digest();
  return {
    secret: secret.toString("hex"),
    secretBytes: secret,
    secretHash: "0x" + hash.toString("hex"),
    secretHashBytes: hash,
  };
}

module.exports = { generateSecret };

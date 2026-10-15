/**
 * PrivatePages - crypto.js
 * PBKDF2-based hashing for PIN / recovery key, plus base32 recovery-key generation.
 * No plaintext PIN or recovery key is ever stored - only salted hashes.
 * Loaded as a plain (non-module) script via <script> / importScripts so every
 * function below is attached to the global scope of whatever context loads it.
 */

const PP_PBKDF2_ITERATIONS = 150000;
const PP_HASH_BITS = 256;

function ppBufToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function ppBufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function ppB64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function ppRandomBytes(n) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

function ppGenerateSaltB64() {
  return ppBufToB64(ppRandomBytes(16).buffer);
}

/**
 * Derive a PBKDF2-SHA256 hash for a secret (PIN or recovery key).
 * Returns a hex string.
 */
async function ppPbkdf2Hash(secret, saltB64, iterations = PP_PBKDF2_ITERATIONS) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const saltBuf = ppB64ToBuf(saltB64);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBuf, iterations, hash: "SHA-256" },
    keyMaterial,
    PP_HASH_BITS
  );
  return ppBufToHex(derived);
}

/**
 * Create a new {hash, salt, iterations} record for a secret.
 */
async function ppHashSecret(secret) {
  const salt = ppGenerateSaltB64();
  const hash = await ppPbkdf2Hash(secret, salt);
  return { hash, salt, iterations: PP_PBKDF2_ITERATIONS };
}

/**
 * Verify a secret against a stored {hash, salt, iterations} record.
 * Uses a constant-time-ish comparison (length-checked char compare).
 */
async function ppVerifySecret(secret, record) {
  if (!record || !record.hash || !record.salt) return false;
  const candidate = await ppPbkdf2Hash(secret, record.salt, record.iterations || PP_PBKDF2_ITERATIONS);
  return ppConstantTimeEqual(candidate, record.hash);
}

function ppConstantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

/** RFC4648 base32 alphabet (no padding), used for human-typeable recovery keys. */
const PP_BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function ppBase32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += PP_BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += PP_BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Generate a new recovery key, formatted like XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
 * Caller is responsible for showing this ONCE and never persisting the raw value.
 */
function ppGenerateRecoveryKey() {
  const raw = ppBase32Encode(ppRandomBytes(16)); // 16 bytes -> 26 base32 chars, trim to 25 for clean grouping
  const trimmed = raw.slice(0, 25);
  const groups = trimmed.match(/.{1,5}/g);
  return groups.join("-");
}

/**
 * Normalize a user-entered recovery key for comparison: uppercase, and drop
 * everything outside the base32 alphabet. That covers the dashes the key is
 * displayed with, spaces someone typed instead, and the 0/1/8/9 that base32
 * does not contain — so an O typed as a 0 becomes a near miss rather than a
 * character the comparison would have to treat as meaningful.
 */
function ppNormalizeRecoveryKey(input) {
  return (input || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PP_PBKDF2_ITERATIONS,
    ppBufToHex,
    ppBufToB64,
    ppB64ToBuf,
    ppRandomBytes,
    ppGenerateSaltB64,
    ppPbkdf2Hash,
    ppHashSecret,
    ppVerifySecret,
    ppConstantTimeEqual,
    ppBase32Encode,
    ppGenerateRecoveryKey,
    ppNormalizeRecoveryKey,
  };
}

/* The hashing and recovery-key generation in lib/crypto.js.
 *
 * node --test tests/
 *
 * This file was correct when it was reviewed and is not being changed, which
 * is precisely why it needs tests: the next person to open it should be able
 * to tell immediately whether an edit broke something. Everything here is a
 * property that would be invisible in use — a salt that stopped being random,
 * a comparison that started returning early, a recovery key that quietly lost
 * half its entropy — right up until it mattered.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadLib } = require("./harness.js");

const C = loadLib("crypto.js");

/* ── Hashing ─────────────────────────────────────────────────────────── */

test("a secret verifies against its own record", async () => {
  const record = await C.ppHashSecret("123456");

  assert.equal(await C.ppVerifySecret("123456", record), true);
});

test("a different secret does not", async () => {
  const record = await C.ppHashSecret("123456");

  for (const wrong of ["123457", "12345", "1234567", "", "023456"]) {
    assert.equal(await C.ppVerifySecret(wrong, record), false, JSON.stringify(wrong));
  }
});

test("the same secret hashed twice gives different records", async () => {
  /* A fresh random salt per record. Without it, two people with the same PIN
   * have the same stored hash, and a precomputed table covers all 10^6. */
  const a = await C.ppHashSecret("123456");
  const b = await C.ppHashSecret("123456");

  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.equal(await C.ppVerifySecret("123456", a), true);
  assert.equal(await C.ppVerifySecret("123456", b), true);
});

test("a record carries its own iteration count and is verified with it", async () => {
  /* This is what lets the iteration count be raised later without invalidating
   * every PIN already stored. */
  const salt = C.ppGenerateSaltB64();
  const record = { hash: await C.ppPbkdf2Hash("123456", salt, 1000), salt, iterations: 1000 };

  assert.equal(await C.ppVerifySecret("123456", record), true);

  const wrongCount = { hash: record.hash, salt, iterations: 2000 };
  assert.equal(await C.ppVerifySecret("123456", wrongCount), false);
});

test("a record with no iteration count falls back to the current default", async () => {
  const salt = C.ppGenerateSaltB64();
  const record = { hash: await C.ppPbkdf2Hash("123456", salt), salt };

  assert.equal(await C.ppVerifySecret("123456", record), true);
});

test("a missing or malformed record verifies nothing", async () => {
  for (const record of [null, undefined, {}, { hash: "abc" }, { salt: "abc" }, { hash: "", salt: "" }]) {
    assert.equal(await C.ppVerifySecret("123456", record), false, JSON.stringify(record));
  }
});

test("the hash is a 256-bit hex string", async () => {
  const record = await C.ppHashSecret("123456");

  assert.match(record.hash, /^[0-9a-f]{64}$/);
});

test("the default iteration count has not been quietly lowered", async () => {
  /* 150,000 is the number the README states and the reason a 6-digit PIN is
   * defensible at all. If someone drops it to speed something up, that is a
   * decision worth making on purpose. */
  const record = await C.ppHashSecret("123456");

  assert.equal(record.iterations, 150000);
});

/* ── Constant-time comparison ────────────────────────────────────────── */

test("the comparison rejects anything that is not a matching string", () => {
  assert.equal(C.ppConstantTimeEqual("abc", "abc"), true);
  assert.equal(C.ppConstantTimeEqual("abc", "abd"), false);
  assert.equal(C.ppConstantTimeEqual("abc", "ab"), false);
  assert.equal(C.ppConstantTimeEqual("", ""), true);
  assert.equal(C.ppConstantTimeEqual("abc", null), false);
  assert.equal(C.ppConstantTimeEqual(null, null), false);
  assert.equal(C.ppConstantTimeEqual(123, 123), false);
});

test("the comparison examines the whole string", () => {
  /* A comparison that returns on the first differing character leaks how much
   * of a guess was right. Same-length strings differing only in the last
   * character must take the same path as identical ones. */
  const a = "0".repeat(63) + "0";
  const b = "0".repeat(63) + "1";

  assert.equal(C.ppConstantTimeEqual(a, b), false);
  assert.equal(C.ppConstantTimeEqual(a, a), true);
});

/* ── Base32 and recovery keys ────────────────────────────────────────── */

test("base32 encodes the RFC 4648 test vectors", () => {
  const enc = (s) => C.ppBase32Encode(new TextEncoder().encode(s));

  assert.equal(enc(""), "");
  assert.equal(enc("f"), "MY");
  assert.equal(enc("fo"), "MZXQ");
  assert.equal(enc("foo"), "MZXW6");
  assert.equal(enc("foob"), "MZXW6YQ");
  assert.equal(enc("fooba"), "MZXW6YTB");
  assert.equal(enc("foobar"), "MZXW6YTBOI");
});

test("a recovery key is 25 base32 characters in five groups", () => {
  for (let i = 0; i < 20; i++) {
    const key = C.ppGenerateRecoveryKey();
    assert.match(key, /^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/, key);
  }
});

test("recovery keys do not repeat", () => {
  const keys = new Set();
  for (let i = 0; i < 200; i++) keys.add(C.ppGenerateRecoveryKey());

  assert.equal(keys.size, 200);
});

test("normalisation accepts a key however it was typed", () => {
  const key = C.ppGenerateRecoveryKey();
  const bare = key.replace(/-/g, "");

  assert.equal(C.ppNormalizeRecoveryKey(key), bare);
  assert.equal(C.ppNormalizeRecoveryKey(key.toLowerCase()), bare);
  assert.equal(C.ppNormalizeRecoveryKey(" " + key.split("-").join(" ") + " "), bare);
  assert.equal(C.ppNormalizeRecoveryKey(key.split("-").join("")), bare);
});

test("normalisation drops characters the alphabet does not contain", () => {
  /* Base32 has no 0, 1, 8 or 9, so a 0 typed for an O is not a character the
   * key could have contained — dropping it is what makes O/0 confusion a
   * near-miss rather than a silent wrong answer. */
  assert.equal(C.ppNormalizeRecoveryKey("ABC01 89DEF"), "ABCDEF");
  assert.equal(C.ppNormalizeRecoveryKey(null), "");
  assert.equal(C.ppNormalizeRecoveryKey(undefined), "");
});

test("a normalised key verifies against a record made from the same key", async () => {
  const key = C.ppGenerateRecoveryKey();
  const record = await C.ppHashSecret(C.ppNormalizeRecoveryKey(key));

  assert.equal(await C.ppVerifySecret(C.ppNormalizeRecoveryKey(key.toLowerCase()), record), true);
  assert.equal(await C.ppVerifySecret(C.ppNormalizeRecoveryKey("AAAAA-AAAAA-AAAAA-AAAAA-AAAAA"), record), false);
});

/* ── Base64 helpers ──────────────────────────────────────────────────── */

test("base64 round-trips arbitrary bytes", () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;

  const back = new Uint8Array(C.ppB64ToBuf(C.ppBufToB64(bytes.buffer)));

  assert.deepEqual(Array.from(back), Array.from(bytes));
});

test("a salt is 16 random bytes", () => {
  const salts = new Set();
  for (let i = 0; i < 100; i++) {
    const salt = C.ppGenerateSaltB64();
    assert.equal(new Uint8Array(C.ppB64ToBuf(salt)).length, 16);
    salts.add(salt);
  }

  assert.equal(salts.size, 100);
});

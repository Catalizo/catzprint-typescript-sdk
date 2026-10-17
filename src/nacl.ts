/**
 * NaCl sealed boxes (libsodium `crypto_box_seal`) with no runtime dependency.
 *
 *   sealed = epk || crypto_box(msg, nonce = BLAKE2b-192(epk || pk), pk, esk)
 *   crypto_box = XSalsa20-Poly1305 keyed with HSalsa20(X25519(esk, pk), 0^16)
 *
 * X25519 comes from node:crypto (OpenSSL). Salsa20, HSalsa20, Poly1305 and
 * BLAKE2b are small, written straight from their specifications, and checked
 * byte for byte against libsodium (PyNaCl) in the test suite.
 */
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from "node:crypto";

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]); // "expand 32-byte k"

function load32(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
}

function store32(b: Uint8Array, i: number, v: number): void {
  b[i] = v & 0xff;
  b[i + 1] = (v >>> 8) & 0xff;
  b[i + 2] = (v >>> 16) & 0xff;
  b[i + 3] = (v >>> 24) & 0xff;
}

function rotl(v: number, c: number): number {
  return ((v << c) | (v >>> (32 - c))) >>> 0;
}

/** 20 Salsa20 rounds over x in place. */
function salsaRounds(x: Uint32Array): void {
  for (let i = 0; i < 20; i += 2) {
    // column round
    x[4]! ^= rotl((x[0]! + x[12]!) >>> 0, 7);
    x[8]! ^= rotl((x[4]! + x[0]!) >>> 0, 9);
    x[12]! ^= rotl((x[8]! + x[4]!) >>> 0, 13);
    x[0]! ^= rotl((x[12]! + x[8]!) >>> 0, 18);
    x[9]! ^= rotl((x[5]! + x[1]!) >>> 0, 7);
    x[13]! ^= rotl((x[9]! + x[5]!) >>> 0, 9);
    x[1]! ^= rotl((x[13]! + x[9]!) >>> 0, 13);
    x[5]! ^= rotl((x[1]! + x[13]!) >>> 0, 18);
    x[14]! ^= rotl((x[10]! + x[6]!) >>> 0, 7);
    x[2]! ^= rotl((x[14]! + x[10]!) >>> 0, 9);
    x[6]! ^= rotl((x[2]! + x[14]!) >>> 0, 13);
    x[10]! ^= rotl((x[6]! + x[2]!) >>> 0, 18);
    x[3]! ^= rotl((x[15]! + x[11]!) >>> 0, 7);
    x[7]! ^= rotl((x[3]! + x[15]!) >>> 0, 9);
    x[11]! ^= rotl((x[7]! + x[3]!) >>> 0, 13);
    x[15]! ^= rotl((x[11]! + x[7]!) >>> 0, 18);
    // row round
    x[1]! ^= rotl((x[0]! + x[3]!) >>> 0, 7);
    x[2]! ^= rotl((x[1]! + x[0]!) >>> 0, 9);
    x[3]! ^= rotl((x[2]! + x[1]!) >>> 0, 13);
    x[0]! ^= rotl((x[3]! + x[2]!) >>> 0, 18);
    x[6]! ^= rotl((x[5]! + x[4]!) >>> 0, 7);
    x[7]! ^= rotl((x[6]! + x[5]!) >>> 0, 9);
    x[4]! ^= rotl((x[7]! + x[6]!) >>> 0, 13);
    x[5]! ^= rotl((x[4]! + x[7]!) >>> 0, 18);
    x[11]! ^= rotl((x[10]! + x[9]!) >>> 0, 7);
    x[8]! ^= rotl((x[11]! + x[10]!) >>> 0, 9);
    x[9]! ^= rotl((x[8]! + x[11]!) >>> 0, 13);
    x[10]! ^= rotl((x[9]! + x[8]!) >>> 0, 18);
    x[12]! ^= rotl((x[15]! + x[14]!) >>> 0, 7);
    x[13]! ^= rotl((x[12]! + x[15]!) >>> 0, 9);
    x[14]! ^= rotl((x[13]! + x[12]!) >>> 0, 13);
    x[15]! ^= rotl((x[14]! + x[13]!) >>> 0, 18);
  }
}

/** Salsa20 input state: constants, key, 16-byte input (nonce||counter). */
function salsaState(key: Uint8Array, input: Uint8Array): Uint32Array {
  const s = new Uint32Array(16);
  s[0] = SIGMA[0]!;
  s[5] = SIGMA[1]!;
  s[10] = SIGMA[2]!;
  s[15] = SIGMA[3]!;
  for (let i = 0; i < 4; i++) {
    s[1 + i] = load32(key, i * 4);
    s[11 + i] = load32(key, 16 + i * 4);
    s[6 + i] = load32(input, i * 4);
  }
  return s;
}

/** HSalsa20: derives a 32-byte subkey from a key and a 16-byte input. */
export function hsalsa20(key: Uint8Array, input: Uint8Array): Uint8Array {
  const x = salsaState(key, input);
  salsaRounds(x);
  const out = new Uint8Array(32);
  const idx = [0, 5, 10, 15, 6, 7, 8, 9];
  idx.forEach((w, i) => store32(out, i * 4, x[w]!));
  return out;
}

/** XORs msg with the XSalsa20 keystream for (key, 24-byte nonce), counter from 0. */
export function xsalsa20Xor(key: Uint8Array, nonce: Uint8Array, msg: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new RangeError("xsalsa20: key must be 32 bytes");
  if (nonce.length !== 24) throw new RangeError("xsalsa20: nonce must be 24 bytes");
  const subkey = hsalsa20(key, nonce.subarray(0, 16));
  const input = new Uint8Array(16);
  input.set(nonce.subarray(16, 24), 0);
  const out = new Uint8Array(msg.length);
  const block = new Uint8Array(64);
  const x = new Uint32Array(16);
  let counter = 0;
  for (let off = 0; off < msg.length; off += 64) {
    // 64-bit little-endian block counter in input[8..16]
    store32(input, 8, counter >>> 0);
    store32(input, 12, Math.floor(counter / 0x100000000) >>> 0);
    const s = salsaState(subkey, input);
    x.set(s);
    salsaRounds(x);
    for (let i = 0; i < 16; i++) store32(block, i * 4, (x[i]! + s[i]!) >>> 0);
    const n = Math.min(64, msg.length - off);
    for (let i = 0; i < n; i++) out[off + i] = msg[off + i]! ^ block[i]!;
    counter++;
  }
  return out;
}

/**
 * Poly1305 one-time authenticator. The accumulator uses ten 13-bit limbs
 * (130 bits) so every partial product stays well inside a double's exact
 * integer range; the final reduction and the tag addition also work on
 * fixed-size limbs, so no step branches on or loops over secret data.
 */
export function poly1305(key: Uint8Array, msg: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new RangeError("poly1305: key must be 32 bytes");
  const rb = key.slice(0, 16);
  rb[3]! &= 15;
  rb[7]! &= 15;
  rb[11]! &= 15;
  rb[15]! &= 15;
  rb[4]! &= 252;
  rb[8]! &= 252;
  rb[12]! &= 252;
  const r = limbs(rb);
  const r5 = r.map((v) => v * 5);
  const h = new Array<number>(10).fill(0);
  const d = new Array<number>(10).fill(0);
  const buf = new Uint8Array(17);
  for (let off = 0; off < msg.length; off += 16) {
    const n = Math.min(16, msg.length - off);
    buf.fill(0);
    buf.set(msg.subarray(off, off + n));
    buf[n] = 1; // the "hibit": 2^(8n)
    const m = limbs(buf);
    for (let i = 0; i < 10; i++) h[i]! += m[i]!;
    for (let i = 0; i < 10; i++) {
      let acc = 0;
      for (let j = 0; j < 10; j++) {
        acc += h[j]! * (j <= i ? r[i - j]! : r5[i - j + 10]!);
      }
      d[i] = acc;
    }
    let c = 0;
    for (let i = 0; i < 10; i++) {
      d[i]! += c;
      c = Math.floor(d[i]! / 8192);
      d[i]! -= c * 8192;
    }
    d[0]! += c * 5; // 2^130 == 5 (mod 2^130 - 5)
    c = Math.floor(d[0]! / 8192);
    d[0]! -= c * 8192;
    d[1]! += c;
    for (let i = 0; i < 10; i++) h[i] = d[i]!;
  }
  // Final reduction and tag addition in fixed-size limbs (poly1305-donna
  // style): no BigInt, no data-dependent branches or loop counts.
  // 1. Fully carry h into ten 13-bit limbs, folding 2^130 back in as 5.
  //    Two passes leave every limb < 2^13 and h < 2^130 (< 2p).
  for (let pass = 0; pass < 2; pass++) {
    let c = 0;
    for (let i = 0; i < 10; i++) {
      h[i]! += c;
      c = h[i]! >>> 13;
      h[i]! &= 0x1fff;
    }
    h[0]! += c * 5;
  }
  // 2. g = h + 5 - 2^130; use g iff h >= p (i.e. h + 5 carries out of bit 130).
  const g = new Array<number>(10);
  let gc = 5;
  for (let i = 0; i < 10; i++) {
    const t = h[i]! + gc;
    gc = t >>> 13;
    g[i] = t & 0x1fff;
  }
  const mask = -gc | 0; // all ones when h >= p, else 0
  for (let i = 0; i < 10; i++) h[i] = (h[i]! & ~mask) | (g[i]! & mask);
  // 3. Serialize the low 128 bits of h little-endian and add s mod 2^128.
  const hb = new Uint8Array(17);
  let bitbuf = 0;
  let nbits = 0;
  let k = 0;
  for (let i = 0; i < 10; i++) {
    bitbuf |= h[i]! << nbits;
    nbits += 13;
    while (nbits >= 8) {
      // Iteration count depends only on i, not on secret data.
      hb[k++] = bitbuf & 0xff;
      bitbuf >>>= 8;
      nbits -= 8;
    }
  }
  const out = new Uint8Array(16);
  let carry = 0;
  for (let i = 0; i < 16; i++) {
    const t = hb[i]! + key[16 + i]! + carry;
    out[i] = t & 0xff;
    carry = t >>> 8;
  }
  return out;
}

/** Ten 13-bit little-endian limbs from up to 17 bytes (bits 0..129). */
function limbs(b: Uint8Array): number[] {
  const padded = new Uint8Array(20);
  padded.set(b.subarray(0, Math.min(b.length, 17)));
  const out: number[] = [];
  for (let i = 0; i < 10; i++) {
    const bit = i * 13;
    const byte = bit >>> 3;
    const v = padded[byte]! | (padded[byte + 1]! << 8) | (padded[byte + 2]! << 16);
    out.push((v >>> (bit & 7)) & 0x1fff);
  }
  return out;
}

/** crypto_secretbox (XSalsa20-Poly1305): returns tag(16) || ciphertext. */
export function secretbox(msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  const padded = new Uint8Array(32 + msg.length);
  padded.set(msg, 32);
  const c = xsalsa20Xor(key, nonce, padded);
  const tag = poly1305(c.subarray(0, 32), c.subarray(32));
  const out = new Uint8Array(16 + msg.length);
  out.set(tag, 0);
  out.set(c.subarray(32), 16);
  return out;
}

// ---- BLAKE2b (RFC 7693), unkeyed, variable output length ----

const MASK64 = (1n << 64n) - 1n;
const B2B_IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA_B2B = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

function b2bCompress(h: bigint[], block: Uint8Array, t: bigint, last: boolean): void {
  const m: bigint[] = [];
  for (let i = 0; i < 16; i++) {
    let w = 0n;
    for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(block[i * 8 + j]!);
    m.push(w);
  }
  const v = [...h, ...B2B_IV];
  v[12] = v[12]! ^ (t & MASK64);
  v[13] = v[13]! ^ (t >> 64n);
  if (last) v[14] = v[14]! ^ MASK64;
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = (v[a]! + v[b]! + x) & MASK64;
    v[d] = rotr64(v[d]! ^ v[a]!, 32n);
    v[c] = (v[c]! + v[d]!) & MASK64;
    v[b] = rotr64(v[b]! ^ v[c]!, 24n);
    v[a] = (v[a]! + v[b]! + y) & MASK64;
    v[d] = rotr64(v[d]! ^ v[a]!, 16n);
    v[c] = (v[c]! + v[d]!) & MASK64;
    v[b] = rotr64(v[b]! ^ v[c]!, 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA_B2B[r % 10]!;
    g(0, 4, 8, 12, m[s[0]!]!, m[s[1]!]!);
    g(1, 5, 9, 13, m[s[2]!]!, m[s[3]!]!);
    g(2, 6, 10, 14, m[s[4]!]!, m[s[5]!]!);
    g(3, 7, 11, 15, m[s[6]!]!, m[s[7]!]!);
    g(0, 5, 10, 15, m[s[8]!]!, m[s[9]!]!);
    g(1, 6, 11, 12, m[s[10]!]!, m[s[11]!]!);
    g(2, 7, 8, 13, m[s[12]!]!, m[s[13]!]!);
    g(3, 4, 9, 14, m[s[14]!]!, m[s[15]!]!);
  }
  for (let i = 0; i < 8; i++) h[i] = h[i]! ^ v[i]! ^ v[i + 8]!;
}

/** Unkeyed BLAKE2b with an output length of 1..64 bytes. */
export function blake2b(data: Uint8Array, outLen: number): Uint8Array {
  if (outLen < 1 || outLen > 64) throw new RangeError("blake2b: outLen must be 1..64");
  const h = [...B2B_IV];
  h[0] = h[0]! ^ (0x01010000n | BigInt(outLen));
  let t = 0n;
  let off = 0;
  // All blocks but the last are compressed as non-final.
  while (data.length - off > 128) {
    t += 128n;
    b2bCompress(h, data.subarray(off, off + 128), t, false);
    off += 128;
  }
  const last = new Uint8Array(128);
  last.set(data.subarray(off));
  t += BigInt(data.length - off);
  b2bCompress(h, last, t, true);
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    let w = h[i]!;
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(w & 0xffn);
      w >>= 8n;
    }
  }
  return out.slice(0, outLen);
}

// ---- X25519 via node:crypto ----

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

function x25519Public(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, Buffer.from(raw)]), format: "der", type: "spki" });
}

function x25519Private(raw: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, Buffer.from(raw)]), format: "der", type: "pkcs8" });
}

function rawPublic(k: KeyObject): Uint8Array {
  const der = k.export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(der.length - 32));
}

function rawPrivate(k: KeyObject): Uint8Array {
  const der = k.export({ format: "der", type: "pkcs8" });
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Generates an X25519 key pair as raw 32-byte keys. */
export function boxKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { publicKey: rawPublic(publicKey), secretKey: rawPrivate(privateKey) };
}

/** Public key for a raw X25519 private key. */
export function boxPublicFromSecret(secretKey: Uint8Array): Uint8Array {
  return rawPublic(createPublicKey(x25519Private(secretKey)));
}

/** crypto_box_beforenm: HSalsa20(X25519(sk, pk), 0^16). */
export function boxBeforeNm(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const shared = diffieHellman({ privateKey: x25519Private(secretKey), publicKey: x25519Public(publicKey) });
  return hsalsa20(new Uint8Array(shared), new Uint8Array(16));
}

/** crypto_box: returns tag(16) || ciphertext. */
export function box(msg: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return secretbox(msg, nonce, boxBeforeNm(publicKey, secretKey));
}

/** Bytes a sealed box adds to the message: 32 (ephemeral key) + 16 (tag). */
export const SEAL_OVERHEAD = 48;

/**
 * libsodium crypto_box_seal. `ephemeralSecretKey` is for tests only; normal
 * callers leave it out and a fresh key pair is generated per message.
 */
export function sealBox(msg: Uint8Array, recipientPublicKey: Uint8Array, ephemeralSecretKey?: Uint8Array): Uint8Array {
  if (recipientPublicKey.length !== 32) throw new RangeError("sealBox: public key must be 32 bytes");
  let esk: Uint8Array;
  let epk: Uint8Array;
  if (ephemeralSecretKey) {
    esk = ephemeralSecretKey;
    epk = boxPublicFromSecret(esk);
  } else {
    const kp = boxKeyPair();
    esk = kp.secretKey;
    epk = kp.publicKey;
  }
  const nonceInput = new Uint8Array(64);
  nonceInput.set(epk, 0);
  nonceInput.set(recipientPublicKey, 32);
  const nonce = blake2b(nonceInput, 24);
  const boxed = box(msg, nonce, recipientPublicKey, esk);
  const out = new Uint8Array(32 + boxed.length);
  out.set(epk, 0);
  out.set(boxed, 32);
  if (!ephemeralSecretKey) esk.fill(0);
  return out;
}

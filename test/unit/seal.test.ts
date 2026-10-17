import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blake2b, boxKeyPair, boxPublicFromSecret, hsalsa20, poly1305, sealBox, xsalsa20Xor } from "../../src/nacl.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s.replace(/\s+/g, ""), "hex"));

const hasPyNaCl = spawnSync("python3", ["-c", "import nacl"]).status === 0;
const checker = fileURLToPath(new URL("../../scripts/pynacl_check.py", import.meta.url));

describe("primitives (published test vectors)", () => {
  it("Poly1305: RFC 8439 §2.5.2", () => {
    const key = unhex("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b");
    expect(hex(poly1305(key, new TextEncoder().encode("Cryptographic Forum Research Group")))).toBe(
      "a8061dc1305136c6c22b8baf0c0127a9",
    );
  });

  it("Poly1305: RFC 8439 A.3 #1 (zero key) and #5/#6 (wrap-around edge cases)", () => {
    expect(hex(poly1305(new Uint8Array(32), new Uint8Array(64)))).toBe("00000000000000000000000000000000");
    // A.3 #5: R=2, S=0, M = ff..ff (16 bytes) -> tag 03 00..
    const k5 = new Uint8Array(32);
    k5[0] = 2;
    expect(hex(poly1305(k5, new Uint8Array(16).fill(0xff)))).toBe("03000000000000000000000000000000");
    // A.3 #6: R=2, S=ff..ff, M = 02 00..00 -> tag 03 00..
    const k6 = new Uint8Array(32);
    k6[0] = 2;
    k6.fill(0xff, 16);
    const m6 = new Uint8Array(16);
    m6[0] = 2;
    expect(hex(poly1305(k6, m6))).toBe("03000000000000000000000000000000");
  });

  it("Poly1305: RFC 8439 A.3 #7-#11 (final-reduction edge cases)", () => {
    const k = (r: string) => {
      const key = new Uint8Array(32);
      key.set(unhex(r));
      return key;
    };
    const ff = "ff".repeat(16);
    expect(hex(poly1305(k("01"), unhex(ff + "f0" + "ff".repeat(15) + "11" + "00".repeat(15))))).toBe(
      "05000000000000000000000000000000",
    );
    expect(hex(poly1305(k("01"), unhex(ff + "fb" + "fe".repeat(15) + "01".repeat(16))))).toBe(
      "00000000000000000000000000000000",
    );
    expect(hex(poly1305(k("02"), unhex("fd" + "ff".repeat(15))))).toBe("faffffffffffffffffffffffffffffff");
    const r10 = "0100000000000000" + "0400000000000000";
    const m11 = "e33594d7505e43b900000000000000003394d7505e4379cd010000000000000000000000000000000000000000000000";
    expect(hex(poly1305(k(r10), unhex(m11 + "01" + "00".repeat(15))))).toBe("14000000000000005500000000000000");
    expect(hex(poly1305(k(r10), unhex(m11)))).toBe("13000000000000000000000000000000");
  });

  it("Poly1305: matches a straightforward BigInt reference on random and extreme inputs", () => {
    const ref = (key: Uint8Array, msg: Uint8Array): string => {
      const le = (b: Uint8Array) => b.reduceRight((acc, v) => (acc << 8n) | BigInt(v), 0n);
      const p = (1n << 130n) - 5n;
      const r = le(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
      const s = le(key.subarray(16, 32));
      let h = 0n;
      for (let off = 0; off < msg.length; off += 16) {
        const blk = msg.subarray(off, off + 16);
        h = ((h + le(blk) + (1n << BigInt(8 * blk.length))) * r) % p;
      }
      let tag = (h + s) & ((1n << 128n) - 1n);
      const out = new Uint8Array(16);
      for (let i = 0; i < 16; i++, tag >>= 8n) out[i] = Number(tag & 0xffn);
      return hex(out);
    };
    const cases: Array<[Uint8Array, Uint8Array]> = [];
    for (const kb of [0x00, 0xff]) for (const mb of [0x00, 0xff]) for (const len of [0, 1, 15, 16, 17, 31, 32, 33, 160]) {
      cases.push([new Uint8Array(32).fill(kb), new Uint8Array(len).fill(mb)]);
    }
    for (let i = 0; i < 400; i++) cases.push([randomBytes(32), randomBytes(i % 97)]);
    for (const [key, msg] of cases) expect(hex(poly1305(key, msg))).toBe(ref(key, msg));
  });

  it("BLAKE2b: RFC 7693 'abc' (512-bit) and empty input at 192 bits", () => {
    expect(hex(blake2b(new TextEncoder().encode("abc"), 64))).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
    // Multi-block input, cross-checked against node:crypto's blake2b512.
    const big = randomBytes(1000);
    expect(hex(blake2b(big, 64))).toBe(createHash("blake2b512").update(big).digest("hex"));
    expect(hex(blake2b(new Uint8Array(128), 64))).toBe(createHash("blake2b512").update(new Uint8Array(128)).digest("hex"));
  });

  it("XSalsa20 + HSalsa20: NaCl 'core1'/'stream' vectors", () => {
    // tests/core1.c in NaCl: HSalsa20 of the box shared secret
    const shared = unhex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
    expect(hex(hsalsa20(shared, new Uint8Array(16)))).toBe("1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389");
    // tests/stream.c: first bytes of XSalsa20 keystream for the box key and nonce
    const key = unhex("1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389");
    const nonce = unhex("69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37");
    const ks = xsalsa20Xor(key, nonce, new Uint8Array(4194304 / 1024));
    expect(hex(ks.subarray(0, 32))).toBe("eea6a7251c1e72916d11c2cb214d3c252539121d8e234e652d651fa4c8cff880");
  });

  it("sealed box size and freshness", () => {
    const kp = boxKeyPair();
    const a = sealBox(new Uint8Array(10), kp.publicKey);
    const b = sealBox(new Uint8Array(10), kp.publicKey);
    expect(a.length).toBe(58);
    expect(hex(a)).not.toBe(hex(b));
    expect(hex(boxPublicFromSecret(kp.secretKey))).toBe(hex(kp.publicKey));
    expect(() => sealBox(new Uint8Array(1), new Uint8Array(31))).toThrow(RangeError);
  });
});

describe.skipIf(!hasPyNaCl)("sealed box interop with libsodium (PyNaCl)", () => {
  it("PyNaCl opens SDK sealed boxes and matches byte for byte", () => {
    const kp = boxKeyPair();
    const sizes = [0, 1, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 1000, 4096, 65537, 1 << 20];
    const sealed = sizes.map((n) => {
      const msg = randomBytes(n);
      return { msg: hex(msg), sealed: hex(sealBox(msg, kp.publicKey)) };
    });
    const deterministic = sizes.slice(0, 14).map((n) => {
      const esk = randomBytes(32);
      const msg = randomBytes(n);
      return { esk: hex(esk), pk: hex(kp.publicKey), msg: hex(msg), sealed: hex(sealBox(msg, kp.publicKey, new Uint8Array(esk))) };
    });
    // A tampered box must not open.
    const bad = { ...sealed[5]! };
    bad.sealed = bad.sealed.slice(0, -2) + (bad.sealed.endsWith("00") ? "01" : "00");
    const out = JSON.parse(
      execFileSync("python3", ["-I", checker], {
        input: JSON.stringify({ secret_key: hex(kp.secretKey), sealed: [...sealed, bad], deterministic }),
        maxBuffer: 64 << 20,
      }).toString(),
    ) as { opened: boolean[]; deterministic: boolean[] };
    expect(out.opened).toEqual([...sizes.map(() => true), false]);
    expect(out.deterministic).toEqual(deterministic.map(() => true));
  });
});

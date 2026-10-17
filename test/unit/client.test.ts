import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import CatzPrintDefault, { AuthenticationError, CatzPrint, detectKind } from "../../src/index.js";
import { boxKeyPair } from "../../src/nacl.js";
import { fakeApi, job, KEY, ORG, send } from "./helpers.js";

const PDF = new Uint8Array(Buffer.from("%PDF-1.4\n%fake\n"));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const offline = () => new CatzPrint({ apiKey: KEY, baseUrl: "http://127.0.0.1:1", orgId: ORG });

describe("construction and secrecy", () => {
  it("refuses a base URL that would send the key in clear text", () => {
    for (const bad of ["http://api-v1.catzprint.com", "http://10.0.0.5:8080", "ftp://x.test", "not a url", "https://u:p@x.test", "https://x.test/?a=1"]) {
      expect(() => new CatzPrint({ apiKey: KEY, baseUrl: bad })).toThrow(TypeError);
    }
    for (const ok of ["https://api.example.test", "http://localhost:8080", "http://127.0.0.1:1", "http://[::1]:3000"]) {
      expect(() => new CatzPrint({ apiKey: KEY, baseUrl: ok })).not.toThrow();
    }
  });

  it("never shows the API key", () => {
    const cz = new CatzPrint({ apiKey: "cz_live_SUPERSECRETvalue123", baseUrl: "http://127.0.0.1:1" });
    for (const s of [String(cz), JSON.stringify(cz), inspect(cz), inspect(cz, { showHidden: true, depth: 5 })]) {
      expect(s).not.toContain("SUPERSECRET");
    }
    expect(String(cz)).toContain("cz_live_****");
    expect(cz.mode).toBe("live");
    expect(Object.keys(cz)).not.toContain("apiKey");
  });

  it("reads CATZPRINT_API_KEY and CATZPRINT_BASE_URL", () => {
    const saved = { ...process.env };
    try {
      process.env.CATZPRINT_API_KEY = "cz_test_fromenv";
      process.env.CATZPRINT_BASE_URL = "https://example.test:9/";
      const cz = new CatzPrint();
      expect(cz.mode).toBe("test");
      expect(cz.baseUrl).toBe("https://example.test:9");
      delete process.env.CATZPRINT_BASE_URL;
      expect(new CatzPrint().baseUrl).toBe("https://api-v1.catzprint.com");
      delete process.env.CATZPRINT_API_KEY;
      expect(() => new CatzPrint()).toThrow(AuthenticationError);
      expect(() => new CatzPrint({ apiKey: "sk_wrong" })).toThrow(/cz_live_/);
    } finally {
      process.env = saved;
    }
  });

  it("has a default export", () => {
    expect(CatzPrintDefault).toBe(CatzPrint);
  });
});

describe("job body building", () => {
  const build = (p: Parameters<CatzPrint["jobs"]["buildCreateBody"]>[0]) => offline().jobs.buildCreateBody(p);

  it("text", async () => {
    const b = await build({ text: "Hello", role: "receipt", copies: 2, reference: "A1", scheduledFor: new Date("2030-01-01T00:00:00Z") });
    expect(b).toMatchObject({ kind: "text", content: "Hello", role: "receipt", copies: 2, reference: "A1", scheduled_for: "2030-01-01T00:00:00.000Z" });
    expect(b).not.toHaveProperty("printer_id");
  });

  it("commands and templates", async () => {
    expect(await build({ commands: [{ type: "text", text: "x", bold: true }, { type: "cut" }] })).toMatchObject({
      kind: "commands",
      commands: [{ type: "text", text: "x", bold: true }, { type: "cut" }],
    });
    expect(await build({ templateId: "t1", data: { total: "9.99" } })).toMatchObject({ kind: "template", template_id: "t1", data: { total: "9.99" } });
    expect(await build({ templateId: "t1" })).toMatchObject({ data: {} });
  });

  it("content: detects PDF/PNG, base64-encodes, defers to fileName", async () => {
    expect(await build({ content: PDF })).toMatchObject({ kind: "pdf", content: Buffer.from(PDF).toString("base64") });
    expect(await build({ content: PNG.buffer })).toMatchObject({ kind: "image" });
    const doc = await build({ content: new Uint8Array([1, 2, 3]), fileName: "menu.docx" });
    expect(doc).toMatchObject({ file_name: "menu.docx", content: "AQID" });
    expect(doc).not.toHaveProperty("kind");
    expect(await build({ content: new TextEncoder().encode("plain"), kind: "text" })).toMatchObject({ content: "plain" });
    expect(await build({ content: new Uint8Array([27, 64]), kind: "escpos" })).toMatchObject({ content: "G0A=" });
    await expect(build({ content: new Uint8Array([1, 2]) })).rejects.toThrow(/Set kind/);
  });

  it("rejects zero or several sources, and sealed commands", async () => {
    await expect(build({})).rejects.toThrow(/exactly one/);
    await expect(build({ text: "a", commands: [] })).rejects.toThrow(/exactly one/);
    await expect(build({ commands: [], sealed: true })).rejects.toThrow(/sealed/);
    await expect(build({ text: "a", kind: "pdf" })).rejects.toThrow(/kind "text"/);
  });

  it("detectKind", () => {
    expect(detectKind(PDF)).toBe("pdf");
    expect(detectKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image");
    expect(detectKind(new Uint8Array([0]))).toBeUndefined();
  });
});

const hasPyNaCl = spawnSync("python3", ["-c", "import nacl"]).status === 0;
const checker = fileURLToPath(new URL("../../scripts/pynacl_check.py", import.meta.url));

describe("print helpers over a fake API", () => {
  let api: Awaited<ReturnType<typeof fakeApi>> | undefined;
  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  it.skipIf(!hasPyNaCl)("printPdf(path, { sealed }) sends sealed_content that libsodium opens", async () => {
    const kp = boxKeyPair();
    api = await fakeApi((r, res) => {
      if (r.url === "/v1/public/server-key") return send(res, 200, { public_key: Buffer.from(kp.publicKey).toString("base64"), algorithm: "x25519-xsalsa20-poly1305-sealed-box" });
      send(res, 201, { job: job({ kind: "pdf", title: r.json.title }) });
    });
    const dir = mkdtempSync(join(tmpdir(), "cz-"));
    const file = join(dir, "invoice.pdf");
    writeFileSync(file, PDF);
    const cz = new CatzPrint({ apiKey: KEY, baseUrl: api.url, orgId: ORG });
    const j = await cz.printPdf(file, { printerId: "office", sealed: true });
    expect(j.title).toBe("invoice.pdf");
    const body = api.requests[1]!.json;
    expect(body.kind).toBe("pdf");
    expect(body).not.toHaveProperty("content");
    const sealed = Buffer.from(body.sealed_content, "base64");
    expect(sealed.length).toBe(PDF.length + 48);
    const out = JSON.parse(
      execFileSync("python3", ["-I", checker], {
        input: JSON.stringify({
          secret_key: Buffer.from(kp.secretKey).toString("hex"),
          sealed: [{ msg: Buffer.from(PDF).toString("hex"), sealed: sealed.toString("hex") }],
          deterministic: [],
        }),
      }).toString(),
    );
    expect(out.opened).toEqual([true]);
  });

  it("printText / printReceipt / printTemplate / printImage map to jobs.create", async () => {
    api = await fakeApi((_r, res) => send(res, 201, { job: job() }));
    const cz = new CatzPrint({ apiKey: KEY, baseUrl: api.url, orgId: ORG });
    await cz.printText("Hi", { printerId: "p" });
    await cz.printReceipt([{ type: "text", text: "Hi" }], { role: "kitchen" });
    await cz.printTemplate("t1", { n: 1 }, { locationId: "l" });
    await cz.printImage(PNG, { printerId: "p", title: "Logo" });
    const bodies = api.requests.map((r) => r.json);
    expect(bodies[0]).toMatchObject({ kind: "text", content: "Hi", printer_id: "p" });
    expect(bodies[1]).toMatchObject({ kind: "commands", role: "kitchen" });
    expect(bodies[2]).toMatchObject({ kind: "template", template_id: "t1", data: { n: 1 }, location_id: "l" });
    expect(bodies[3]).toMatchObject({ kind: "image", title: "Logo", content: Buffer.from(PNG).toString("base64") });
  });
});

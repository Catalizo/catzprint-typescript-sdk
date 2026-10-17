/**
 * Integration tests against a running CatzPrint API.
 *
 *   CATZPRINT_TEST_FIXTURE=/tmp/czdev/sdk/fixture.json npm run test:integration
 *
 * The fixture names an org with a receipt and an office printer on one
 * paired station, whose device token lets the test "play the station".
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CatzPrint,
  ConflictError,
  PermissionError,
  ValidationError,
  type Job,
} from "../../src/index.js";

interface Fixture {
  base_url: string;
  org_id: string;
  location_id: string;
  receipt_printer_id: string;
  office_printer_id: string;
  api_key_live: string;
  api_key_test: string;
  api_key_printers_read_only: string;
  device_token: string;
  device_private_key_b64: string;
}

const fixturePath = process.env.CATZPRINT_TEST_FIXTURE;
const fx: Fixture | undefined = fixturePath ? JSON.parse(readFileSync(fixturePath, "utf8")) : undefined;
const hasPyNaCl = spawnSync("python3", ["-c", "import nacl"]).status === 0;

// A tiny but well-formed one-page PDF.
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

async function device(method: string, path: string, body?: unknown): Promise<{ status: number; body: Buffer }> {
  const res = await fetch(fx!.base_url + path, {
    method,
    headers: { Authorization: `Bearer ${fx!.device_token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : null,
  });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

/** Plays the station: pull pending jobs (marks them sent), then report one printed. */
async function stationPrints(jobId: string, status: "printed" | "failed" = "printed", detail = ""): Promise<void> {
  const pull = await device("GET", "/v1/device/jobs");
  expect(pull.status).toBe(200);
  const res = await device("POST", `/v1/device/jobs/${jobId}/status`, { status, detail });
  expect([200, 204]).toContain(res.status);
}

describe.skipIf(!fx)("live dev API", () => {
  const live = () => new CatzPrint({ apiKey: fx!.api_key_live, baseUrl: fx!.base_url });
  const test = () => new CatzPrint({ apiKey: fx!.api_key_test, baseUrl: fx!.base_url });

  it("1. key() returns the org", async () => {
    const cz = live();
    const k = await cz.key();
    expect(k.org_id).toBe(fx!.org_id);
    expect(k.live).toBe(true);
    expect(k.scopes).toContain("jobs:write");
    expect(await cz.orgId()).toBe(fx!.org_id);
    const t = await test().whoami();
    expect(t.org_id).toBe(fx!.org_id);
    expect(t.live).toBe(false);
  });

  it("reads printers, locations and templates", async () => {
    const cz = live();
    const printers = await cz.printers.list();
    expect(printers.map((p) => p.id)).toEqual(expect.arrayContaining([fx!.receipt_printer_id, fx!.office_printer_id]));
    const receipt = printers.find((p) => p.id === fx!.receipt_printer_id)!;
    expect(receipt.capabilities).toContain("escpos");
    const locations = await cz.locations.list();
    expect(locations.map((l) => l.id)).toContain(fx!.location_id);
    const loc = await cz.locations.get(fx!.location_id);
    expect(loc.id).toBe(fx!.location_id);
    expect(Array.isArray(await cz.templates.list())).toBe(true);
  });

  let testJob: Job;

  it("2. prints text with the TEST key: live=false, billed_as=test", async () => {
    testJob = await test().printText("CatzPrint Node SDK test\nHello!", {
      printerId: fx!.receipt_printer_id,
      title: "Node SDK text",
      reference: `node-${Date.now()}`,
    });
    expect(testJob.live).toBe(false);
    expect(testJob.billed_as).toBe("test");
    expect(testJob.kind).toBe("escpos");
    expect(testJob.printer_id).toBe(fx!.receipt_printer_id);
    expect(["queued", "sent"]).toContain(testJob.status);
  });

  let sealedJob: Job;

  it("3. prints a sealed PDF with the LIVE key to the office printer", async () => {
    sealedJob = await live().printPdf(PDF, { printerId: fx!.office_printer_id, sealed: true, title: "Node SDK sealed PDF" });
    expect(sealedJob.live).toBe(true);
    expect(sealedJob.kind).toBe("pdf");
    expect(sealedJob.size).toBe(PDF.length);
    expect(sealedJob.printer_id).toBe(fx!.office_printer_id);
  });

  it.skipIf(!hasPyNaCl)("3b. the station receives exactly the PDF (server opened our seal)", async () => {
    await device("GET", "/v1/device/jobs"); // marks it sent
    const res = await device("GET", `/v1/device/jobs/${sealedJob.id}/content`);
    expect(res.status).toBe(200);
    const opened = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        "import sys,base64;from nacl.public import PrivateKey,SealedBox;" +
          "sk=PrivateKey(base64.b64decode(sys.argv[1]));sys.stdout.buffer.write(SealedBox(sk).decrypt(sys.stdin.buffer.read()))",
        fx!.device_private_key_b64,
      ],
      { input: res.body },
    );
    expect(Buffer.compare(opened, PDF)).toBe(0);
  });

  it("4. the station prints it and waitFor returns printed", async () => {
    await stationPrints(sealedJob.id);
    const done = await live().jobs.waitFor(sealedJob.id, { timeoutMs: 20_000, intervalMs: 250 });
    expect(done.status).toBe("printed");
    expect(done.printed_at).toBeTruthy();
    expect(done.events.map((e) => e.status)).toContain("printed");

    await stationPrints(testJob.id);
    expect((await test().jobs.waitFor(testJob.id, { timeoutMs: 20_000, intervalMs: 250 })).status).toBe("printed");
  });

  it("5. list includes the job; a scheduled job can be cancelled", async () => {
    const cz = live();
    const page = await cz.jobs.list({ printerId: fx!.office_printer_id, limit: 50 });
    expect(page.items.map((j) => j.id)).toContain(sealedJob.id);
    // Auto-pagination with a tiny page size.
    let seen = 0;
    let found = false;
    for await (const j of cz.jobs.iterate({ printerId: fx!.office_printer_id, limit: 2 })) {
      seen++;
      if (j.id === sealedJob.id) found = true;
      if (found && seen >= 3) break;
    }
    expect(found).toBe(true);

    const scheduled = await test().printText("Later", {
      printerId: fx!.receipt_printer_id,
      scheduledFor: new Date(Date.now() + 3600_000),
    });
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.scheduled_for).toBeTruthy();
    const cancelled = await test().jobs.cancel(scheduled.id);
    expect(cancelled.status).toBe("cancelled");
    await expect(test().jobs.cancel(scheduled.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("retry and reprint", async () => {
    const cz = test();
    const j = await cz.printReceipt(
      [
        { type: "text", text: "Retry me", align: "center", bold: true },
        { type: "columns", columns: [{ text: "Item" }, { text: "1.00", align: "right" }] },
        { type: "cut" },
      ],
      { printerId: fx!.receipt_printer_id },
    );
    await stationPrints(j.id, "failed", "Paper out");
    expect((await cz.jobs.get(j.id)).status).toBe("failed");
    const retried = await cz.jobs.retry(j.id);
    expect(retried.status).toBe("queued");
    await stationPrints(j.id);
    const re = await cz.jobs.reprint(j.id, { copies: 2 });
    expect(re.reprint_of).toBe(j.id);
    expect(re.copies).toBe(2);
    await stationPrints(re.id);
  });

  it("6. errors: read-only key, bad key, unknown printer", async () => {
    const ro = new CatzPrint({ apiKey: fx!.api_key_printers_read_only, baseUrl: fx!.base_url });
    const e1 = await ro.printText("nope", { printerId: fx!.receipt_printer_id }).catch((e) => e);
    expect(e1).toBeInstanceOf(PermissionError);
    expect(e1.status).toBe(403);
    expect(e1.code).toBe("forbidden");

    const bad = new CatzPrint({ apiKey: "cz_live_thisKeyDoesNotExist000000000000000", baseUrl: fx!.base_url });
    const e2 = await bad.key().catch((e) => e);
    expect(e2).toBeInstanceOf(AuthenticationError);
    expect(e2.code).toBe("invalid_api_key");

    const e3 = await test().printText("x", { printerId: randomUUID() }).catch((e) => e);
    expect(e3).toBeInstanceOf(ValidationError);
    expect(e3.fields).toHaveProperty("printer_id");

    const e4 = await test().jobs.get(randomUUID()).catch((e) => e);
    expect(e4.name).toBe("NotFoundError");
  });

  it("7. the same idempotency key returns the same job", async () => {
    const cz = test();
    const key = `node-sdk-${randomUUID()}`;
    const a = await cz.printText("Once", { printerId: fx!.receipt_printer_id, idempotencyKey: key });
    const b = await cz.printText("Once", { printerId: fx!.receipt_printer_id, idempotencyKey: key });
    expect(b.id).toBe(a.id);
    await stationPrints(a.id);
  });
});

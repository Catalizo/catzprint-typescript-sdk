import { inspect } from "node:util";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CatzPrintError,
  FileTokenStore,
  MemoryTokenStore,
  NoPinError,
  OutcomeUnknownError,
  OutOfPrintsError,
  PermissionError,
  PinMismatchError,
  PrinterError,
  ServerError,
  StationUnreachableError,
  ValidationError,
  isCoverOpen,
  isOfflineAllowanceExhausted,
  isOutOfPaper,
  isPrinterOffline,
  isStationUnreachable,
  type CatzPrint,
} from "../../src/index.js";
import { MDNS_SERVICE, MdnsCollector, buildQuery } from "../../src/local/dns.js";
import { mdnsBrowse } from "../../src/local/mdns.js";
import { dashedIp } from "../../src/local/transport.js";
import { DEAD_CLOUD, certs, deadUrl, fakeCloud, fakeResponder, fakeStation, localClient, spkiOf } from "./localHelpers.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function station(cert = certs.selfSigned) {
  const s = await fakeStation(cert);
  cleanups.push(s.close);
  return s;
}
async function cloud() {
  const c = await fakeCloud();
  cleanups.push(c.close);
  return c;
}
function client(...args: Parameters<typeof localClient>): CatzPrint {
  const c = localClient(...args);
  cleanups.push(() => c.close());
  return c;
}
const kitchen = (key?: string) => ({ role: "kitchen", templateId: "tpl-kitchen", data: { table: "12" }, reference: "order-1042", idempotencyKey: key });

// ---- DNS packets ----

type RR = { name: string; type: "PTR" | "SRV" | "TXT" | "A"; ptr?: string; port?: number; target?: string; txt?: string[]; a?: string };

function nameBytes(n: string): number[] {
  const out: number[] = [];
  for (const l of n.replace(/\.$/, "").split(".")) {
    const b = [...new TextEncoder().encode(l)];
    out.push(b.length, ...b);
  }
  return [...out, 0];
}

function response(answers: RR[], additionals: RR[] = []): Uint8Array {
  const rr = (r: RR) => {
    let type = 0;
    let rd: number[] = [];
    if (r.type === "PTR") (type = 12), (rd = nameBytes(r.ptr!));
    if (r.type === "SRV") (type = 33), (rd = [0, 0, 0, 0, r.port! >> 8, r.port! & 255, ...nameBytes(r.target!)]);
    if (r.type === "TXT") (type = 16), (rd = r.txt!.flatMap((s) => { const b = [...new TextEncoder().encode(s)]; return [b.length, ...b]; }));
    if (r.type === "A") (type = 1), (rd = r.a!.split(".").map(Number));
    return [...nameBytes(r.name), 0, type, 0x80, 1, 0, 0, 0, 120, rd.length >> 8, rd.length & 255, ...rd];
  };
  const h = [0, 0, 0x84, 0, 0, 0, 0, answers.length, 0, 0, 0, additionals.length];
  return new Uint8Array([...h, ...answers.flatMap(rr), ...additionals.flatMap(rr)]);
}

function announcement(o: { name?: string; id?: string; org?: string; loc?: string; port: number; fp: string; ip: string; extra?: string[]; tls?: string; host?: string }) {
  const inst = `${o.name ?? "Kitchen PC"} (CatzPrint).${MDNS_SERVICE}`;
  const host = `catzprint-${o.id ?? "st1"}.local`;
  const txt = [...(o.extra ?? []), "v=1", `id=${o.id ?? "st1"}`, `org=${o.org ?? "34c4671b-d2ab-4ddf-aaac-615786d5acac"}`, `loc=${o.loc ?? "loc1"}`,
    `port=${o.port}`, `fp=${o.fp}`, `tls=${o.tls ?? "self_signed"}`, `host=${o.host ?? ""}`];
  return response([{ name: MDNS_SERVICE, type: "PTR", ptr: inst }], [
    { name: inst, type: "SRV", port: o.port, target: host },
    { name: inst, type: "TXT", txt },
    { name: host, type: "A", a: o.ip },
  ]);
}

describe("mDNS packets", () => {
  it("builds a PTR query with the QU bit", () => {
    const q = buildQuery();
    expect([...q.slice(0, 12)]).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    expect([...q.slice(-4)]).toEqual([0, 12, 0x80, 1]);
    expect(new TextDecoder().decode(q.slice(12, -4))).toContain("_catzprint");
  });

  it("parses a full announcement", () => {
    const fp = "a1".repeat(32);
    const col = new MdnsCollector();
    col.add(announcement({ port: 7443, fp, ip: "192.168.1.20" }), "192.168.1.20");
    expect(col.stations()).toEqual([
      { instance: "Kitchen PC (CatzPrint)", stationId: "st1", orgId: "34c4671b-d2ab-4ddf-aaac-615786d5acac", locationId: "loc1", port: 7443,
        fingerprint: fp, tlsMode: "self_signed", hostname: "", addresses: ["192.168.1.20"] },
    ]);
  });

  it("combines split packets, uses the source address without an A record, and compression pointers", () => {
    const inst = `Bar (CatzPrint).${MDNS_SERVICE}`;
    const col = new MdnsCollector();
    col.add(response([{ name: MDNS_SERVICE, type: "PTR", ptr: inst }]), "10.0.0.9");
    expect(col.stations()).toEqual([]);
    col.add(response([
      { name: inst, type: "SRV", port: 7000, target: "catzprint-st2.local" },
      { name: inst, type: "TXT", txt: ["v=1", "id=st2", "port=7443", `FP=${"0F".repeat(32)}`, "tls=public", "host=10-0-0-9.abcdefghij.local.catzprint.com"] },
    ]), "10.0.0.9");
    const [s] = col.stations();
    expect(s).toMatchObject({ stationId: "st2", port: 7443, fingerprint: "0f".repeat(32), addresses: ["10.0.0.9"], hostname: "10-0-0-9.abcdefghij.local.catzprint.com" });

    // A name compressed with a pointer to the question.
    const q = [...nameBytes(MDNS_SERVICE)];
    const pkt = new Uint8Array([0, 0, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0, ...q, 0, 12, 0, 1, 0xc0, 12, 0, 12, 0, 1, 0, 0, 0, 120, 0, 2, 0xc0, 12]);
    const c2 = new MdnsCollector();
    c2.add(pkt); // a PTR pointing at itself isn't an instance: ignored, no crash
    expect(c2.stations()).toEqual([]);
  });

  it("ignores bad announcements and garbage", () => {
    const fp = "aa".repeat(32);
    for (const pkt of [
      announcement({ port: 7443, fp, ip: "192.168.1.2", extra: ["v=2"] }),
      announcement({ port: 7443, fp: "zz", ip: "192.168.1.2" }),
      announcement({ id: "", port: 7443, fp, ip: "192.168.1.2" }),
      announcement({ port: 7443, fp, ip: "192.168.1.2" }).slice(0, 40),
      buildQuery(),
      new Uint8Array([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 12]), // pointer loop
    ]) {
      const col = new MdnsCollector();
      col.add(pkt, "192.168.1.2");
      expect(col.stations()).toEqual([]);
    }
  });

  it("browses over UDP and honours abort", async () => {
    const r = await fakeResponder(announcement({ port: 7443, fp: "ab".repeat(32), ip: "192.168.1.20" }));
    cleanups.push(r.close);
    const t0 = Date.now();
    const found = await mdnsBrowse(300, r.target);
    expect(found.map((s) => s.stationId)).toEqual(["st1"]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const t1 = Date.now();
    await mdnsBrowse(5000, r.target, ctrl.signal);
    expect(Date.now() - t1).toBeLessThan(1000);
  });
});

describe("dashedIp", () => {
  it("maps only private/loopback dashed hostnames", () => {
    expect(dashedIp("192-168-1-20.ab3k9x2mqp.local.catzprint.com", "ab3k9x2mqp")).toBe("192.168.1.20");
    expect(dashedIp("192-168-1-20.ab3k9x2mqp.local.catzprint.com", "otherlabel")).toBeUndefined();
    expect(dashedIp("192-168-1-20.ab3k9x2mqp.local.catzprint.com", undefined)).toBeUndefined();
    expect(dashedIp("10-0-0-5.x.y", "x")).toBe("10.0.0.5");
    expect(dashedIp("8-8-8-8.x.local.catzprint.com", "x")).toBeUndefined();
    expect(dashedIp("192-168-1.x.y", "x")).toBeUndefined();
    expect(dashedIp("192-168-1-20.com", "com")).toBeUndefined();
  });
});

// ---- modes and fallback ----

describe("local mode", () => {
  it("prints on the station with a minted token and an sdk- key", async () => {
    const c = await cloud();
    const st = await station();
    const cz = client(c.url, { mode: "local", locationId: "loc1", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    const j = await cz.jobs.create({ role: "kitchen", commands: [{ type: "text", text: "ALLERGY", invert: true }, { type: "cut" }], copies: 2 });
    expect(j).toMatchObject({ via: "local", printed_locally: true, status: "queued", copies: 2, live: true, printer_name: "Kitchen" });
    expect(j.id).toMatch(/^lj_/);
    expect(j.local?.station_url).toBe(st.url);
    const [r] = st.jobRequests();
    expect(r!.auth).toMatch(/^Bearer czl1\./);
    expect(r!.body).toMatchObject({ kind: "commands", role: "kitchen", location_id: "loc1", copies: 2 });
    expect(r!.body.idempotency_key).toMatch(/^sdk-[0-9a-f-]{36}$/);
    expect(c.state.mints).toEqual([{ device_name: "Hub", location_ids: ["loc1"], ttl_days: 30 }]);
    await cz.jobs.create({ text: "again" });
    expect(c.state.mints).toHaveLength(1);
    expect(c.state.jobs).toHaveLength(0);
  });

  it("sends escpos as base64, honours waitSeconds, strips cloud-only fields", async () => {
    const c = await cloud();
    const st = await station();
    const cz = client(c.url, { mode: "local", stations: [st.url], fingerprints: { [st.url]: st.fp }, waitSeconds: 5 });
    const j = await cz.jobs.create({ content: new Uint8Array([0x1b, 0x40, 0x68]), kind: "escpos", title: "Raw" });
    expect(j.status).toBe("printed");
    expect(j.printed_at).not.toBeNull();
    const [r] = st.jobRequests();
    expect(r!.query).toBe("wait=5");
    expect(r!.body).toMatchObject({ kind: "escpos", content: Buffer.from([0x1b, 0x40, 0x68]).toString("base64"), title: "Raw" });
    expect(r!.body).not.toHaveProperty("file_name");
  });

  it("refuses PDFs locally; local_first sends them to the cloud", async () => {
    const c = await cloud();
    const st = await station();
    const pdf = new Uint8Array(Buffer.from("%PDF-1.4 x"));
    const local = client(c.url, { mode: "local", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    await expect(local.printPdf(pdf)).rejects.toMatchObject({ code: "unsupported_locally" });
    const lf = client(c.url, { mode: "local_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    expect((await lf.printPdf(pdf)).via).toBe("cloud");
    expect(st.reqs).toHaveLength(0);
  });

  it("tries the next station when one is unreachable", async () => {
    const c = await cloud();
    const st = await station();
    const dead = await deadUrl();
    const cz = client(c.url, { mode: "local", stations: [dead, st.url], fingerprints: { [dead]: st.fp, [st.url]: st.fp } });
    expect((await cz.jobs.create({ text: "x" })).local?.station_url).toBe(st.url);
  });

  it("validates its options", () => {
    const bad = [
      { mode: "offline" as never },
      { mode: "local" as const },
      { mode: "local" as const, stations: ["http://192.168.1.20:7443"] },
      { mode: "local" as const, stations: ["https://192.168.1.20:7443/x"] },
      { mode: "local" as const, discover: true, fingerprints: { x: "abc" } },
      { mode: "local" as const, discover: true, token: "cz_live_x" },
      { mode: "local" as const, discover: true, waitSeconds: 60 },
    ];
    for (const local of bad) expect(() => localClient(DEAD_CLOUD, local)).toThrow(TypeError);
  });
});

describe("local_first", () => {
  it("falls back to the cloud with the same key when the station is unreachable", async () => {
    const c = await cloud();
    const dead = await deadUrl();
    const cz = client(c.url, { mode: "local_first", stations: [dead], fingerprints: { [dead]: "ab".repeat(32) } });
    const j = await cz.jobs.create(kitchen("order-1042-kitchen-r1"));
    expect(j).toMatchObject({ via: "cloud", id: "cloud-1" });
    expect(c.state.jobs[0].idempotency_key).toBe("order-1042-kitchen-r1");
  });

  const cases: Array<[number, string, boolean, ((e: unknown) => boolean)?]> = [
    [502, "bad_gateway", true],
    [504, "gateway_timeout", true],
    [503, "local_disabled", true],
    [503, "printer_offline", false, isPrinterOffline],
    [503, "out_of_paper", false, isOutOfPaper],
    [503, "cover_open", false, isCoverOpen],
    [503, "printer_error", false, (e) => e instanceof PrinterError],
    [422, "no_printer", false, (e) => e instanceof ValidationError],
    [400, "invalid", false, (e) => e instanceof ValidationError],
    [402, "offline_allowance_exhausted", false, (e) => isOfflineAllowanceExhausted(e) && e instanceof OutOfPrintsError],
    [403, "device_not_approved", false, (e) => e instanceof PermissionError],
    [429, "rate_limited", false],
  ];
  for (const [status, code, fallback, check] of cases) {
    it(`${status} ${code} → ${fallback ? "cloud" : "returned"}`, async () => {
      const c = await cloud();
      const st = await station();
      st.fail = (p) => (p === "/local/v1/jobs" ? [status, code] : undefined);
      const cz = client(c.url, { mode: "local_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
      if (fallback) {
        const j = await cz.jobs.create(kitchen(`k-${code}`));
        expect(j.via).toBe("cloud");
        expect(c.state.jobs.map((x) => x.idempotency_key)).toEqual([`k-${code}`]);
        return;
      }
      const err = await cz.jobs.create(kitchen(`k-${code}`)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CatzPrintError);
      expect((err as CatzPrintError).code).toBe(code);
      expect(isStationUnreachable(err)).toBe(false);
      if (check) expect(check(err)).toBe(true);
      expect(c.state.jobs).toHaveLength(0);
    });
  }

  it("401: re-mints once and retries", async () => {
    const c = await cloud();
    const st = await station();
    st.accept = (tok) => tok.length > 0 && JSON.parse(Buffer.from(tok.split(".")[1] ?? "", "base64url").toString()).jti === "jti-2";
    const cz = client(c.url, { mode: "local", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    expect((await cz.jobs.create(kitchen("k1"))).via).toBe("local");
    expect(c.state.mints).toHaveLength(2);
    expect(st.jobRequests()).toHaveLength(2);
  });

  it("401 twice: local_first uses the cloud, local returns the 401", async () => {
    for (const mode of ["local_first", "local"] as const) {
      const c = await cloud();
      const st = await station();
      st.accept = () => false;
      const cz = client(c.url, { mode, stations: [st.url], fingerprints: { [st.url]: st.fp } });
      const res = await cz.jobs.create(kitchen("k401")).catch((e: unknown) => e);
      expect(c.state.mints).toHaveLength(2);
      expect(st.jobRequests()).toHaveLength(2);
      if (mode === "local_first") {
        expect(res).toMatchObject({ via: "cloud" });
        expect(c.state.jobs[0].idempotency_key).toBe("k401");
      } else {
        expect(res).toBeInstanceOf(AuthenticationError);
        expect((res as AuthenticationError).code).toBe("token_expired");
      }
    }
  });

  it("station and cloud both down: StationUnreachableError with the cloud error", async () => {
    const c = await cloud();
    const st = await station();
    st.accept = () => false;
    const cz = client(c.url, { mode: "local_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    await cz.local.token();
    c.state.down = true;
    const err = await cz.jobs.create(kitchen("k")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StationUnreachableError);
    expect((err as StationUnreachableError).cloudError).toBeInstanceOf(ServerError);
    expect((err as StationUnreachableError).code).toBe("station_unreachable");
    expect(String((err as Error).message)).toMatch(/cloud fallback failed too/);
  });

  it("times out a station that never recorded the job (probe 404) and falls back", async () => {
    const c = await cloud();
    const st = await station();
    st.jobDelayMs = 2000;
    const cz = client(c.url, { mode: "local_first", stations: [st.url], fingerprints: { [st.url]: st.fp }, requestTimeoutMs: 200 });
    const t0 = Date.now();
    const j = await cz.jobs.create({ text: "x", idempotencyKey: "slow-1" });
    expect(j.via).toBe("cloud");
    expect(c.state.jobs[0].idempotency_key).toBe("slow-1");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("an aborted signal stops without falling back", async () => {
    const c = await cloud();
    const st = await station();
    st.delayMs = 3000;
    const cz = client(c.url, { mode: "local_first", stations: [st.url], fingerprints: { [st.url]: st.fp }, requestTimeoutMs: 10_000 });
    await cz.local.token();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error("user cancelled")), 150);
    const t0 = Date.now();
    // Cancelled after the job was sent: it may print, so OutcomeUnknownError wrapping the cancellation (C6).
    const err = (await cz.jobs.create({ text: "x", signal: ctrl.signal }).catch((e: unknown) => e)) as OutcomeUnknownError;
    expect(err).toBeInstanceOf(OutcomeUnknownError);
    expect((err.cause as Error).message).toBe("user cancelled");
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(c.state.jobs).toHaveLength(0);
  });
});

describe("cloud_first", () => {
  it("503 → station with the same key, no cloud retries", async () => {
    const c = await cloud();
    c.state.jobStatus = 503;
    c.state.jobCode = "unavailable";
    const st = await station();
    const cz = client(c.url, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    const j = await cz.jobs.create({ text: "x" });
    expect(j.via).toBe("local");
    expect(c.state.jobs).toHaveLength(1);
    expect(st.jobRequests()[0]!.body.idempotency_key).toBe(c.state.jobs[0].idempotency_key);
    expect(c.state.jobs[0].idempotency_key).toMatch(/^sdk-/);
  });

  it("network error → station", async () => {
    const st = await station();
    const cz = client(DEAD_CLOUD, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp }, token: "czd_paired" });
    const j = await cz.jobs.create({ text: "x", idempotencyKey: "order-7" });
    expect(j.via).toBe("local");
    expect(st.jobRequests()[0]).toMatchObject({ auth: "Bearer czd_paired", body: { idempotency_key: "order-7" } });
  });

  for (const [status, code] of [[422, "no_printer"], [402, "out_of_prints"], [429, "rate_limited"], [401, "invalid_api_key"]] as const) {
    it(`${status} stays in the cloud`, async () => {
      const c = await cloud();
      c.state.jobStatus = status;
      c.state.jobCode = code;
      const st = await station();
      const cz = client(c.url, { mode: "cloud_first", stations: [st.url], fingerprints: { [st.url]: st.fp } });
      await expect(cz.jobs.create({ text: "x" })).rejects.toMatchObject({ code });
      expect(st.reqs).toHaveLength(0);
    });
  }

  it("both down", async () => {
    const c = await cloud();
    c.state.jobStatus = 503;
    c.state.jobCode = "unavailable";
    const dead = await deadUrl();
    const cz = client(c.url, { mode: "cloud_first", stations: [dead], fingerprints: { [dead]: "00".repeat(32) } });
    const err = (await cz.jobs.create({ text: "x" }).catch((e: unknown) => e)) as StationUnreachableError;
    expect(err).toBeInstanceOf(StationUnreachableError);
    expect(err.urls).toEqual([dead]);
    expect(err.cloudError).toBeInstanceOf(ServerError);
  });
});

it("cloud mode is unchanged (uuid key, via cloud)", async () => {
  const c = await cloud();
  const cz = client(c.url, {});
  const j = await cz.printText("x");
  expect(j.via).toBe("cloud");
  expect(c.state.jobs[0].idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
});

// ---- TLS ----

describe("TLS trust", () => {
  it("never contacts an IP station without a fingerprint", async () => {
    const st = await station();
    const cz = client(DEAD_CLOUD, { mode: "local", stations: [st.url], token: "czd_x" });
    const err = (await cz.jobs.create({ text: "x" }).catch((e: unknown) => e)) as StationUnreachableError;
    expect(err).toBeInstanceOf(StationUnreachableError);
    expect(err.attempts[0]!.error).toBeInstanceOf(NoPinError);
    expect(st.reqs).toHaveLength(0);
  });

  it("rejects a wrong fingerprint before sending anything", async () => {
    const st = await station();
    const cz = client(DEAD_CLOUD, { mode: "local", stations: [st.url], token: "czd_x", fingerprints: { [st.url]: certs.otherSelfSigned.fingerprint } });
    const err = (await cz.jobs.create({ text: "x" }).catch((e: unknown) => e)) as StationUnreachableError;
    expect(err.attempts[0]!.error).toBeInstanceOf(PinMismatchError);
    expect((err.attempts[0]!.error as PinMismatchError).actual).toBe(st.fp);
    expect(st.reqs).toHaveLength(0);
  });

  it("accepts colon/upper-case pins keyed by host:port", async () => {
    const st = await station();
    const pin = st.fp.toUpperCase().match(/../g)!.join(":");
    const cz = client(DEAD_CLOUD, { mode: "local", stations: [st.url], token: "czd_x", fingerprints: { [`127.0.0.1:${st.port}`]: pin } });
    expect((await cz.jobs.create({ text: "x" })).via).toBe("local");
  });

  it("pins the fingerprint from the cloud endpoint list", async () => {
    const c = await cloud();
    const st = await station();
    c.state.stations = [{ station_id: "st1", name: "K", location_id: "loc1", connected: true, local_enabled: true, port: st.port, addresses: ["127.0.0.1"],
      urls: [st.url], tls_mode: "self_signed", cert_fingerprint_sha256: st.fp, updated_at: "" }];
    const cz = client(c.url, { mode: "local", stations: [st.url] });
    const j = await cz.jobs.create({ text: "x" });
    expect(j.station_id).toBe("st1");
  });

  it("public hostnames come from the cloud list: verified, SPKI-pinned, dialled under their label", async () => {
    const st = await station(certs.publicLeaf);
    const url = `https://${certs.publicLeaf.host}:${st.port}`;
    const ep = { station_id: "st1", name: "K", location_id: "loc1", connected: true, local_enabled: true, port: st.port, addresses: [],
      urls: [url], tls_mode: "public", cert_fingerprint_sha256: "", public_spki_sha256: spkiOf(certs.publicLeaf.cert), local_label: "abcdefghij", updated_at: "" };
    const c = await cloud();
    c.state.stations = [ep];
    const ok = client(c.url, { mode: "local", discover: true, ca: certs.ca.cert });
    expect((await ok.jobs.create({ text: "x" })).local?.station_url).toBe(url);

    const c2 = await cloud();
    c2.state.stations = [{ ...ep, public_spki_sha256: "ab".repeat(32) }];
    const wrongKey = client(c2.url, { mode: "local", discover: true, ca: certs.ca.cert });
    const e1 = (await wrongKey.jobs.create({ text: "x" }).catch((e: unknown) => e)) as StationUnreachableError;
    expect(e1.attempts[0]!.error).toBeInstanceOf(PinMismatchError);
    expect((e1.attempts[0]!.error as PinMismatchError).spki).toBe(true);

    const noCa = client(c.url, { mode: "local", discover: true });
    const e2 = (await noCa.jobs.create({ text: "x" }).catch((e: unknown) => e)) as StationUnreachableError;
    expect(e2).toBeInstanceOf(StationUnreachableError);
    expect(String(e2.message)).toMatch(/certificate|issuer/i);

    // A configured hostname the cloud doesn't know isn't dialled at the IP in its name.
    const before = st.reqs.length;
    const unknown = client(DEAD_CLOUD, { mode: "local", stations: [url], token: "czd_x", ca: certs.ca.cert });
    await expect(unknown.jobs.create({ text: "x" })).rejects.toBeInstanceOf(StationUnreachableError);
    expect(st.reqs.length).toBe(before);
  });
});

// ---- token store ----

describe("token store", () => {
  it("FileTokenStore: 0600, atomic, survives reload, replaces corrupt files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cz-local-"));
    const path = join(dir, "sub", "tokens.json");
    const s = new FileTokenStore(path);
    expect(await s.load("a")).toBeUndefined();
    await Promise.all([s.save("a", { token: "czl1.a", expires_at: "2030-01-01T00:00:00Z" }), s.save("b", { token: "czl1.b" })]);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "sub"))).toEqual(["tokens.json"]);
    expect(await new FileTokenStore(path).load("a")).toMatchObject({ token: "czl1.a" });
    expect(await new FileTokenStore(path).load("b")).toMatchObject({ token: "czl1.b" });
    writeFileSync(path, "{nope");
    await expect(s.load("a")).rejects.toThrow();
    await s.save("a", { token: "czl1.c" });
    expect(await s.load("a")).toMatchObject({ token: "czl1.c" });
  });

  it("reuses a stored token after a restart, refreshes it in the background when < 7 days are left", async () => {
    const c = await cloud();
    const st = await station();
    c.state.stations = [];
    const path = join(mkdtempSync(join(tmpdir(), "cz-local-")), "tokens.json");
    const opts = { mode: "local" as const, locationId: "loc1", stations: [st.url], fingerprints: { [st.url]: st.fp }, tokenStore: new FileTokenStore(path) };
    await client(c.url, opts).jobs.create({ text: "1" });
    expect(c.state.mints).toHaveLength(1);
    await client(c.url, opts).jobs.create({ text: "2" });
    expect(c.state.mints).toHaveLength(1);
    expect(readFileSync(path, "utf8")).not.toContain("cz_test_");

    const all = JSON.parse(readFileSync(path, "utf8"));
    const key = Object.keys(all)[0]!;
    const old = all[key].token;
    all[key].expires_at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    all[key].issued_at = new Date(Date.now() - 27 * 86_400_000).toISOString(); // a 30-day token, 3 days left
    writeFileSync(path, JSON.stringify(all));
    const c3 = client(c.url, opts);
    await c3.jobs.create({ text: "3" });
    expect(st.jobRequests().at(-1)!.auth).toBe(`Bearer ${old}`);
    await c3.local.idle();
    expect(c.state.mints).toHaveLength(2);
    const renewed = (await new FileTokenStore(path).load(key))!;
    expect(renewed.token).not.toBe(old);

    renewed.expires_at = new Date(Date.now() - 60_000).toISOString();
    await new FileTokenStore(path).save(key, renewed);
    await client(c.url, opts).jobs.create({ text: "4" });
    expect(st.jobRequests().at(-1)!.auth).not.toBe(`Bearer ${renewed.token}`);
    expect(c.state.mints).toHaveLength(3);
  });

  it("uses the endpoint list from the mint and refreshes it when stale", async () => {
    const c = await cloud();
    const st = await station();
    c.state.stations = [{ station_id: "st1", name: "K", location_id: "loc1", connected: true, local_enabled: true, port: st.port, addresses: [],
      urls: [st.url], tls_mode: "self_signed", cert_fingerprint_sha256: st.fp, updated_at: "" }];
    const cz = client(c.url, { mode: "local", discover: true, tokenStore: new MemoryTokenStore() });
    let now = Date.now();
    cz.local.now = () => now;
    expect((await cz.jobs.create({ text: "x" })).local?.station_url).toBe(st.url);
    expect(c.state.endpoints).toBe(0);
    now += 2 * 3_600_000;
    await cz.jobs.create({ text: "y" });
    await cz.local.idle();
    expect(c.state.endpoints).toBe(1);
  });
});

// ---- mDNS end to end ----

describe("mDNS discovery", () => {
  it("offline, an announcement is used only with a configured fingerprint", async () => {
    const st = await station();
    const r = await fakeResponder(announcement({ port: st.port, fp: st.fp, ip: "127.0.0.1" }));
    cleanups.push(r.close);
    const bare = client(DEAD_CLOUD, { mode: "local", locationId: "loc1", discover: true, discoverTimeoutMs: 200, token: "czd_paired" });
    bare.local.mdnsTarget = r.target;
    await expect(bare.jobs.create({ text: "x" })).rejects.toBeInstanceOf(StationUnreachableError);
    expect(st.reqs).toHaveLength(0);
    const fingerprints = { "kitchen-pc": st.fp };
    const cz = client(DEAD_CLOUD, { mode: "local", locationId: "loc1", discover: true, discoverTimeoutMs: 200, token: "czd_paired", fingerprints });
    cz.local.mdnsTarget = r.target;
    const j = await cz.jobs.create({ text: "x" });
    expect(j.local?.station_url).toBe(st.url);
    expect(j.live).toBe(true);

    for (const ann of [announcement({ port: st.port, fp: st.fp, ip: "127.0.0.1", org: "other-org" }), announcement({ port: st.port, fp: st.fp, ip: "127.0.0.1", loc: "loc2" })]) {
      const r2 = await fakeResponder(ann);
      cleanups.push(r2.close);
      const cz2 = client(DEAD_CLOUD, { mode: "local", locationId: "loc1", discover: true, discoverTimeoutMs: 150, token: "czd_paired", fingerprints });
      cz2.local.mdnsTarget = r2.target;
      await expect(cz2.jobs.create({ text: "x" })).rejects.toBeInstanceOf(StationUnreachableError);
    }
  });

  it("ignores stations missing from a known endpoint list", async () => {
    const c = await cloud();
    const st = await station();
    c.state.stations = [{ station_id: "st1", name: "K", location_id: "loc1", connected: true, local_enabled: true, port: 1, addresses: [],
      urls: [await deadUrl()], tls_mode: "self_signed", cert_fingerprint_sha256: "cd".repeat(32), updated_at: "" }];
    const r = await fakeResponder(announcement({ id: "st666", port: st.port, fp: st.fp, ip: "127.0.0.1" }));
    cleanups.push(r.close);
    const cz = client(c.url, { mode: "local", discover: true, discoverTimeoutMs: 150 });
    cz.local.mdnsTarget = r.target;
    await expect(cz.jobs.create({ text: "x" })).rejects.toBeInstanceOf(StationUnreachableError);
    expect(st.reqs).toHaveLength(0);
  });
});

// ---- helpers ----

describe("local helpers", () => {
  it("status, info, pair, getJob, discover, tokens, endpoints", async () => {
    const c = await cloud();
    const st = await station();
    c.state.stations = [{ station_id: "st1", name: "Kitchen PC", location_id: "loc1", connected: true, local_enabled: true, port: st.port,
      addresses: ["127.0.0.1"], urls: [st.url], tls_mode: "self_signed", cert_fingerprint_sha256: st.fp, updated_at: "" }];
    const cz = client(c.url, { mode: "local", locationId: "loc1", discover: true, discoverTimeoutMs: 100 });
    cz.local.mdnsTarget = { address: "127.0.0.1", port: 9 };

    const s = await cz.local.status();
    expect(s).toMatchObject({ unsynced: 3, allowance: { prints_left: 1997 }, station_url: st.url });
    expect((await cz.local.info(st.url)).pairing_open).toBe(true);
    await expect(cz.local.pair(st.url, "1234", "Till")).rejects.toThrow(TypeError);
    await expect(cz.local.pair(st.url, "00000000", "Till")).rejects.toMatchObject({ code: "invalid_code" });
    const p = await cz.local.pair(st.url, "12345678", "Till 3");
    expect(p).toEqual({ token: "czd_paired", deviceId: "d_0123456789abcdef", stationId: "st1", orgId: "34c4671b-d2ab-4ddf-aaac-615786d5acac", locationId: "loc1" });
    expect(JSON.parse(JSON.stringify(p)).token).toBe("czd_paired"); // serializes (handed to tills)
    expect(inspect(p)).not.toContain("czd_paired"); // but not logged
    expect(st.reqs.at(-1)).toMatchObject({ auth: "", body: { device_name: "Till 3" } });

    const j = await cz.jobs.create({ text: "x" });
    const done = await cz.jobs.waitFor(j.id, { intervalMs: 10 });
    expect(done).toMatchObject({ status: "printed", via: "local" });
    await expect(cz.jobs.get("lj_missing")).rejects.toMatchObject({ code: "not_found" });

    const found = await cz.local.discover();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ stationId: "st1", fromCloud: true, fingerprint: st.fp, urls: [st.url] });

    const lt = await cz.localTokens.create({ deviceName: "Till 9", locationIds: ["loc1"], ttlDays: 7 });
    expect(lt.token).toMatch(/^czl1\./);
    expect(c.state.mints.at(-1)).toEqual({ device_name: "Till 9", location_ids: ["loc1"], ttl_days: 7 });
    await cz.localTokens.revoke(lt.token_id);
    expect(c.state.revoked).toEqual([lt.token_id]);
    expect(await cz.localEndpoints.list({ locationId: "loc1" })).toHaveLength(1);
    expect(c.requests.at(-1)!.url).toContain("location_id=loc1");
  });
});

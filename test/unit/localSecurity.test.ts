// Regression tests for the security review (FINDINGS.md H4, M6, M7, M8) and
// SPEC addendum 1 (A10, A11, A12, A15).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatzPrint, FileTokenStore, PinMismatchError, StationUnreachableError, type CatzPrint as Client } from "../../src/index.js";
import { endpointTargets, privateIp } from "../../src/local/manager.js";
import { MDNS_SERVICE } from "../../src/local/dns.js";
import { DEAD_CLOUD, certs, fakeCloud, fakeResponder, fakeStation, localClient } from "./localHelpers.js";
import { ORG } from "./helpers.js";

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
function client(...args: Parameters<typeof localClient>): Client {
  const c = localClient(...args);
  cleanups.push(() => c.close());
  return c;
}

function nameBytes(n: string): number[] {
  const out: number[] = [];
  for (const l of n.replace(/\.$/, "").split(".")) {
    const b = [...new TextEncoder().encode(l)];
    out.push(b.length, ...b);
  }
  return [...out, 0];
}

/** An mDNS announcement (PTR + SRV + TXT + A). */
function announce(o: { id: string; port: number; fp: string; ip: string; host?: string; tls?: string }): Uint8Array {
  const inst = `Kitchen (CatzPrint).${MDNS_SERVICE}`;
  const target = `catzprint-${o.id}.local`;
  const rr = (name: string, type: number, rd: number[]) => [...nameBytes(name), 0, type, 0x80, 1, 0, 0, 0, 120, rd.length >> 8, rd.length & 255, ...rd];
  const txt = ["v=1", `id=${o.id}`, `org=${ORG}`, "loc=loc1", `port=${o.port}`, `fp=${o.fp}`, `tls=${o.tls ?? "self_signed"}`, `host=${o.host ?? ""}`]
    .flatMap((s) => { const b = [...new TextEncoder().encode(s)]; return [b.length, ...b]; });
  const recs = [
    rr(MDNS_SERVICE, 12, nameBytes(inst)),
    rr(inst, 33, [0, 0, 0, 0, o.port >> 8, o.port & 255, ...nameBytes(target)]),
    rr(inst, 16, txt),
    rr(target, 1, o.ip.split(".").map(Number)),
  ];
  return new Uint8Array([0, 0, 0x84, 0, 0, 0, 0, recs.length, 0, 0, 0, 0, ...recs.flat()]);
}

describe("H4: mDNS impostor", () => {
  it("an impostor copying a listed station's ID (with its own hostname and fingerprint) gets nothing", async () => {
    const real = certs.selfSigned.fingerprint;
    const impostor = await station(certs.otherSelfSigned);
    const c = await cloud();
    c.state.stations = [{ station_id: "real-station", name: "K", location_id: "loc1", connected: true, local_enabled: true, port: impostor.port,
      addresses: ["192.168.1.20"], urls: [], tls_mode: "public", cert_fingerprint_sha256: real, updated_at: "" }];
    const r = await fakeResponder(announce({ id: "real-station", port: impostor.port, fp: impostor.fp, ip: "127.0.0.1", tls: "public",
      host: "127-0-0-1.attackerlbl.local.catzprint.com" }));
    cleanups.push(r.close);
    const cz = client(c.url, { mode: "local", discover: true, discoverTimeoutMs: 150, ca: certs.ca.cert });
    cz.local.mdnsTarget = r.target;
    const err = (await cz.jobs.create({ text: "secret" }).catch((e: unknown) => e)) as StationUnreachableError;
    expect(err).toBeInstanceOf(StationUnreachableError);
    // Only the IP was tried, pinned to the cloud's fingerprint; never the announced hostname.
    expect(err.urls).toEqual([`https://127.0.0.1:${impostor.port}`]);
    expect(err.attempts[0]!.error).toBeInstanceOf(PinMismatchError);
    expect((err.attempts[0]!.error as PinMismatchError).expected).toBe(real);
    expect(impostor.reqs).toHaveLength(0);
  });

  it("without a cloud list an announcement alone is never trusted (paired device)", async () => {
    const impostor = await station(certs.otherSelfSigned);
    const r = await fakeResponder(announce({ id: "x", port: impostor.port, fp: impostor.fp, ip: "127.0.0.1" }));
    cleanups.push(r.close);
    const cz = client(DEAD_CLOUD, { mode: "local", locationId: "loc1", discover: true, discoverTimeoutMs: 150, token: "czd_paired" });
    cz.local.mdnsTarget = r.target;
    await expect(cz.jobs.create({ text: "x" })).rejects.toBeInstanceOf(StationUnreachableError);
    expect(impostor.reqs).toHaveLength(0);
  });
});

describe("M6/A10: addresses and hostnames", () => {
  it("drops public IPs; hostnames get the label and SPKI from the list", () => {
    expect(privateIp("192.168.1.2")).toBe(true);
    expect(privateIp("fd00::1")).toBe(true);
    expect(privateIp("100.64.0.1")).toBe(false);
    expect(privateIp("203.0.113.9")).toBe(false);
    const fp = "cd".repeat(32);
    const ts = endpointTargets({ station_id: "s", name: "", location_id: null, connected: true, local_enabled: true, port: 7443, addresses: [],
      urls: ["https://192-168-1-20.abcdefghij.local.catzprint.com:7443", "https://192.168.1.20:7443", "https://203.0.113.9:7443"],
      tls_mode: "public", cert_fingerprint_sha256: fp, public_spki_sha256: "ef".repeat(32), local_label: "abcdefghij", updated_at: "" }, "cloud");
    expect(ts.map((t) => t.url)).toEqual(["https://192-168-1-20.abcdefghij.local.catzprint.com:7443", "https://192.168.1.20:7443"]);
    expect(ts[0]).toMatchObject({ label: "abcdefghij", spki: "ef".repeat(32), fingerprint: "" });
    expect(ts[1]).toMatchObject({ fingerprint: fp });
  });

  it("mints tokens bound to locationId; org-wide needs allLocations", async () => {
    expect(() => new CatzPrint({ apiKey: "cz_test_x", local: { mode: "local", discover: true } })).toThrow(/locationId/);
    const c = await cloud();
    const st = await station();
    const cz = client(c.url, { mode: "local", locationId: "loc9", stations: [st.url], fingerprints: { [st.url]: st.fp } });
    await cz.jobs.create({ text: "x" });
    expect(c.state.mints[0].location_ids).toEqual(["loc9"]);
  });
});

describe("M7/A11: re-minting", () => {
  for (const code of ["device_revoked", "unauthenticated"]) {
    it(`never re-mints on ${code}`, async () => {
      const c = await cloud();
      const st = await station();
      st.accept = () => false;
      st.rejectCode = code;
      const cz = client(c.url, { mode: "local", stations: [st.url], fingerprints: { [st.url]: st.fp } });
      await expect(cz.jobs.create({ text: "x" })).rejects.toMatchObject({ code });
      expect(c.state.mints).toHaveLength(1);
      expect(st.jobRequests()).toHaveLength(1);
    });
  }

  it("re-mints at most once per 10 minutes per store key, across restarts", async () => {
    const c = await cloud();
    const st = await station();
    st.accept = () => false;
    const tokenStore = new FileTokenStore(join(mkdtempSync(join(tmpdir(), "cz-remint-")), "t.json"));
    const opts = { mode: "local" as const, stations: [st.url], fingerprints: { [st.url]: st.fp }, tokenStore };
    for (let i = 0; i < 3; i++) {
      await expect(client(c.url, opts).jobs.create({ text: "x" })).rejects.toMatchObject({ code: "token_expired" });
    }
    expect(c.state.mints).toHaveLength(2);
    const later = client(c.url, opts);
    later.local.now = () => Date.now() + 11 * 60_000;
    await later.jobs.create({ text: "x" }).catch(() => {});
    expect(c.state.mints).toHaveLength(3);
  });
});

describe("M8/A12: pairing", () => {
  it("needs the fingerprint from the station app or the cloud list", async () => {
    const st = await station();
    const cz = new CatzPrint({ apiKey: "cz_test_x", baseUrl: DEAD_CLOUD, orgId: ORG });
    cleanups.push(() => cz.close());
    await expect(cz.local.pair(st.url, "12345678", "Till")).rejects.toThrow(/fingerprint/);
    const relayed = (await cz.local.pair(st.url, "12345678", "Till", { fingerprint: "ab".repeat(32) }).catch((e: unknown) => e)) as StationUnreachableError;
    expect(relayed).toBeInstanceOf(StationUnreachableError);
    expect(relayed.attempts[0]!.error).toBeInstanceOf(PinMismatchError);
    await expect(cz.local.pair(`https://${certs.publicLeaf.host}:${st.port}`, "12345678", "Till")).rejects.toThrow(/cloud endpoint list/);
    expect(st.reqs).toHaveLength(0);
    const p = await cz.local.pair(st.url, "12345678", "Till", { fingerprint: st.fp.toUpperCase() });
    expect(p.token).toBe("czd_paired");
  });
});

describe("A15 and paired devices", () => {
  it("maps LocalJob.live; paired devices are live", async () => {
    const st = await station();
    const cz = client(DEAD_CLOUD, { mode: "local", stations: [st.url], fingerprints: { [st.url]: st.fp }, token: "czd_paired" });
    expect((await cz.jobs.create({ text: "x" })).live).toBe(true);
    st.live = false;
    const j = await cz.jobs.create({ text: "y" });
    expect(j.live).toBe(false);
    expect(j.local?.live).toBe(false);
  });

  it("a paired device needs no API key in local mode; cloud calls say so", async () => {
    const saved = process.env.CATZPRINT_API_KEY;
    delete process.env.CATZPRINT_API_KEY;
    try {
      const st = await station();
      expect(() => new CatzPrint({ local: { mode: "local_first", stations: [st.url], token: "czd_paired" } })).toThrow(/API key/);
      const cz = new CatzPrint({ local: { mode: "local", stations: [st.url], fingerprints: { [st.url]: st.fp }, token: "czd_paired" } });
      cleanups.push(() => cz.close());
      expect((await cz.jobs.create({ role: "kitchen", text: "x" })).via).toBe("local");
      expect((await cz.local.status()).station_url).toBe(st.url);
      await expect(cz.printers.list()).rejects.toMatchObject({ code: "missing_api_key" });
    } finally {
      if (saved !== undefined) process.env.CATZPRINT_API_KEY = saved;
    }
  });
});

// Minimal DNS wire format for mDNS discovery (RFC 1035 / 6762 / 6763):
// build a PTR query, parse PTR/SRV/TXT/A answers. Pure functions on
// Uint8Array.

export const MDNS_SERVICE = "_catzprint._tcp.local";
export const MDNS_GROUP = "224.0.0.251";
export const MDNS_PORT = 5353;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

/** A station as announced over mDNS (spec §4.8). */
export interface MdnsStation {
  instance: string;
  stationId: string;
  orgId: string;
  locationId: string;
  port: number;
  /** Lower-case hex SHA-256 of the certificate, or "". */
  fingerprint: string;
  tlsMode: string;
  /** Public-cert hostname for that interface, or "". */
  hostname: string;
  addresses: string[];
}

function encodeName(name: string): number[] {
  const out: number[] = [];
  for (const label of name.replace(/\.$/, "").split(".")) {
    const bytes = new TextEncoder().encode(label);
    if (bytes.length === 0 || bytes.length > 63) throw new Error(`bad DNS label in ${name}`);
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  return out;
}

/** A PTR query for the CatzPrint service, with the unicast-response (QU) bit. */
export function buildQuery(): Uint8Array {
  const header = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]; // id 0, flags 0, 1 question
  return new Uint8Array([...header, ...encodeName(MDNS_SERVICE), 0, TYPE_PTR, 0x80, 0x01]);
}

class Reader {
  constructor(readonly b: Uint8Array) {}
  u16(o: number): number {
    if (o + 2 > this.b.length) throw new RangeError("short packet");
    return (this.b[o]! << 8) | this.b[o + 1]!;
  }
  /** Reads a (possibly compressed) name at o; returns it and the offset after it. */
  name(o: number): [string, number] {
    const labels: string[] = [];
    let end = -1;
    let jumps = 0;
    for (;;) {
      if (o >= this.b.length) throw new RangeError("short packet");
      const len = this.b[o]!;
      if (len === 0) {
        o += 1;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        if (++jumps > 32) throw new RangeError("compression loop");
        const ptr = this.u16(o) & 0x3fff;
        if (end < 0) end = o + 2;
        o = ptr;
        continue;
      }
      if ((len & 0xc0) !== 0) throw new RangeError("bad label");
      if (o + 1 + len > this.b.length) throw new RangeError("short packet");
      labels.push(new TextDecoder().decode(this.b.subarray(o + 1, o + 1 + len)));
      o += 1 + len;
    }
    return [labels.join("."), end >= 0 ? end : o];
  }
}

/** Accumulates records from any number of mDNS responses. */
export class MdnsCollector {
  readonly #ptr = new Set<string>();
  readonly #srv = new Map<string, { port: number; target: string }>();
  readonly #txt = new Map<string, Map<string, string>>();
  readonly #addr = new Map<string, string[]>();
  readonly #src = new Map<string, string>();
  readonly #names = new Map<string, string>();

  /** Parses one packet; malformed packets and unrelated records are ignored. */
  add(packet: Uint8Array, from?: string): void {
    try {
      this.#parse(packet, from);
    } catch {
      // ignore malformed packets
    }
  }

  #parse(b: Uint8Array, from?: string): void {
    const r = new Reader(b);
    const flags = r.u16(2);
    if ((flags & 0x8000) === 0) return; // a query, not a response
    const qd = r.u16(4);
    const rrCount = r.u16(6) + r.u16(8) + r.u16(10);
    let o = 12;
    for (let i = 0; i < qd; i++) o = r.name(o)[1] + 4;
    const svc = MDNS_SERVICE.toLowerCase();
    const isInstance = (n: string) => n.endsWith("." + svc) && n.length > svc.length + 1;
    // Parse every record first: the PTR may come after the SRV/TXT.
    const pending: Array<() => void> = [];
    for (let i = 0; i < rrCount; i++) {
      const [rawName, after] = r.name(o);
      const name = rawName.toLowerCase();
      const type = r.u16(after);
      const rdlen = r.u16(after + 8);
      const rd = after + 10;
      if (rd + rdlen > b.length) throw new RangeError("short packet");
      if (type === TYPE_PTR && name === svc) {
        const inst = r.name(rd)[0];
        if (isInstance(inst.toLowerCase())) {
          this.#ptr.add(inst.toLowerCase());
          this.#names.set(inst.toLowerCase(), inst);
        }
      } else if (type === TYPE_SRV && isInstance(name)) {
        const port = r.u16(rd + 4);
        const target = r.name(rd + 6)[0].toLowerCase();
        pending.push(() => {
          this.#srv.set(name, { port, target });
          this.#names.set(name, rawName);
          if (from) this.#src.set(name, from);
        });
      } else if (type === TYPE_TXT && isInstance(name)) {
        const kv = new Map<string, string>();
        let p = rd;
        while (p < rd + rdlen) {
          const len = b[p]!;
          const s = new TextDecoder().decode(b.subarray(p + 1, p + 1 + len));
          p += 1 + len;
          const eq = s.indexOf("=");
          const k = (eq < 0 ? s : s.slice(0, eq)).trim().toLowerCase();
          if (k && !kv.has(k)) kv.set(k, eq < 0 ? "" : s.slice(eq + 1)); // RFC 6763: first wins
        }
        pending.push(() => {
          this.#txt.set(name, kv);
          this.#names.set(name, rawName);
          if (from) this.#src.set(name, from);
        });
      } else if (type === TYPE_A && rdlen === 4) {
        const ip = `${b[rd]}.${b[rd + 1]}.${b[rd + 2]}.${b[rd + 3]}`;
        pending.push(() => {
          const list = this.#addr.get(name) ?? [];
          if (!list.includes(ip)) list.push(ip);
          this.#addr.set(name, list);
        });
      }
      o = rd + rdlen;
    }
    for (const f of pending) f();
  }

  /** Every complete, valid station seen so far, sorted by instance name. */
  stations(): MdnsStation[] {
    const out: MdnsStation[] = [];
    const svcSuffix = "." + MDNS_SERVICE;
    for (const name of [...this.#txt.keys()].sort()) {
      const srv = this.#srv.get(name);
      const kv = this.#txt.get(name)!;
      if (!srv || kv.get("v") !== "1" || !kv.get("id")) continue;
      let port = srv.port;
      const tp = Number(kv.get("port"));
      if (Number.isInteger(tp) && tp > 0 && tp < 65536) port = tp;
      if (!port) continue;
      const rawFp = kv.get("fp") ?? "";
      const fp = rawFp.replace(/[:\s]/g, "").toLowerCase();
      if (rawFp && !/^[0-9a-f]{64}$/.test(fp)) continue; // malformed: ignore the announcement
      const shown = this.#names.get(name) ?? name;
      const addresses = [...(this.#addr.get(srv.target) ?? [])];
      const src = this.#src.get(name);
      if (addresses.length === 0 && src) addresses.push(src);
      out.push({
        instance: shown.toLowerCase().endsWith(svcSuffix.toLowerCase()) ? shown.slice(0, -svcSuffix.length) : shown,
        stationId: kv.get("id")!,
        orgId: kv.get("org") ?? "",
        locationId: kv.get("loc") ?? "",
        port,
        fingerprint: rawFp ? fp : "",
        tlsMode: kv.get("tls") ?? "",
        hostname: (kv.get("host") ?? "").replace(/\.$/, "").toLowerCase(),
        addresses,
      });
    }
    return out;
  }
}

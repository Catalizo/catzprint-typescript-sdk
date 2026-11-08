import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { MDNS_GROUP, MDNS_PORT, MdnsCollector, buildQuery, type MdnsStation } from "./dns.js";

export interface BrowseTarget {
  address: string;
  port: number;
}

/**
 * Sends an mDNS query for `_catzprint._tcp.local` (to the group, or to a
 * unicast address in tests) and collects answers for `timeoutMs` or until
 * `signal` aborts. Sockets are closed before it resolves.
 */
export async function mdnsBrowse(
  timeoutMs: number,
  target: BrowseTarget = { address: MDNS_GROUP, port: MDNS_PORT },
  signal?: AbortSignal,
): Promise<MdnsStation[]> {
  const col = new MdnsCollector();
  const query = buildQuery();
  const multicast = target.address === MDNS_GROUP;
  const sockets: Socket[] = [];
  const onMessage = (msg: Buffer, rinfo: { address: string }) =>
    col.add(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength), rinfo.address);

  const main = createSocket({ type: "udp4", reuseAddr: true });
  main.on("message", onMessage);
  main.on("error", () => {});
  sockets.push(main);
  await new Promise<void>((resolve, reject) => {
    main.once("error", reject);
    main.bind(0, () => {
      main.off("error", reject);
      resolve();
    });
  });

  if (multicast) {
    // Responders that ignore the QU bit answer to the group: listen there
    // too when port 5353 can be shared (it can't always be).
    const group = createSocket({ type: "udp4", reuseAddr: true });
    group.on("error", () => {});
    group.on("message", onMessage);
    await new Promise<void>((resolve) => {
      group.once("error", () => resolve());
      group.bind(MDNS_PORT, () => {
        try {
          group.addMembership(MDNS_GROUP);
          sockets.push(group);
        } catch {
          group.close();
        }
        resolve();
      });
    }).catch(() => {});
  }

  const send = () => {
    if (!multicast) {
      main.send(query, target.port, target.address, () => {});
      return;
    }
    try {
      main.setMulticastTTL(255);
    } catch {
      // ignore
    }
    let sent = false;
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family !== "IPv4" || a.internal) continue;
        try {
          main.setMulticastInterface(a.address);
          main.send(query, target.port, target.address, () => {});
          sent = true;
        } catch {
          // try the next interface
        }
      }
    }
    if (!sent) main.send(query, target.port, target.address, () => {});
  };
  send();

  await new Promise<void>((resolve) => {
    const resend = setTimeout(send, Math.min(300, timeoutMs / 3));
    const done = () => {
      clearTimeout(resend);
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
  await Promise.all(sockets.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return col.stations();
}

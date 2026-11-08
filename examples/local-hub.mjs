// A restaurant hub that keeps printing kitchen tickets when the internet is
// down, through the CatzPrint station on the same network (local_first).
//
//   npm run build
//   CATZPRINT_API_KEY=cz_live_... CATZPRINT_LOCATION_ID=... node examples/local-hub.mjs
//
// Run it once while online: the local token and the stations' addresses and
// fingerprints are saved in ~/.catzprint/local-tokens.json, so tickets print
// through the station even after a restart without internet.
import { homedir } from "node:os";
import { join } from "node:path";
import { CatzPrint, FileTokenStore, isOutOfPaper, isPrinterOffline, isStationUnreachable } from "catzprint";

const cz = new CatzPrint({
  local: {
    mode: "local_first",
    locationId: process.env.CATZPRINT_LOCATION_ID,
    discover: true, // cloud endpoint list + mDNS
    tokenStore: new FileTokenStore(join(homedir(), ".catzprint", "local-tokens.json")),
    deviceName: "Hub (front counter)",
    waitSeconds: 5,
  },
});

const order = { id: 1042, table: "12", items: [{ qty: 2, name: "Pad thai", note: "no egg" }], allergies: ["PEANUTS"] };

function kitchenTicket(o) {
  const params = {
    role: "kitchen",
    title: `Table ${o.table}`,
    reference: `order-${o.id}`,
    idempotencyKey: `order-${o.id}-kitchen-r1`, // bump to r2 only for a deliberate reprint
  };
  if (o.allergies.length === 0) {
    return { ...params, templateId: process.env.CATZPRINT_KITCHEN_TEMPLATE_ID, data: { order: o.id, table: o.table, items: o.items } };
  }
  const banner = { type: "text", text: ` ALLERGY: ${o.allergies.join(", ")} `, align: "center", bold: true, invert: true, size: 2 };
  return {
    ...params,
    commands: [
      banner,
      { type: "text", text: `Table ${o.table}`, bold: true, size: 2 },
      { type: "line" },
      ...o.items.flatMap((it) => [
        { type: "columns", columns: [{ text: `${it.qty} x`, width: 0.15 }, { text: it.name, bold: true }] },
        ...(it.note ? [{ type: "text", text: `   ${it.note}` }] : []),
      ]),
      { type: "line" },
      { ...banner, size: 1 },
      { type: "feed", lines: 2 },
      { type: "cut" },
    ],
  };
}

try {
  const job = await cz.jobs.create(kitchenTicket(order));
  console.log(`Ticket ${job.id} ${job.status} via ${job.via}`);
} catch (err) {
  if (isPrinterOffline(err) || isOutOfPaper(err)) console.error("Kitchen printer needs attention:", err.message);
  else if (isStationUnreachable(err)) console.error("No station and no internet:", err.urls, err.message);
  else throw err;
} finally {
  await cz.close();
}

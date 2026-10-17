// Prints a receipt from ESC/POS commands.
//
//   npm run build
//   CATZPRINT_API_KEY=cz_test_... PRINTER_ID=... node examples/print-receipt.mjs
import { CatzPrint } from "catzprint";

const cz = new CatzPrint(); // reads CATZPRINT_API_KEY (and CATZPRINT_BASE_URL)

const items = [
  ["2 x Flat white", "7.00"],
  ["1 x Croissant", "3.20"],
];

const job = await cz.printReceipt(
  [
    { type: "text", text: "Corner Café", align: "center", bold: true, size: 2 },
    { type: "text", text: "12 High Street", align: "center" },
    { type: "line" },
    ...items.map(([name, price]) => ({ type: "columns", columns: [{ text: name, width: 0.75 }, { text: price, align: "right" }] })),
    { type: "line" },
    { type: "columns", columns: [{ text: "Total", bold: true }, { text: "10.20", align: "right", bold: true }] },
    { type: "feed", lines: 1 },
    { type: "qr", data: "https://example.com/r/1042", align: "center" },
    { type: "text", text: "Thank you!", align: "center" },
    { type: "cut" },
  ],
  {
    // Either a printer, or let routing pick one by role / location.
    ...(process.env.PRINTER_ID ? { printerId: process.env.PRINTER_ID } : { role: "receipt" }),
    title: "Order #1042",
    reference: "order-1042",
    // Same key = same job, so it's safe to run this twice.
    idempotencyKey: process.env.IDEMPOTENCY_KEY,
  },
);

console.log(`Job ${job.id} is ${job.status} on ${job.printer_name} (${job.live ? "live" : "test"}).`);

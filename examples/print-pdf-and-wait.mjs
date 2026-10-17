// Prints a PDF, sealed to the server key, and waits until it's printed.
//
//   npm run build
//   CATZPRINT_API_KEY=cz_live_... PRINTER_ID=... node examples/print-pdf-and-wait.mjs invoice.pdf
import { CatzPrint, TimeoutError, CatzPrintError } from "catzprint";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node examples/print-pdf-and-wait.mjs <file.pdf>");
  process.exit(2);
}

const cz = new CatzPrint();

try {
  const job = await cz.printPdf(file, {
    printerId: process.env.PRINTER_ID,
    sealed: true, // encrypted client-side; only the server can open it
  });
  console.log(`Sent ${job.title} as job ${job.id} (${job.status}). Waiting…`);

  const done = await cz.jobs.waitFor(job.id, { timeoutMs: 120_000, intervalMs: 2_000 });
  if (done.status === "printed") console.log(`Printed at ${done.printed_at}.`);
  else console.log(`Job ended as ${done.status}: ${done.status_detail}`);
} catch (err) {
  if (err instanceof TimeoutError) {
    console.error(`Still not printed after 2 minutes (last status: ${err.lastJob?.status}). Is the station online?`);
  } else if (err instanceof CatzPrintError) {
    console.error(`${err.name} ${err.status} ${err.code}: ${err.message}`, err.fields);
  } else {
    throw err;
  }
  process.exit(1);
}

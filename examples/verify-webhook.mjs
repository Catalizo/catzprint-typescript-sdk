// A webhook receiver with plain node:http (no framework needed).
// See the README for Express and Next.js versions.
//
//   npm run build
//   CATZPRINT_WEBHOOK_SECRET=whsec_... node examples/verify-webhook.mjs
//   # then point a CatzPrint webhook endpoint at http://your-host:4242/webhooks/catzprint
import { createServer } from "node:http";
import { webhooks, SignatureVerificationError } from "catzprint";

const secret = process.env.CATZPRINT_WEBHOOK_SECRET;
if (!secret) {
  console.error("Set CATZPRINT_WEBHOOK_SECRET to the endpoint's signing secret.");
  process.exit(2);
}

export const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhooks/catzprint") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks); // verify the exact bytes received
    let event;
    try {
      event = webhooks.verify(raw, req.headers["catzprint-signature"], secret);
    } catch (err) {
      if (err instanceof SignatureVerificationError) {
        res.writeHead(400).end("bad signature");
        return;
      }
      throw err;
    }
    switch (event.type) {
      case "job.printed":
        console.log(`Job ${event.data.job.id} printed.`);
        break;
      case "job.failed":
        console.log(`Job ${event.data.job.id} failed: ${event.data.job.status_detail}`);
        break;
      default:
        console.log(`Got ${event.type}.`);
    }
    // Answer 2xx quickly; CatzPrint retries other answers with backoff.
    res.writeHead(204).end();
  });
});

const port = Number(process.env.PORT ?? 4242);
server.listen(port, () => console.log(`Listening on http://localhost:${port}/webhooks/catzprint`));

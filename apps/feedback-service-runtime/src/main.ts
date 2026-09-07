#!/usr/bin/env node
import { createFeedbackProductionRuntime } from "./composition.js";
import { createFeedbackNodeServer } from "./listener.js";

const environment = process.env;
const runtime = await createFeedbackProductionRuntime({ environment });
const host = environment.FEEDBACK_SERVICE_HOST ?? "127.0.0.1";
if (!/^(?:127\.0\.0\.1|0\.0\.0\.0|::1|::|[A-Za-z0-9.-]+)$/u.test(host)) throw new Error("FEEDBACK_SERVICE_HOSTが不正です");
const portSource = environment.FEEDBACK_SERVICE_PORT ?? "8080";
if (!/^[0-9]+$/u.test(portSource) || Number(portSource) < 1 || Number(portSource) > 65535) throw new Error("FEEDBACK_SERVICE_PORTが不正です");
const server = createFeedbackNodeServer({ runtime });
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(Number(portSource), host, resolve);
});
process.stdout.write(`Feedback Service listening on ${host}:${portSource}\n`);

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

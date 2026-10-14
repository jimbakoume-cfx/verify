// Edge Function "flow": the rider's verification session API (see contract.ts).
import { createServiceClient, loadConfig } from "../_shared/env.ts";
import { consoleLogger } from "../_shared/log.ts";
import { createCaseStore } from "../worker/repo.ts";
import { createFlowHandler } from "./handler.ts";
import { createCaptureStorage, createFlowRepo } from "./repo.ts";
import { createWorkerRing } from "./ring.ts";

const db = createServiceClient();
const config = loadConfig({ needsWorkerRingUrl: true });

// Supabase's Edge Runtime keeps the function alive for a task passed to EdgeRuntime.waitUntil after
// the response is sent. Elsewhere (local Deno) the ring simply runs on its own.
const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (task: Promise<unknown>) => void } }).EdgeRuntime;
const waitUntil = edgeRuntime?.waitUntil ? (task: Promise<unknown>) => edgeRuntime.waitUntil!(task) : undefined;

Deno.serve(createFlowHandler({
  repo: createFlowRepo(db),
  storage: createCaptureStorage(db),
  allowedOrigins: config.allowedOrigins,
  ring: createWorkerRing({ url: config.workerRingUrl, waitUntil, log: consoleLogger }),
  cases: createCaseStore(db),
}));

// Edge Function "flow": the rider's verification session API (see contract.ts).
import { createServiceClient, loadConfig } from "../_shared/env.ts";
import { createFlowHandler } from "./handler.ts";
import { createCaptureStorage, createFlowRepo } from "./repo.ts";

const db = createServiceClient();
const config = loadConfig();

Deno.serve(createFlowHandler({
  repo: createFlowRepo(db),
  storage: createCaptureStorage(db),
  allowedOrigins: config.allowedOrigins,
}));

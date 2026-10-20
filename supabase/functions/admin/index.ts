// Edge Function "admin": staff enrollment and staff-only actions (see contract.ts).
import { createServiceClient, loadConfig } from "../_shared/env.ts";
import { createAdminHandler } from "./handler.ts";
import { createAdminRepo, createDecisionRepo, createSignedUrlStorage, createStaffAuth } from "./repo.ts";

const db = createServiceClient();

Deno.serve(createAdminHandler({
  repo: createAdminRepo(db),
  decisions: createDecisionRepo(db),
  auth: createStaffAuth(db),
  storage: createSignedUrlStorage(db),
  config: loadConfig({ needsRiderAppUrl: true }),
}));

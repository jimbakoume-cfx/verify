// Edge Function "worker": the AI worker's API (see contract.ts). Called only by the worker on Vercel,
// which signs every request; there are no browser origins to allow.
import { createServiceClient } from "../_shared/env.ts";
import { createWorkerHandler } from "./handler.ts";
import { createImageStorage, createWorkerRepo } from "./repo.ts";

const db = createServiceClient();

Deno.serve(createWorkerHandler({
  repo: createWorkerRepo(db),
  images: createImageStorage(db),
}));

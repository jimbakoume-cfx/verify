// Edge Function "face": the face worker's API (M6/M7, see contract.ts "Face worker API"). Called only by
// the face worker on Vercel (project confiance-verify-face), which signs every request; there are no
// browser origins to allow.
import { createServiceClient } from "../_shared/env.ts";
import { createFaceHandler } from "./handler.ts";
import { createFaceImageStorage, createFaceRepo } from "./repo.ts";

const db = createServiceClient();

Deno.serve(createFaceHandler({
  repo: createFaceRepo(db),
  images: createFaceImageStorage(db),
}));

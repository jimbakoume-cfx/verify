// Public, non-secret settings of the hosted test environment (Supabase project confiance-verify-test,
// Vercel sites confiance-verify / confiance-verify-ops and the worker confiance-verify-worker, team
// "JB"). Used only when the matching environment variable is not set; production must set
// ALLOWED_ORIGINS, RIDER_APP_URL and WORKER_RING_URL explicitly.
export const TEST_ENVIRONMENT_DEFAULTS: Readonly<Record<string, string>> = {
  ALLOWED_ORIGINS: "https://confiance-verify.vercel.app,https://confiance-verify-ops.vercel.app",
  RIDER_APP_URL: "https://confiance-verify.vercel.app",
  // The worker's production alias. A ring carries no authority: the worker then claims, signed.
  WORKER_RING_URL: "https://confiance-verify-worker.vercel.app/api/process",
};

// Public, non-secret settings of the hosted test environment (Supabase project confiance-verify-test,
// Vercel sites confiance-verify / confiance-verify-ops, team "JB"). Used only when the matching environment
// variable is not set; production must set ALLOWED_ORIGINS and RIDER_APP_URL explicitly.
export const TEST_ENVIRONMENT_DEFAULTS: Readonly<Record<string, string>> = {
  ALLOWED_ORIGINS: "https://confiance-verify.vercel.app,https://confiance-verify-ops.vercel.app",
  RIDER_APP_URL: "https://confiance-verify.vercel.app",
};

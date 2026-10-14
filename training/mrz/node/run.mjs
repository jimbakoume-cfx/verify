// Runs one of the TypeScript scripts in this folder with the repository's own code, unchanged:
// Vite's module runner (Vite is already a dev dependency of the web apps) resolves the workspace
// packages (@verify/capture, @verify/shared) and the rider app's sources exactly as the tests do,
// and keeps running for dynamic imports (the rider's OCR engine imports tesseract.js lazily).
// Nothing is bundled or copied, so the training data and the gates always use the current rider
// pipeline.
//
// usage: node training/mrz/node/run.mjs training/mrz/node/<script>.ts [args...]
import { fileURLToPath } from "node:url";
import { createServer, createServerModuleRunner } from "vite";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const server = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
try {
  const script = await runner.import(process.argv[2]);
  await script.main(process.argv.slice(3));
} finally {
  await runner.close();
  await server.close();
}

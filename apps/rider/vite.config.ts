import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify((process.env.COMMIT_REF ?? "local").slice(0, 7)),
  },
  // The capture analyzer runs in a module worker, emitted as its own chunk.
  worker: { format: "es" },
});

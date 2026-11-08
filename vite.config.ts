import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by Ilven's gateway under /apps/locke/ (container alias app-locke:8080).
export default defineConfig({
  base: "/apps/locke/",
  plugins: [react()],
  // @ilven/web-auth is linked from the sibling Ilven repo: resolve its imports from Locke's node_modules.
  resolve: { preserveSymlinks: true },
  build: { target: "es2022", outDir: "dist/web", emptyOutDir: true },
});

import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/viewer"),
  base: "/",
  build: {
    outDir: resolve(__dirname, "dist/viewer"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "src/viewer/index.html"),
    },
  },
});

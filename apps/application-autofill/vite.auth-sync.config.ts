import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(rootDirectory, "src/auth-sync.ts"),
      name: "GuguAuthSync",
      formats: ["iife"],
      fileName: () => "auth-sync.js",
    },
  },
});

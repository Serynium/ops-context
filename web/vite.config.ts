import { fileURLToPath, URL } from "node:url"
import stylex from "@stylexjs/unplugin"
import { defineConfig } from "vite"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: "public",
  plugins: [stylex.vite()],
  resolve: {
    alias: [
      { find: "react/jsx-dev-runtime", replacement: "preact/jsx-runtime" },
      { find: "react/jsx-runtime", replacement: "preact/jsx-runtime" },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/health": "http://localhost:8787"
    }
  }
})

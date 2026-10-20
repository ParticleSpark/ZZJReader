import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readerWorkspaceAliases } from "../../workspace-aliases";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: readerWorkspaceAliases },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:17840" },
      "/pub": { target: "http://127.0.0.1:17840" },
    },
  },
  build: { target: "es2022" },
});

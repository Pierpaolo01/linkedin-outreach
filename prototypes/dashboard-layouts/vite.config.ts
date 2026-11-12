// PROTOTYPE, throwaway. Three dashboard layouts for gate 3, switchable with ?v=a|b|c.
// Run from the repo root: npx vite --config prototypes/dashboard-layouts/vite.config.ts --port 5179
// Not imported by src/ and not part of the app build.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", strictPort: true },
});

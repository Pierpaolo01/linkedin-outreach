import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI is built once (setup/update) and served by the app's own server on one port.
export default defineConfig({
  root: "src/ui",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../../dist/ui", emptyOutDir: true },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the dashboard UI (src/) into dist/. Functions in netlify/functions are bundled by Netlify.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});

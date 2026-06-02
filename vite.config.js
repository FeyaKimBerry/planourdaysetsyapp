import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standard Vite + React setup. Builds to /dist, which is what Netlify publishes.
export default defineConfig({
  plugins: [react()],
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Multi-page setup:
//   index.html  -> static marketing homepage (served at /)
//   login.html  -> the React app entry (served at /login via netlify.toml)
// Builds to /dist, which is what Netlify publishes.
export default defineConfig({
  plugins: [react()],
  // Honor a PORT env var when one is provided (e.g. by the preview harness);
  // otherwise fall back to Vite's default dev port.
  server: process.env.PORT ? { port: Number(process.env.PORT) } : undefined,
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        login: "login.html",
      },
    },
  },
});

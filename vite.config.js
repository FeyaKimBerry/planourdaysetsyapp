import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Multi-page setup:
//   index.html  -> static marketing homepage (served at /)
//   login.html  -> the React app entry (served at /login via netlify.toml)
// Builds to /dist, which is what Netlify publishes.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        login: "login.html",
      },
    },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the build works from any static-hosting sub-path.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { target: "es2022" },
  // `npm run dev` talks to a locally running `cargo run -p meshmap-server`
  server: { proxy: { "/api": "http://localhost:8080" } },
});

import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true, allowedHosts: true, proxy: { "/api": "http://localhost:8787", "/healthz": "http://localhost:8787" } },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
})

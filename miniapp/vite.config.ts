import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig(({ mode }) => {
  // shared secrets live in the repo-root .env; only the WalletConnect project id (public by design) is exposed
  const env = loadEnv(mode, "..", "")
  return {
  define: { "import.meta.env.VITE_WC_PROJECT_ID": JSON.stringify(env.VITE_WC_PROJECT_ID || env.WALLETCONNECT_PROJECT_ID || "") },
  plugins: [react()],
  server: { port: 5173, host: true, allowedHosts: true, proxy: { "/api": "http://localhost:8787", "/healthz": "http://localhost:8787" } },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
}
})

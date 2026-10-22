import React from "react"
import { createRoot } from "react-dom/client"
import { WagmiProvider, http } from "wagmi"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RainbowKitProvider, getDefaultConfig, darkTheme, lightTheme } from "@rainbow-me/rainbowkit"
import "@rainbow-me/rainbowkit/styles.css"
import { chainFor } from "@keel/shared"
import { api, tg, type AppConfig } from "./lib/api"
import { App } from "./App"
import "./styles.css"

tg?.ready()
tg?.expand()

const root = createRoot(document.getElementById("root")!)

async function boot() {
  let cfg: AppConfig
  try {
    cfg = await api.config()
  } catch {
    root.render(<div className="center">Can't reach the Keel server. Please try again in a moment.</div>)
    return
  }
  const chain = chainFor(cfg.network)
  const projectId = import.meta.env.VITE_WC_PROJECT_ID || "keel-no-walletconnect"
  const wagmi = getDefaultConfig({
    appName: "Keel",
    projectId,
    chains: [chain],
    transports: { [chain.id]: http(cfg.rpcUrl ?? chain.rpcUrls.default.http[0]) } as never,
    ssr: false,
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })
  const dark = (tg?.colorScheme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark"
  root.render(
    <React.StrictMode>
      <WagmiProvider config={wagmi}>
        <QueryClientProvider client={qc}>
          <RainbowKitProvider theme={dark ? darkTheme({ accentColor: "#2f7cf6" }) : lightTheme({ accentColor: "#2f7cf6" })} modalSize="compact">
            <App cfg={cfg} />
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </React.StrictMode>,
  )
}
void boot()

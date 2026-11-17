import React from "react"
import { createRoot } from "react-dom/client"
import { WagmiProvider, createConfig, http } from "wagmi"
import { injected, walletConnect } from "wagmi/connectors"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RainbowKitProvider, getDefaultConfig, lightTheme } from "@rainbow-me/rainbowkit"
import "@rainbow-me/rainbowkit/styles.css"
import { chainFor } from "@keel/shared"
import { loadSnapshot } from "./lib/snapshot"
import { api, tg, type AppConfig } from "./lib/api"
import { App } from "./App"
import { inTelegram, readHandoffFromUrl } from "./lib/telegram"
import { scopeStorageToUser } from "./lib/session"
import { isDemo, isWeb } from "./lib/web"
import { WebRoot } from "./web/WebRoot"
import "./styles.css"

tg?.ready()
tg?.expand()
try {
  tg?.setHeaderColor?.("#ffffff")
  tg?.setBackgroundColor?.("#ffffff")
  tg?.setBottomBarColor?.("#ffffff")
  tg?.disableVerticalSwipes?.()
} catch {
  /* older Telegram clients */
}

readHandoffFromUrl()
// before wagmi restores any stored connection: it must belong to this Telegram account
scopeStorageToUser(tg?.initDataUnsafe.user?.id)

const rootEl = document.getElementById("root")!
rootEl.replaceChildren() // drop the prerendered landing markup (hidden for app launches) before the app renders
const root = createRoot(rootEl)


/** Waits for the backend (a free host that sleeps when idle): shows a friendly screen and retries by itself. */
function WakeScreen({ since, onRetry }: { since: number; onRetry: () => void }) {
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const sec = Math.round((now - since) / 1000)
  return (
    <div className="app">
      <div className="state">
        <img src="/keel-mark-red.svg" width={56} height={56} alt="Keel" />
        <h2>Waking up the server</h2>
        <p className="muted">Keel's free server sleeps when nobody is using it. This takes about 30 seconds. We keep trying, no need to reload.</p>
        <p className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>{sec}s{sec > 75 ? " · still trying, the server may be restarting" : ""}</p>
        <button className="btn" onClick={onRetry}>Try again now</button>
      </div>
    </div>
  )
}

async function loadConfig(): Promise<AppConfig> {
  const onPublicPage = location.pathname.replace(/\/$/, "") === "/stats" || isDemo()
  const since = Date.now()
  let wake: (() => void) | null = null
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.config(attempt === 0 ? 6000 : 12_000)
    } catch {
      // public pages and the read-only demo never need the backend to start: use the config baked into the build
      if (onPublicPage) {
        const snap = await loadSnapshot()
        if (snap) return snap.config
      }
      if (attempt === 0) root.render(<WakeScreen since={since} onRetry={() => wake?.()} />)
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, 4000)
      })
    }
  }
}

async function boot() {
  // read-only demo with sample data (web), or the dev preview (`?mock`)
  if (isDemo() || (import.meta.env.DEV && new URLSearchParams(location.search).has("mock"))) (await import("./lib/demo")).installMock()
  root.render(<div className="app"><div className="splash"><div className="splash-mark"><span className="splash-glow" /><img src="/keel-mark-red.svg" width={72} height={72} alt="Keel" /></div></div></div>)
  const cfg = await loadConfig()
  const chain = chainFor(cfg.network)
  const projectId = import.meta.env.VITE_WC_PROJECT_ID || "keel-no-walletconnect"
  const transports = { [chain.id]: http(cfg.rpcUrl ?? chain.rpcUrls.default.http[0]) } as never
  // Inside Telegram we drive WalletConnect ourselves (see TelegramConnect): no modal, deep links via tg.openLink.
  // Elsewhere (desktop, or a wallet's own browser) RainbowKit's picker and injected wallets work as usual.
  const wagmi = inTelegram()
    ? createConfig({
        chains: [chain],
        transports,
        connectors: [
          walletConnect({ projectId, showQrModal: false, metadata: { name: "Keel", description: "BTC-backed dollars in Telegram", url: location.origin, icons: [`${location.origin}/keel-icon-512.png`] } }),
          injected(),
        ],
      })
    : getDefaultConfig({ appName: "Keel", projectId, chains: [chain], transports, ssr: false })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })
  root.render(
    <React.StrictMode>
      <WagmiProvider config={wagmi}>
        <QueryClientProvider client={qc}>
          <RainbowKitProvider theme={lightTheme({ accentColor: "#E10600", accentColorForeground: "#FFFFFF", borderRadius: "large", overlayBlur: "small" })} modalSize="compact">
            {isWeb() && !(import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) ? <WebRoot cfg={cfg} /> : <App cfg={cfg} />}
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </React.StrictMode>,
  )
}
void boot()

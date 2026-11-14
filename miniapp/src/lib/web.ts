import { handoffToken, inTelegram } from "./telegram"

/**
 * Web mode: Keel in a normal browser, with no Telegram. The user signs a server nonce with their wallet and gets a
 * short-lived session token; the server resolves the account from the session's wallet on every request.
 * Demo mode: a clearly labelled preview with sample data (no server account, signing disabled).
 */

const SESSION = "keel:web-session"
const DEMO = "keel:demo"

export interface WebSession {
  token: string
  address: string
  expires: number
  telegram: boolean
}

/** A normal browser: not Telegram, and not the one-time wallet-browser handoff. */
export const isWeb = () => !inTelegram() && !handoffToken()

export function webSession(): WebSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION) ?? "null") as WebSession | null
    if (!s || s.expires * 1000 < Date.now() + 60_000) return null
    return s
  } catch {
    return null
  }
}

const changed = () => dispatchEvent(new Event("keel:session"))

export function saveWebSession(s: WebSession) {
  try {
    localStorage.setItem(SESSION, JSON.stringify(s))
  } catch { /* storage blocked: the session lasts for this page only */ }
  memo = s
  changed()
}
let memo: WebSession | null = null

export function clearWebSession() {
  try {
    localStorage.removeItem(SESSION)
  } catch { /* storage blocked */ }
  memo = null
  changed()
}

export const sessionToken = () => (isWeb() ? (webSession() ?? memo)?.token ?? null : null)

export function isDemo() {
  if (!isWeb()) return false
  if (new URLSearchParams(location.search).has("demo")) return true
  try {
    return sessionStorage.getItem(DEMO) === "1"
  } catch {
    return false
  }
}

export function enterDemo() {
  try {
    sessionStorage.setItem(DEMO, "1")
  } catch { /* the ?demo flag in the URL carries it instead */ }
  location.href = `${location.pathname}?demo=1#/`
}

export function exitDemo() {
  try {
    sessionStorage.removeItem(DEMO)
  } catch { /* storage blocked */ }
  location.href = `${location.pathname}#/about`
}

/** Public links shown on the landing page and in the README. */
export const LINKS = {
  bot: "https://t.me/KeelMezoBot",
  miniapp: "https://t.me/KeelMezoBot/app",
  github: "https://github.com/Im-2/keel",
  deck: "/keel-deck.pdf",
  video: (import.meta.env.VITE_DEMO_VIDEO_URL as string | undefined) || null,
}

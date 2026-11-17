/**
 * Entry. A normal browser opening the site root gets the marketing landing page, a small bundle with no wallet or
 * Telegram code. Everything else (inside Telegram, app routes like #/borrow, claim links, ?w= handoffs, ?demo,
 * /stats) loads the Telegram SDK first and then the full app, exactly as before.
 */
const q = new URLSearchParams(location.search)
const hash = location.hash

function telegramLike() {
  if (/tgWebApp/.test(hash + location.search)) return true
  if ("TelegramWebviewProxy" in window) return true
  try {
    // Telegram's SDK keeps the launch params here across in-app reloads
    // (the SDK writes this key in plain browsers too, so only real launch data counts)
    if (/tgWebAppData/.test(sessionStorage.getItem("__telegram__initParams") ?? "")) return true
  } catch { /* storage blocked */ }
  return false
}

const isLanding =
  !telegramLike() && location.pathname === "/" && (hash === "" || hash === "#" || hash === "#/" + "about") &&
  !q.has("w") && !q.has("demo") && !q.has("mock")

function loadTelegramSdk(): Promise<void> {
  return new Promise((resolve) => {
    const s = document.createElement("script")
    s.src = "https://telegram.org/js/telegram-web-app.js"
    s.onload = s.onerror = () => resolve()
    document.head.appendChild(s)
    setTimeout(resolve, 5000) // never block the app on a slow or blocked script
  })
}

// The docs (/docs, /docs/<page>) are public pages with their own bundle, in a browser and inside Telegram alike.
const isDocs = /^\/docs(\/|$)/.test(location.pathname)

const isStatus = location.pathname.replace(/\/$/, "") === "/status"

if (isStatus) {
  void import("./web/statusmount")
} else if (isDocs) {
  void import("./docs/docsmount")
} else if (isLanding) {
  if (hash) history.replaceState(null, "", "/")
  void import("./landing/mount")
} else {
  void loadTelegramSdk().then(() => import("./boot"))
}

export {}

import { createRoot, hydrateRoot } from "react-dom/client"
import { Landing } from "./Landing"
import "./landing.css"

const el = document.getElementById("root")!
// production: the HTML was prerendered at build time (scripts/prerender-landing.mjs), so hydrate it
if (el.querySelector(".lp")) hydrateRoot(el, <Landing />)
else createRoot(el).render(<Landing />)

// Links like /#/app only change the hash, so the page doesn't reload and this small bundle would stay on screen.
// Any app route (#/…) means "open the app": reload, and src/main.tsx loads the full app for it.
addEventListener("hashchange", () => {
  const h = location.hash
  if (h.startsWith("#/") && h !== "#/about") location.reload()
})

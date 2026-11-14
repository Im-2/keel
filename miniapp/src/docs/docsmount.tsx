import { createRoot, hydrateRoot } from "react-dom/client"
import { Docs, slugFromPath } from "./Docs"
import "./docs.css"

const el = document.getElementById("root")!
const slug = slugFromPath(location.pathname)
// production: each docs page was prerendered at build time (scripts/prerender-landing.mjs), so hydrate it
if (el.querySelector(".dx")) hydrateRoot(el, <Docs initialSlug={slug} />)
else {
  el.replaceChildren() // the catch-all index.html carries the (hidden) prerendered landing
  createRoot(el).render(<Docs initialSlug={slug} />)
}

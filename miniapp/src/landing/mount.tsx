import { createRoot, hydrateRoot } from "react-dom/client"
import { Landing } from "./Landing"
import "./landing.css"

const el = document.getElementById("root")!
// production: the HTML was prerendered at build time (scripts/prerender-landing.mjs), so hydrate it
if (el.querySelector(".lp")) hydrateRoot(el, <Landing />)
else createRoot(el).render(<Landing />)

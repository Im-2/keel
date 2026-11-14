import { renderToString } from "react-dom/server"
import { Landing } from "./Landing"

/** Build-time prerender of the landing page (scripts/prerender-landing.mjs puts it into dist/index.html). */
export const render = () => renderToString(<Landing />)

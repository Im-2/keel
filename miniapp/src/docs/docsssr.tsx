import { renderToString } from "react-dom/server"
import { Docs } from "./Docs"
import { PAGES } from "./pages"

/** Build-time prerender of every docs page (scripts/prerender-landing.mjs writes them to dist/docs/...). */
export const pages = PAGES.map((p) => ({ slug: p.slug, title: p.title, description: p.description }))
export const render = (slug: string) => renderToString(<Docs initialSlug={slug} />)

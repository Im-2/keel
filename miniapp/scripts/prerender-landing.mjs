// After `vite build`: render the landing page to HTML and put it into dist/index.html, so a browser shows the
// page before any JavaScript runs (React then hydrates it). The landing stylesheet is linked only when the
// landing is shown: an inline script in index.html (same rules as src/main.tsx) writes the <link> for the
// landing and marks every other launch (Telegram, app routes) as "app", which hides the prerendered markup.
import fs from "node:fs"
import path from "node:path"
import { execSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, "..")
const dist = path.join(root, "dist")
execSync("npx vite build --ssr src/landing/ssr.tsx --outDir dist-ssr --emptyOutDir", { cwd: root, stdio: "inherit" })
const { render } = await import(pathToFileURL(path.join(root, "dist-ssr", "ssr.js")).href)
const html = render()
const css = fs.readdirSync(path.join(dist, "assets")).find((f) => /^mount-.*\.css$/.test(f))
if (!css) throw new Error("landing stylesheet (mount-*.css) not found in dist/assets")
const file = path.join(dist, "index.html")
let page = fs.readFileSync(file, "utf8")
if (!page.includes("__LANDING_CSS__")) throw new Error("index.html has no __LANDING_CSS__ placeholder")
const assets = path.join(dist, "assets")
const mountJs = fs.readdirSync(assets).find((f) => /^mount-.*\.js$/.test(f))
const deps = [...fs.readFileSync(path.join(assets, mountJs), "utf8").matchAll(/from\s*"\.\/([\w.-]+\.js)"/g)].map((m) => m[1])
const preload = [mountJs, ...new Set(deps)].map((f) => `/assets/${f}`).join(",")
page = page.replace("__LANDING_JS__", preload)
page = page.replace("__LANDING_CSS__", `/assets/${css}`).replace('<div id="root"></div>', `<div id="root">${html}</div>`)
fs.writeFileSync(file, page)
fs.rmSync(path.join(root, "dist-ssr"), { recursive: true, force: true })
console.log(`prerendered landing: ${(html.length / 1024).toFixed(1)} kB of HTML, stylesheet /assets/${css}`)

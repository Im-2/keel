// After `vite build`: prerender the landing page and every docs page to static HTML, so a browser shows content
// before any JavaScript runs (React then hydrates it), each docs URL has its own title and meta tags, and deep
// links like /docs/guardian are real files (the Vercel catch-all would also serve them through index.html).
//
// The landing stylesheet is linked only for landing visits: an inline script in index.html (same rules as
// src/main.tsx) writes the <link> for the landing and marks Telegram/app launches "app" (hiding the markup) and
// /docs "docs". Also writes sitemap.xml and copies docs/images to /docs-images for the docs pages.
import fs from "node:fs"
import path from "node:path"
import { execSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, "..")
const dist = path.join(root, "dist")
const assets = path.join(dist, "assets")
const SITE = "https://keel-miniapp.vercel.app"

const ssr = async (entry, outDir) => {
  execSync(`npx vite build --ssr ${entry} --outDir ${outDir} --emptyOutDir`, { cwd: root, stdio: "inherit" })
  const file = fs.readdirSync(path.join(root, outDir)).find((f) => f.endsWith(".js"))
  return import(pathToFileURL(path.join(root, outDir, file)).href)
}
const find = (re, what) => {
  const f = fs.readdirSync(assets).find((x) => re.test(x))
  if (!f) throw new Error(`${what} not found in dist/assets`)
  return f
}
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

// ---------------------------------------------------------------- template with the landing's assets filled in
const indexFile = path.join(dist, "index.html")
let template = fs.readFileSync(indexFile, "utf8")
if (!template.includes("__LANDING_CSS__")) throw new Error("index.html has no __LANDING_CSS__ placeholder")
const landingCss = find(/^mount-.*\.css$/, "landing stylesheet (mount-*.css)")
const mountJs = find(/^mount-.*\.js$/, "landing chunk (mount-*.js)")
const deps = [...fs.readFileSync(path.join(assets, mountJs), "utf8").matchAll(/from\s*"\.\/([\w.-]+\.js)"/g)].map((m) => m[1])
template = template
  .replace("__LANDING_JS__", [mountJs, ...new Set(deps)].map((f) => `/assets/${f}`).join(","))
  .replace("__LANDING_CSS__", `/assets/${landingCss}`)

// ---------------------------------------------------------------- landing at /
const landing = await ssr("src/landing/ssr.tsx", "dist-ssr-landing")
const landingHtml = landing.render()
fs.writeFileSync(indexFile, template.replace('<div id="root"></div>', `<div id="root">${landingHtml}</div>`))
console.log(`prerendered landing: ${(landingHtml.length / 1024).toFixed(1)} kB of HTML`)

// ---------------------------------------------------------------- docs at /docs and /docs/<page>
const docs = await ssr("src/docs/docsssr.tsx", "dist-ssr-docs")
const docsCss = find(/^docsmount-.*\.css$/, "docs stylesheet (docsmount-*.css)")
const head = (title, description, url) =>
  template
    .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${escAttr(description)}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${escAttr(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${escAttr(description)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${escAttr(title)}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${escAttr(description)}$2`)
    .replace("</head>", `  <link rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/onest-latin.woff2" />\n    <link rel="stylesheet" href="/assets/${docsCss}" />\n  </head>`)
const urls = [`${SITE}/`, `${SITE}/stats`]
for (const p of docs.pages) {
  const route = p.slug === "overview" ? "/docs" : `/docs/${p.slug}`
  const url = `${SITE}${route}`
  const html = head(`${p.title} · Keel docs`, p.description, url).replace('<div id="root"></div>', `<div id="root">${docs.render(p.slug)}</div>`)
  const dir = path.join(dist, ...route.split("/").filter(Boolean))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "index.html"), html)
  // the overview is also reachable as /docs/overview
  if (p.slug === "overview") {
    fs.mkdirSync(path.join(dist, "docs", "overview"), { recursive: true })
    fs.writeFileSync(path.join(dist, "docs", "overview", "index.html"), html)
  }
  urls.push(url)
}
console.log(`prerendered ${docs.pages.length} docs pages`)

// ---------------------------------------------------------------- sitemap and docs images
const today = new Date().toISOString().slice(0, 10)
fs.writeFileSync(
  path.join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join("\n")}\n</urlset>\n`,
)
const imgSrc = path.join(root, "..", "docs", "images")
fs.cpSync(imgSrc, path.join(dist, "docs-images"), { recursive: true })
for (const d of ["dist-ssr-landing", "dist-ssr-docs"]) fs.rmSync(path.join(root, d), { recursive: true, force: true })
console.log(`sitemap.xml: ${urls.length} URLs; docs images copied`)

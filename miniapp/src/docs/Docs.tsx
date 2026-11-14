import { useEffect, useMemo, useRef, useState } from "react"
import { PAGES, pageBySlug, type DocPage } from "./pages"
import { plain, render } from "./markdown"

/** The page a /docs URL points at ("/docs" is the overview). */
export const slugFromPath = (path: string) => path.replace(/^\/docs\/?/, "").replace(/\/$/, "").split("/")[0] || "overview"

const SITE = "https://keel-miniapp.vercel.app"
const GROUPS = [...new Set(PAGES.map((p) => p.group))]

export function Docs({ initialSlug }: { initialSlug: string }) {
  const [slug, setSlug] = useState(initialSlug)
  const [menu, setMenu] = useState(false)
  const [q, setQ] = useState("")
  const page = pageBySlug(slug) ?? PAGES[0]
  const { html, headings } = useMemo(() => render(page.md), [page])
  const idx = PAGES.indexOf(page)
  const prev = idx > 0 ? PAGES[idx - 1] : null
  const next = idx < PAGES.length - 1 ? PAGES[idx + 1] : null
  const article = useRef<HTMLElement>(null)
  const [active, setActive] = useState("")

  // client-side navigation between docs pages (full page loads for everything else)
  const go = (to: string, push = true) => {
    const url = new URL(to, location.origin)
    const s = slugFromPath(url.pathname)
    if (!pageBySlug(s)) return false
    if (push) history.pushState(null, "", url.pathname + url.hash)
    setSlug(s)
    setMenu(false)
    setQ("")
    requestAnimationFrame(() => {
      const el = url.hash ? document.getElementById(decodeURIComponent(url.hash.slice(1))) : null
      if (el) el.scrollIntoView()
      else window.scrollTo(0, 0)
    })
    return true
  }

  useEffect(() => {
    const onPop = () => go(location.pathname + location.hash, false)
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as HTMLElement).closest("a")
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return
      const href = a.getAttribute("href") ?? ""
      if (/^\/docs(\/|$|#)/.test(href) && go(href)) e.preventDefault()
    }
    addEventListener("popstate", onPop)
    document.addEventListener("click", onClick)
    return () => {
      removeEventListener("popstate", onPop)
      document.removeEventListener("click", onClick)
    }
  }, [])

  // title, description and canonical per page
  useEffect(() => {
    document.title = `${page.title} · Keel docs`
    document.querySelector('meta[name="description"]')?.setAttribute("content", page.description)
    document.querySelector('link[rel="canonical"]')?.setAttribute("href", `${SITE}/docs/${page.slug === "overview" ? "" : page.slug}`)
  }, [page])

  // copy buttons, Mermaid diagrams (loaded only when a page has one), and the active TOC entry
  useEffect(() => {
    const root = article.current
    if (!root) return
    const copies = Array.from(root.querySelectorAll<HTMLButtonElement>(".code-copy"))
    const onCopy = (e: Event) => {
      const btn = e.currentTarget as HTMLButtonElement
      const code = btn.parentElement?.querySelector("code")?.textContent ?? ""
      void navigator.clipboard?.writeText(code).then(() => {
        btn.textContent = "Copied"
        setTimeout(() => (btn.textContent = "Copy"), 1500)
      })
    }
    copies.forEach((b) => b.addEventListener("click", onCopy))
    const diagrams = Array.from(root.querySelectorAll<HTMLElement>("pre.mermaid:not([data-processed])"))
    if (diagrams.length) {
      void import("mermaid").then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          securityLevel: "strict",
          themeVariables: { primaryColor: "#fff1f0", primaryBorderColor: "#e10600", primaryTextColor: "#0a0a0a", lineColor: "#555555", fontFamily: "Onest, system-ui, sans-serif", fontSize: "14px" },
        })
        void mermaid.run({ nodes: diagrams })
      })
    }
    const io = new IntersectionObserver((es) => {
      const vis = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      if (vis) setActive(vis.target.id)
    }, { rootMargin: "-80px 0px -70% 0px" })
    root.querySelectorAll("h2[id], h3[id]").forEach((h) => io.observe(h))
    return () => {
      copies.forEach((b) => b.removeEventListener("click", onCopy))
      io.disconnect()
    }
  }, [html])

  const results = useMemo(() => search(q), [q])

  return (
    <div className="dx">
      <a className="skip" href="#doc">Skip to content</a>
      <header className="dx-top">
        <a className="dx-brand" href="/" aria-label="Keel home"><img src="/keel-mark-red.svg" width={28} height={28} alt="" /><span>Keel</span><em>Docs</em></a>
        <div className="dx-search" role="search">
          <input type="search" placeholder="Search the docs" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the docs"
            onKeyDown={(e) => { if (e.key === "Enter" && results[0]) go(`/docs/${results[0].page.slug}`) }} />
          {q.length > 1 && (
            <ul className="dx-results">
              {results.length === 0 && <li className="none">No matches for “{q}”.</li>}
              {results.map((r) => (
                <li key={r.page.slug}><a href={`/docs/${r.page.slug}`}><b>{r.page.title}</b><span>{r.snippet}</span></a></li>
              ))}
            </ul>
          )}
        </div>
        <nav className="dx-toplinks" aria-label="Site">
          <a href="/stats">Stats</a>
          <a href="https://github.com/Im-2/keel" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a className="dx-btn" href="/#/app">Open web app</a>
        </nav>
        <button className="dx-menu-btn" aria-expanded={menu} aria-controls="dx-side" onClick={() => setMenu(!menu)}>{menu ? "Close" : "Menu"}</button>
      </header>

      <div className="dx-body">
        <aside id="dx-side" className={`dx-side ${menu ? "open" : ""}`} aria-label="Docs pages">
          {GROUPS.map((g) => (
            <div key={g} className="dx-group">
              <span>{g}</span>
              {PAGES.filter((p) => p.group === g).map((p) => (
                <a key={p.slug} href={`/docs/${p.slug === "overview" ? "" : p.slug}`} aria-current={p.slug === page.slug ? "page" : undefined}>{p.title}</a>
              ))}
            </div>
          ))}
          <div className="dx-group">
            <span>Resources</span>
            <a href="/keel-deck.pdf" target="_blank" rel="noopener noreferrer">Pitch deck (PDF)</a>
            <a href="/keel-deck.pptx" download>Pitch deck (PPTX)</a>
            <a href="/stats">Live stats</a>
          </div>
        </aside>

        <main id="doc" className="dx-main">
          {headings.length > 1 && (
            <details className="dx-toc-inline">
              <summary>On this page</summary>
              <ul>
                {headings.filter((h) => h.depth === 2).map((h) => (
                  <li key={h.id}><a href={`#${h.id}`}>{h.text}</a></li>
                ))}
              </ul>
            </details>
          )}
          <article ref={article} className="dx-article" dangerouslySetInnerHTML={{ __html: html }} />
          <nav className="dx-pager" aria-label="Previous and next page">
            {prev ? <a href={`/docs/${prev.slug === "overview" ? "" : prev.slug}`} className="prev"><small>Previous</small>{prev.title}</a> : <span />}
            {next ? <a href={`/docs/${next.slug}`} className="next"><small>Next</small>{next.title}</a> : <span />}
          </nav>
          <p className="dx-edit"><a href={`https://github.com/Im-2/keel/blob/main/docs/${sourcePath(page)}`} target="_blank" rel="noopener noreferrer">Edit this page on GitHub</a> · Keel is testnet software, not audited.</p>
        </main>

        {headings.length > 1 && (
          <aside className="dx-toc" aria-label="On this page">
            <details open>
              <summary>On this page</summary>
              <ul>
                {headings.filter((h) => h.depth === 2 || h.depth === 3).map((h) => (
                  <li key={h.id} className={`d${h.depth} ${active === h.id ? "on" : ""}`}><a href={`#${h.id}`}>{h.text}</a></li>
                ))}
              </ul>
            </details>
          </aside>
        )}
      </div>
    </div>
  )
}

function sourcePath(p: DocPage) {
  return p.slug === "business" ? "BUSINESS.md" : p.slug === "wave2" ? "WAVE2_CHECKLIST.md" : `site/${p.slug}.md`
}

let index: Array<{ page: DocPage; text: string }> | null = null
function search(q: string) {
  if (q.trim().length < 2) return []
  index ??= PAGES.map((page) => ({ page, text: plain(page.md) }))
  const needle = q.trim().toLowerCase()
  const out: Array<{ page: DocPage; snippet: string; score: number }> = []
  for (const { page, text } of index) {
    const lower = text.toLowerCase()
    const at = lower.indexOf(needle)
    const inTitle = page.title.toLowerCase().includes(needle)
    if (at < 0 && !inTitle) continue
    const s = Math.max(0, at - 40)
    out.push({ page, snippet: at < 0 ? page.description : `${s ? "…" : ""}${text.slice(s, at + needle.length + 70)}…`, score: (inTitle ? 2 : 0) + (at >= 0 ? 1 : 0) })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8)
}

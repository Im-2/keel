import { Marked, type Tokens } from "marked"
import { FILE_TO_SLUG } from "./pages"

export interface Heading {
  depth: number
  text: string
  id: string
}

const REPO = "https://github.com/Im-2/keel/blob/main/docs"

export const slugify = (s: string) =>
  s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-")

const decode = (s: string) =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Repo-relative links and images (written to work on GitHub) become site routes and served assets. */
export function rewriteHref(href: string): { href: string; external: boolean } {
  const [path, hash = ""] = href.split("#")
  const anchor = hash ? `#${hash}` : ""
  if (/^(https?:|mailto:)/.test(href)) return { href, external: true }
  if (href.startsWith("#")) return { href, external: false }
  // docs/site/x.md links to "x.md"; docs/*.md (checklist, business) link to "site/x.md"
  const file = path.replace(/^\.\.\//, "").replace(/^\.\//, "").replace(/^site\//, "")
  if (FILE_TO_SLUG[file]) return { href: `/docs/${FILE_TO_SLUG[file]}${anchor}`, external: false }
  if (path.startsWith("../images/")) return { href: `/docs-images/${path.slice("../images/".length)}`, external: false }
  if (path.startsWith("/")) return { href, external: false }
  return { href: `${REPO}/${file}${anchor}`, external: true }
}

/** Markdown to HTML, with heading ids for the table of contents, copyable code blocks and Mermaid diagrams. */
export function render(md: string): { html: string; headings: Heading[]; title: string } {
  const headings: Heading[] = []
  const used = new Map<string, number>()
  let title = ""
  const marked = new Marked({ gfm: true })
  marked.use({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const text = this.parser.parseInline(tokens)
        if (depth === 1) {
          title = decode(text.replace(/<[^>]+>/g, ""))
          return `<h1>${text}</h1>`
        }
        let id = slugify(text) || "section"
        const n = used.get(id) ?? 0
        used.set(id, n + 1)
        if (n) id = `${id}-${n}`
        if (depth <= 3) headings.push({ depth, text: decode(text.replace(/<[^>]+>/g, "")), id })
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${text}</h${depth}>`
      },
      link({ href, title: t, tokens }: Tokens.Link) {
        const r = rewriteHref(href)
        const inner = this.parser.parseInline(tokens)
        return `<a href="${esc(r.href)}"${t ? ` title="${esc(t)}"` : ""}${r.external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${inner}</a>`
      },
      image({ href, text }: Tokens.Image) {
        return `<img src="${esc(rewriteHref(href).href)}" alt="${esc(text)}" loading="lazy" />`
      },
      code({ text, lang }: Tokens.Code) {
        if (lang === "mermaid") return `<div class="mermaid-wrap"><pre class="mermaid">${esc(text)}</pre></div>`
        return `<div class="code"><button type="button" class="code-copy" aria-label="Copy code">Copy</button><pre><code${lang ? ` class="language-${esc(lang)}"` : ""}>${esc(text)}</code></pre></div>`
      },
      table(token: Tokens.Table) {
        // wide tables scroll sideways on phones instead of breaking the layout
        const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join("")
        const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`).join("")
        return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        // raw <img src="../images/..."> in the markdown (sized screenshots)
        return text.replace(/src="([^"]+)"/g, (_, s: string) => `src="${esc(rewriteHref(s).href)}"`)
      },
    },
  })
  const html = marked.parse(md, { async: false }) as string
  return { html, headings, title }
}

/** Plain text of a page for search. */
export const plain = (md: string) =>
  md.replace(/```[\s\S]*?```/g, " ").replace(/<[^>]+>/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#*`|>_-]+/g, " ").replace(/\s+/g, " ").trim()

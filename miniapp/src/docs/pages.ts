/**
 * The docs site renders the repo's own markdown: docs/site/*.md, plus docs/BUSINESS.md and docs/WAVE2_CHECKLIST.md.
 * The same files read correctly on GitHub (relative links and images) and here (rewritten in markdown.ts).
 */
const site = import.meta.glob("../../../docs/site/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>
const extra = import.meta.glob(["../../../docs/BUSINESS.md", "../../../docs/WAVE2_CHECKLIST.md"], { query: "?raw", import: "default", eager: true }) as Record<string, string>

export interface DocPage {
  slug: string
  title: string
  description: string
  group: string
  md: string
}

const src = (file: string) => site[`../../../docs/site/${file}.md`] ?? extra[`../../../docs/${file}.md`] ?? `# Missing page\n\n${file}`

const PAGES_META: Array<[slug: string, file: string, title: string, group: string, description: string]> = [
  ["overview", "overview", "Overview", "Start", "What Keel is, who it's for, and the four pillars: borrow, Guardian protection, risk alerts and payments."],
  ["quick-start", "quick-start", "Quick start", "Start", "Try Keel on Mezo testnet in two minutes: open it, connect a wallet, borrow, turn on protection, pay someone."],
  ["borrowing", "borrowing", "How borrowing works", "Product", "MUSD basics used by Keel: fee, interest, the 1,800 MUSD minimum, collateral ratio, liquidation, redemption and Recovery Mode."],
  ["guardian", "guardian", "Guardian protection", "Product", "The guardian contract and keeper: what they can and cannot do, limits, and Guardian v2's partial rescue and result codes."],
  ["payments", "payments", "Payments", "Product", "Send to @username, split bills, payment requests and escrowed claim links for people without a wallet."],
  ["alerts", "alerts", "Alerts and notifications", "Product", "Liquidation, redemption-queue, Recovery Mode and reserve alerts with one-tap fixes, and payment notices."],
  ["web-mode", "web-mode", "Web, Telegram and demo mode", "Product", "Using Keel in a browser with wallet sign-in, inside Telegram, or as a read-only demo."],
  ["security", "security", "Security model", "Trust", "Non-custodial intent signing, data isolation, contract limits, and Keel's known risks and limitations."],
  ["contracts", "contracts", "Contracts and verification", "Trust", "Every deployed Keel contract on Mezo testnet with links to its verified source on the explorer."],
  ["wave2", "WAVE2_CHECKLIST", "Wave 2 checklist", "Trust", "Each point of the Wave 1 judge feedback with its status and evidence: tests, transactions and live links."],
  ["business", "BUSINESS", "Business model", "Company", "Who pays Keel and for what: revenue streams, pricing, market sizing, unit economics and assumptions."],
  ["roadmap", "roadmap", "Roadmap and changelog", "Company", "What's next for Keel, and what shipped in Wave 1 and Wave 2."],
  ["architecture", "architecture", "Architecture", "Build", "Keel's components and data flow: contracts, API and bot, keeper, block watcher, app."],
  ["developers", "developers", "Developers", "Build", "Run Keel locally, environment variables, deploy, tests, API overview, repo layout, license and credits."],
  ["faq", "faq", "FAQ", "Help", "Is it custodial, why 1,800 MUSD, what it costs, what happens if the reserve runs out, and more."],
]

export const PAGES: DocPage[] = PAGES_META.map(([slug, file, title, group, description]) => ({ slug, title, group, description, md: src(file) }))
export const pageBySlug = (slug: string) => PAGES.find((p) => p.slug === slug) ?? null
/** Markdown file names (as linked from other pages) to site slugs. */
export const FILE_TO_SLUG: Record<string, string> = Object.fromEntries(PAGES_META.map(([slug, file]) => [`${file}.md`, slug]))

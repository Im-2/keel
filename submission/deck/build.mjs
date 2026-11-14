// Builds the pitch deck from deck.html: fills in live numbers from Keel's public stats API, then renders
// submission/keel-deck.pdf and one PNG per slide (build-pptx.py turns those into submission/keel-deck.pptx).
//   node submission/deck/build.mjs        (needs puppeteer-core and a local Chrome)
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import puppeteer from "puppeteer-core"

const here = path.dirname(fileURLToPath(process.env.DECK_DIR ? pathToFileURL(path.join(process.env.DECK_DIR, "x")).href : import.meta.url))
const out = path.join(here, "..")
const API = process.env.KEEL_API ?? "https://keel-bot.onrender.com"
const TESTS = process.env.KEEL_TESTS ?? "320"
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe"

const get = async (q) => (await fetch(`${API}/api/stats${q}`, { signal: AbortSignal.timeout(120_000) })).json()
const all = await get("?all=1")
const ext = await get("")
const done = all.protections.filter((p) => p.kind !== "insufficient")
const tokens = {
  GUARDIANS: String(all.guardians),
  MUSD: Number(BigInt(all.musdBorrowed) / 10n ** 18n).toLocaleString("en-US"),
  PROT_TOTAL: String(done.length),
  PROT_PRICE: String(done.filter((p) => p.trigger === "price").length),
  EXT_GUARDIANS: String(ext.guardians),
  TESTS,
  STATS_DATE: new Date(all.updatedAt * 1000).toISOString().slice(0, 10),
}
let html = fs.readFileSync(path.join(here, "deck.html"), "utf8")
for (const [k, v] of Object.entries(tokens)) html = html.replaceAll(`{{${k}}}`, v)
const built = path.join(here, "deck.build.html")
fs.writeFileSync(built, html)
console.log("tokens", tokens)

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--allow-file-access-from-files"] })
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1080 })
await page.goto(pathToFileURL(built).href, { waitUntil: "networkidle0" })
await page.evaluate(() => document.fonts.ready)
await page.pdf({ path: path.join(out, "keel-deck.pdf"), width: "1920px", height: "1080px", printBackground: true })
const dir = path.join(here, "slides")
fs.mkdirSync(dir, { recursive: true })
const slides = await page.$$("section.slide")
for (const [i, s] of slides.entries()) await s.screenshot({ path: path.join(dir, `slide-${String(i + 1).padStart(2, "0")}.png`) })
const notes = await page.$$eval("section.slide", (els) => els.map((e) => e.innerText.replace(/\n{2,}/g, "\n")))
fs.writeFileSync(path.join(dir, "notes.json"), JSON.stringify(notes, null, 1))
await browser.close()
console.log(`rendered ${slides.length} slides`)

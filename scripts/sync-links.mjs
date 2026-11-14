// Writes the demo video link from keel.config.json into README.md and submission/SUBMISSION.md (between
// <!-- video --> markers). An empty demoVideoUrl removes the link, so nothing ever shows a dead placeholder.
// The landing page, the docs and the deck read keel.config.json themselves at build time.
//   node scripts/sync-links.mjs
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const { demoVideoUrl: url = "" } = JSON.parse(fs.readFileSync(path.join(root, "keel.config.json"), "utf8"))
if (url && !/^https:\/\/\S+$/.test(url)) throw new Error(`demoVideoUrl must be an https URL, got "${url}"`)

const targets = [
  ["README.md", (u) => ` ·\n  <a href="${u}"><b>Demo video</b></a>`],
  ["submission/SUBMISSION.md", (u) => `| Demo video | ${u} |\n`],
]
for (const [file, render] of targets) {
  const p = path.join(root, file)
  const s = fs.readFileSync(p, "utf8")
  const next = s.replace(/<!-- video -->[\s\S]*?<!-- \/video -->/, `<!-- video -->${url ? render(url) : ""}<!-- /video -->`)
  if (!/<!-- video -->/.test(s)) throw new Error(`${file} has no <!-- video --> marker`)
  fs.writeFileSync(p, next)
  console.log(`${file}: ${url ? `video link set to ${url}` : "no video link"}`)
}

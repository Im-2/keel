// Bakes a recent copy of the public stats + app config into public/stats-snapshot.json, so the static pages can show
// real numbers instantly even when the free backend is asleep. Runs before every build (and on a schedule in CI).
// If the backend can't be reached the previous snapshot is kept, so a build never fails because of it.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "stats-snapshot.json")
const api = (process.env.VITE_API_BASE || "https://keel-bot.onrender.com").replace(/\/$/, "")
const get = async (p) => {
  const r = await fetch(api + p, { signal: AbortSignal.timeout(75_000) }) // a sleeping Render service needs about a minute
  if (!r.ok) throw new Error(`${p} ${r.status}`)
  return r.json()
}
try {
  const [config, all, outside] = await Promise.all([get("/api/config"), get("/api/stats?all=1"), get("/api/stats")])
  if (typeof all.guardians !== "number" || !Array.isArray(all.protections)) throw new Error("unexpected stats shape")
  fs.writeFileSync(file, JSON.stringify({ at: Math.floor(Date.now() / 1000), config, all, outside }))
  console.log(`stats snapshot written (${all.guardians} guardians, ${all.protections.length} protections)`)
} catch (e) {
  console.warn(`stats snapshot not refreshed (${e.message}); keeping ${fs.existsSync(file) ? "the existing one" : "NONE"}`)
}

// One-off: copy the local SQLite database (wallet links, intents, requests, alert state, stats) into Turso,
// so the hosted bot starts with everyone's data. Safe to re-run: rows are upserted.
// Usage: pnpm tsx scripts/migrate-to-turso.ts [path-to-local.sqlite]
import { Store } from "../src/db"
import { libsqlMirror } from "../src/mirror"

const path = process.argv[2] ?? ".keel-data/keel.sqlite"
const local = new Store(path)
const remote = libsqlMirror(process.env.TURSO_DATABASE_URL!, process.env.TURSO_AUTH_TOKEN)
// creating a store against the mirror sets up the schema remotely
await Store.open(":memory:", remote)
let n = 0
for (const table of ["users", "nonces", "intents", "requests", "alert_state", "kv", "handoffs"]) {
  const rows = local.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
  for (const r of rows) {
    const cols = Object.keys(r)
    await remote.execute(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => r[c]))
    n++
  }
  console.log(`${table}: ${rows.length} rows`)
}
const check = await Store.open(":memory:", libsqlMirror(process.env.TURSO_DATABASE_URL!, process.env.TURSO_AUTH_TOKEN))
console.log(`copied ${n} rows; Turso now holds`, check.counts())
console.log("linked users:", check.boundUsers().map((u) => `${u.tg_id} @${u.username} -> ${u.address}`))

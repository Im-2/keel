import { createClient, type Client } from "@libsql/client"
import type { Mirror } from "./db"

/** Turso / libSQL as the durable copy of the bot's SQLite database. `file:` URLs work too (tests, local backups). */
export function libsqlMirror(url: string, authToken?: string): Mirror & { client: Client } {
  const client = createClient({ url, authToken })
  return {
    client,
    async execute(sql, args) {
      await client.execute({ sql, args: args as never })
    },
    async query(sql) {
      const rs = await client.execute(sql)
      return rs.rows.map((row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i] as unknown])))
    },
  }
}

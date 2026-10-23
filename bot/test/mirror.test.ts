import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Store } from "../src/db"
import { libsqlMirror } from "../src/mirror"

describe("durable store (local SQLite + libSQL mirror)", () => {
  it("survives losing the local disk: a fresh instance restores every row from the mirror", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mirror-"))
    try {
      const mirrorUrl = `file:${join(dir, "remote.db").split("\\").join("/")}`
      const a = await Store.open(":memory:", libsqlMirror(mirrorUrl))
      a.upsertUser(42, "ada", "Ada")
      a.setAddress(42, "0x00000000000000000000000000000000000000a1")
      a.updateSettings(42, { muted: true })
      const i = a.createIntent(42, "repay", { amount: "5" })
      a.completeIntent(i.id, "done", "0x" + "1".repeat(64))
      a.setKv("status:keeper_last", '{"ok":true}')
      a.setAlert(42, "icr", "warn")
      const h = a.createHandoff(42, "link", null)
      expect(a.useHandoff(h.token)).toBe(true)
      await a.flush()
      expect(a.mirrorBacklog).toBe(0)

      // "host restarted": new process, empty local disk, same mirror
      const b = await Store.open(":memory:", libsqlMirror(mirrorUrl))
      expect(b.getUser(42)?.address).toBe("0x00000000000000000000000000000000000000a1")
      expect(b.getUser(42)?.settings.muted).toBe(true)
      expect(b.getIntent(i.id)?.status).toBe("done")
      expect(b.getKv("status:keeper_last")).toBe('{"ok":true}')
      expect(b.getAlert(42, "icr")?.value).toBe("warn")
      expect(b.useHandoff(h.token)).toBe(false) // single-use survives restarts too
      expect(b.counts().users).toBe(1)
      ;(a as unknown as { mirror: { client: { close(): void } } }).mirror.client.close()
      ;(b as unknown as { mirror: { client: { close(): void } } }).mirror.client.close()
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows keeps the libSQL file locked briefly after close; the OS temp dir is cleaned later
      }
    }
  })
})

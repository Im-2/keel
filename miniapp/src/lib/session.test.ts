import { beforeEach, describe, expect, it } from "vitest"
import { scopeStorageToUser } from "./session"

/** A Map-backed Storage whose keys show up in Object.keys(), as browser localStorage does. */
function memStorage() {
  const m = new Map<string, string>()
  const api = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  }
  return new Proxy(api, {
    ownKeys: () => [...m.keys()],
    getOwnPropertyDescriptor: (_t, k) => (m.has(String(k)) ? { enumerable: true, configurable: true, value: m.get(String(k)) } : undefined),
  }) as unknown as Storage
}

describe("device storage belongs to one Telegram account", () => {
  beforeEach(() => {
    Object.assign(globalThis, { localStorage: memStorage(), sessionStorage: memStorage(), indexedDB: { databases: async () => [], deleteDatabase: () => undefined } })
  })

  it("a different Telegram user on the same device starts without the previous wallet session", () => {
    expect(scopeStorageToUser(111)).toBe(false)
    localStorage.setItem("wagmi.store", "{connected A}")
    localStorage.setItem("wc@2:client:0.3//session", "{A}")
    localStorage.setItem("keel:wallet-app", "metamask")
    localStorage.setItem("unrelated", "keep")
    expect(scopeStorageToUser(111)).toBe(false) // same user: untouched
    expect(localStorage.getItem("wagmi.store")).toBe("{connected A}")
    expect(scopeStorageToUser(222)).toBe(true)
    expect(localStorage.getItem("wagmi.store")).toBeNull()
    expect(localStorage.getItem("wc@2:client:0.3//session")).toBeNull()
    expect(localStorage.getItem("keel:wallet-app")).toBeNull()
    expect(localStorage.getItem("unrelated")).toBe("keep")
    expect(localStorage.getItem("keel:tg")).toBe("222")
  })
})

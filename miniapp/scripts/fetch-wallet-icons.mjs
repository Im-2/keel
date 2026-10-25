#!/usr/bin/env node
/**
 * Downloads the official wallet icons from the WalletConnect (Reown) Explorer registry into public/wallets/, so the
 * Mini App serves them from its own domain (fast inside Telegram, no third-party request at runtime).
 *
 * Runs before `vite build`. Icons already on disk are kept (they are committed), so CI builds need neither the
 * network nor a project id; pass --force to refresh them. Needs WALLETCONNECT_PROJECT_ID (or VITE_…) to fetch.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const out = resolve(root, "public/wallets")
const force = process.argv.includes("--force")

// Explorer listing ids; the name is checked against the registry so a wrong id never ships a wrong logo.
const WALLETS = [
  ["metamask", "MetaMask", "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96"],
  ["trust", "Trust Wallet", "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0"],
  ["rainbow", "Rainbow", "1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369"],
  ["coinbase", "Coinbase", "fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa"],
  ["phantom", "Phantom", "a797aa35c0fadbfc1a53e7f675162ed5226968b44a19ee3d24385c64d1d3c393"],
  ["okx", "OKX Wallet", "971e689d0a5be527bac79629b4ee9b925e82208e5168b733496a09c0faed0709"],
  ["zerion", "Zerion", "ecc4036f814562b41a5268adc86270fba1365471402006302e70169465b7ac18"],
  ["uniswap", "Uniswap Wallet", "c03dfee351b6fcc421b4494ea33b9d4b92a984f87aa76d1663bb28705e95034a"],
]

function projectId() {
  if (process.env.WALLETCONNECT_PROJECT_ID) return process.env.WALLETCONNECT_PROJECT_ID
  if (process.env.VITE_WALLETCONNECT_PROJECT_ID) return process.env.VITE_WALLETCONNECT_PROJECT_ID
  for (const f of [resolve(root, ".env"), resolve(root, "../.env")]) {
    if (!existsSync(f)) continue
    const m = readFileSync(f, "utf8").match(/^(?:VITE_)?WALLETCONNECT_PROJECT_ID=(.+)$/m)
    if (m) return m[1].trim()
  }
  return ""
}

const manifestPath = resolve(out, "manifest.json")
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {}
const missing = WALLETS.filter(([id]) => force || !manifest[id] || !existsSync(resolve(out, manifest[id].file)))
if (!missing.length) {
  console.log(`wallet icons: ${Object.keys(manifest).length} cached in public/wallets`)
  process.exit(0)
}
const pid = projectId()
if (!pid) {
  console.warn(`wallet icons: no WALLETCONNECT_PROJECT_ID; ${missing.length} icon(s) missing, the app falls back to a neutral tile`)
  process.exit(0)
}

mkdirSync(out, { recursive: true })
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" }
for (const [id, name, listing] of missing) {
  try {
    const r = await fetch(`https://explorer-api.walletconnect.com/v3/wallets?projectId=${pid}&ids=${listing}`)
    const entry = (await r.json()).listings?.[listing]
    if (!entry) throw new Error("not in the registry")
    if (!entry.name.toLowerCase().includes(name.toLowerCase())) throw new Error(`registry name is "${entry.name}"`)
    const img = await fetch(`https://explorer-api.walletconnect.com/v3/logo/lg/${entry.image_id}?projectId=${pid}`)
    if (!img.ok) throw new Error(`logo HTTP ${img.status}`)
    const type = (img.headers.get("content-type") ?? "").split(";")[0]
    const ext = EXT[type]
    if (!ext) throw new Error(`unexpected type ${type}`)
    const file = `${id}.${ext}`
    writeFileSync(resolve(out, file), Buffer.from(await img.arrayBuffer()))
    manifest[id] = { name: entry.name, file, source: `WalletConnect Explorer listing ${listing} (image ${entry.image_id})`, homepage: entry.homepage }
    console.log(`wallet icons: ${entry.name} -> public/wallets/${file}`)
  } catch (e) {
    console.warn(`wallet icons: ${name} skipped (${e.message})`)
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

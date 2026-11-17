import { test, expect } from "@playwright/test"

// The backend (Render) is sleeping or down: every public page must still render, never blank or hung.
const BASE = process.env.E2E_URL ?? "https://keel-miniapp.vercel.app"

test.beforeEach(async ({ page }) => {
  await page.route((u) => /keel-bot\.onrender\.com/.test(u.href) || u.pathname.startsWith("/api/"), (r) => r.abort("connectionfailed"))
})

test("landing renders with the baked snapshot when the API is down", async ({ page }) => {
  await page.goto(BASE + "/")
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible()
  await expect(page.getByText("Live data is waking up").first()).toBeAttached({ timeout: 15_000 })
  await expect(page.getByText("Guardian accounts")).toBeAttached({ timeout: 15_000 })
})

test("docs render", async ({ page }) => {
  await page.goto(BASE + "/docs")
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible()
})

test("/stats shows the snapshot with a waking note", async ({ page }) => {
  await page.goto(BASE + "/stats")
  await expect(page.getByText("Live data is waking up, showing the latest snapshot")).toBeVisible({ timeout: 25_000 })
  await expect(page.getByText("Guardian accounts")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Protections" })).toBeVisible()
})

test("/status paints and says the server is waking", async ({ page }) => {
  await page.goto(BASE + "/status")
  await expect(page.getByRole("heading", { name: "Keel status" })).toBeVisible()
  await expect(page.getByText("Website (static, CDN)")).toBeVisible()
  await expect(page.getByText("The server is waking up")).toBeVisible({ timeout: 25_000 })
})

test("demo mode opens without the backend", async ({ page }) => {
  await page.goto(BASE + "/?demo=1")
  await expect(page.locator("body")).not.toContainText("Can't reach Keel", { timeout: 25_000 })
  await expect(page.locator("#root")).not.toBeEmpty({ timeout: 25_000 })
})

test("web app shows the friendly waking screen, not a hang or a hard error", async ({ page }) => {
  await page.goto(BASE + "/#/app")
  await expect(page.getByRole("heading", { name: "Waking up the server" })).toBeVisible({ timeout: 25_000 })
  await expect(page.getByRole("button", { name: "Try again now" })).toBeVisible()
})

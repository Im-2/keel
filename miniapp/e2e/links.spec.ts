import { expect, test, type Locator, type Page } from "@playwright/test"

/**
 * Every link and button on the landing page must work: it is clickable (Playwright refuses to click an element
 * covered by another layer), it goes to a real destination (no "#", no placeholder, no 404), and external links
 * open a new tab with rel="noopener noreferrer". Also covered: the resource carousel after a drag, keyboard
 * activation, and deep links into the docs on a hard refresh.
 */

const checked = new Map<string, number>() // destination -> HTTP status (shared across tests in this worker)

async function status(page: Page, url: string) {
  if (checked.has(url)) return checked.get(url)!
  let code = 0
  try {
    const r = await page.request.get(url, { maxRedirects: 5, timeout: 30_000, headers: { "user-agent": "Mozilla/5.0 KeelLinkCheck" } })
    code = r.status()
  } catch {
    code = 0
  }
  checked.set(url, code)
  return code
}

async function openLanding(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await expect(page.locator(".lp h1")).toBeVisible()
  // a visitor moves the pointer or scrolls before clicking; that starts the scroll motion (Lenis, pinning).
  // Wait for it and for the layout to settle, so clicks aren't measured against a page that is still moving.
  await page.mouse.move(200, 200)
  await page.mouse.move(260, 240)
  await page.waitForFunction(() => !!(window as unknown as { __lenis?: unknown }).__lenis, null, { timeout: 30_000 }).catch(() => undefined)
  await page.waitForTimeout(800)
}

/** Every link or button in the landing page, as stable selectors we can re-find after navigating back. */
async function inventory(page: Page) {
  return page.evaluate(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".lp a[href], .lp button"))
    return els.map((el, i) => {
      el.setAttribute("data-e2e", String(i))
      const a = el as HTMLAnchorElement
      return {
        i,
        tag: el.tagName.toLowerCase(),
        text: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
        href: el.tagName === "A" ? a.getAttribute("href") ?? "" : "",
        target: a.target || "",
        rel: a.rel || "",
        download: el.hasAttribute("download"),
        inMobileMenu: !!el.closest("#mobile-menu"),
        inDesktopNav: !!el.closest(".nav-links, .nav-cta"),
        skip: el.classList.contains("skip"),
      }
    })
  })
}

test("every landing link has a real destination and the right new-tab behaviour", async ({ page, baseURL }) => {
  await openLanding(page)
  const items = await inventory(page)
  expect(items.length).toBeGreaterThan(40)
  const problems: string[] = []
  for (const it of items.filter((x) => x.tag === "a")) {
    const label = `${it.text || "(no text)"} → ${it.href}`
    if (!it.href || it.href === "#" || /^javascript:/i.test(it.href) || /placeholder|todo|example\.com/i.test(it.href)) {
      problems.push(`placeholder href: ${label}`)
      continue
    }
    if (it.href.startsWith("#")) {
      const exists = await page.locator(it.href === "#top" ? "#top" : it.href).count()
      if (!exists) problems.push(`in-page anchor without a target: ${label}`)
      continue
    }
    const abs = new URL(it.href, baseURL).toString()
    const external = !abs.startsWith(new URL(baseURL!).origin)
    if (external || /\.(pdf)$/.test(it.href)) {
      if (it.target !== "_blank") problems.push(`external/PDF link not opening in a new tab: ${label}`)
      if (!/noopener/.test(it.rel) || !/noreferrer/.test(it.rel)) problems.push(`missing rel="noopener noreferrer": ${label}`)
    }
    // t.me pages answer bots with 200; some sites reject HEAD-less bots with 403/429, which still proves they exist
    const code = await status(page, abs.split("#")[0])
    if (code === 0 || code === 404 || code >= 500) problems.push(`destination answered ${code}: ${label}`)
  }
  expect(problems, problems.join("\n")).toEqual([])
})

test("every visible link and button is clickable and lands where it says", async ({ page, baseURL, isMobile, context }) => {
  test.setTimeout(900_000) // ~50 links, each opened from a fresh page load
  await openLanding(page)
  const items = await inventory(page)
  const visible = items.filter((x) => !x.skip && (isMobile ? !x.inDesktopNav : !x.inMobileMenu))
  const problems: string[] = []
  for (const it of visible) {
    await openLanding(page)
    await inventory(page) // re-tag after reload
    if (isMobile && it.inMobileMenu) await page.locator(".nav-toggle").tap()
    const el = page.locator(`[data-e2e="${it.i}"]`)
    if (!(await el.isVisible())) {
      await el.scrollIntoViewIfNeeded().catch(() => undefined)
      if (!(await el.isVisible())) continue // e.g. the open-menu button text when the menu is closed
    }
    const label = `${it.tag} "${it.text}" ${it.href}`
    // bring it on screen the way a visitor would, and let scroll-linked motion (the footer sliding up) settle
    await el.scrollIntoViewIfNeeded().catch(() => undefined)
    await page.waitForTimeout(900)
    try {
      if (it.tag === "button") {
        // the only button is the mobile menu toggle: it must open the menu
        await (isMobile ? el.tap() : el.click())
        if (it.text.match(/menu/i)) await expect(page.locator("#mobile-menu")).toBeVisible()
        continue
      }
      if (it.download) {
        const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20_000 }), el.click()])
        expect(dl.suggestedFilename()).toMatch(/\.pptx$/)
        continue
      }
      if (it.target === "_blank") {
        const [popup] = await Promise.all([context.waitForEvent("page", { timeout: 20_000 }), isMobile ? el.tap() : el.click()])
        // with rel="noopener noreferrer" the new tab starts at about:blank; wait for it to navigate
        await popup.waitForURL(/^https?:/, { timeout: 30_000 }).catch(() => undefined)
        const want = new URL(it.href, baseURL).toString().split("#")[0]
        if (!popup.url().startsWith(want.replace(/\/$/, "")) && !popup.url().includes(new URL(want).host)) problems.push(`new tab went to ${popup.url()} instead of ${want}: ${label}`)
        await popup.close()
        continue
      }
      if (it.href.startsWith("#")) {
        await (isMobile ? el.tap() : el.click())
        // smooth scroll: poll until the section is on screen (or give up after 8 s)
        const target = page.locator(it.href)
        const vh = page.viewportSize()!.height
        let ok = false
        for (let t = 0; t < 32 && !ok; t++) {
          await page.waitForTimeout(250)
          const box = await target.boundingBox()
          ok = !!box && box.y < vh * 0.6 && box.y + box.height > 0
        }
        if (!ok) {
          const where = await page.evaluate((sel) => ({ y: Math.round(scrollY), top: Math.round(document.querySelector(sel)?.getBoundingClientRect().top ?? -1), lenis: !!(window as unknown as { __lenis?: unknown }).__lenis }), it.href)
          problems.push(`anchor did not scroll to its section (${JSON.stringify(where)}): ${label}`)
        }
        continue
      }
      const want = new URL(it.href, baseURL)
      // "commit": the navigation happened; heavy destinations (the app in demo mode) can take longer to finish loading
      await Promise.all([page.waitForURL((u) => u.pathname === want.pathname && u.search === want.search, { timeout: 30_000, waitUntil: "commit" }), isMobile ? el.tap() : el.click()])
      // the destination rendered something real, and it is the RIGHT thing: not the landing page left on screen
      // (a hash-only link like /#/app used to leave the landing bundle in place)
      await expect(page.locator("body")).not.toHaveText(/^\s*$/, { timeout: 20_000 })
      const expectText: Record<string, RegExp> = { "/#/app": /Connect your wallet|Sign in/, "/?demo=1#/": /Demo mode/, "/docs": /Overview/, "/stats": /Live stats/ }
      const key = it.href in expectText ? it.href : want.pathname.startsWith("/docs") ? "/docs" : ""
      if (key) await expect(page.locator("body"), `${label} should show its own page`).toHaveText(expectText[key], { timeout: 60_000 })
    } catch (e) {
      problems.push(`${(e as Error).message.split("\n")[0]}: ${label}`)
    }
  }
  expect(problems, problems.join("\n")).toEqual([])
})

test("resource cards: still clickable after dragging the carousel, and by keyboard", async ({ page, isMobile, context, baseURL }) => {
  await openLanding(page)
  const rail = page.locator(".rail")
  await rail.scrollIntoViewIfNeeded()
  const before = await rail.evaluate((el) => el.scrollLeft)
  const box = (await rail.boundingBox())!
  if (!isMobile) {
    // a real mouse drag scrolls the row and does NOT open the card under the pointer
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    expect(await rail.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before)
    expect(new URL(page.url()).pathname).toBe("/")
  } else {
    await rail.evaluate((el) => el.scrollBy({ left: 260 }))
    await page.waitForTimeout(300)
  }
  // then a plain click/tap on a card still navigates
  const docsCard = page.locator(".rcard", { hasText: "Docs" })
  await docsCard.scrollIntoViewIfNeeded()
  await Promise.all([page.waitForURL(/\/docs\/?$/), isMobile ? docsCard.tap() : docsCard.click()])
  await expect(page.locator(".dx h1")).toHaveText("Overview")

  // keyboard: focus a card and press Enter
  await openLanding(page)
  const stats = page.locator(".rcard", { hasText: "Live stats" })
  await stats.focus()
  await Promise.all([page.waitForURL(/\/stats$/), page.keyboard.press("Enter")])

  // the deck opens in a new tab and is a real PDF
  await openLanding(page)
  const deck = page.locator(".rcard", { hasText: "Pitch deck" })
  await deck.scrollIntoViewIfNeeded()
  const [pdf] = await Promise.all([context.waitForEvent("page"), isMobile ? deck.tap() : deck.click()])
  await pdf.waitForURL(/keel-deck\.pdf$/, { timeout: 30_000 })
  const r = await page.request.get(new URL("/keel-deck.pdf", baseURL).toString())
  expect(r.status()).toBe(200)
  expect(r.headers()["content-type"]).toContain("pdf")
})

test("docs deep links work on a hard refresh and every docs page has its own title", async ({ page }) => {
  const slugs = ["", "quick-start", "borrowing", "guardian", "payments", "alerts", "web-mode", "security", "contracts", "wave2", "business", "roadmap", "architecture", "developers", "faq"]
  for (const s of slugs) {
    const res = await page.goto(`/docs/${s}`, { waitUntil: "domcontentloaded" })
    expect(res?.status(), `/docs/${s}`).toBe(200)
    await expect(page.locator(".dx-article h1")).toBeVisible()
    expect(await page.title()).toMatch(/· Keel docs$/)
  }
  // in-page navigation between docs pages and back
  await page.goto("/docs/guardian")
  await Promise.all([page.waitForURL(/\/docs\/payments$/), page.locator(".dx-pager .next").click()])
  await expect(page.locator(".dx-article h1")).toHaveText("Payments")
  await page.goBack()
  await expect(page.locator(".dx-article h1")).toHaveText("Guardian protection")
  const sitemap = await page.request.get("/sitemap.xml")
  expect(sitemap.status()).toBe(200)
  expect(await sitemap.text()).toContain("/docs/guardian")
})

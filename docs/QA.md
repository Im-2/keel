# QA: landing page and docs links

**Production run:** https://keel-miniapp.vercel.app, 15 November 2026, Playwright 1.49 on the installed Chrome, headless. Suite: [`miniapp/e2e/links.spec.ts`](../miniapp/e2e/links.spec.ts).

```bash
pnpm --filter @keel/miniapp e2e                              # production
E2E_URL=http://localhost:4174 pnpm --filter @keel/miniapp e2e  # a local build (vite preview)
```

## Result: 8 of 8 passed

| Viewport | Test | Result | Time |
|---|---|---|---|
| 375 × 812, mobile, touch | Every landing link has a real destination and the right new-tab behaviour | ✅ pass | 21.9 s |
| 375 × 812, mobile, touch | Every visible link and button is clickable (tapped) and lands where it says | ✅ pass | 4.7 min |
| 375 × 812, mobile, touch | Resource cards: still clickable after swiping the carousel, and by keyboard | ✅ pass | 13.2 s |
| 375 × 812, mobile, touch | Docs deep links work on a hard refresh; every docs page has its own title | ✅ pass | 8.4 s |
| 1440 × 900 | Every landing link has a real destination and the right new-tab behaviour | ✅ pass | 36.9 s |
| 1440 × 900 | Every visible link and button is clickable (clicked) and lands where it says | ✅ pass | 7.0 min |
| 1440 × 900 | Resource cards: still clickable after a mouse drag, and by keyboard | ✅ pass | 28.2 s |
| 1440 × 900 | Docs deep links work on a hard refresh; every docs page has its own title | ✅ pass | 7.9 s |

## What was covered

On both viewports the landing page has **63 interactive elements**: 62 links (31 unique destinations, of which 22 are external and 14 are in-page anchors) and 1 button (the mobile menu). They cover the nav and mobile menu, the hero CTAs, the resource cards, the stats band, the Built on Mezo contract links, the CTA band, the footer columns and the social links.

For **every link**:
- The `href` is real: never `#`, `javascript:` or a placeholder.
- External links and the PDF open in a **new tab** with `rel="noopener noreferrer"`.
- The destination answers without a 404 or 5xx: internal pages, the deck PDF and PPTX, GitHub, Telegram, the explorer and mezo.org.
- It is **actually clicked** (desktop) or **tapped** (mobile) from a fresh page load. Playwright refuses to click an element covered by another layer, and each click must land:
  - **same-tab links** must navigate to their path (`/docs`, `/docs/contracts`, `/stats`, `/#/app`, `/?demo=1#/` and so on);
  - **new-tab links** must open the right URL;
  - **in-page anchors** must scroll their section into view;
  - **the PPTX link** must download a `.pptx`.

**Carousel:**
- A real mouse drag scrolls the row and does **not** open the card under the pointer.
- A plain click or tap afterwards **does** open a card.
- Focusing a card and pressing **Enter** opens it.
- The deck card opens the PDF in a new tab, served as `application/pdf`.

**Docs:**
- All 15 pages return 200 on a hard refresh (`/docs`, `/docs/guardian`, …), each with its own `<title>`.
- Previous/next links navigate inside the docs, and Back returns to the previous page.
- `sitemap.xml` lists the docs pages.

## Problems found and fixed

| Problem | Root cause (evidence) | Fix |
|---|---|---|
| Resource cards ("Dig deeper") did nothing on click or tap | `content-visibility: auto` on the section left it "skipped" while on screen. `document.elementFromPoint` at a card returned `SECTION.rail-sec`; switching it off made the same point return `A.rcard` | `content-visibility` removed from every section ([248fc44](https://github.com/Im-2/keel/commit/248fc44), [9546822](https://github.com/Im-2/keel/commit/9546822)) |
| Mouse clicks on cards never opened them, even before that | The drag handler added `.dragging` (`pointer-events: none` on the cards) on every mousedown, so mouseup and the click landed on the rail | Dragging starts only after more than 6 px of movement, and only the click that ends a real drag is cancelled ([248fc44](https://github.com/Im-2/keel/commit/248fc44)) |
| Cards pointed at the wrong places (docs went to the README, the video card to the demo) | Placeholder targets | Deck → PDF (new tab) plus a PPTX link; Docs → `/docs`; Verified contracts → `/docs/contracts`; Live stats → `/stats`; GitHub → the repo; the video card is shown only when a URL is configured |
| `#payments` / `#developers` landed in the wrong place | The first click started the scroll motion, which pins the Guardian scene and inserts a tall spacer above those sections after the jump | In-page links start the motion first, then scroll ([e3f129d](https://github.com/Im-2/keel/commit/e3f129d)) |
| Links below the fold moved under the pointer | Sections changing height on first render made the pinned scene re-flow | No `content-visibility`; the resource cards no longer slide in ([9546822](https://github.com/Im-2/keel/commit/9546822)) |
| Every docs page showed "Missing page" in production | `.vercelignore` excluded `/docs`, so the Vercel build had no markdown | `docs/` is included, and the build now fails if any docs page has no markdown ([61b6125](https://github.com/Im-2/keel/commit/61b6125)) |
| Some external links lacked `noreferrer` | `rel="noopener"` only | All external links use `rel="noopener noreferrer"` |

## Notes on the test itself

- Before clicking, the suite moves the pointer and waits for the scroll motion to start, as a visitor would. It also scrolls each element into view and lets scroll-linked motion settle (the footer slides up as you reach it), so it never clicks a page that is still moving.
- Against production, a destination that answers 403 or 429 to an automated request still counts as existing. Only network errors, 404s and 5xx fail.

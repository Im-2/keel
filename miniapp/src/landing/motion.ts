import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import Lenis from "lenis"

/**
 * All landing-page motion. Loaded after first paint. One easing family everywhere: expo-like out-curves close to
 * cubic-bezier(0.22, 1, 0.36, 1) for entrances, linear for scroll-scrubbed parallax. Only transform, opacity and
 * (on larger screens) filter are animated, so it stays on the compositor.
 * prefers-reduced-motion: no smooth scrolling, no parallax or pinning; content simply fades in.
 */
const EASE = "expo.out"

export function initMotion(root: HTMLElement): () => void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
  const off: Array<() => void> = []
  const on = <K extends keyof WindowEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
    t.addEventListener(type, fn as EventListener, opts)
    off.push(() => t.removeEventListener(type, fn as EventListener, opts))
  }
  const $$ = <T extends Element = HTMLElement>(sel: string, el: ParentNode = root) => Array.from(el.querySelectorAll<T>(sel) as NodeListOf<T>)
  const nav = root.querySelector<HTMLElement>(".nav")
  const setNav = (y: number) => nav?.classList.toggle("scrolled", y > 8)

  if (reduce) {
    root.classList.add("rm")
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { rootMargin: "0px 0px -10% 0px" })
    $$("[data-reveal], [data-stagger] > *, .w").forEach((el) => io.observe(el))
    on(window, "scroll", () => setNav(scrollY), { passive: true })
    renderGuardian(root, 1)
    return () => {
      io.disconnect()
      off.forEach((f) => f())
    }
  }

  gsap.registerPlugin(ScrollTrigger)
  root.classList.add("motion")
  const lenis = new Lenis({ duration: 1.15, easing: (t) => 1 - Math.pow(1 - t, 4), smoothWheel: true })
  lenis.on("scroll", (e: { scroll: number }) => {
    ScrollTrigger.update()
    setNav(e.scroll)
  })
  // handle for automated checks (screenshots) to scroll the way a wheel would
  ;(window as unknown as { __lenis?: Lenis }).__lenis = lenis
  const raf = (time: number) => lenis.raf(time * 1000)
  gsap.ticker.add(raf)
  gsap.ticker.lagSmoothing(0)
  // in-page links glide instead of jumping
  on(root, "click", (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]')
    if (!a) return
    const id = a.getAttribute("href")!
    const target = id === "#top" ? 0 : root.querySelector(id)
    if (target === null) return
    e.preventDefault()
    lenis.scrollTo(target as HTMLElement | number, { offset: -72, duration: 1.4 })
  })

  const desktop = matchMedia("(min-width: 769px)").matches
  const fine = matchMedia("(pointer: fine)").matches
  const blur = (px: number) => (desktop ? `blur(${px}px)` : "blur(0px)")

  const ctx = gsap.context(() => {
    // ---- hero entrance
    const tl = gsap.timeline({ defaults: { ease: EASE } })
    tl.from("[data-hero]", { y: 34, opacity: 0, filter: blur(12), duration: 1.4, stagger: 0.09 })
      .from(".hero-phone", { y: 120, rotate: 5, opacity: 0, duration: 1.8 }, 0.15)
      .from(".hero .float", { y: 40, scale: 0.85, opacity: 0, duration: 1.4, stagger: 0.12 }, 0.6)
      .from(".hero .sph", { scale: 0.4, opacity: 0, duration: 2.2, stagger: 0.1 }, 0.1)

    // ---- ambient drift: every sphere and floating card breathes on its own slow loop
    $$(".sph, .float").forEach((el, i) => {
      gsap.to(el, { y: `+=${gsap.utils.random(10, 22)}`, x: `+=${gsap.utils.random(-10, 10)}`, rotate: el.classList.contains("float") ? gsap.utils.random(-1.5, 1.5) : 0, duration: gsap.utils.random(5, 9), ease: "sine.inOut", yoyo: true, repeat: -1, delay: i * 0.13 })
    })

    // ---- parallax: data-speed > 1 moves faster than the page, < 1 slower (depth)
    $$("[data-speed]").forEach((el) => {
      const speed = Number(el.dataset.speed)
      const section = el.closest("section, footer") ?? el
      gsap.to(el, { yPercent: -speed * 32, ease: "none", scrollTrigger: { trigger: section, start: "top bottom", end: "bottom top", scrub: true } })
    })
    // the hero phone drifts back as you leave the hero
    gsap.to(".hero-phone", { y: -60, scale: 0.96, ease: "none", scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true } })

    // ---- reveals
    $$("[data-reveal]").forEach((el) => {
      gsap.from(el, { y: 48, opacity: 0, filter: blur(12), duration: 1.3, ease: EASE, scrollTrigger: { trigger: el, start: "top 86%" } })
    })
    $$("[data-stagger]").forEach((el) => {
      gsap.from(el.children, { y: 56, opacity: 0, filter: blur(10), duration: 1.3, ease: EASE, stagger: 0.1, scrollTrigger: { trigger: el, start: "top 86%" } })
    })

    // ---- the intro paragraph sharpens word by word as it scrolls through
    gsap.fromTo(".words .w", { opacity: 0.12, filter: blur(8) }, { opacity: 1, filter: "blur(0px)", ease: "none", stagger: 0.05, scrollTrigger: { trigger: ".intro", start: "top 78%", end: "bottom 60%", scrub: 0.6 } })

    // ---- a rounded card grows edge to edge into the Mini App scene
    gsap.fromTo("[data-expand]", { clipPath: desktop ? "inset(4% 8% 4% 8% round 48px)" : "inset(2% 4% 2% 4% round 32px)" }, {
      clipPath: "inset(0% 0% 0% 0% round 0px)", ease: "none", scrollTrigger: { trigger: "[data-expand]", start: "top 92%", end: "top 12%", scrub: true },
    })
    gsap.from(".expand-phone", { y: 160, rotate: -6, ease: "none", scrollTrigger: { trigger: "[data-expand]", start: "top bottom", end: "center center", scrub: true } })

    // ---- pinned guardian scene: price falls, keeper acts, reserve tops the loan back up
    const g = { p: 0 }
    gsap.timeline({ scrollTrigger: { trigger: "[data-pin]", start: "top top", end: desktop ? "+=220%" : "+=180%", pin: true, scrub: 0.8, anticipatePin: 1 } })
      .to(g, { p: 1, ease: "none", duration: 1, onUpdate: () => renderGuardian(root, g.p) })
    renderGuardian(root, 0)

    // ---- payments: phones rise into a fan
    gsap.from(".pay-phone.l", { y: 180, x: 60, rotate: -14, opacity: 0.2, ease: "none", scrollTrigger: { trigger: ".pay-stage", start: "top bottom", end: "center 60%", scrub: true } })
    gsap.from(".pay-phone.r", { y: 180, x: -60, rotate: 14, opacity: 0.2, ease: "none", scrollTrigger: { trigger: ".pay-stage", start: "top bottom", end: "center 60%", scrub: true } })
    gsap.from(".pay-phone.c", { y: 120, ease: "none", scrollTrigger: { trigger: ".pay-stage", start: "top bottom", end: "center 60%", scrub: true } })

    // ---- live stats count up once visible
    ScrollTrigger.create({
      trigger: ".stats",
      start: "top 80%",
      once: true,
      onEnter: () => countUp(root),
    })

    // ---- footer slides up over the red band
    gsap.from("[data-footer]", { yPercent: 18, ease: "none", scrollTrigger: { trigger: "[data-footer]", start: "top bottom", end: "top 55%", scrub: true } })
    gsap.to(".cta .cta-grid", { y: 60, ease: "none", scrollTrigger: { trigger: "[data-footer]", start: "top bottom", end: "top 40%", scrub: true } })
  }, root)

  // stats arrive asynchronously: count up whenever new numbers render while visible
  const mo = new MutationObserver(() => {
    const el = root.querySelector(".stats")
    if (el && el.getBoundingClientRect().top < innerHeight) countUp(root)
  })
  const statsEl = root.querySelector(".stats")
  if (statsEl) mo.observe(statsEl, { childList: true, subtree: true })

  // ---- cursor-aware tilt on cards and magnetic buttons (mouse/trackpad only)
  if (fine) {
    $$("[data-tilt]").forEach((card) => {
      const rx = gsap.quickTo(card, "rotationX", { duration: 0.6, ease: "power3.out" })
      const ry = gsap.quickTo(card, "rotationY", { duration: 0.6, ease: "power3.out" })
      gsap.set(card, { transformPerspective: 900 })
      on(card, "pointermove", (e: PointerEvent) => {
        const r = card.getBoundingClientRect()
        ry(((e.clientX - r.left) / r.width - 0.5) * 9)
        rx(-((e.clientY - r.top) / r.height - 0.5) * 9)
        card.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`)
        card.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`)
      })
      on(card, "pointerleave", () => {
        rx(0)
        ry(0)
      })
    })
    $$("[data-magnetic]").forEach((btn) => {
      const x = gsap.quickTo(btn, "x", { duration: 0.5, ease: "power3.out" })
      const y = gsap.quickTo(btn, "y", { duration: 0.5, ease: "power3.out" })
      on(btn, "pointermove", (e: PointerEvent) => {
        const r = btn.getBoundingClientRect()
        x((e.clientX - r.left - r.width / 2) * 0.22)
        y((e.clientY - r.top - r.height / 2) * 0.3)
      })
      on(btn, "pointerleave", () => {
        gsap.to(btn, { x: 0, y: 0, duration: 0.9, ease: "elastic.out(1, 0.45)" })
      })
    })
  }

  // images and fonts change heights: re-measure pinned and scrubbed sections once they're in
  const refresh = () => ScrollTrigger.refresh()
  on(window, "load", refresh)
  void document.fonts?.ready.then(refresh)

  return () => {
    mo.disconnect()
    ctx.revert()
    gsap.ticker.remove(raf)
    lenis.destroy()
    off.forEach((f) => f())
  }
}

let counted = false
function countUp(root: HTMLElement) {
  const els = Array.from(root.querySelectorAll<HTMLElement>("[data-count]"))
  if (!els.length || counted) return
  counted = true
  for (const el of els) {
    const to = Number(el.dataset.count)
    const fmt = el.dataset.fmt === "int" ? (n: number) => Math.round(n).toLocaleString("en-US") : (n: number) => String(Math.round(n))
    const o = { v: 0 }
    gsap.to(o, { v: to, duration: 1.8, ease: "power3.out", onUpdate: () => { el.textContent = fmt(o.v) } })
  }
}

// ------------------------------------------------------------------ guardian scene (a pure function of progress)

const R = 92
const C = Math.PI * R
const MIN = 110
const MAX = 230
const TRIGGER = 170
const frac = (icr: number) => Math.min(1, Math.max(0, (icr - MIN) / (MAX - MIN)))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const seg = (p: number, a: number, b: number) => Math.min(1, Math.max(0, (p - a) / (b - a)))
const easeIn = (t: number) => t * t
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

/**
 * 0.00–0.40 BTC falls: 185% → 166% (under the 170% trigger)
 * 0.40–0.52 the keeper calls protect()
 * 0.52–0.85 reserve BTC moves into the loan: 166% → 180%
 * 0.85–1.00 done; the last step explains v2's partial rescue
 */
export function renderGuardian(root: HTMLElement, p: number) {
  const q = <T extends Element = HTMLElement>(k: string) => root.querySelector<T>(`[data-g="${k}"]`)
  const fall = easeIn(seg(p, 0, 0.4))
  const fill = easeOut(seg(p, 0.52, 0.85))
  const icr = p < 0.52 ? lerp(185, 166, fall) : lerp(166, 180, fill)
  const price = lerp(93_000, 83_900, fall)
  const reserve = lerp(0.005, 0.00008, fill)
  const keeper = p >= 0.4
  const done = p >= 0.85
  const icrEl = q("icr")
  if (icrEl) icrEl.textContent = `${icr.toFixed(1)}%`
  const st = q("state")
  if (st) {
    const below = icr < TRIGGER
    st.textContent = done ? "Protected" : below ? "Below trigger" : keeper ? "Topping up…" : "Safe"
    st.className = done ? "ok" : below ? "bad" : ""
  }
  const arc = q<SVGPathElement>("arc")
  if (arc) {
    arc.style.strokeDashoffset = String(C * (1 - frac(icr)))
    arc.classList.toggle("bad", icr < TRIGGER && !done)
  }
  const trig = q<SVGLineElement>("trig")
  if (trig) trig.setAttribute("transform", `rotate(${(frac(TRIGGER) - 0.5) * 180} 110 112)`)
  const pr = q("price")
  if (pr) pr.textContent = `$${Math.round(price).toLocaleString("en-US")}`
  const res = q("res")
  if (res) res.textContent = `${reserve.toFixed(4)} BTC`
  const bar = q("bar")
  if (bar) bar.style.transform = `scaleX(${reserve / 0.005})`
  q("keeper")?.classList.toggle("on", keeper)
  q("done")?.classList.toggle("on", done)
  const step = p < 0.4 ? 0 : p < 0.52 ? 1 : p < 0.9 ? 2 : 3
  root.querySelectorAll<HTMLElement>("[data-gstep]").forEach((li) => li.classList.toggle("active", Number(li.dataset.gstep) === step))
}

import type { SVGProps } from "react"

type P = SVGProps<SVGSVGElement> & { size?: number }
const base = ({ size = 22, ...p }: P) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...p,
})

export const IconHome = (p: P) => <svg {...base(p)}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h5v-6h4v6h5V9.5" /></svg>
export const IconBorrow = (p: P) => <svg {...base(p)}><rect x="3" y="6" width="18" height="13" rx="3" /><path d="M3 10h18" /><path d="M7 15h4" /></svg>
export const IconSend = (p: P) => <svg {...base(p)}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
export const IconShield = (p: P) => <svg {...base(p)}><path d="M12 3c3 0 5.6.7 7.5 1.7v6.8c0 4.3-3.2 7.6-7.5 9.5-4.3-1.9-7.5-5.2-7.5-9.5V4.7C6.4 3.7 9 3 12 3Z" /><path d="m9 12 2 2 4-4" /></svg>
export const IconActivity = (p: P) => <svg {...base(p)}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
export const IconBack = (p: P) => <svg {...base(p)}><path d="m15 18-6-6 6-6" /></svg>
export const IconPlus = (p: P) => <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
export const IconMinus = (p: P) => <svg {...base(p)}><path d="M5 12h14" /></svg>
export const IconLink = (p: P) => <svg {...base(p)}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
export const IconCheck = (p: P) => <svg {...base(p)}><path d="m5 12 5 5 9-10" /></svg>
export const IconAlert = (p: P) => <svg {...base(p)}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
export const IconQueue = (p: P) => <svg {...base(p)}><path d="M4 6h16M4 12h10M4 18h6" /></svg>
export const IconDrop = (p: P) => <svg {...base(p)}><path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11Z" /></svg>
export const IconWallet = (p: P) => <svg {...base(p)}><path d="M4 7a2 2 0 0 1 2-2h12v4" /><rect x="3" y="7" width="18" height="13" rx="3" /><circle cx="16.5" cy="13.5" r="1.2" fill="currentColor" stroke="none" /></svg>
export const IconGift = (p: P) => <svg {...base(p)}><rect x="3" y="8" width="18" height="5" rx="1" /><path d="M5 13v8h14v-8M12 8v13" /><path d="M12 8S9.5 3 7.5 4.5 9 8 12 8Zm0 0s2.5-5 4.5-3.5S15 8 12 8Z" /></svg>
export const IconExternal = (p: P) => <svg {...base(p)}><path d="M14 4h6v6M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>
export const IconStar = (p: P) => <svg {...base(p)}><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" /></svg>
export const IconCoin = (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M10 8h3a2 2 0 0 1 0 4h-3V8Zm0 4h3.5a2 2 0 0 1 0 4H10v-4Zm1-5.5V8m0 8v1.5m2-11V8m0 8v1.5" /></svg>

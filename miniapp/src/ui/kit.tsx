import { useEffect, useId, useRef, useState, type ReactNode, type CSSProperties } from "react"
import { IconAlert, IconCheck } from "./icons"
import type { Tone } from "../lib/units"

export const KeelMark = ({ size = 28 }: { size?: number }) => <img src="/keel-mark-red.svg" width={size} height={size} alt="Keel" className="mark" />

/** Mezo's logo is a solid square, so it sits on a matching rounded badge, unaltered. */
export const MezoBadge = ({ label = "Built on Mezo" }: { label?: string }) => (
  <span className="mezo-badge">
    <img src="/mezo-logo.jpg" alt="Mezo" width={16} height={16} />
    {label}
  </span>
)

export function Glass({ children, className = "", orb, style, onClick }: { children: ReactNode; className?: string; orb?: "gold" | "amber" | "dim"; style?: CSSProperties; onClick?: () => void }) {
  return (
    <section className={`glass ${className}`} style={style} onClick={onClick}>
      {orb && <span className={`orb orb-${orb}`} aria-hidden />}
      <div className="glass-body">{children}</div>
    </section>
  )
}

export const Skeleton = ({ h = 16, w = "100%", r = 10, style }: { h?: number; w?: number | string; r?: number; style?: CSSProperties }) => (
  <span className="skeleton" style={{ height: h, width: w, borderRadius: r, ...style }} />
)

export function Sparkline({ values, tone = "gold", height = 34, width = 96 }: { values: number[]; tone?: "gold" | "green" | "red"; height?: number; width?: number }) {
  const id = useId().replace(/:/g, "")
  if (values.length < 2) return <svg width={width} height={height} className="spark" aria-hidden />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 3 - ((v - min) / span) * (height - 6)] as const)
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")
  // black/red/white palette: neutral trends in white, adverse ones in red
  const color = tone === "red" ? "var(--red)" : "#111111"
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="spark" aria-hidden>
      <defs>
        <linearGradient id={`sp${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${width} ${height} L0 ${height} Z`} fill={`url(#sp${id})`} />
      <path d={d} stroke={color} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" className="spark-line" />
    </svg>
  )
}

/** Semicircle safety gauge from 110% (liquidation) to 250%, animated on mount and on change. */
export function Gauge({ icr, size = 210, label = "Safety ratio" }: { icr: number; size?: number; label?: string }) {
  const [shown, setShown] = useState(110)
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(icr))
    return () => cancelAnimationFrame(t)
  }, [icr])
  const lo = 110
  const hi = 250
  const frac = Math.min(1, Math.max(0, (shown - lo) / (hi - lo)))
  const r = size / 2 - 14
  const len = Math.PI * r
  const tone: Tone = icr >= 150 ? "safe" : icr >= 125 ? "warn" : "danger"
  // light theme: safe is a neutral black arc; red is reserved for watch / at risk (always with a label and icon)
  const color = tone === "safe" ? "#111111" : "var(--red)"
  const cx = size / 2
  const cy = size / 2
  const angle = Math.PI * (1 - frac)
  const kx = cx + r * Math.cos(angle)
  const ky = cy - r * Math.sin(angle)
  const ccr = Math.PI * (1 - (150 - lo) / (hi - lo))
  return (
    <div className={`gauge gauge-${tone}`} style={{ width: size, height: size / 2 + 26 }} role="meter" aria-valuenow={Math.round(icr)} aria-valuemin={110} aria-valuemax={250} aria-label={label}>
      <svg width={size} height={size / 2 + 8} viewBox={`0 0 ${size} ${size / 2 + 8}`}>
        <path d={`M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy}`} stroke="rgba(0,0,0,.08)" strokeWidth="12" fill="none" strokeLinecap="round" />
        <path
          d={`M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          stroke={color}
          strokeWidth="12"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={len}
          strokeDashoffset={len * (1 - frac)}
          className="gauge-arc"
        />
        <line x1={cx + (r - 10) * Math.cos(ccr)} y1={cy - (r - 10) * Math.sin(ccr)} x2={cx + (r + 10) * Math.cos(ccr)} y2={cy - (r + 10) * Math.sin(ccr)} stroke="rgba(0,0,0,.35)" strokeWidth="2" />
        <circle cx={kx} cy={ky} r="7" fill="#fff" stroke={color} strokeWidth="3" className="gauge-knob" />
      </svg>
      <div className="gauge-read">
        <strong>{icr > 9999 ? "∞" : `${icr.toFixed(icr >= 1000 ? 0 : 1)}%`}</strong>
        <span>{label}</span>
        <em className="gauge-status">{tone === "safe" ? <IconCheck size={11} /> : <IconAlert size={11} />}{tone === "safe" ? "Safe" : tone === "warn" ? "Watch" : "At risk"}</em>
      </div>
    </div>
  )
}

export function Slider({ value, min, max, step, onChange, format, marks }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string; marks?: Array<[number, string]> }) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <div className="slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ ["--p" as string]: `${pct}%` }} aria-valuetext={format?.(value)} />
      {marks && (
        <div className="slider-marks">
          {marks.map(([v, l]) => (
            <span key={l} style={{ left: `${((v - min) / (max - min)) * 100}%` }}>{l}</span>
          ))}
        </div>
      )}
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  const i = Math.max(0, options.findIndex(([v]) => v === value))
  return (
    <div className="seg" role="tablist" style={{ ["--n" as string]: options.length, ["--i" as string]: i }}>
      <span className="seg-pill" aria-hidden />
      {options.map(([v, l]) => (
        <button key={v} role="tab" aria-selected={v === value} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  )
}

export const Toggle = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
    <span />
  </button>
)

export function Button({ children, onClick, disabled, variant = "primary", type = "button", busy }: { children: ReactNode; onClick?: () => void; disabled?: boolean; variant?: "primary" | "ghost" | "quiet"; type?: "button" | "submit"; busy?: boolean }) {
  return (
    <button type={type} className={`btn btn-${variant} ${busy ? "busy" : ""}`} disabled={disabled || busy} onClick={onClick}>
      {busy && <span className="spinner" aria-hidden />}
      {children}
    </button>
  )
}

export function Rows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="rows">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export const Notice = ({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "danger" | "info" }) => (
  <p className={`notice notice-${tone}`}>
    <IconAlert size={16} />
    <span>{children}</span>
  </p>
)

export function StateView({ kind, title, body, action }: { kind: "empty" | "error" | "success"; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`state state-${kind}`}>
      <div className="state-icon">{kind === "success" ? <IconCheck size={30} /> : kind === "error" ? <IconAlert size={28} /> : <KeelMark size={40} />}</div>
      <h2>{title}</h2>
      {body && <p className="muted">{body}</p>}
      {action}
    </div>
  )
}

export function Avatar({ name, photo }: { name: string; photo?: string }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className="avatar" aria-hidden>
      {photo && !broken ? <img src={photo} alt="" onError={() => setBroken(true)} /> : (name.trim()[0] ?? "K").toUpperCase()}
    </span>
  )
}

/** Field with a big number input and a unit, used on every amount screen. */
export function AmountInput({ value, onChange, unit, placeholder = "0" }: { value: string; onChange: (v: string) => void; unit: string; placeholder?: string }) {
  return (
    <label className="amount">
      <input inputMode="decimal" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} />
      <span>{unit}</span>
    </label>
  )
}

/** Official wallet logo, unmodified, in a rounded tile; a neutral lettered tile only if the image fails to load. */
export function WalletIcon({ wallet, size = 40 }: { wallet?: { name: string; icon: string } | null; size?: number }) {
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size, borderRadius: Math.round(size * 0.28) }
  if (!wallet || broken) {
    return <span className="wallet-ico fallback" style={{ ...style, fontSize: size * 0.42 }} aria-hidden>{wallet?.name[0] ?? "?"}</span>
  }
  return <img className="wallet-ico" style={style} src={wallet.icon} alt="" width={size} height={size} loading="eager" decoding="async" onError={() => setBroken(true)} />
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

/** A number that counts to its new value (ease-out) and flashes up/down; instant under reduced motion. */
export function CountUp({ value, format, duration = 750 }: { value: number; format: (v: number) => string; duration?: number }) {
  const [shown, setShown] = useState(value)
  const [flash, setFlash] = useState<"up" | "down" | null>(null)
  const from = useRef(value)
  useEffect(() => {
    const start = from.current
    if (start === value) return
    from.current = value
    setFlash(value > start ? "up" : "down")
    const clear = setTimeout(() => setFlash(null), 1400)
    if (reducedMotion()) {
      setShown(value)
      return () => clearTimeout(clear)
    }
    const t0 = performance.now()
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / duration)
      setShown(start + (value - start) * (1 - (1 - k) ** 3))
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(clear)
      setShown(value)
    }
  }, [value, duration])
  return <span className={`countup${flash ? ` flash-${flash}` : ""}`}>{format(shown)}</span>
}

/** Stacked bar of how value is split, with a legend. Parts with zero value are left out. */
export function SplitBar({ parts }: { parts: Array<{ label: string; value: number; tone: "black" | "red" | "grey" | "rose" }> }) {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0)
  const shown = parts.filter((p) => p.value > 0)
  if (!total) return null
  return (
    <div className="split">
      <div className="split-bar" role="img" aria-label={shown.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(", ")}>
        {shown.map((p) => <span key={p.label} className={`seg seg-${p.tone}`} style={{ flexGrow: p.value / total }} />)}
      </div>
      <div className="split-legend">
        {shown.map((p) => (
          <span key={p.label}><i className={`dot seg-${p.tone}`} />{p.label} {p.value / total < 0.005 ? "<1" : Math.round((p.value / total) * 100)}%</span>
        ))}
      </div>
    </div>
  )
}

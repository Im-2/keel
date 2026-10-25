import { useEffect, type ReactNode } from "react"
import { tg } from "../lib/api"
import { go } from "../lib/data"
import { IconActivity, IconBack, IconBorrow, IconHome, IconSend, IconShield } from "./icons"
import { Avatar, KeelMark } from "./kit"
import { LiveDot } from "./live"
import { liveEnabled } from "../lib/useLive"

export const TABS = ["", "borrow", "pay", "protect", "activity"] as const
export type Tab = (typeof TABS)[number]

export function TabBar({ active }: { active: string }) {
  const item = (tab: Tab, label: string, icon: ReactNode) => (
    <button className={`tab ${active === tab ? "on" : ""}`} onClick={() => go(`/${tab}`)} aria-current={active === tab ? "page" : undefined}>
      {icon}
      <span>{label}</span>
    </button>
  )
  return (
    <nav className="tabbar" aria-label="Main">
      {item("", "Home", <IconHome />)}
      {item("borrow", "Borrow", <IconBorrow />)}
      <button className={`tab-fab ${active === "pay" ? "on" : ""}`} onClick={() => go("/pay")} aria-label="Send or pay">
        <IconSend size={24} />
      </button>
      {item("protect", "Protect", <IconShield />)}
      {item("activity", "Activity", <IconActivity />)}
    </nav>
  )
}

export function Header({ title, greeting, back }: { title: string; greeting?: string; back?: boolean }) {
  const u = tg?.initDataUnsafe.user
  return (
    <header className="top">
      {back ? (
        <button className="icon-btn" onClick={() => (history.length > 1 ? history.back() : go("/"))} aria-label="Back">
          <IconBack />
        </button>
      ) : (
        <KeelMark size={30} />
      )}
      <div className="top-text">
        {greeting && <span className="greet">{greeting}</span>}
        <h1>{title}</h1>
      </div>
      {liveEnabled() && <LiveDot />}
      <button className="avatar-btn" onClick={() => go("/profile")} aria-label="Profile and wallet settings">
        <Avatar name={u?.first_name ?? "K"} photo={u?.photo_url} />
      </button>
    </header>
  )
}

/** Telegram's native back button mirrors the in-app one on non-tab screens. */
export function useTelegramBack(show: boolean) {
  useEffect(() => {
    const b = tg?.BackButton
    if (!b) return
    const onBack = () => (history.length > 1 ? history.back() : go("/"))
    if (show) {
      b.show()
      b.onClick(onBack)
    } else b.hide()
    return () => b.offClick(onBack)
  }, [show])
}

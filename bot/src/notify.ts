import type { Api } from "grammy"

export interface NotifyButton {
  text: string
  url?: string
  /** Opens the Mini App inside Telegram (private chats only). */
  webApp?: string
}

export interface NotifyOpts {
  buttonText?: string
  buttonUrl?: string
  /** Rows of buttons; alerts use these for one-tap protection. */
  buttons?: NotifyButton[][]
}

export function keyboardOf(opts?: NotifyOpts) {
  const rows: Array<Array<{ text: string; url: string } | { text: string; web_app: { url: string } }>> = []
  for (const row of opts?.buttons ?? []) rows.push(row.map((b) => (b.webApp ? { text: b.text, web_app: { url: b.webApp } } : { text: b.text, url: b.url! })))
  if (opts?.buttonUrl) rows.push([{ text: opts.buttonText ?? "Open", url: opts.buttonUrl }])
  return rows.length ? { inline_keyboard: rows } : undefined
}

/** Anything that can deliver a Telegram message. Faked in tests. */
export interface Notifier {
  /**
   * Resolves false only when Telegram says this person can't be reached: they never pressed Start in the bot's
   * chat, or they blocked it. Other failures are logged and treated as delivered (retrying would spam).
   */
  send(tgId: number, html: string, opts?: NotifyOpts): Promise<boolean>
}

/** Telegram's answer when a bot may not message someone (never started, blocked, deactivated). */
export const unreachable = (e: unknown) => {
  const m = (e as { description?: string; message?: string })?.description ?? (e as Error)?.message ?? ""
  return /bot can't initiate conversation|bot was blocked|chat not found|user is deactivated|Forbidden/i.test(m)
}

export class TelegramNotifier implements Notifier {
  constructor(private api: Api) {}
  async send(tgId: number, html: string, opts?: NotifyOpts) {
    try {
      await this.api.sendMessage(tgId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: keyboardOf(opts),
      })
      return true
    } catch (e) {
      console.warn(`notify ${tgId} failed:`, (e as Error).message)
      return !unreachable(e)
    }
  }
}

/** Minimal store surface for the outbox (kept narrow so tests can use the real Store). */
interface OutboxStore {
  queueMessage(tgId: number, html: string, opts: unknown): void
  takeMessages(tgId: number): Array<{ html: string; opts: unknown }>
  hasQueued(tgId: number): boolean
}

/** Send now, or keep the message for when the person next talks to the bot. */
export async function notifyOrQueue(store: OutboxStore, notifier: Notifier, tgId: number, html: string, opts?: NotifyOpts): Promise<"sent" | "queued"> {
  if (await notifier.send(tgId, html, opts)) return "sent"
  store.queueMessage(tgId, html, opts ?? {})
  return "queued"
}

/** Deliver everything queued for this person (call on any update from them: they are reachable now). */
export async function flushOutbox(store: OutboxStore, notifier: Notifier, tgId: number) {
  if (!store.hasQueued(tgId)) return 0
  const msgs = store.takeMessages(tgId)
  for (const m of msgs) await notifier.send(tgId, m.html, m.opts as NotifyOpts)
  return msgs.length
}

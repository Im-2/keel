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
  send(tgId: number, html: string, opts?: NotifyOpts): Promise<void>
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
    } catch (e) {
      console.warn(`notify ${tgId} failed:`, (e as Error).message)
    }
  }
}

import type { Api } from "grammy"

export interface NotifyOpts {
  buttonText?: string
  buttonUrl?: string
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
        reply_markup: opts?.buttonUrl ? { inline_keyboard: [[{ text: opts.buttonText ?? "Open", url: opts.buttonUrl }]] } : undefined,
      })
    } catch (e) {
      console.warn(`notify ${tgId} failed:`, (e as Error).message)
    }
  }
}

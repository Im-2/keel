import { explorerTx, fmtMusd } from "@keel/shared"
import type { Config } from "./config"
import type { IntentRow, Store, UserRow } from "./db"
import type { ChainService } from "./chain"
import { notifyOrQueue, type Notifier } from "./notify"
import { esc, renderRequest } from "./format"
import { payKeyboard } from "./bot"
import type { LiveBus } from "./live"
import type { Splits } from "./splits"

export interface CompletionDeps {
  config: Pick<Config, "network" | "miniappUrl" | "botUsername">
  store: Store
  chain: ChainService
  notifier: Notifier
  live?: LiveBus
  /** Bill splits: a confirmed pay_split marks that share paid. */
  splits?: Splits
  /** Edits a group payment-request message. Wired to bot.api in production. */
  editMessage?: (chatId: number, messageId: number, html: string, replyMarkup?: unknown) => Promise<unknown>
}

export type ConfirmResult =
  | { status: "done" }
  | { status: "failed"; reason: "reverted" }
  | { status: "unconfirmed" }
  | { status: "wrong_sender" }

/** "@alice", else the first name, else a short address: how people are named in notices and history. */
export const nameOf = (u: Pick<UserRow, "username" | "first_name"> | null | undefined, address?: string | null) =>
  u?.username ? "@" + u.username : u?.first_name ? u.first_name : address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "someone"

/** Dedup key for "you received" notices: the watcher and the completion path share it, so each transfer is told once. */
export const receivedKey = (tx: string, to: string) => `rx:${tx.toLowerCase()}:${to.toLowerCase()}`

/**
 * The single way an intent becomes done or failed: the transaction must be mined with a success status, by the
 * user's own linked wallet. Called by the Mini App (/complete), and by the watcher for transactions the app reported
 * but could not confirm (closed webview, lagging RPC node).
 */
export function createCompletion(d: CompletionDeps) {
  const { config, store, chain, notifier } = d
  const activityUrl = `${config.miniappUrl}/#/activity`

  async function confirm(intent: IntentRow, txHash: string): Promise<ConfirmResult> {
    const fresh = store.getIntent(intent.id)
    if (fresh && fresh.status !== "pending") return fresh.status === "done" ? { status: "done" } : { status: "failed", reason: "reverted" }
    store.setIntentTx(intent.id, txHash)
    const rc = await chain.receipt(txHash)
    if (!rc) return { status: "unconfirmed" }
    const u = store.getUser(intent.tg_id)
    if (!u?.address || rc.from.toLowerCase() !== u.address.toLowerCase()) return { status: "wrong_sender" }
    if (!rc.ok) {
      store.completeIntent(intent.id, "failed", txHash)
      await notifier.send(intent.tg_id, `❌ <b>Transaction reverted</b> on Mezo, so nothing was ${intent.type === "send" ? "sent" : "changed"}. Your funds are where they were (only the gas fee was spent).`, { buttonText: "View transaction", buttonUrl: explorerTx(config.network, txHash) })
      d.live?.publish(intent.tg_id, { reason: "tx_failed", intentId: intent.id, tx: txHash })
      return { status: "failed", reason: "reverted" }
    }
    store.completeIntent(intent.id, "done", txHash)
    await afterIntent(intent, txHash)
    return { status: "done" }
  }

  async function afterIntent(intent: IntentRow, txHash: string) {
    const user = store.getUser(intent.tg_id)
    if (!user) return
    const p = intent.params as Record<string, string>
    const url = explorerTx(config.network, txHash)
    d.live?.publish(user.tg_id, { reason: "tx_confirmed", intentId: intent.id, tx: txHash })

    // the recipient first, so the sender's confirmation can say whether they were reached
    let recipientNote = ""
    if (intent.type === "send" && p.to) {
      const to = p.toTg ? store.getUser(Number(p.toTg)) : store.findByAddress(p.to)
      if (to && store.claimNotice(receivedKey(txHash, p.to))) {
        const memo = p.memo ? ` for “${esc(p.memo)}”` : ""
        const how = await notifyOrQueue(store, notifier, to.tg_id, `💸 You received <b>${fmtMusd(BigInt(p.amount), 2)}</b> from <b>${esc(nameOf(user, user.address))}</b>${memo}.`, {
          buttons: [[{ text: "View transaction", url }, { text: "Open Keel", webApp: activityUrl }]],
        })
        d.live?.publish(to.tg_id, { reason: "received", tx: txHash, toast: `Received ${fmtMusd(BigInt(p.amount), 2)} from ${nameOf(user, user.address)}` })
        if (how === "queued") recipientNote = `\n${esc(nameOf(to))} hasn't started Keel yet; they'll see it when they join.`
      }
    }

    if (intent.type === "pay_split" && p.splitId) {
      const marked = await d.splits?.markPaid(String(p.splitId), Number(p.idx), txHash)
      if (marked === false && d.splits) {
        // their share was already paid (another payment got there first): say so plainly
        await notifier.send(user.tg_id, `ℹ️ Your share of <b>${esc(p.memo ?? "the split")}</b> was already marked paid, so this extra <b>${fmtMusd(BigInt(p.amount), 2)}</b> went to ${esc(p.label ?? "the requester")} as a normal payment. Ask them to send it back if it was a mistake.`, { buttonText: "View transaction", buttonUrl: url })
        return
      }
    }

    const verbs: Partial<Record<IntentRow["type"], string>> = {
      borrow: "✅ Loan opened.", repay: "✅ Repayment confirmed.", add_collateral: "✅ Collateral added.", fund_reserve: "✅ Reserve funded.", close: "✅ Loan closed.",
      pay_split: `✅ Paid <b>${p.amount ? fmtMusd(BigInt(p.amount), 2) : ""}</b> to ${esc(p.label ?? "the requester")} for ${esc(p.memo ?? "the split")}.`,
      cancel_claim: "↩️ Claim link cancelled: the MUSD is back in your wallet.",
      protect_config: "✅ Protection settings saved.", send: `✅ Sent <b>${p.amount ? fmtMusd(BigInt(p.amount), 2) : ""}</b>${p.label ? " to " + esc(p.label) : ""}.`, pay_request: "✅ Payment sent.", create_claim: "🎁 Claim link created.",
    }
    const text = verbs[intent.type]
    if (text) await notifier.send(user.tg_id, text + recipientNote + (intent.type === "borrow" ? "\nSee /position for your ratio and liquidation price." : ""), { buttonText: "View transaction", buttonUrl: url })

    if (intent.type === "pay_request" && p.requestId) {
      const req = store.markRequestPaid(p.requestId, { tg_id: user.tg_id, tx_hash: txHash, username: user.username ?? undefined })
      const fresh = req && store.getRequest(req.id)
      if (fresh?.message_id && d.editMessage) {
        const requester = store.getUser(fresh.requester_tg)
        await d.editMessage(fresh.chat_id, fresh.message_id, renderRequest(fresh, requester?.username ? "@" + requester.username : requester?.first_name ?? "Someone"), payKeyboard(config.botUsername, fresh.id)).catch(() => undefined)
      }
      if (fresh && store.claimNotice(receivedKey(txHash, fresh.requester_address))) {
        await notifyOrQueue(store, notifier, fresh.requester_tg, `💸 ${esc(nameOf(user, user.address))} paid your request.`, { buttonText: "View transaction", buttonUrl: url })
        d.live?.publish(fresh.requester_tg, { reason: "received", tx: txHash })
      }
    }
  }

  return { confirm, afterIntent }
}
export type Completion = ReturnType<typeof createCompletion>

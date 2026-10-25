import { Bot, InlineKeyboard, type Context } from "grammy"
import {
  E18, DEFAULT_BORROW, DEFAULT_BORROW_ICR, faucetUrl, parseStartParam, GAS_BUFFER, SUGGESTED_RESERVE, closeCost, maxPartialRepay, explorerTx, fmtBtc, fmtIcr, fmtMusd, pct, quoteBorrow, riskLevel, RISK_EMOJI, parseUnits18,
} from "@keel/shared"
import type { Config } from "./config"
import type { Store, UserRow, IntentRow, IntentType } from "./db"
import type { ChainService } from "./chain"
import { balanceCard, borrowCard, esc, helpText, historyLine, positionCard, renderRequest, welcomeText } from "./format"
import { UserError, args, parseAmount, parsePercent, parseRecipient, splitArgs, type Recipient } from "./parse"
import { mountChat } from "./chat"
import { NOT_ON_KEEL, resolveRecipient } from "./recipient"
import { History } from "./history"
import { TelegramNotifier, flushOutbox } from "./notify"
import { Splits, parseSplitArgs, type PersonInput } from "./splits"

export interface Deps {
  config: Config
  store: Store
  chain: ChainService
  /** The shared history feed (intents + on-chain ledger); built here when not given (tests). */
  history?: History
  /** Bill splits; built here when not given (tests). */
  splits?: Splits
}

/** Everything a user can do. Slash commands and the natural-language layer both call these, so they behave identically. */
export interface Actions {
  needWallet(ctx: Context, user: UserRow, opts?: { allowGroup?: boolean }): Promise<`0x${string}` | null>
  start(ctx: Context, user: UserRow): Promise<void>
  help(ctx: Context): Promise<void>
  linkWallet(ctx: Context, user: UserRow): Promise<void>
  disconnectAsk(ctx: Context, user: UserRow): Promise<void>
  disconnect(ctx: Context, user: UserRow): Promise<void>
  position(ctx: Context, user: UserRow, edit?: boolean): Promise<void>
  borrow(ctx: Context, user: UserRow, a: { amount?: bigint; icr?: bigint }): Promise<void>
  repay(ctx: Context, user: UserRow, a: { amount?: bigint; all?: boolean }): Promise<void>
  close(ctx: Context, user: UserRow): Promise<void>
  close(ctx: Context, user: UserRow): Promise<void>
  addCollateral(ctx: Context, user: UserRow, a: { amount: bigint }): Promise<void>
  fund(ctx: Context, user: UserRow, a: { amount: bigint }): Promise<void>
  protectMenu(ctx: Context, user: UserRow): Promise<void>
  protect(ctx: Context, user: UserRow, a: { min: bigint; target: bigint }): Promise<void>
  protectOff(ctx: Context, user: UserRow): Promise<void>
  alerts(ctx: Context, user: UserRow): Promise<void>
  setMuted(ctx: Context, user: UserRow, muted: boolean): Promise<void>
  premium(ctx: Context, user: UserRow): Promise<void>
  send(ctx: Context, user: UserRow, a: { to: Recipient; amount: bigint; memo?: string }): Promise<void>
  claimLink(ctx: Context, user: UserRow, a: { amount: bigint; forName?: string }): Promise<void>
  request(ctx: Context, user: UserRow, a: { amount: bigint; memo?: string | null }): Promise<void>
  split(ctx: Context, user: UserRow, a: { total: bigint; names: string[]; memo?: string | null; people?: PersonInput[]; includeMe?: boolean; dueAt?: number | null }): Promise<void>
  balance(ctx: Context, user: UserRow): Promise<void>
  history(ctx: Context, user: UserRow, offset?: number): Promise<void>
}

export function createBot(deps: Deps, bot = new Bot(deps.config.botToken)): Bot {
  const { config, store, chain } = deps
  const history = deps.history ?? new History({ config, store, chain })
  const notifier = new TelegramNotifier(bot.api)
  const splits = deps.splits ?? new Splits({ config, store, notifier })
  // the split card is posted and edited by the bot itself
  splits.attach({
    post: async (chatId, html, markup) => (await bot.api.sendMessage(chatId, html, { parse_mode: "HTML", reply_markup: markup as never, link_preview_options: { is_disabled: true } })).message_id,
    edit: async (chatId, messageId, html, markup) => void (await bot.api.editMessageText(chatId, messageId, html, { parse_mode: "HTML", reply_markup: markup as never, link_preview_options: { is_disabled: true } }).catch((e: Error) => { if (!/not modified/.test(e.message)) throw e })),
  })

  // Anyone who talks to the bot can be reached now: deliver what was queued while Telegram wouldn't let us
  // (they never pressed Start, or had blocked the bot). After the handler, so its reply comes first.
  bot.use(async (ctx, next) => {
    await next()
    if (ctx.from && ctx.chat?.type === "private") await flushOutbox(store, notifier, ctx.from.id).catch(() => undefined)
  })
  const miniapp = (hash: string) => `${config.miniappUrl}/#${hash}`
  const dm = (suffix = "") => `https://t.me/${config.botUsername}${suffix}`
  const isPrivate = (ctx: Context) => ctx.chat?.type === "private"

  // Mini App buttons only work in private chats; this builds the DM deep link for groups.
  const signButton = (label: string, hash: string) => new InlineKeyboard().webApp(label, miniapp(hash))

  const intent = (ctx: Context, type: IntentType, params: Record<string, unknown>): IntentRow =>
    store.createIntent(ctx.from!.id, type, params, ctx.chat?.id)

  function remember(ctx: Context): UserRow {
    return store.upsertUser(ctx.from!.id, ctx.from!.username, ctx.from!.first_name)
  }

  /** Wrap handlers: register the user, turn UserErrors into friendly replies. */
  const handler = (fn: (ctx: Context, user: UserRow) => Promise<unknown>) => async (ctx: Context) => {
    if (!ctx.from) return
    try {
      await fn(ctx, remember(ctx))
    } catch (e) {
      if (e instanceof UserError) return void (await ctx.reply(`⚠️ ${esc(e.message)}`, { parse_mode: "HTML" }))
      console.error("handler error", e)
      await ctx.reply("Something went wrong on my side. Please try again in a moment.")
    }
  }

  const payKb = (id: string) => payKeyboard(config.botUsername, id)

  async function postRequest(ctx: Context, user: UserRow, amount: bigint, memo: string | null, participants: Array<{ username: string }> | null) {
    if (!user.address) return void (await ctx.reply("Link your wallet first so people know where to pay 👉", { reply_markup: new InlineKeyboard().url("Open Keel", dm()) }))
    const r = store.createRequest({ chat_id: ctx.chat!.id, requester_tg: user.tg_id, requester_address: user.address, amount: fmtAmountPlain(amount), memo, participants })
    const msg = await ctx.reply(renderRequest(r, user.username ? "@" + user.username : user.first_name ?? "Someone"), { parse_mode: "HTML", reply_markup: payKb(r.id) })
    store.setRequestMessage(r.id, msg.message_id)
  }

  function alertsText(user: UserRow) {
    const s = user.settings
    return `🔔 <b>Alerts</b> ${s.muted ? "(muted)" : "(on)"}\nWarn me below <b>${Math.round(s.warnIcr * 100)}%</b> · urgent below <b>${Math.round(s.dangerIcr * 100)}%</b>\nRedemption warning when ≤ <b>${s.redemptionAlertMusd.toLocaleString("en-US")} MUSD</b> stands between me and redemption.\n\nI also tell you about Recovery Mode, guardian actions and incoming payments.`
  }
  function alertsKb(user: UserRow) {
    const s = user.settings
    return new InlineKeyboard()
      .text(s.warnIcr === 1.4 ? "• 140%" : "140%", "al:warn:1.4").text(s.warnIcr === 1.5 ? "• 150%" : "150%", "al:warn:1.5").text(s.warnIcr === 1.7 ? "• 170%" : "170%", "al:warn:1.7").row()
      .text(s.muted ? "🔔 Unmute" : "🔕 Mute", "al:mute:" + (s.muted ? "0" : "1"))
  }

  const actions: Actions = {
    /** Account actions need DM + a linked wallet. Returns the address, or null after replying. */
    async needWallet(ctx, user, opts) {
      // a group split is public by design (the card lists who owes what); everything else stays private
      if (!isPrivate(ctx) && opts?.allowGroup) {
        if (user.address) return user.address as `0x${string}`
        await ctx.reply("Link your wallet with me in private first, then split here 👉", { reply_markup: new InlineKeyboard().url("Open Keel", dm()) })
        return null
      }
      if (!isPrivate(ctx)) {
        await ctx.reply("This one is about your money, so let's do it in private 👉", { reply_markup: new InlineKeyboard().url("Open Keel", dm()) })
        return null
      }
      if (!user.address) {
        await ctx.reply("Connect your wallet first (one signature, no gas, no passwords).", { reply_markup: signButton("🔗 Connect wallet", "/link") })
        return null
      }
      return user.address as `0x${string}`
    },

    async start(ctx, user) {
      if (!isPrivate(ctx)) return void (await ctx.reply("Hi! Message me privately to get started 👉", { reply_markup: new InlineKeyboard().url("Open Keel", dm()) }))
      if (!user.address) return void (await ctx.reply(welcomeText(), { parse_mode: "HTML", reply_markup: signButton("🔗 Connect wallet", "/link") }))
      await ctx.reply("Welcome back 👋 Ask me anything, like <i>how safe is my loan?</i>, or pick one:", {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("📊 My position", "cb:position").text("🛡 Protection", "cb:protect").row().text("🔔 Alerts", "cb:alerts").text("❓ Help", "cb:help"),
      })
    },

    async help(ctx) {
      await ctx.reply(helpText(), { parse_mode: "HTML" })
    },

    async linkWallet(ctx, user) {
      if (!isPrivate(ctx)) return void (await ctx.reply("Open me privately to link a wallet 👉", { reply_markup: new InlineKeyboard().url("Open Keel", dm()) }))
      if (!user.address) return void (await ctx.reply("Sign one free message to prove the wallet is yours.", { parse_mode: "HTML", reply_markup: signButton("🔗 Connect wallet", "/link") }))
      await ctx.reply(`Currently linked: <code>${user.address}</code>\nTo switch, connect the other wallet and sign: it replaces this one. Or disconnect.`, {
        parse_mode: "HTML",
        reply_markup: signButton("🔁 Switch wallet", "/link").row().text("🔌 Disconnect wallet", "cb:disconnect"),
      })
    },

    async disconnectAsk(ctx, user) {
      if (!user.address) return void (await ctx.reply("No wallet is connected.", { reply_markup: isPrivate(ctx) ? signButton("🔗 Connect wallet", "/link") : undefined }))
      if (!isPrivate(ctx)) return void (await ctx.reply("Let's do that in private 👉", { reply_markup: new InlineKeyboard().url("Open Keel", dm()) }))
      const a = user.address
      await ctx.reply(`Disconnect <code>${a.slice(0, 6)}…${a.slice(-4)}</code>?\nYour loan and funds stay on-chain and untouched; you can reconnect any time.`, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🔌 Yes, disconnect", "cb:disconnect:yes").text("Cancel", "cb:disconnect:no"),
      })
    },

    async disconnect(ctx, user) {
      const was = store.disconnect(user.tg_id)
      await ctx.reply(
        was
          ? `🔌 Wallet <code>${was.slice(0, 6)}…${was.slice(-4)}</code> disconnected. Alerts for it are off and unsigned requests were cleared.\nConnect the same wallet again to pick your loan back up, or a different one to start fresh.`
          : "No wallet was connected.",
        { parse_mode: "HTML", reply_markup: signButton("🔗 Connect wallet", "/link") },
      )
    },

    async position(ctx, user, edit = false) {
      const address = await actions.needWallet(ctx, user)
      if (!address) return
      const [view, sys] = await Promise.all([chain.view(address), chain.system()])
      const kb = new InlineKeyboard()
      if (view.trove) kb.webApp("➕ Add collateral", miniapp(`/i/${intent(ctx, "add_collateral", {}).id}`)).webApp("💵 Repay", miniapp(`/i/${intent(ctx, "repay", {}).id}`)).row()
      kb.text("🛡 Protection", "cb:protect").text("🔄 Refresh", "cb:position").row().text("🔌 Disconnect wallet", "cb:disconnect")
      const [btc, musd] = await Promise.all([chain.balance(address), chain.musdBalance(address)])
      const text = positionCard(view, sys) + "\n\n" + balanceCard(view, sys, { btc, musd }, faucetUrl(config.network) ?? undefined)
      if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => undefined)
      else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb })
    },

    async borrow(ctx, user, a) {
      const address = await actions.needWallet(ctx, user)
      if (!address) return
      const amount = a.amount ?? BigInt(DEFAULT_BORROW) * E18
      const targetIcr = a.icr ?? pct(DEFAULT_BORROW_ICR)
      const sys = await chain.system()
      const q = quoteBorrow({
        borrowAmount: amount, price: sys.price, borrowingRate: sys.borrowingRate, interestRateBps: sys.interestRateBps,
        minNetDebt: sys.minNetDebt, targetIcr, recoveryMode: sys.recoveryMode,
      })
      const balance = await chain.balance(address)
      const need = q.collateral + GAS_BUFFER
      const short = balance < need
      const blocked = short || q.blocking
      let text = borrowCard(q, sys, amount) + (a.icr ? "" : "\n\n<i>Tip: a higher ratio is safer, e.g. <code>/borrow 1800 200</code> (needs more BTC).</i>")
      text += short
        ? `\n\n🪙 <b>Not enough BTC in your wallet.</b> You need about <b>${fmtBtc(need, 4)}</b> (${fmtBtc(q.collateral, 4)} collateral + ${fmtBtc(GAS_BUFFER, 3)} for fees); your wallet has ${fmtBtc(balance, 4)}. Get testnet BTC from the Mezo faucet, or try a lower amount or ratio.`
        : `\n\n🪙 Wallet: ${fmtBtc(balance, 4)}. After borrowing you'll have about ${fmtBtc(balance - q.collateral, 4)} left: keep ~${fmtBtc(SUGGESTED_RESERVE, 3)} for your guardian reserve (<code>/fund ${fmtBtc(SUGGESTED_RESERVE, 3).replace(" BTC", "")}</code>).`
      if (blocked) return void (await ctx.reply(text, { parse_mode: "HTML" }))
      const i = intent(ctx, "borrow", { amount: amount.toString(), targetIcr: targetIcr.toString() })
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
    },

    async repay(ctx, user, a) {
      const address = await actions.needWallet(ctx, user)
      if (!address) return
      // paying everything off is closing the loan: Mezo never lets an open loan drop under the minimum net debt
      if (a.all) return actions.close(ctx, user)
      const amount = a.amount
      if (!amount) throw new UserError("Please include a repay amount (in MUSD), e.g. 25")
      const [view, sys] = await Promise.all([chain.view(address), chain.system()])
      if (!view.trove) throw new UserError("You don't have an open loan to repay.")
      const max = maxPartialRepay(view.trove.debt, sys.minNetDebt)
      if (amount > max) {
        const why = max === 0n
          ? `Your loan is at Mezo's ${fmtMusd(sys.minNetDebt, 0)} minimum, so it can't be partly repaid.`
          : `You can repay at most <b>${fmtMusd(max, 2)}</b> and keep the loan open (Mezo's minimum is ${fmtMusd(sys.minNetDebt, 0)}).`
        return void (await ctx.reply(`${why} To pay off everything, close the loan.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Close my loan", "cb:close") }))
      }
      const i = intent(ctx, "repay", { amount: amount.toString() })
      await ctx.reply(`Repay <b>${fmtMusd(amount)}</b> of your loan.`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
    },

    async close(ctx, user) {
      const address = await actions.needWallet(ctx, user)
      if (!address) return
      const view = await chain.view(address)
      if (!view.trove) throw new UserError("You don't have an open loan.")
      if (view.kind !== "guardian") throw new UserError("This loan isn't held by a Keel guardian, so close it where you opened it.")
      const i = intent(ctx, "close", {})
      await ctx.reply(
        `Close your loan: pay about <b>${fmtMusd(closeCost(view.trove.debt), 2)}</b> and get your <b>${fmtBtc(view.trove.coll, 5)}</b> collateral back, plus whatever is in your guardian's reserve.\n<i>You owe a little more than you borrowed (the 0.1% fee and interest), so make sure your wallet has enough MUSD.</i>`,
        { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) },
      )
    },

    async addCollateral(ctx, user, a) {
      if (!(await actions.needWallet(ctx, user))) return
      const i = intent(ctx, "add_collateral", { amount: a.amount.toString() })
      await ctx.reply(`Add <b>${fmtBtc(a.amount)}</b> collateral — this raises your safety margin.`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
    },

    async fund(ctx, user, a) {
      if (!(await actions.needWallet(ctx, user))) return
      const i = intent(ctx, "fund_reserve", { amount: a.amount.toString() })
      await ctx.reply(`Add <b>${fmtBtc(a.amount)}</b> to your guardian's reserve. You can withdraw it any time.`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
    },

    async protectMenu(ctx, user) {
      const address = await actions.needWallet(ctx, user)
      if (!address) return
      const view = await chain.view(address)
      const g = view.guardian
      const lines = ["🛡 <b>Guardian protection</b>", "A guardian account owns your loan. If your ratio drops below your trigger, <i>anyone</i> (a keeper bot) can add collateral or repay from <b>your reserve</b> to bring it back — and can't touch anything else. You stay in control."]
      if (g) lines.push(`\nStatus: <b>${g.enabled ? "ON" : "OFF"}</b> · trigger ${fmtIcr(g.minIcr)} → target ${fmtIcr(g.targetIcr)} · tip ${(g.tipBps / 100).toFixed(2)}%\nReserve: ${fmtBtc(g.reserveBTC, 5)}${g.reserveMUSD > 0n ? " + " + fmtMusd(g.reserveMUSD, 0) : ""}`)
      else lines.push("\nYou don't have a guardian yet — setting it up is one signature.")
      const kb = new InlineKeyboard()
      const on = intent(ctx, "protect_config", { enabled: true, minIcr: pct(130).toString(), targetIcr: pct(150).toString(), tipBps: 20, cooldown: 300 })
      kb.webApp(g?.enabled ? "⚙️ Update (130% → 150%)" : "✅ Turn on (130% → 150%)", miniapp(`/i/${on.id}`)).row()
      kb.webApp("💰 Fund reserve", miniapp(`/i/${intent(ctx, "fund_reserve", {}).id}`))
      if (g?.enabled) kb.webApp("⏸ Turn off", miniapp(`/i/${intent(ctx, "protect_config", { enabled: false, minIcr: g.minIcr.toString(), targetIcr: g.targetIcr.toString(), tipBps: g.tipBps, cooldown: g.cooldown }).id}`))
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb })
    },

    async protect(ctx, user, { min: minIcr, target: targetIcr }) {
      const address = await actions.needWallet(ctx, user)
      if (!address) return
      if (minIcr <= pct(110)) throw new UserError("The trigger must be above 110% (the liquidation line).")
      if (targetIcr <= minIcr) throw new UserError("The target must be higher than the trigger, e.g. /protect 130 150.")
      if (targetIcr > pct(500)) throw new UserError("The target can be at most 500%.")
      const i = intent(ctx, "protect_config", { enabled: true, minIcr: minIcr.toString(), targetIcr: targetIcr.toString(), tipBps: 20, cooldown: 300 })
      const view = await chain.view(address)
      const notes: string[] = []
      if (view.trove && view.trove.icr < minIcr) notes.push(`Your ratio is <b>${fmtIcr(view.trove.icr)}</b>, already under the trigger, so the keeper will top you up within about a minute of signing (if the reserve has BTC).`)
      if (!view.guardian || (view.guardian.reserveBTC === 0n && view.guardian.reserveMUSD === 0n)) notes.push(`The reserve is empty. Add BTC with <code>/fund ${fmtBtc(SUGGESTED_RESERVE, 3).replace(" BTC", "")}</code> so there is something to top up with.`)
      await ctx.reply(`Guardian will act below <b>${fmtIcr(minIcr)}</b> and restore you to <b>${fmtIcr(targetIcr)}</b>.${notes.length ? "\n\n" + notes.join("\n") : ""}`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
    },

    async protectOff(ctx, user) {
      const address = await actions.needWallet(ctx, user)
      if (!address) return
      const g = (await chain.view(address)).guardian
      if (!g?.enabled) return void (await ctx.reply("Protection is already off."))
      const i = intent(ctx, "protect_config", { enabled: false, minIcr: g.minIcr.toString(), targetIcr: g.targetIcr.toString(), tipBps: g.tipBps, cooldown: g.cooldown })
      await ctx.reply(`Turn protection <b>off</b>? The keeper will stop topping up your loan. Your reserve (${fmtBtc(g.reserveBTC, 5)}) stays yours.`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
    },

    async alerts(ctx, user) {
      await ctx.reply(alertsText(user), { parse_mode: "HTML", reply_markup: alertsKb(user) })
    },

    async setMuted(ctx, user, muted) {
      const next = store.updateSettings(user.tg_id, { muted })
      const fresh = { ...user, settings: next }
      await ctx.reply(muted ? "🔕 Alerts muted. I'll stay quiet until you say <i>unmute</i>." : "🔔 Alerts are on again.", { parse_mode: "HTML", reply_markup: alertsKb(fresh) })
    },

    async premium(ctx, user) {
      const p = config.premium
      if (!p) return void (await ctx.reply("Premium alerts aren't enabled on this network."))
      const until = Number(store.getKv(`premium:${user.tg_id}`) ?? 0)
      const active = until > Math.floor(Date.now() / 1000)
      await ctx.reply(
        `⭐ <b>Keel Premium</b> — pay-per-use in MUSD via x402, no subscription.\n${p.priceMusd} MUSD for ${p.days} days of near-real-time monitoring (free alerts are checked every few minutes).\n${active ? "Active until " + new Date(until * 1000).toISOString().slice(0, 10) : "Not active."}`,
        { parse_mode: "HTML", reply_markup: isPrivate(ctx) ? signButton(active ? "Extend" : "Get Premium", "/premium") : new InlineKeyboard().url("Open Keel", dm()) },
      )
    },

    async send(ctx, user, { to: recipient, amount, memo = "" }) {
      if (!(await actions.needWallet(ctx, user))) return
      const r = resolveRecipient(store, user, recipient.kind === "address" ? recipient.address : recipient.username)
      if (r.kind === "invalid") throw new UserError(r.error)
      if (r.kind === "self") throw new UserError("That's your own wallet. Send to @username or another 0x address.")
      if (r.kind === "wallet") {
        const i = intent(ctx, "send", { to: r.address, amount: amount.toString(), label: r.label, ...(r.user ? { toTg: r.user.tg_id } : {}), memo })
        const to = r.user ? `<b>${esc(r.label)}</b>` : `<code>${r.address}</code>`
        return void (await ctx.reply(`Send <b>${fmtMusd(amount)}</b> to ${to}${memo ? ` for “${esc(memo)}”` : ""}.\nYou'll see ✅ here once it's confirmed on Mezo.`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) }))
      }
      const i = intent(ctx, "create_claim", { amount: amount.toString(), forName: "@" + r.username, expiryHours: 72 })
      await ctx.reply(
        `<b>@${esc(r.username)}</b>: ${esc(NOT_ON_KEEL)}.\n<b>${fmtMusd(amount)}</b> is held in escrow until they claim it in one tap; it refunds to you after 72h if they don't, and you can cancel any time.`,
        { parse_mode: "HTML", reply_markup: signButton("🎁 Create claim link", `/i/${i.id}`) },
      )
    },

    async balance(ctx, user) {
      const address = await actions.needWallet(ctx, user)
      if (!address) return
      const [view, sys, btc, musd] = await Promise.all([chain.view(address), chain.system(), chain.balance(address), chain.musdBalance(address)])
      const kb = new InlineKeyboard().text("🔄 Refresh", "cb:balance").text("📜 History", "hist:0")
      if (isPrivate(ctx)) kb.row().webApp("📊 Open dashboard", miniapp("/"))
      await ctx.reply(balanceCard(view, sys, { btc, musd }, faucetUrl(config.network) ?? undefined), { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } })
    },

    async history(ctx, user, offset = 0) {
      // personal data never goes into a group chat
      if (!isPrivate(ctx)) return void (await ctx.reply("Your history is private. Let's look at it in our chat 👉", { reply_markup: new InlineKeyboard().url("Open Keel", dm()) }))
      const PAGE = 10
      const { items, more } = await history.feed(user, { limit: PAGE, offset })
      if (!items.length && offset === 0) {
        const kb = new InlineKeyboard()
        if (!user.address) kb.webApp("🔗 Connect wallet", miniapp("/link"))
        return void (await ctx.reply(user.address ? "No activity yet. Borrow with /borrow, or send MUSD with /send @friend 5." : "No activity yet. Connect a wallet to start.", { reply_markup: kb }))
      }
      const lines = items.map((i) => historyLine(i, (tx) => explorerTx(config.network, tx)))
      const kb = new InlineKeyboard()
      if (more) kb.text("⬇️ Show more", `hist:${offset + PAGE}`)
      if (isPrivate(ctx)) kb.webApp("📊 Open Activity", miniapp("/activity"))
      await ctx.reply(`📜 <b>${offset ? "Earlier activity" : "Your recent activity"}</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } })
    },

    async claimLink(ctx, user, { amount, forName }) {
      if (!(await actions.needWallet(ctx, user))) return
      const i = intent(ctx, "create_claim", { amount: amount.toString(), expiryHours: 72, ...(forName ? { forName } : {}) })
      await ctx.reply(`Create a claim link worth <b>${fmtMusd(amount)}</b>. Share it with anyone — they don't need a wallet yet. Unclaimed funds refund to you after 72h.`, { parse_mode: "HTML", reply_markup: signButton("🎁 Create claim link", `/i/${i.id}`) })
    },

    async request(ctx, user, { amount, memo = null }) {
      await postRequest(ctx, user, amount, memo || null, null)
    },

    async split(ctx, user, { total, names, memo = null, people, includeMe = true, dueAt = null }) {
      if (!(await actions.needWallet(ctx, user, { allowGroup: true }))) return
      const list = people ?? names.map((n) => ({ raw: "@" + n.replace(/^@/, "") }))
      if (!list.length && isPrivate(ctx)) throw new UserError("Who's in? e.g. /split 90 @ada @bob dinner (in a group, leave names out and people tap I'm in).")
      const r = await splits.create(user, { total, title: memo ?? "", people: list, includeMe, dueAt, chatId: ctx.chat?.id ?? user.tg_id })
      if (!r.ok) throw new UserError(r.error)
    },
  }

  // ------------------------------------------------------------------ slash commands

  bot.command("start", handler(async (ctx, user) => {
    const payload = args(ctx).trim()
    if (payload.startsWith("pay_")) return void (await startPay(ctx, user, payload.slice(4)))
    const target = parseStartParam(payload)
    // Fallback for t.me/<bot>?start=… links: open the Mini App on that screen in one tap. The big menu button at the
    // bottom of this chat is pointed at the same screen too, until the next plain /start.
    if (target.kind === "claim" || target.kind === "split") {
      const hash = target.kind === "claim" ? `/claim/${payload.slice(6)}` : `/split/${target.id}${target.idx === null ? "" : "/" + target.idx}`
      const label = target.kind === "claim" ? "🎁 Claim MUSD" : "🧾 Open & pay"
      if (isPrivate(ctx)) await bot.api.setChatMenuButton({ chat_id: ctx.chat!.id, menu_button: { type: "web_app", text: label.slice(3), web_app: { url: miniapp(hash) } } }).catch(() => undefined)
      const text = target.kind === "claim"
        ? target.key ? "🎁 <b>Someone sent you MUSD.</b> Tap below to see how much and claim it. No wallet yet? You can create one in the next step." : "⚠️ This claim link is incomplete. Ask the sender to share it again."
        : "🧾 <b>You've been asked to pay a share of a bill.</b> Tap below to see the details and pay."
      return void (await ctx.reply(text, { parse_mode: "HTML", reply_markup: target.kind === "claim" && !target.key ? undefined : signButton(label, hash) }))
    }
    if (isPrivate(ctx)) await bot.api.setChatMenuButton({ chat_id: ctx.chat!.id }).catch(() => undefined)
    await actions.start(ctx, user)
  }))
  bot.command("help", handler((ctx) => actions.help(ctx)))
  bot.command("link", handler((ctx, user) => actions.linkWallet(ctx, user)))
  bot.command(["disconnect", "unlink", "logout"], handler((ctx, user) => actions.disconnectAsk(ctx, user)))
  bot.callbackQuery(/^cb:disconnect(?::(yes|no))?$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    const choice = (ctx.match as RegExpMatchArray)[1]
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined)
    await handler(async (c, u) => {
      if (!choice) return actions.disconnectAsk(c, u)
      if (choice === "no") return void (await c.reply("Okay, your wallet stays connected."))
      await actions.disconnect(c, u)
    })(ctx)
  })

  // Admin-only: forget this Telegram account completely, to re-test first-time onboarding.
  bot.command("resetme", handler(async (ctx, user) => {
    if (!config.adminIds.includes(user.tg_id)) return void (await ctx.reply("That command is for Keel admins only."))
    store.resetUser(user.tg_id)
    await ctx.reply("🧹 Your Keel records are wiped (wallet link, intents, requests, alerts, premium). Nothing on-chain changed.\nSend /start to see the first-time welcome again.")
  }))
  bot.command(["position", "status"], handler((ctx, user) => actions.position(ctx, user)))
  bot.callbackQuery("cb:position", async (ctx) => {
    await ctx.answerCallbackQuery()
    await actions.position(ctx, remember(ctx), true).catch((e) => console.error(e))
  })

  bot.command("borrow", handler(async (ctx, user) => {
    const [amountRaw, icrRaw] = splitArgs(args(ctx))
    await actions.borrow(ctx, user, {
      amount: amountRaw ? parseAmount(amountRaw, "borrow amount (in MUSD)") : undefined,
      icr: icrRaw ? parsePercent(icrRaw, DEFAULT_BORROW_ICR) : undefined,
    })
  }))
  bot.command("repay", handler(async (ctx, user) => {
    const raw = splitArgs(args(ctx))[0]
    if (raw && /^(all|everything|max)$/i.test(raw)) return actions.repay(ctx, user, { all: true })
    if (!(await actions.needWallet(ctx, user))) return
    await actions.repay(ctx, user, { amount: parseAmount(raw, "repay amount (in MUSD)") })
  }))
  bot.command(["addcollateral", "deposit"], handler(async (ctx, user) => {
    if (!(await actions.needWallet(ctx, user))) return
    await actions.addCollateral(ctx, user, { amount: parseAmount(splitArgs(args(ctx))[0], "BTC amount") })
  }))

  bot.command("protect", handler(async (ctx, user) => {
    const [a, b] = splitArgs(args(ctx))
    if (!a) return actions.protectMenu(ctx, user)
    if (/^off$/i.test(a)) return actions.protectOff(ctx, user)
    if (!(await actions.needWallet(ctx, user))) return
    await actions.protect(ctx, user, { min: parsePercent(a, 130), target: parsePercent(b, 150) })
  }))
  bot.command("close", handler((ctx, user) => actions.close(ctx, user)))
  bot.callbackQuery("cb:close", async (ctx) => {
    await ctx.answerCallbackQuery()
    await handler((c, u) => actions.close(c, u))(ctx)
  })
  bot.callbackQuery("cb:protect", async (ctx) => {
    await ctx.answerCallbackQuery()
    await handler((c, u) => actions.protectMenu(c, u))(ctx)
  })
  bot.command("fund", handler(async (ctx, user) => {
    if (!(await actions.needWallet(ctx, user))) return
    await actions.fund(ctx, user, { amount: parseAmount(splitArgs(args(ctx))[0], "BTC amount") })
  }))

  bot.command("alerts", handler((ctx, user) => actions.alerts(ctx, user)))
  bot.callbackQuery("cb:alerts", async (ctx) => {
    await ctx.answerCallbackQuery()
    await actions.alerts(ctx, remember(ctx))
  })
  bot.callbackQuery(/^al:(warn|mute):(.+)$/, async (ctx) => {
    const user = remember(ctx)
    const [, kind, val] = ctx.match as RegExpMatchArray
    const next = kind === "warn" ? store.updateSettings(user.tg_id, { warnIcr: Number(val), dangerIcr: Math.min(1.3, Number(val) - 0.1) }) : store.updateSettings(user.tg_id, { muted: val === "1" })
    await ctx.answerCallbackQuery({ text: "Saved" })
    const fresh = { ...user, settings: next }
    await ctx.editMessageText(alertsText(fresh), { parse_mode: "HTML", reply_markup: alertsKb(fresh) }).catch(() => undefined)
  })
  bot.callbackQuery("cb:help", async (ctx) => {
    await ctx.answerCallbackQuery()
    await actions.help(ctx)
  })
  bot.command("premium", handler((ctx, user) => actions.premium(ctx, user)))
  bot.command(["history", "activity", "transactions"], handler((ctx, user) => actions.history(ctx, user)))
  bot.command(["balance", "balances", "wallet"], handler((ctx, user) => actions.balance(ctx, user)))
  bot.callbackQuery(/^hist:(\d{1,4})$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    await actions.history(ctx, remember(ctx), Number((ctx.match as RegExpMatchArray)[1]))
  })
  bot.callbackQuery("cb:balance", async (ctx) => {
    await ctx.answerCallbackQuery()
    await actions.balance(ctx, remember(ctx))
  })

  bot.command("send", handler(async (ctx, user) => {
    if (!(await actions.needWallet(ctx, user))) return
    let [to, amt, ...note] = splitArgs(args(ctx))
    // "/send 5 @bob" works as well as "/send @bob 5"
    if (to && amt && /^\d+([.,]\d+)?$/.test(to) && !/^\d+([.,]\d+)?$/.test(amt)) [to, amt] = [amt, to]
    if (!to) throw new UserError("Usage: /send @username 5 (or a 0x address), optionally followed by a note.")
    const recipient = parseRecipient(to)
    await actions.send(ctx, user, { to: recipient, amount: parseAmount(amt, "amount (in MUSD)"), memo: note.join(" ") })
  }))
  bot.command("claimlink", handler(async (ctx, user) => {
    if (!(await actions.needWallet(ctx, user))) return
    await actions.claimLink(ctx, user, { amount: parseAmount(splitArgs(args(ctx))[0], "amount (in MUSD)") })
  }))
  bot.command("request", handler(async (ctx, user) => {
    const [amt, ...memo] = splitArgs(args(ctx))
    await actions.request(ctx, user, { amount: parseAmount(amt, "amount (in MUSD)"), memo: memo.join(" ") || null })
  }))
  bot.command("split", handler(async (ctx, user) => {
    let parsed: ReturnType<typeof parseSplitArgs>
    try {
      parsed = parseSplitArgs(args(ctx))
    } catch (e) {
      throw new UserError((e as Error).message)
    }
    await actions.split(ctx, user, { total: parsed.total, names: [], people: parsed.people, memo: parsed.title || null, includeMe: parsed.includeMe, dueAt: parsed.dueAt })
  }))
  // the split card's buttons
  bot.callbackQuery(/^split:(join|lock|remind|cancel):([A-Za-z0-9]{4,16})$/, async (ctx) => {
    const user = remember(ctx)
    const [, action, id] = ctx.match as RegExpMatchArray
    if (action === "join") {
      const r = await splits.join(id, user)
      return void (await ctx.answerCallbackQuery({ text: r.ok ? r.value : r.error, show_alert: !r.ok }))
    }
    if (action === "lock") {
      const r = await splits.lock(id, user.tg_id)
      return void (await ctx.answerCallbackQuery({ text: r.ok ? "Locked: everyone's been asked to pay ✅" : r.error, show_alert: !r.ok }))
    }
    if (action === "cancel") {
      const r = await splits.cancel(id, user.tg_id)
      return void (await ctx.answerCallbackQuery({ text: r.ok ? "Cancelled" : r.error, show_alert: !r.ok }))
    }
    const r = await splits.remind(id, user.tg_id)
    if (!r.ok) return void (await ctx.answerCallbackQuery({ text: r.error, show_alert: true }))
    const v = r.value
    const parts = [
      v.reminded.length ? `Reminded ${v.reminded.join(", ")}.` : "",
      v.queued.length ? `${v.queued.join(", ")} will see it when they open Keel.` : "",
      v.skipped.length ? `${v.skipped.join(", ")} was reminded less than an hour ago.` : "",
      v.links.length ? `${v.links.map((l) => l.label).join(", ")} isn't on Keel yet: send them their pay link.` : "",
    ].filter(Boolean)
    await ctx.answerCallbackQuery({ text: parts.join(" ").slice(0, 190) || "Nothing to remind.", show_alert: true })
  })

  async function startPay(ctx: Context, user: UserRow, requestId: string) {
    const r = store.getRequest(requestId)
    if (!r) throw new UserError("That payment request has expired or doesn't exist.")
    const address = await actions.needWallet(ctx, user)
    if (!address) return
    if (r.requester_tg === user.tg_id) throw new UserError("That's your own request 🙂")
    const i = intent(ctx, "pay_request", { requestId, to: r.requester_address, amount: r.amount, memo: r.memo ?? "" })
    await ctx.reply(`Pay <b>${fmtMusd(parseUnits18(r.amount))}</b>${r.memo ? ` for “${esc(r.memo)}”` : ""}`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
  }

  bot.command("stats", handler(async (ctx) => {
    const [n, sys] = await Promise.all([chain.guardianCount(), chain.system()])
    const protections = store.getKv("stat:protections") ?? "0"
    await ctx.reply(
      `🛡 <b>Keel network</b>\nGuardian accounts: <b>${n}</b>\nProtections executed by this keeper: <b>${protections}</b>\nSystem ratio: ${fmtIcr(sys.tcr)} ${sys.recoveryMode ? "🚨 Recovery Mode" : "✅ normal"}\nBTC: $${Math.round(Number(sys.price / E18)).toLocaleString("en-US")}`,
      { parse_mode: "HTML" },
    )
  }))

  bot.command("risk", handler(async (ctx) => {
    const sys = await chain.system()
    await ctx.reply(`${RISK_EMOJI[riskLevel(sys.tcr)]} System ratio ${fmtIcr(sys.tcr)}${sys.recoveryMode ? " — Recovery Mode" : ""}`)
  }))

  // Plain-language messages: registered last so every slash command above wins.
  mountChat(bot, { config, store, chain, actions, remember, handler })

  return bot
}

export const payKeyboard = (botUsername: string, id: string) => new InlineKeyboard().url("Pay with Keel", `https://t.me/${botUsername}?start=pay_${id}`)

/** MUSD bigint -> plain decimal string (for storage in requests). */
export function fmtAmountPlain(v: bigint): string {
  const whole = v / E18
  const frac = (v % E18).toString().padStart(18, "0").replace(/0+$/, "")
  return frac ? `${whole}.${frac}` : whole.toString()
}

export { explorerTx }

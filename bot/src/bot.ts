import { Bot, InlineKeyboard, type Context } from "grammy"
import {
  E18, DEFAULT_BORROW, DEFAULT_BORROW_ICR, GAS_BUFFER, SUGGESTED_RESERVE, explorerTx, fmtBtc, fmtIcr, fmtMusd, pct, quoteBorrow, riskLevel, RISK_EMOJI, parseUnits18,
} from "@keel/shared"
import type { Config } from "./config"
import type { Store, UserRow, IntentRow, IntentType } from "./db"
import type { ChainService } from "./chain"
import { borrowCard, esc, helpText, positionCard, renderRequest } from "./format"
import { UserError, args, parseAmount, parsePercent, parseRecipient, splitArgs } from "./parse"

export interface Deps {
  config: Config
  store: Store
  chain: ChainService
}

export function createBot(deps: Deps, bot = new Bot(deps.config.botToken)): Bot {
  const { config, store, chain } = deps
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

  /** Account actions need DM + a linked wallet. Returns the address, or null after replying. */
  async function needWallet(ctx: Context, user: UserRow): Promise<`0x${string}` | null> {
    if (!isPrivate(ctx)) {
      await ctx.reply("This one is about your money, so let's do it in private 👉", { reply_markup: new InlineKeyboard().url("Open Keel", dm()) })
      return null
    }
    if (!user.address) {
      await ctx.reply("Connect your wallet first (one signature, no gas, no passwords).", { reply_markup: signButton("🔗 Connect wallet", "/link") })
      return null
    }
    return user.address as `0x${string}`
  }

  // ------------------------------------------------------------------ start / help / link

  bot.command("start", handler(async (ctx, user) => {
    const payload = args(ctx).trim()
    if (payload.startsWith("pay_")) return void (await startPay(ctx, user, payload.slice(4)))
    if (payload.startsWith("claim_")) {
      return void (await ctx.reply("🎁 Someone sent you MUSD. Tap to claim — you'll get a wallet-connect prompt and the funds arrive in one step.", {
        reply_markup: signButton("Claim MUSD", `/claim/${payload.slice(6)}`),
      }))
    }
    if (!isPrivate(ctx)) return void (await ctx.reply("Hi! Message me privately to get started 👉", { reply_markup: new InlineKeyboard().url("Open Keel", dm()) }))
    if (!user.address) {
      return void (await ctx.reply(
        `<b>Keel</b> — borrow dollars against your Bitcoin without selling it, with a guardian that keeps your loan safe.\n\n• Non-custodial: you sign everything in your own wallet\n• Auto-protection against liquidation\n• Alerts before redemptions reach you\n• Send MUSD to anyone with a link\n\nBuilt on Mezo's MUSD.`,
        { parse_mode: "HTML", reply_markup: signButton("🔗 Connect wallet", "/link") },
      ))
    }
    await ctx.reply("Welcome back 👋 What would you like to do?", {
      reply_markup: new InlineKeyboard().text("📊 My position", "cb:position").text("🛡 Protection", "cb:protect").row().text("🔔 Alerts", "cb:alerts").text("❓ Help", "cb:help"),
    })
  }))

  bot.command("help", handler(async (ctx) => void (await ctx.reply(helpText(), { parse_mode: "HTML" }))))

  bot.command("link", handler(async (ctx, user) => {
    if (!isPrivate(ctx)) return void (await ctx.reply("Open me privately to link a wallet 👉", { reply_markup: new InlineKeyboard().url("Open Keel", dm()) }))
    const note = user.address ? `Currently linked: <code>${user.address}</code>\nLinking again replaces it.` : "Sign one free message to prove the wallet is yours."
    await ctx.reply(note, { parse_mode: "HTML", reply_markup: signButton("🔗 Connect wallet", "/link") })
  }))

  // ------------------------------------------------------------------ position

  async function sendPosition(ctx: Context, user: UserRow, edit = false) {
    const address = await needWallet(ctx, user)
    if (!address) return
    const [view, sys] = await Promise.all([chain.view(address), chain.system()])
    const kb = new InlineKeyboard()
    if (view.trove) kb.webApp("➕ Add collateral", miniapp(`/i/${intent(ctx, "add_collateral", {}).id}`)).webApp("💵 Repay", miniapp(`/i/${intent(ctx, "repay", {}).id}`)).row()
    kb.text("🛡 Protection", "cb:protect").text("🔄 Refresh", "cb:position")
    const text = positionCard(view, sys)
    if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => undefined)
    else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb })
  }
  bot.command(["position", "status"], handler((ctx, user) => sendPosition(ctx, user)))
  bot.callbackQuery("cb:position", async (ctx) => {
    await ctx.answerCallbackQuery()
    const user = remember(ctx)
    await sendPosition(ctx, user, true).catch((e) => console.error(e))
  })

  // ------------------------------------------------------------------ borrow / repay / collateral

  bot.command("borrow", handler(async (ctx, user) => {
    const address = await needWallet(ctx, user)
    if (!address) return
    const [amountRaw, icrRaw] = splitArgs(args(ctx))
    const amount = amountRaw ? parseAmount(amountRaw, "borrow amount (in MUSD)") : BigInt(DEFAULT_BORROW) * E18
    const targetIcr = parsePercent(icrRaw, DEFAULT_BORROW_ICR)
    const sys = await chain.system()
    const q = quoteBorrow({
      borrowAmount: amount, price: sys.price, borrowingRate: sys.borrowingRate, interestRateBps: sys.interestRateBps,
      minNetDebt: sys.minNetDebt, targetIcr, recoveryMode: sys.recoveryMode,
    })
    const balance = await chain.balance(address)
    const need = q.collateral + GAS_BUFFER
    const short = balance < need
    const blocked = short || q.warnings.some((w) => /Minimum|below the 110/.test(w))
    let text = borrowCard(q, sys, amount) + (icrRaw ? "" : "\n\n<i>Tip: a higher ratio is safer, e.g. <code>/borrow 1800 200</code> (needs more BTC).</i>")
    text += short
      ? `\n\n🪙 <b>Not enough BTC in your wallet.</b> You need about <b>${fmtBtc(need, 4)}</b> (${fmtBtc(q.collateral, 4)} collateral + ${fmtBtc(GAS_BUFFER, 3)} for fees); your wallet has ${fmtBtc(balance, 4)}. Get testnet BTC from the Mezo faucet, or try a lower amount or ratio.`
      : `\n\n🪙 Wallet: ${fmtBtc(balance, 4)}. After borrowing you'll have about ${fmtBtc(balance - q.collateral, 4)} left: keep ~${fmtBtc(SUGGESTED_RESERVE, 3)} for your guardian reserve (<code>/fund ${fmtBtc(SUGGESTED_RESERVE, 3).replace(" BTC", "")}</code>).`
    if (blocked) return void (await ctx.reply(text, { parse_mode: "HTML" }))
    const i = intent(ctx, "borrow", { amount: amount.toString(), targetIcr: targetIcr.toString() })
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
  }))

  bot.command("repay", handler(async (ctx, user) => {
    if (!(await needWallet(ctx, user))) return
    const amount = parseAmount(splitArgs(args(ctx))[0], "repay amount (in MUSD)")
    const i = intent(ctx, "repay", { amount: amount.toString() })
    await ctx.reply(`Repay <b>${fmtMusd(amount)}</b> of your loan.`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
  }))

  bot.command(["addcollateral", "deposit"], handler(async (ctx, user) => {
    if (!(await needWallet(ctx, user))) return
    const amount = parseAmount(splitArgs(args(ctx))[0], "BTC amount")
    const i = intent(ctx, "add_collateral", { amount: amount.toString() })
    await ctx.reply(`Add <b>${fmtBtc(amount)}</b> collateral — this raises your safety margin.`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
  }))

  // ------------------------------------------------------------------ protection

  async function sendProtect(ctx: Context, user: UserRow) {
    const address = await needWallet(ctx, user)
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
  }
  bot.command("protect", handler(async (ctx, user) => {
    const [a, b] = splitArgs(args(ctx))
    if (!a) return sendProtect(ctx, user)
    const address = await needWallet(ctx, user)
    if (!address) return
    const minIcr = parsePercent(a, 130)
    const targetIcr = parsePercent(b, 150)
    if (minIcr <= pct(110)) throw new UserError("The trigger must be above 110% (the liquidation line).")
    if (targetIcr <= minIcr) throw new UserError("The target must be higher than the trigger, e.g. /protect 130 150.")
    const i = intent(ctx, "protect_config", { enabled: true, minIcr: minIcr.toString(), targetIcr: targetIcr.toString(), tipBps: 20, cooldown: 300 })
    const view = await chain.view(address)
    const notes: string[] = []
    if (view.trove && view.trove.icr < minIcr) notes.push(`Your ratio is <b>${fmtIcr(view.trove.icr)}</b>, already under the trigger, so the keeper will top you up within about a minute of signing (if the reserve has BTC).`)
    if (!view.guardian || (view.guardian.reserveBTC === 0n && view.guardian.reserveMUSD === 0n)) notes.push(`The reserve is empty. Add BTC with <code>/fund ${fmtBtc(SUGGESTED_RESERVE, 3).replace(" BTC", "")}</code> so there is something to top up with.`)
    await ctx.reply(`Guardian will act below <b>${fmtIcr(minIcr)}</b> and restore you to <b>${fmtIcr(targetIcr)}</b>.${notes.length ? "\n\n" + notes.join("\n") : ""}`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
  }))
  bot.callbackQuery("cb:protect", async (ctx) => {
    await ctx.answerCallbackQuery()
    await handler((c, u) => sendProtect(c, u))(ctx)
  })
  bot.command("fund", handler(async (ctx, user) => {
    if (!(await needWallet(ctx, user))) return
    const amount = parseAmount(splitArgs(args(ctx))[0], "BTC amount")
    const i = intent(ctx, "fund_reserve", { amount: amount.toString() })
    await ctx.reply(`Add <b>${fmtBtc(amount)}</b> to your guardian's reserve. You can withdraw it any time.`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
  }))

  // ------------------------------------------------------------------ alerts

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
  bot.command("alerts", handler(async (ctx, user) => void (await ctx.reply(alertsText(user), { parse_mode: "HTML", reply_markup: alertsKb(user) }))))
  bot.callbackQuery("cb:alerts", async (ctx) => {
    await ctx.answerCallbackQuery()
    const user = remember(ctx)
    await ctx.reply(alertsText(user), { parse_mode: "HTML", reply_markup: alertsKb(user) })
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
    await ctx.reply(helpText(), { parse_mode: "HTML" })
  })

  bot.command("premium", handler(async (ctx, user) => {
    const p = config.premium
    if (!p) return void (await ctx.reply("Premium alerts aren't enabled on this network."))
    const until = Number(store.getKv(`premium:${user.tg_id}`) ?? 0)
    const active = until > Math.floor(Date.now() / 1000)
    await ctx.reply(
      `⭐ <b>Keel Premium</b> — pay-per-use in MUSD via x402, no subscription.
${p.priceMusd} MUSD for ${p.days} days of near-real-time monitoring (free alerts are checked every few minutes).
${active ? "Active until " + new Date(until * 1000).toISOString().slice(0, 10) : "Not active."}`,
      { parse_mode: "HTML", reply_markup: isPrivate(ctx) ? signButton(active ? "Extend" : "Get Premium", "/premium") : new InlineKeyboard().url("Open Keel", dm()) },
    )
  }))

  // ------------------------------------------------------------------ payments

  bot.command("send", handler(async (ctx, user) => {
    if (!(await needWallet(ctx, user))) return
    const [to, amt, ...note] = splitArgs(args(ctx))
    const recipient = parseRecipient(to)
    const amount = parseAmount(amt, "amount (in MUSD)")
    if (recipient.kind === "address") {
      const i = intent(ctx, "send", { to: recipient.address, amount: amount.toString(), label: recipient.address.slice(0, 8) + "…", memo: note.join(" ") })
      return void (await ctx.reply(`Send <b>${fmtMusd(amount)}</b> to <code>${recipient.address}</code>.`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) }))
    }
    const target = store.findByUsername(recipient.username)
    if (target?.address) {
      const i = intent(ctx, "send", { to: target.address, amount: amount.toString(), label: "@" + recipient.username, toTg: target.tg_id, memo: note.join(" ") })
      return void (await ctx.reply(`Send <b>${fmtMusd(amount)}</b> to <b>@${esc(recipient.username)}</b>.`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) }))
    }
    const i = intent(ctx, "create_claim", { amount: amount.toString(), forName: "@" + recipient.username, expiryHours: 72 })
    await ctx.reply(
      `<b>@${esc(recipient.username)}</b> hasn't linked a wallet to Keel yet. No problem — create a <b>claim link</b>: <b>${fmtMusd(amount)}</b> is held in escrow and they claim it in one tap (you can cancel any time; it refunds after 72h).`,
      { parse_mode: "HTML", reply_markup: signButton("🎁 Create claim link", `/i/${i.id}`) },
    )
  }))

  bot.command("claimlink", handler(async (ctx, user) => {
    if (!(await needWallet(ctx, user))) return
    const amount = parseAmount(splitArgs(args(ctx))[0], "amount (in MUSD)")
    const i = intent(ctx, "create_claim", { amount: amount.toString(), expiryHours: 72 })
    await ctx.reply(`Create a claim link worth <b>${fmtMusd(amount)}</b>. Share it with anyone — they don't need a wallet yet. Unclaimed funds refund to you after 72h.`, { parse_mode: "HTML", reply_markup: signButton("🎁 Create claim link", `/i/${i.id}`) })
  }))

  const payKb = (id: string) => payKeyboard(config.botUsername, id)

  async function postRequest(ctx: Context, user: UserRow, amount: bigint, memo: string | null, participants: Array<{ username: string }> | null) {
    if (!user.address) return void (await ctx.reply("Link your wallet first so people know where to pay 👉", { reply_markup: new InlineKeyboard().url("Open Keel", dm()) }))
    const r = store.createRequest({ chat_id: ctx.chat!.id, requester_tg: user.tg_id, requester_address: user.address, amount: fmtAmountPlain(amount), memo, participants })
    const msg = await ctx.reply(renderRequest(r, user.username ? "@" + user.username : user.first_name ?? "Someone"), { parse_mode: "HTML", reply_markup: payKb(r.id) })
    store.setRequestMessage(r.id, msg.message_id)
  }

  bot.command("request", handler(async (ctx, user) => {
    const [amt, ...memo] = splitArgs(args(ctx))
    await postRequest(ctx, user, parseAmount(amt, "amount (in MUSD)"), memo.join(" ") || null, null)
  }))

  bot.command("split", handler(async (ctx, user) => {
    const [amt, ...rest] = splitArgs(args(ctx))
    const total = parseAmount(amt, "total (in MUSD)")
    const names = rest.filter((t) => t.startsWith("@")).map((t) => t.slice(1))
    if (names.length === 0) throw new UserError("Mention the people to split with, e.g. /split 90 @ada @bob")
    const share = total / BigInt(names.length + 1)
    const memo = rest.filter((t) => !t.startsWith("@")).join(" ") || null
    await postRequest(ctx, user, share, memo ? `${memo} (split ${names.length + 1} ways)` : `split ${names.length + 1} ways`, names.map((username) => ({ username })))
  }))

  async function startPay(ctx: Context, user: UserRow, requestId: string) {
    const r = store.getRequest(requestId)
    if (!r) throw new UserError("That payment request has expired or doesn't exist.")
    const address = await needWallet(ctx, user)
    if (!address) return
    if (r.requester_tg === user.tg_id) throw new UserError("That's your own request 🙂")
    const i = intent(ctx, "pay_request", { requestId, to: r.requester_address, amount: r.amount, memo: r.memo ?? "" })
    await ctx.reply(`Pay <b>${fmtMusd(parseUnits18(r.amount))}</b>${r.memo ? ` for “${esc(r.memo)}”` : ""}`, { parse_mode: "HTML", reply_markup: signButton("✍️ Review & sign", `/i/${i.id}`) })
  }

  // ------------------------------------------------------------------ stats

  bot.command("stats", handler(async (ctx) => {
    const [n, sys] = await Promise.all([chain.guardianCount(), chain.system()])
    const protections = store.getKv("stat:protections") ?? "0"
    await ctx.reply(
      `🛡 <b>Keel network</b>\nGuardian accounts: <b>${n}</b>\nProtections executed by this keeper: <b>${protections}</b>\nSystem ratio: ${fmtIcr(sys.tcr)} ${sys.recoveryMode ? "🚨 Recovery Mode" : "✅ normal"}\nBTC: $${Math.round(Number(sys.price / E18)).toLocaleString("en-US")}`,
      { parse_mode: "HTML" },
    )
  }))

  // Demo helper for local development only (needs the dev chain + admin id).
  bot.command("risk", handler(async (ctx) => {
    const sys = await chain.system()
    await ctx.reply(`${RISK_EMOJI[riskLevel(sys.tcr)]} System ratio ${fmtIcr(sys.tcr)}${sys.recoveryMode ? " — Recovery Mode" : ""}`)
  }))

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

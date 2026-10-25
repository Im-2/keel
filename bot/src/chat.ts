import { InlineKeyboard, type Bot, type Context } from "grammy"
import { CCR, E18, MCR, collateralToTarget, computeIcr, fmtBtc, fmtIcr, fmtMusd, fmtUsd, liquidationPrice, parseUnits18, pct, requestedShares } from "@keel/shared"
import type { Actions } from "./bot"
import type { ChainService } from "./chain"
import type { Config } from "./config"
import { newId, type Store, type UserRow } from "./db"
import { esc } from "./format"
import { ACCEPT, INTENT_LABEL, parse, type NluIntent, type Slots } from "./nlu"
import { UserError } from "./parse"

/**
 * Plain-language layer. It only ever calls the same actions as the slash commands, which create the same
 * intents and confirmation cards; nothing here signs or moves funds. Every money action is echoed back
 * (amount, recipient, ratio) with Yes / Cancel before an intent exists.
 */
export interface ChatDeps {
  config: Config
  store: Store
  chain: ChainService
  actions: Actions
  remember: (ctx: Context) => UserRow
  handler: (fn: (ctx: Context, user: UserRow) => Promise<unknown>) => (ctx: Context) => Promise<void>
}

type Missing = "amount" | "recipient" | "names" | "protect"
interface Pending {
  tg: number
  intent: NluIntent
  slots: Slots
  missing?: Missing
  exp: number
}

const TTL = 15 * 60
const MONEY: NluIntent[] = ["borrow", "repay", "add_collateral", "fund_reserve", "protect_on", "protect_off", "send", "claim_link", "request", "split"]
const now = () => Math.floor(Date.now() / 1000)

export const EXAMPLES = [
  "borrow 2000 at 180%",
  "how safe is my loan?",
  "what if BTC drops 20%?",
  "send 20 to @ada for lunch",
  "turn on protection",
]

export function mountChat(bot: Bot, d: ChatDeps) {
  const { store, chain, actions, handler } = d

  // ---- pending state (server-side, so callback data stays tiny and tamper-proof)
  const savePending = (p: Omit<Pending, "exp">): string => {
    const id = newId(6)
    store.setKv(`nl:p:${id}`, JSON.stringify({ ...p, exp: now() + TTL }))
    return id
  }
  const loadPending = (id: string, tg: number): Pending | null => {
    const raw = store.getKv(`nl:p:${id}`)
    if (!raw) return null
    const p = JSON.parse(raw) as Pending | null
    return p && p.tg === tg && p.exp > now() ? p : null
  }
  const dropPending = (id: string) => store.setKv(`nl:p:${id}`, "null")
  const setAwait = (tg: number, pid: string | null) => store.setKv(`nl:await:${tg}`, pid ? JSON.stringify({ pid, exp: now() + TTL }) : "null")
  const getAwait = (tg: number): string | null => {
    const raw = store.getKv(`nl:await:${tg}`)
    const v = raw ? (JSON.parse(raw) as { pid: string; exp: number } | null) : null
    return v && v.exp > now() ? v.pid : null
  }

  const kb = (...rows: Array<Array<[string, string]>>) => {
    const k = new InlineKeyboard()
    rows.forEach((row, i) => {
      for (const [label, data] of row) k.text(label, data)
      if (i < rows.length - 1) k.row()
    })
    return k
  }
  const go = (intent: NluIntent, arg = "") => `nl:go:${intent}${arg ? ":" + arg : ""}`

  /** Follow-up suggestions after each answer. */
  function suggestions(after: NluIntent | "unknown"): InlineKeyboard {
    switch (after) {
      case "safety":
      case "liquidation":
        return kb([["📉 What if BTC −20%", go("whatif", "20")], ["➕ Add collateral", go("add_collateral")]], [["🛡 Protection", go("protect_info")], ["📊 Position", go("position")]])
      case "whatif":
        return kb([["−30%", go("whatif", "30")], ["−40%", go("whatif", "40")], ["−50%", go("whatif", "50")]], [["🛡 Turn on protection", go("protect_on")], ["➕ Add collateral", go("add_collateral")]])
      case "protect_info":
        return kb([["✅ Turn on protection", go("protect_on")], ["💰 Fund reserve", go("fund_reserve")]], [["How safe am I?", go("safety")]])
      case "fees":
      case "what_musd":
        return kb([["💵 Borrow", go("borrow")], ["How safe am I?", go("safety")]], [["❓ Help", go("help")]])
      case "position":
        return kb([["How safe am I?", go("safety")], ["📉 What if BTC −20%", go("whatif", "20")]])
      default:
        return kb([["💵 Borrow", go("borrow")], ["📊 My position", go("position")]], [["🛡 Protection", go("protect_info")], ["💸 Send", go("send")]], [["❓ Help", go("help")]])
    }
  }

  // ---- slot helpers
  const amountOf = (s: Slots): bigint | null => {
    if (!s.amount) return null
    try {
      const v = parseUnits18(s.amount)
      return v > 0n ? v : null
    } catch {
      return null
    }
  }
  const ratio = (p: number | undefined) => (p !== undefined && p > 110 && p <= 1000 ? pct(p) : undefined)
  const who = (s: Slots) => (s.address ? s.address : s.usernames[0] ? "@" + s.usernames[0] : null)

  /** Ask for one missing piece, with quick replies; the next plain message fills it too. */
  async function ask(ctx: Context, user: UserRow, intent: NluIntent, slots: Slots, missing: Missing) {
    const pid = savePending({ tg: user.tg_id, intent, slots, missing })
    setAwait(user.tg_id, pid)
    const set = (label: string, v: string): [string, string] => [label, `nl:set:${pid}:${v}`]
    const cancel: [string, string] = ["✖ Cancel", `nl:no:${pid}`]
    const a = amountOf(slots)
    switch (missing) {
      case "amount": {
        const q: Partial<Record<NluIntent, [string, Array<[string, string]>]>> = {
          borrow: ["How much MUSD do you want to borrow? (minimum 1,800)", [set("1,800", "1800"), set("2,500", "2500"), set("5,000", "5000")]],
          repay: ["How much do you want to repay?", [set("100", "100"), set("500", "500"), set("Everything", "all")]],
          add_collateral: ["How much BTC do you want to add as collateral?", [set("0.005 BTC", "0.005"), set("0.01 BTC", "0.01"), set("0.02 BTC", "0.02")]],
          fund_reserve: ["How much BTC should go into your guardian's reserve?", [set("0.005 BTC", "0.005"), set("0.01 BTC", "0.01")]],
          send: [`How much MUSD should I send${who(slots) ? " to " + esc(who(slots)!) : ""}?`, [set("5", "5"), set("10", "10"), set("20", "20"), set("50", "50")]],
          claim_link: ["How much MUSD should the claim link hold?", [set("5", "5"), set("10", "10"), set("25", "25")]],
          request: ["How much are you requesting (MUSD)?", [set("10", "10"), set("20", "20"), set("50", "50")]],
          split: ["What's the total to split (MUSD)?", [set("30", "30"), set("60", "60"), set("90", "90")]],
        }
        const [text, buttons] = q[intent] ?? ["How much?", []]
        const unitHint = slots.unit === "btc" && ["borrow", "repay", "send", "claim_link", "request", "split"].includes(intent)
          ? "\n<i>(This one is in MUSD dollars, not BTC.)</i>"
          : slots.unit === "musd" && ["add_collateral", "fund_reserve"].includes(intent) ? "\n<i>(Collateral and reserve are in BTC.)</i>" : ""
        return void (await ctx.reply(`${text}${unitHint}\nTap one or just type the number.`, { parse_mode: "HTML", reply_markup: kb(buttons, [cancel]) }))
      }
      case "recipient":
        return void (await ctx.reply(`Who should get <b>${a ? fmtMusd(a) : "it"}</b>? Reply with an <b>@username</b> or a <b>0x address</b>.`, {
          parse_mode: "HTML",
          reply_markup: kb([["🎁 Make a claim link instead", `nl:set:${pid}:claimlink`]], [cancel]),
        }))
      case "names":
        return void (await ctx.reply("Who are you splitting with? Mention them, like <i>@ada @bob</i>.", { parse_mode: "HTML", reply_markup: kb([cancel]) }))
      case "protect":
        return void (await ctx.reply("When should your guardian step in, and where should it bring you back to?", {
          reply_markup: kb([set("130% → 150%", "130-150"), set("150% → 180%", "150-180")], [set("170% → 180% (demo)", "170-180")], [cancel]),
        }))
    }
  }

  /** Echo the exact action back before any intent is created. */
  async function confirm(ctx: Context, user: UserRow, intent: NluIntent, slots: Slots) {
    const a = amountOf(slots)
    const r = slots.percents
    let text: string
    switch (intent) {
      case "borrow":
        text = `Borrow <b>${fmtMusd(a!)}</b> at a <b>${r[0] ? r[0] + "%" : "160%"}</b> collateral ratio?\nNext I'll show the full quote: BTC locked, fee, interest and liquidation price.`
        break
      case "repay":
        text = slots.all ? "Pay off <b>everything</b> and close your loan? You get your BTC collateral back." : `Repay <b>${fmtMusd(a!)}</b> of your loan?`
        break
      case "add_collateral":
        text = `Add <b>${fmtBtc(a!)}</b> to your loan as collateral?`
        break
      case "fund_reserve":
        text = `Put <b>${fmtBtc(a!)}</b> into your guardian's reserve?`
        break
      case "protect_on":
        text = `Turn on protection: act below <b>${r[0]}%</b> and restore you to <b>${r[1]}%</b>?`
        break
      case "protect_off":
        text = "Turn protection <b>off</b>?"
        break
      case "send":
        text = `Send <b>${fmtMusd(a!)}</b> to <b>${esc(who(slots)!)}</b>${slots.memo ? ` for “${esc(slots.memo)}”` : ""}?`
        break
      case "claim_link":
        text = `Create a claim link holding <b>${fmtMusd(a!)}</b>${slots.usernames[0] ? ` for <b>@${esc(slots.usernames[0])}</b>` : ""}?`
        break
      case "request":
        text = `Post a request for <b>${fmtMusd(a!)}</b>${slots.memo ? ` for “${esc(slots.memo)}”` : ""} in this chat?`
        break
      case "split": {
        const memo = slots.memo ? ` for “${esc(slots.memo)}”` : ""
        if (!slots.usernames.length) {
          text = `Split <b>${fmtMusd(a!)}</b>${memo} with everyone here who taps <b>I'm in</b>? You lock it when everyone's in.`
          break
        }
        const names = slots.usernames.map((u) => "<b>@" + esc(u) + "</b>").join(", ")
        try {
          const { mine, theirs } = requestedShares(a!, slots.usernames.length, { kind: "equal" }, !slots.excludeMe)
          const each = theirs.every((x) => x === theirs[0]) ? `Each pays <b>${fmtMusd(theirs[0], 2)}</b>` : `Shares: ${theirs.map((x) => fmtMusd(x, 2)).join(", ")}`
          text = `Split <b>${fmtMusd(a!)}</b>${memo} with ${names}${slots.excludeMe ? " (not you)" : ` and you (${theirs.length + 1} ways)`}? ${each}${mine > 0n ? `, your own share is ${fmtMusd(mine, 2)}` : ""}.`
        } catch (e) {
          return void (await ctx.reply(`⚠️ ${esc((e as Error).message)}`, { parse_mode: "HTML" }))
        }
        break
      }
      default:
        return run(ctx, user, intent, slots)
    }
    const pid = savePending({ tg: user.tg_id, intent, slots })
    await ctx.reply(`${text}\n\n<i>Nothing moves until you review and sign in your own wallet.</i>`, {
      parse_mode: "HTML",
      reply_markup: kb([["✅ Yes, continue", `nl:ok:${pid}`], ["✖ Cancel", `nl:no:${pid}`]]),
    })
  }

  /** Fill defaults and check what's missing; then confirm (money) or answer (info). */
  async function proceed(ctx: Context, user: UserRow, intent: NluIntent, slots: Slots) {
    const a = amountOf(slots)
    switch (intent) {
      case "borrow":
        if (!a || slots.unit === "btc") return ask(ctx, user, intent, { ...slots, amount: undefined }, "amount")
        return confirm(ctx, user, intent, slots)
      case "repay":
        if (!a && !slots.all) return ask(ctx, user, intent, slots, "amount")
        if (slots.unit === "btc") return ask(ctx, user, intent, { ...slots, amount: undefined }, "amount")
        return confirm(ctx, user, intent, slots)
      case "add_collateral":
      case "fund_reserve":
        if (!a || slots.unit === "musd") return ask(ctx, user, intent, { ...slots, amount: undefined }, "amount")
        return confirm(ctx, user, intent, slots)
      case "protect_on": {
        const [p1, p2] = slots.percents
        if (p1 === undefined) return ask(ctx, user, intent, slots, "protect")
        const target = p2 ?? Math.min(500, p1 + 20)
        return confirm(ctx, user, intent, { ...slots, percents: [p1, target] })
      }
      case "protect_off":
        return confirm(ctx, user, intent, slots)
      case "send":
        if (!a || slots.unit === "btc") return ask(ctx, user, intent, { ...slots, amount: undefined }, "amount")
        if (!who(slots)) return ask(ctx, user, intent, slots, "recipient")
        return confirm(ctx, user, intent, slots)
      case "claim_link":
      case "request":
        if (!a || slots.unit === "btc") return ask(ctx, user, intent, { ...slots, amount: undefined }, "amount")
        return confirm(ctx, user, intent, slots)
      case "split":
        if (!a) return ask(ctx, user, intent, slots, "amount")
        // in a group, "split 120 between everyone" (or no names) makes a split people join with "I'm in"
        if (!slots.usernames.length && !(ctx.chat?.type !== "private")) return ask(ctx, user, intent, slots, "names")
        return confirm(ctx, user, intent, slots)
      default:
        return run(ctx, user, intent, slots)
    }
  }

  /** Execute: money intents go to the shared actions (which build the cards); info intents are answered here. */
  async function run(ctx: Context, user: UserRow, intent: NluIntent, slots: Slots) {
    const a = amountOf(slots)
    switch (intent) {
      case "borrow": return actions.borrow(ctx, user, { amount: a!, icr: ratio(slots.percents[0]) })
      case "repay": return actions.repay(ctx, user, slots.all ? { all: true } : { amount: a! })
      case "add_collateral": return actions.addCollateral(ctx, user, { amount: a! })
      case "fund_reserve": return actions.fund(ctx, user, { amount: a! })
      case "protect_on": return actions.protect(ctx, user, { min: pct(slots.percents[0]), target: pct(slots.percents[1]) })
      case "protect_off": return actions.protectOff(ctx, user)
      case "send":
        return actions.send(ctx, user, {
          to: slots.address ? { kind: "address", address: slots.address as `0x${string}` } : { kind: "username", username: slots.usernames[0] },
          amount: a!,
          memo: slots.memo,
        })
      case "claim_link": return actions.claimLink(ctx, user, { amount: a!, forName: slots.usernames[0] ? "@" + slots.usernames[0] : undefined })
      case "request": return actions.request(ctx, user, { amount: a!, memo: slots.memo ?? null })
      case "split": return actions.split(ctx, user, { total: a!, names: slots.usernames, memo: slots.memo ?? null, includeMe: !slots.excludeMe })
      case "position": return actions.position(ctx, user)
      case "alerts": return actions.alerts(ctx, user)
      case "mute": return actions.setMuted(ctx, user, true)
      case "unmute": return actions.setMuted(ctx, user, false)
      case "link_wallet": return actions.linkWallet(ctx, user)
      case "disconnect": return actions.disconnectAsk(ctx, user)
      case "premium": return actions.premium(ctx, user)
      case "history": return actions.history(ctx, user)
      case "balance": return actions.balance(ctx, user)
      case "help":
        await actions.help(ctx)
        return void (await ctx.reply("Or just tell me what you want, in your own words.", { reply_markup: suggestions("unknown") }))
      case "greeting":
        return void (await ctx.reply(`Hi${user.first_name ? " " + esc(user.first_name) : ""} 👋 Talk to me normally, for example:\n${EXAMPLES.map((e) => `• <i>${esc(e)}</i>`).join("\n")}`, { parse_mode: "HTML", reply_markup: suggestions("unknown") }))
      case "what_musd":
        return void (await ctx.reply(
          "<b>MUSD</b> is Mezo's dollar stablecoin, backed by Bitcoin. You lock BTC as collateral and mint MUSD against it at a fixed interest rate, so you get dollars without selling your Bitcoin. You can repay any time to unlock your BTC. Keel makes this a chat: it quotes, protects and alerts, and you sign everything in your own wallet.",
          { parse_mode: "HTML", reply_markup: suggestions("what_musd") },
        ))
      case "protect_info": return answerProtectInfo(ctx, user)
      case "fees": return answerFees(ctx)
      case "safety": return answerSafety(ctx, user)
      case "liquidation": return answerLiquidation(ctx, user)
      case "whatif": return answerWhatIf(ctx, user, slots)
    }
  }

  // ---- answers from real data (never invented numbers)

  async function loanOrExplain(ctx: Context, user: UserRow) {
    if (!user.address) {
      await ctx.reply("Connect your wallet first and I'll answer with your real numbers.", { reply_markup: new InlineKeyboard().webApp("🔗 Connect wallet", `${d.config.miniappUrl}/#/link`) })
      return null
    }
    const [view, sys] = await Promise.all([chain.view(user.address as `0x${string}`), chain.system()])
    if (!view.trove) {
      await ctx.reply(`You don't have an open loan, so there's nothing at risk. BTC is ${fmtUsd(sys.price, 0)} right now. Try <i>borrow 1800 at 160%</i> for a quote.`, { parse_mode: "HTML", reply_markup: suggestions("fees") })
      return null
    }
    return { view, sys, t: view.trove }
  }

  const levelWords = (icr: bigint) =>
    icr >= pct(200) ? "very safe" : icr >= pct(150) ? "safe" : icr >= pct(130) ? "getting tight" : icr >= MCR ? "at risk" : "below the liquidation line"

  async function answerSafety(ctx: Context, user: UserRow) {
    const r = await loanOrExplain(ctx, user)
    if (!r) return
    const { view, sys, t } = r
    const g = view.guardian
    const lines = [
      `Your loan is <b>${levelWords(t.icr)}</b>: ratio <b>${fmtIcr(t.icr)}</b> (liquidation happens at ${fmtIcr(MCR)}).`,
      `BTC is ${fmtUsd(sys.price, 0)}; it would have to fall <b>${(t.bufferBps / 100).toFixed(1)}%</b>, to <b>${fmtUsd(t.liqPrice, 0)}</b>, before you could be liquidated.`,
    ]
    if (sys.recoveryMode) lines.push(`🚨 The system is in <b>Recovery Mode</b>: loans under ${fmtIcr(CCR)} can be liquidated, so aim to stay above it.`)
    lines.push(g?.enabled
      ? `🛡 Protection is <b>on</b>: below ${fmtIcr(g.minIcr)} your guardian tops you up to ${fmtIcr(g.targetIcr)} from a ${fmtBtc(g.reserveBTC, 5)} reserve.${g.reserveBTC === 0n && g.reserveMUSD === 0n ? " ⚠️ The reserve is empty, so it can't act yet." : ""}`
      : "🛡 Protection is <b>off</b>. Turning it on lets a keeper top up your loan automatically.")
    if (view.redemption) lines.push(`Redemption queue: ${view.redemption.ahead === 0n ? "<b>you're next</b>" : `${fmtMusd(view.redemption.ahead, 0)} ahead of you`} (rank ${view.redemption.rank + 1} of ${view.redemption.total}).`)
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: suggestions("safety") })
  }

  async function answerLiquidation(ctx: Context, user: UserRow) {
    const r = await loanOrExplain(ctx, user)
    if (!r) return
    const { sys, t } = r
    const lines = [`You'd be liquidated if BTC falls to <b>${fmtUsd(t.liqPrice, 0)}</b>, that's <b>${(t.bufferBps / 100).toFixed(1)}%</b> below today's ${fmtUsd(sys.price, 0)}. At that price your ratio hits ${fmtIcr(MCR)}.`]
    const ccrPrice = liquidationPrice(t.coll, t.debt) * CCR / MCR
    lines.push(sys.recoveryMode
      ? `🚨 Recovery Mode is on right now, so liquidation can already happen below ${fmtIcr(CCR)}, which for you is around <b>${fmtUsd(ccrPrice, 0)}</b>.`
      : `If the whole system ever entered Recovery Mode, the line would move up to ${fmtIcr(CCR)}: about ${fmtUsd(ccrPrice, 0)} for you.`)
    lines.push("Adding collateral or repaying moves that price down.")
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: suggestions("liquidation") })
  }

  async function answerWhatIf(ctx: Context, user: UserRow, slots: Slots) {
    const r = await loanOrExplain(ctx, user)
    if (!r) return
    const { view, sys, t } = r
    let newPrice: bigint
    let label: string
    if (slots.priceTarget !== undefined) {
      newPrice = BigInt(Math.round(slots.priceTarget * 100)) * (E18 / 100n)
      label = `BTC at ${fmtUsd(newPrice, 0)}`
    } else {
      const drop = Math.min(99, Math.max(1, slots.drop ?? 20))
      newPrice = (sys.price * BigInt(Math.round((100 - drop) * 100))) / 10_000n
      label = `BTC −${drop}% (${fmtUsd(newPrice, 0)})`
    }
    const newIcr = computeIcr(t.coll, t.debt, newPrice)
    const lines = [`📉 <b>${label}</b>`, `Your ratio: ${fmtIcr(t.icr)} → <b>${fmtIcr(newIcr)}</b> (${levelWords(newIcr)}).`]
    const g = view.guardian
    let coll = t.coll
    if (g?.enabled && newIcr < g.minIcr) {
      const need = collateralToTarget(t.coll, t.debt, newPrice, g.targetIcr)
      // the keeper's tip is paid from the reserve too, so not all of it can go into the loan
      const usable = (g.reserveBTC * (10_000n - BigInt(g.tipBps))) / 10_000n
      const used = need < usable ? need : usable
      coll = t.coll + used
      const after = computeIcr(coll, t.debt, newPrice)
      lines.push(used === 0n
        ? `🛡 Protection would trigger (below ${fmtIcr(g.minIcr)}), but the reserve is empty, so it couldn't help.`
        : `🛡 Protection would trigger below ${fmtIcr(g.minIcr)} and add about <b>${fmtBtc(used, 5)}</b> from your reserve, bringing you to <b>${fmtIcr(after)}</b>${used < need ? " (the reserve runs out before reaching your target)" : ""}.`)
    } else if (g?.enabled) {
      lines.push(`🛡 Protection would not need to act (it triggers below ${fmtIcr(g.minIcr)}).`)
    } else if (newIcr < pct(150)) {
      lines.push("🛡 Protection is off, so nothing would top you up automatically.")
    }
    const finalIcr = computeIcr(coll, t.debt, newPrice)
    const liquidationLine = sys.recoveryMode ? CCR : MCR
    lines.push(finalIcr < liquidationLine
      ? `⚠️ <b>You could be liquidated</b> at that price (below ${fmtIcr(liquidationLine)}).`
      : `✅ You would not be liquidated. Liquidation price: <b>${fmtUsd(liquidationPrice(coll, t.debt), 0)}</b>.`)
    lines.push("<i>Estimate from today's numbers, assuming nothing else changes.</i>")
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: suggestions("whatif") })
  }

  async function answerProtectInfo(ctx: Context, user: UserRow) {
    const lines = [
      "🛡 <b>How protection works</b>",
      "Your loan is owned by a personal guardian contract. You pick a <b>trigger</b> (say 150%) and a <b>target</b> (say 180%) and fund a small BTC <b>reserve</b>.",
      "If your ratio falls below the trigger, any keeper bot can call the guardian, which adds BTC from your reserve to bring you back to the target. It can't withdraw, borrow or send anything anywhere else, and the keeper's tip is capped at 1% (Keel uses 0.2%).",
    ]
    if (user.address) {
      const g = (await chain.view(user.address as `0x${string}`)).guardian
      lines.push(g ? `\nYours: <b>${g.enabled ? "ON" : "OFF"}</b>, trigger ${fmtIcr(g.minIcr)} → ${fmtIcr(g.targetIcr)}, reserve ${fmtBtc(g.reserveBTC, 5)}.` : "\nYou don't have a guardian yet: turning protection on creates one.")
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: suggestions("protect_info") })
  }

  async function answerFees(ctx: Context) {
    const sys = await chain.system()
    const feePct = Number((sys.borrowingRate * 10_000n) / E18) / 100
    const lines = [
      "💵 <b>What borrowing costs</b> (live from Mezo):",
      `• One-time borrowing fee: <b>${feePct}%</b> of the amount`,
      `• Interest: <b>${(sys.interestRateBps / 100).toFixed(2)}% a year</b>, fixed for your loan`,
      "• 200 MUSD gas reserve held with the loan and returned when you close it",
      `• Minimum loan: ${fmtMusd(sys.minNetDebt, 0)}`,
      "• Network gas is paid in BTC and is tiny on Mezo",
      "• Protection: the keeper tip is 0.2% of what it adds, only when it acts",
      "Keel adds no fee on loans or payments.",
    ]
    if (d.config.premium) lines.push(`• Optional Premium alerts: ${d.config.premium.priceMusd} MUSD for ${d.config.premium.days} days`)
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: suggestions("fees") })
  }

  async function didntGetIt(ctx: Context) {
    await ctx.reply(
      `I didn't get that 🤔 I understand things like:\n${EXAMPLES.map((e) => `• <i>${esc(e)}</i>`).join("\n")}\n\nOr pick one:`,
      { parse_mode: "HTML", reply_markup: suggestions("unknown") },
    )
  }

  // ---- entry point for plain text
  async function handleText(ctx: Context, user: UserRow, text: string) {
    const parsed = parse(text)
    // a pending question? a bare answer ("2000", "@ada", "everything") fills it
    const awaitingId = getAwait(user.tg_id)
    const waiting = awaitingId ? loadPending(awaitingId, user.tg_id) : null
    if (waiting && (!parsed.intent || parsed.confidence < ACCEPT || parsed.intent === waiting.intent)) {
      const s = { ...waiting.slots }
      if (waiting.missing === "amount" && (parsed.slots.amount || parsed.slots.all)) {
        s.amount = parsed.slots.amount
        s.unit = parsed.slots.unit
        s.all = parsed.slots.all
      } else if (waiting.missing === "recipient" && (parsed.slots.usernames.length || parsed.slots.address)) {
        s.usernames = parsed.slots.usernames
        s.address = parsed.slots.address
      } else if (waiting.missing === "names" && parsed.slots.usernames.length) {
        s.usernames = parsed.slots.usernames
      } else if (waiting.missing === "protect" && parsed.slots.percents.length + (parsed.slots.amount ? 1 : 0) > 0) {
        const nums = [...parsed.slots.percents, ...(parsed.slots.amount ? [parseFloat(parsed.slots.amount)] : [])]
        s.percents = nums
      } else if (!parsed.intent) {
        setAwait(user.tg_id, null)
        return didntGetIt(ctx)
      }
      setAwait(user.tg_id, null)
      dropPending(awaitingId!)
      return proceed(ctx, user, waiting.intent, s)
    }
    setAwait(user.tg_id, null)

    if (!parsed.intent) return didntGetIt(ctx)
    if (parsed.confidence < ACCEPT) {
      const options = [parsed.intent, ...parsed.alternatives.filter((x) => x !== parsed.intent)].slice(0, 3)
      const pid = savePending({ tg: user.tg_id, intent: parsed.intent, slots: parsed.slots })
      const k = new InlineKeyboard()
      for (const o of options) k.text(INTENT_LABEL[o], `nl:dym:${pid}:${o}`).row()
      k.text("✖ None of these", `nl:no:${pid}`)
      return void (await ctx.reply("Did you mean…?", { reply_markup: k }))
    }
    await proceed(ctx, user, parsed.intent, parsed.slots)
  }

  // ---- wiring
  bot.on("message:text", handler(async (ctx, user) => {
    let text = ctx.message?.text ?? ""
    if (text.startsWith("/")) return // unknown slash command: leave it to Telegram's command menu
    if (ctx.chat?.type !== "private") {
      // in groups, only when addressed: @mention or a reply to one of the bot's messages
      const mention = new RegExp(`@${d.config.botUsername}\\b`, "i")
      const replyToBot = ctx.message!.reply_to_message?.from?.id === ctx.me.id
      if (!mention.test(text) && !replyToBot) return
      text = text.replace(mention, " ").trim()
    }
    if (text.length > 500) text = text.slice(0, 500)
    await handleText(ctx, user, text)
  }))

  bot.callbackQuery(/^nl:(ok|no|set|dym|go):([^:]+)(?::(.+))?$/, async (ctx) => {
    const user = d.remember(ctx)
    const [, kind, a, b] = ctx.match as RegExpMatchArray
    await ctx.answerCallbackQuery().catch(() => undefined)
    try {
      if (kind === "go") {
        const intent = a as NluIntent
        if (!(intent in INTENT_LABEL)) return
        const slots: Slots = { percents: [], usernames: [], ...(intent === "whatif" && b ? { drop: Number(b) } : {}) }
        return void (await proceed(ctx, user, intent, slots))
      }
      const p = loadPending(a, user.tg_id)
      if (!p) return void (await ctx.reply("That question expired. Just tell me again what you'd like to do."))
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined)
      if (kind === "no") {
        dropPending(a)
        setAwait(user.tg_id, null)
        return void (await ctx.reply("Okay, cancelled. Nothing was created."))
      }
      if (kind === "ok") {
        dropPending(a) // single use: a second tap can't create a second intent
        return void (await run(ctx, user, p.intent, p.slots))
      }
      if (kind === "dym") {
        dropPending(a)
        const intent = b as NluIntent
        if (!(intent in INTENT_LABEL)) return
        return void (await proceed(ctx, user, intent, p.slots))
      }
      if (kind === "set" && b) {
        dropPending(a)
        setAwait(user.tg_id, null)
        const s = { ...p.slots }
        if (b === "claimlink") return void (await proceed(ctx, user, "claim_link", s))
        if (p.missing === "protect") {
          const [x, y] = b.split("-").map(Number)
          return void (await proceed(ctx, user, "protect_on", { ...s, percents: [x, y] }))
        }
        if (b === "all") {
          s.all = true
          s.amount = undefined
        } else if (/^\d+(\.\d+)?$/.test(b)) {
          s.amount = b
          s.unit = undefined
        }
        return void (await proceed(ctx, user, p.intent, s))
      }
    } catch (e) {
      if (e instanceof UserError) return void (await ctx.reply(`⚠️ ${esc(e.message)}`, { parse_mode: "HTML" }))
      console.error("chat callback error", e)
      await ctx.reply("Something went wrong on my side. Please try again in a moment.")
    }
  })
}

import { type Address, type Hex, type PublicClient, type WalletClient } from "viem"
import {
  E18, GAS_BUFFER, collateralToTarget, computeIcr, fmtBtc, fmtIcr, fmtMusd, fmtUsd, hintHelpersAbi, keelGuardianAbi, keelGuardianFactoryAbi, keelPayAbi,
  liquidationPrice, maxPartialRepay, closeCost, musdAbi, parseUnits18, quoteBorrow, readGuardian, readSystem, readTrove, sortedTrovesAbi, findGuardian,
  type Deployment,
} from "@keel/shared"
import type { IntentDto } from "./api"
import { claimKeyFor, saveClaimKey } from "./claimkeys"

export const ZERO: Address = "0x0000000000000000000000000000000000000000"
const NICR_PRECISION = 10n ** 20n

export interface Ctx {
  pub: PublicClient
  deployment: Deployment
  account: Address
}

export interface Step {
  label: string
  run(w: WalletClient, ctx: Ctx): Promise<Hex>
}

export interface Plan {
  title: string
  rows: Array<[string, string]>
  warnings: string[]
  blocked: boolean
  steps: Step[]
  /** Final tx hash (the last step) completes the intent. */
  afterDone?: { claimKey?: Hex }
  /** Extra data computed while planning that the UI shows after success. */
  claimKey?: Hex
}

/** Ask the protocol for sorted-list neighbours of a trove with the given collateral and debt. */
export async function hintsFor(ctx: Ctx, coll: bigint, debt: bigint): Promise<[Address, Address]> {
  if (debt === 0n) return [ZERO, ZERO]
  const m = ctx.deployment.musd
  const nicr = (coll * NICR_PRECISION) / debt
  const size = await ctx.pub.readContract({ address: m.sortedTroves, abi: sortedTrovesAbi, functionName: "getSize" })
  if (size === 0n) return [ZERO, ZERO]
  const trials = BigInt(Math.max(15, Math.ceil(Math.sqrt(Number(size)) * 15)))
  const [hint] = await ctx.pub.readContract({ address: m.hintHelpers, abi: hintHelpersAbi, functionName: "getApproxHint", args: [nicr, trials, 42n] })
  const [upper, lower] = await ctx.pub.readContract({ address: m.sortedTroves, abi: sortedTrovesAbi, functionName: "findInsertPosition", args: [nicr, hint, hint] })
  return [upper, lower]
}

/**
 * Every transaction carries its own gas limit. Mezo's public RPC can estimate cheap calls below the EIP-7623
 * calldata floor it then enforces (seen on testnet for an approve), and protocol calls that search hints
 * on-chain vary between estimate and execution. 30% + 5k covers both; unused gas is not charged.
 */
async function write(w: WalletClient, ctx: Ctx, req: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint }) {
  const call = { ...req, account: ctx.account } as never
  // A node that hasn't seen the previous step yet (approve -> create) simulates a revert and prices it cheaply,
  // which then runs out of gas on-chain. Wait for the call to simulate cleanly before estimating.
  for (let attempt = 0; ; attempt++) {
    try {
      await ctx.pub.simulateContract(call)
      break
    } catch (e) {
      if (attempt >= 5) throw e
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  const est = await ctx.pub.estimateContractGas(call)
  // a lagging node can also return the (cheap) gas of a reverted path without an error: never go below 150k
  const gas = (est * 13n) / 10n + 5_000n
  return w.writeContract({ ...req, account: ctx.account, chain: w.chain, gas: gas > 150_000n ? gas : 150_000n } as never)
}

async function allowanceOk(ctx: Ctx, spender: Address, amount: bigint) {
  const a = await ctx.pub.readContract({ address: ctx.deployment.musd.musd, abi: musdAbi, functionName: "allowance", args: [ctx.account, spender] })
  return a >= amount
}
const approveStep = (spender: Address, amount: bigint): Step => ({
  label: "Approve MUSD",
  run: (w, ctx) => write(w, ctx, { address: ctx.deployment.musd.musd, abi: musdAbi, functionName: "approve", args: [spender, amount] }),
})

const pctText = (n: bigint) => fmtIcr(n)

export async function buildPlan(intent: IntentDto, ctx: Ctx, input: { amount?: string }): Promise<Plan> {
  const keel = ctx.deployment.keel!
  const m = ctx.deployment.musd
  const p = intent.params
  const sys = await readSystem(ctx.pub, m)
  const guardianAddr = await findGuardian(ctx.pub, keel, ctx.account)
  const trove = guardianAddr ? await readTrove(ctx.pub, m, guardianAddr, sys.price) : null
  const amountRaw = input.amount ?? p.amount
  const plan: Plan = { title: "", rows: [], warnings: [], blocked: false, steps: [] }
  const decimalAmount = () => {
    if (!amountRaw) throw new Error("Enter an amount")
    // bot intents store 18-decimal integers; typed input is a decimal string
    return input.amount !== undefined ? parseUnits18(input.amount) : BigInt(amountRaw)
  }
  const balance = await ctx.pub.getBalance({ address: ctx.account })
  const needGuardian = !guardianAddr
  const guardianTarget = guardianAddr ?? (await ctx.pub.readContract({ address: keel.guardianFactory, abi: keelGuardianFactoryAbi, functionName: "predict", args: [ctx.account] }))
  const createGuardian: Step = {
    label: "Create your guardian account",
    run: (w, c) => write(w, c, { address: keel.guardianFactory, abi: keelGuardianFactoryAbi, functionName: "createGuardian" }),
  }

  switch (intent.type) {
    case "borrow": {
      plan.title = "Borrow MUSD"
      const amount = BigInt(p.amount)
      const target = BigInt(p.targetIcr)
      if (trove?.active) {
        plan.blocked = true
        plan.warnings.push("You already have an open loan. Add collateral or repay instead.")
        return plan
      }
      const q = quoteBorrow({ borrowAmount: amount, price: sys.price, borrowingRate: sys.borrowingRate, interestRateBps: sys.interestRateBps, minNetDebt: sys.minNetDebt, targetIcr: target, recoveryMode: sys.recoveryMode })
      plan.rows = [
        ["You receive", fmtMusd(amount, 2)],
        ["BTC locked", `${fmtBtc(q.collateral, 5)} (≈ ${fmtUsd((q.collateral * sys.price) / E18, 0)})`],
        ["One-time fee (0.1%)", fmtMusd(q.fee, 2)],
        ["Gas reserve (refunded on repay)", "200 MUSD"],
        ["Total debt", fmtMusd(q.totalDebt, 2)],
        ["Interest (fixed)", `${(sys.interestRateBps / 100).toFixed(2)}% APR ≈ ${fmtMusd(q.annualInterest, 0)}/yr`],
        ["Collateral ratio", fmtIcr(q.icr)],
        ["Liquidation price", `${fmtUsd(q.liqPrice, 0)} (BTC now ${fmtUsd(sys.price, 0)})`],
      ]
      plan.warnings = [...q.warnings]
      const needBtc = q.collateral + GAS_BUFFER
      if (balance < needBtc) plan.warnings.push(`Not enough BTC: you need about ${fmtBtc(needBtc, 4)} (${fmtBtc(q.collateral, 4)} collateral + ${fmtBtc(GAS_BUFFER, 3)} for fees) but your wallet has ${fmtBtc(balance, 4)}. Get testnet BTC from the Mezo faucet or borrow less.`)
      plan.blocked = q.blocking || balance < needBtc
      if (needGuardian) plan.steps.push(createGuardian)
      plan.steps.push({
        label: "Open loan",
        run: async (w, c) => {
          const [u, l] = await hintsFor(c, q.collateral, q.totalDebt)
          return write(w, c, { address: guardianTarget, abi: keelGuardianAbi, functionName: "openTrove", args: [amount, u, l, c.account], value: q.collateral })
        },
      })
      return plan
    }
    case "add_collateral": {
      plan.title = "Add collateral"
      const amount = decimalAmount()
      if (!trove?.active) return { ...plan, blocked: true, warnings: ["You don't have an open loan yet."] }
      const coll = trove.coll + amount
      plan.rows = [
        ["Adding", fmtBtc(amount, 6)],
        ["Fee", "none"],
        ["Ratio", `${pctText(trove.icr)} → ${pctText(computeIcr(coll, trove.debt, sys.price))}`],
        ["Liquidation price", `${fmtUsd(trove.liqPrice, 0)} → ${fmtUsd(liquidationPrice(coll, trove.debt), 0)}`],
        ["Interest", `unchanged (${(trove.interestRateBps / 100).toFixed(2)}% APR)`],
      ]
      if (balance < amount + GAS_BUFFER) plan.warnings.push(`Not enough BTC: you need about ${fmtBtc(amount + GAS_BUFFER, 4)} (including ~${fmtBtc(GAS_BUFFER, 3)} for fees) but your wallet has ${fmtBtc(balance, 4)}.`)
      plan.blocked = balance < amount + GAS_BUFFER
      plan.steps.push({
        label: "Add collateral",
        run: async (w, c) => {
          const [u, l] = await hintsFor(c, coll, trove.debt)
          return write(w, c, { address: guardianTarget, abi: keelGuardianAbi, functionName: "addCollateral", args: [u, l], value: amount })
        },
      })
      return plan
    }
    case "repay": {
      plan.title = "Repay"
      const amount = decimalAmount()
      if (!trove?.active) return { ...plan, blocked: true, warnings: ["You don't have an open loan."] }
      // Mezo keeps at least the minimum net debt on an open loan; anything beyond that means closing it
      const maxRepay = maxPartialRepay(trove.debt, sys.minNetDebt)
      if (amount > maxRepay) plan.warnings.push(maxRepay === 0n ? `Your loan is at the ${fmtMusd(sys.minNetDebt, 0)} minimum, so it can't be partly repaid. Close the loan to pay it off.` : `You can repay up to ${fmtMusd(maxRepay, 2)} and keep the loan open (Mezo's minimum is ${fmtMusd(sys.minNetDebt, 0)}). To pay off everything, close the loan.`)
      const debt = trove.debt - amount
      plan.rows = [
        ["Repaying", fmtMusd(amount, 2)],
        ["Fee", "none"],
        ["Debt", `${fmtMusd(trove.debt, 2)} → ${fmtMusd(debt, 2)}`],
        ["Ratio", `${pctText(trove.icr)} → ${pctText(computeIcr(trove.coll, debt, sys.price))}`],
        ["Liquidation price", `${fmtUsd(trove.liqPrice, 0)} → ${fmtUsd(liquidationPrice(trove.coll, debt), 0)}`],
      ]
      const bal = await ctx.pub.readContract({ address: m.musd, abi: musdAbi, functionName: "balanceOf", args: [ctx.account] })
      if (bal < amount) plan.warnings.push(`Your wallet has ${fmtMusd(bal, 2)}.`)
      plan.blocked = amount > maxRepay || bal < amount
      if (!(await allowanceOk(ctx, guardianTarget, amount))) plan.steps.push(approveStep(guardianTarget, amount))
      plan.steps.push({
        label: "Repay",
        run: async (w, c) => {
          const [u, l] = await hintsFor(c, trove.coll, debt)
          return write(w, c, { address: guardianTarget, abi: keelGuardianAbi, functionName: "repay", args: [amount, u, l] })
        },
      })
      return plan
    }
    case "close": {
      plan.title = "Close loan"
      if (!trove?.active) return { ...plan, blocked: true, warnings: ["You don't have an open loan."] }
      const g = await readGuardian(ctx.pub, guardianTarget)
      const need = closeCost(trove.debt)
      // the guardian spends its own MUSD reserve first and pulls only the shortfall from you
      const pull = need > g.reserveMUSD ? need - g.reserveMUSD : 0n
      const bal = await ctx.pub.readContract({ address: m.musd, abi: musdAbi, functionName: "balanceOf", args: [ctx.account] })
      plan.rows = [
        ["You pay", fmtMusd(pull, 2)],
        ["Debt cleared", fmtMusd(trove.debt, 2) + " (incl. 200 MUSD gas reserve, settled by the protocol)"],
        ["You get back", `${fmtBtc(trove.coll, 5)} collateral${g.reserveBTC > 0n ? ` + ${fmtBtc(g.reserveBTC, 5)} reserve` : ""}`],
        ["Fee", "none"],
      ]
      if (bal < pull) plan.warnings.push(`You need ${fmtMusd(pull, 2)} but your wallet has ${fmtMusd(bal, 2)}. Interest and the 0.1% fee mean you owe a little more than you borrowed: get ${fmtMusd(pull - bal, 2)} more first.`)
      plan.blocked = bal < pull
      if (pull > 0n && !(await allowanceOk(ctx, guardianTarget, pull))) plan.steps.push(approveStep(guardianTarget, pull))
      plan.steps.push({ label: "Close loan", run: (w, c) => write(w, c, { address: guardianTarget, abi: keelGuardianAbi, functionName: "closeTrove" }) })
      return plan
    }
    case "fund_reserve": {
      plan.title = "Fund guardian reserve"
      const amount = decimalAmount()
      plan.rows = [
        ["Adding to reserve", fmtBtc(amount, 6)],
        ["Fee", "none"],
        ["Who can spend it", "Only your guardian, only to protect your loan"],
        ["Withdraw", "You can take it back any time"],
      ]
      if (balance < amount + GAS_BUFFER) plan.warnings.push(`Not enough BTC: you need about ${fmtBtc(amount + GAS_BUFFER, 4)} (including ~${fmtBtc(GAS_BUFFER, 3)} for fees) but your wallet has ${fmtBtc(balance, 4)}.`)
      plan.blocked = balance < amount + GAS_BUFFER
      if (needGuardian) plan.steps.push(createGuardian)
      plan.steps.push({ label: "Fund reserve", run: (w, c) => write(w, c, { address: guardianTarget, abi: keelGuardianAbi, functionName: "fundReserve", value: amount }) })
      return plan
    }
    case "protect_config": {
      plan.title = String(p.enabled) === "false" ? "Turn protection off" : "Turn protection on"
      const enabled = !(String(p.enabled) === "false")
      const minIcr = BigInt(p.minIcr)
      const targetIcr = BigInt(p.targetIcr)
      const tipBps = Number(p.tipBps)
      const cooldown = Number(p.cooldown)
      const g = guardianAddr ? await readGuardian(ctx.pub, guardianAddr) : null
      plan.rows = [
        ["Acts when ratio falls below", fmtIcr(minIcr)],
        ["Restores ratio to", fmtIcr(targetIcr)],
        ["Keeper tip", `${(tipBps / 100).toFixed(2)}% of the amount applied`],
        ["Reserve", g ? `${fmtBtc(g.reserveBTC, 5)}${g.reserveMUSD > 0n ? " + " + fmtMusd(g.reserveMUSD, 0) : ""}` : "empty — fund it after this"],
        ["Fee", "none"],
      ]
      if (trove?.active) plan.rows.push(["Your ratio now", pctText(trove.icr)])
      if (enabled && (!g || (g.reserveBTC === 0n && g.reserveMUSD === 0n))) plan.warnings.push("Reserve is empty: protection needs BTC in the reserve to act. Fund it next (about 0.005 BTC).")
      if (enabled && trove?.active) {
        const topUp = collateralToTarget(trove.coll, trove.debt, sys.price, targetIcr)
        if (trove.icr < minIcr) plan.warnings.push(`Your ratio (${pctText(trove.icr)}) is already below ${pctText(minIcr)}: the keeper will act right after you sign, using about ${fmtBtc(topUp, 4)} from the reserve${g && g.reserveBTC < topUp ? ` (the reserve has only ${fmtBtc(g.reserveBTC, 4)}, so it will restore you only partway; fund more)` : ""}.`)
      }
      if (needGuardian) plan.steps.push(createGuardian)
      plan.steps.push({
        label: "Save protection settings",
        run: (w, c) => write(w, c, { address: guardianTarget, abi: keelGuardianAbi, functionName: "configure", args: [enabled, tipBps, cooldown, minIcr, targetIcr] }),
      })
      return plan
    }
    case "send":
    case "pay_split":
    case "pay_request": {
      plan.title = intent.type === "send" ? `Send MUSD${p.label ? " to " + p.label : ""}` : intent.type === "pay_split" ? `Pay your share${p.memo ? " · " + p.memo : ""}` : "Pay request"
      const amount = intent.type === "pay_request" ? parseUnits18(p.amount) : BigInt(p.amount)
      const to = p.to as Address
      const bal = await ctx.pub.readContract({ address: m.musd, abi: musdAbi, functionName: "balanceOf", args: [ctx.account] })
      plan.rows = [
        ["Amount", fmtMusd(amount, 2)],
        ...(intent.type === "pay_split" ? ([["Requested by", p.label ?? "the requester"]] as Array<[string, string]>) : []),
        ["To", `${to.slice(0, 8)}…${to.slice(-6)}`],
        ["Fee", "none (gas in BTC only)"],
        ...(p.memo ? ([[intent.type === "pay_split" ? "For" : "Note", p.memo]] as Array<[string, string]>) : []),
      ]
      if (bal < amount) plan.warnings.push(`Your wallet has ${fmtMusd(bal, 2)}.`)
      plan.blocked = bal < amount
      plan.steps.push({ label: "Send", run: (w, c) => write(w, c, { address: m.musd, abi: musdAbi, functionName: "transfer", args: [to, amount] }) })
      return plan
    }
    case "create_claim": {
      plan.title = "Create claim link"
      const amount = BigInt(p.amount)
      const hours = Number(p.expiryHours ?? 72)
      const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts")
      // one key per intent, saved before signing: a webview reload mid-signing must reuse it, not make a new link
      const key = claimKeyFor(intent.id) ?? generatePrivateKey()
      const link = privateKeyToAccount(key).address
      saveClaimKey(intent.id, key, link)
      const expiry = BigInt(Math.floor(Date.now() / 1000) + hours * 3600)
      const bal = await ctx.pub.readContract({ address: m.musd, abi: musdAbi, functionName: "balanceOf", args: [ctx.account] })
      plan.rows = [
        ["Escrowed", fmtMusd(amount, 2)],
        ["For", p.forName ?? "anyone with the link"],
        ["Fee", "none"],
        ["Expires", `${hours}h — then it refunds to you; you can cancel any time`],
      ]
      if (bal < amount) plan.warnings.push(`Your wallet has ${fmtMusd(bal, 2)}.`)
      plan.blocked = bal < amount
      plan.claimKey = key
      if (!(await allowanceOk(ctx, keel.pay, amount))) plan.steps.push(approveStep(keel.pay, amount))
      plan.steps.push({ label: "Escrow funds", run: (w, c) => write(w, c, { address: keel.pay, abi: keelPayAbi, functionName: "create", args: [link, amount, expiry] }) })
      return plan
    }
    case "cancel_claim": {
      plan.title = "Cancel claim link"
      const link = p.link as Address
      plan.rows = [
        ["Refund to you", fmtMusd(BigInt(p.amount ?? "0"), 2)],
        ["Link", `${link.slice(0, 8)}…${link.slice(-6)}`],
        ["Fee", "none (gas in BTC only)"],
      ]
      plan.steps.push({ label: "Cancel & refund", run: (w, c) => write(w, c, { address: keel.pay, abi: keelPayAbi, functionName: "cancel", args: [link] }) })
      return plan
    }
    default:
      return { ...plan, title: "Unsupported action", blocked: true, warnings: [`"${intent.type}" is not supported in the Mini App yet.`] }
  }
}

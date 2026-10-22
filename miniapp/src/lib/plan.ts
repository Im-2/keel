import { type Address, type Hex, type PublicClient, type WalletClient } from "viem"
import {
  E18, computeIcr, fmtBtc, fmtIcr, fmtMusd, fmtUsd, hintHelpersAbi, keelGuardianAbi, keelGuardianFactoryAbi, keelPayAbi,
  liquidationPrice, musdAbi, parseUnits18, quoteBorrow, readGuardian, readSystem, readTrove, sortedTrovesAbi, findGuardian,
  type Deployment,
} from "@keel/shared"
import type { IntentDto } from "./api"

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

const write = (w: WalletClient, ctx: Ctx, req: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint }) =>
  w.writeContract({ ...req, account: ctx.account, chain: w.chain } as never)

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
      if (balance < q.collateral) plan.warnings.push(`Your wallet has ${fmtBtc(balance, 5)}, less than the ${fmtBtc(q.collateral, 5)} needed.`)
      plan.blocked = q.warnings.some((w) => /Minimum|below the 110/.test(w)) || balance < q.collateral
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
      if (balance < amount) plan.warnings.push("Not enough BTC in your wallet.")
      plan.blocked = balance < amount
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
      const maxRepay = trove.debt > 200n * E18 ? trove.debt - 200n * E18 : 0n
      if (amount > maxRepay) plan.warnings.push(`You can repay up to ${fmtMusd(maxRepay, 2)} (the 200 MUSD gas reserve stays until you close the loan).`)
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
    case "fund_reserve": {
      plan.title = "Fund guardian reserve"
      const amount = decimalAmount()
      plan.rows = [
        ["Adding to reserve", fmtBtc(amount, 6)],
        ["Fee", "none"],
        ["Who can spend it", "Only your guardian, only to protect your loan"],
        ["Withdraw", "You can take it back any time"],
      ]
      if (balance < amount) plan.warnings.push("Not enough BTC in your wallet.")
      plan.blocked = balance < amount
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
      if (enabled && (!g || (g.reserveBTC === 0n && g.reserveMUSD === 0n))) plan.warnings.push("Reserve is empty: protection needs BTC in the reserve to act. Fund it next.")
      if (needGuardian) plan.steps.push(createGuardian)
      plan.steps.push({
        label: "Save protection settings",
        run: (w, c) => write(w, c, { address: guardianTarget, abi: keelGuardianAbi, functionName: "configure", args: [enabled, tipBps, cooldown, minIcr, targetIcr] }),
      })
      return plan
    }
    case "send":
    case "pay_request": {
      plan.title = intent.type === "send" ? `Send MUSD${p.label ? " to " + p.label : ""}` : "Pay request"
      const amount = intent.type === "send" ? BigInt(p.amount) : parseUnits18(p.amount)
      const to = p.to as Address
      const bal = await ctx.pub.readContract({ address: m.musd, abi: musdAbi, functionName: "balanceOf", args: [ctx.account] })
      plan.rows = [
        ["Amount", fmtMusd(amount, 2)],
        ["To", `${to.slice(0, 8)}…${to.slice(-6)}`],
        ["Fee", "none (gas in BTC only)"],
        ...(p.memo ? ([["Note", p.memo]] as Array<[string, string]>) : []),
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
      const key = generatePrivateKey()
      const link = privateKeyToAccount(key).address
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
    default:
      return { ...plan, title: "Unsupported action", blocked: true, warnings: [`"${intent.type}" is not supported in the Mini App yet.`] }
  }
}

// End-to-end smoke test of the readers against `pnpm dev:chain`.
import { getDeployment, makeClient, readSystem, readTrove, scanTroves, findGuardian, readGuardian, redemptionAhead, fmtUsd, fmtMusd, fmtBtc, fmtIcr } from "../src/index"

const dep = getDeployment("local")
const client = makeClient("local")
const demo = "0x1b1E98f4912aE9014064a70537025EF338e6aD67" as const

const sys = await readSystem(client, dep.musd)
console.log("system:", { price: fmtUsd(sys.price), tcr: fmtIcr(sys.tcr), recovery: sys.recoveryMode, minNet: fmtMusd(sys.minNetDebt), rate: sys.borrowingRate, interestBps: sys.interestRateBps })

const guardian = await findGuardian(client, dep.keel!, demo)
console.log("guardian:", guardian)
const trove = await readTrove(client, dep.musd, guardian!, sys.price)
console.log("trove:", { coll: fmtBtc(trove.coll), debt: fmtMusd(trove.debt), icr: fmtIcr(trove.icr), liq: fmtUsd(trove.liqPrice), buffer: trove.bufferBps / 100 + "%", risk: trove.risk })
const g = await readGuardian(client, guardian!)
console.log("guardian cfg:", { enabled: g.enabled, tip: g.tipBps, min: fmtIcr(g.minIcr), target: fmtIcr(g.targetIcr), reserve: fmtBtc(g.reserveBTC), canProtect: g.canProtect })

const troves = await scanTroves(client, dep.musd, sys.price)
console.log("troves:", troves.length)
const r = redemptionAhead(troves, guardian!)!
console.log("redemption ahead of demo guardian:", { ahead: fmtMusd(r.ahead), rank: r.rank, of: r.total })
if (troves.length < 9 || trove.icr < 17n * 10n ** 17n) process.exit(1)
console.log("OK")

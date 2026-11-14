import { expect } from "chai"
import { ethers } from "hardhat"
import { fastForwardTime, getOpenTroveTotalDebt, openTrove, setupTests, User } from "../helpers"
import { to1e18 } from "../utils"
import { Contracts } from "../helpers/interfaces"
import { ZERO_ADDRESS } from "../../helpers/constants"

/**
 * Guardian v2 against the real MUSD protocol: partial rescues instead of reverts, an explicit "insufficient reserve"
 * result with the exact BTC shortfall, Recovery Mode, dust, repeated calls, and the capped protocol share of the tip.
 */
describe("Keel: GuardianFactoryV2 + GuardianV2 (partial rescue, protocol share)", () => {
  let contracts: Contracts
  let alice: User
  let bob: User
  let carol: User
  let dennis: User
  let deployer: User
  let factory: any
  const TREASURY = "0x000000000000000000000000000000000000dEaD"
  const FULL = 0n
  const PARTIAL = 1n
  const INSUFFICIENT = 2n

  async function protocolStruct() {
    return {
      borrowerOperations: await contracts.borrowerOperations.getAddress(),
      troveManager: await contracts.troveManager.getAddress(),
      priceFeed: await contracts.priceFeed.getAddress(),
      hintHelpers: await contracts.hintHelpers.getAddress(),
      sortedTroves: await contracts.sortedTroves.getAddress(),
      musd: await contracts.musd.getAddress(),
    }
  }

  async function guardianFor(user: User): Promise<any> {
    await factory.connect(user.wallet).createGuardian()
    return ethers.getContractAt("KeelGuardianV2", await factory.guardianOf(user.address), user.wallet)
  }

  async function openGuardianTrove(g: any, owner: User, musdAmount: string, icr: number) {
    const price = await contracts.priceFeed.fetchPrice()
    const amount = to1e18(musdAmount)
    const totalDebt = await getOpenTroveTotalDebt(contracts, amount)
    const coll = (BigInt(Math.round(icr * 1e6)) * 10n ** 12n * totalDebt) / price
    await g.connect(owner.wallet).openTrove(amount, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, { value: coll })
    return { coll, totalDebt }
  }

  async function setIcr(addr: string, targetICR: bigint) {
    const price = await contracts.priceFeed.fetchPrice()
    const icr = await contracts.troveManager.getCurrentICR(addr, price)
    await contracts.mockAggregator.connect(deployer.wallet).setPrice((targetICR * price) / icr)
  }

  async function icrOf(addr: string) {
    return contracts.troveManager.getCurrentICR(addr, await contracts.priceFeed.fetchPrice())
  }

  const bal = (a: string) => ethers.provider.getBalance(a)

  /** Call protect() and return its Result plus the receipt (the static call sees the same state). */
  async function protect(g: any, keeper: User) {
    const result = await g.connect(keeper.wallet).protect.staticCall(ZERO_ADDRESS, ZERO_ADDRESS)
    const tx = await g.connect(keeper.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)
    const rc = await tx.wait()
    return { result: result as bigint, tx, rc, gas: rc!.gasUsed * rc!.gasPrice }
  }

  function eventArgs(rc: any, g: any, name: string) {
    for (const log of rc.logs) {
      try {
        const parsed = g.interface.parseLog(log)
        if (parsed?.name === name) return parsed.args
      } catch {
        /* not this contract */
      }
    }
    return null
  }

  beforeEach(async () => {
    const t = await setupTests()
    contracts = t.contracts
    alice = t.alice
    bob = t.bob
    carol = t.carol
    dennis = t.dennis
    deployer = t.deployer
    await openTrove(contracts, { musdAmount: "10,000", ICR: "300", sender: carol.wallet })
    await openTrove(contracts, { musdAmount: "20,000", ICR: "250", sender: bob.wallet })
    const F = await ethers.getContractFactory("KeelGuardianFactoryV2")
    factory = await F.connect(deployer.wallet).deploy(await protocolStruct(), TREASURY, 2_000) // 20% of the tip
    await factory.waitForDeployment()
  })

  describe("factory v2", () => {
    it("clones a V2 implementation deterministically, once per owner", async () => {
      const predicted = await factory.predict(alice.address)
      const g = await guardianFor(alice)
      expect(await g.getAddress()).to.equal(predicted)
      expect(await g.VERSION()).to.equal(2n)
      expect(await g.factory()).to.equal(await factory.getAddress())
      await expect(factory.connect(alice.wallet).createGuardian()).to.be.revertedWithCustomError(factory, "AlreadyHasGuardian")
      await expect(g.initialize(bob.address, await protocolStruct())).to.be.reverted
    })

    it("hard-caps the protocol share at 50% of the tip and only the admin can change it", async () => {
      expect(await factory.feeInfo()).to.deep.equal([TREASURY, 2_000n])
      await expect(factory.connect(deployer.wallet).setFeeConfig(TREASURY, 5_001)).to.be.revertedWithCustomError(factory, "FeeTooHigh")
      await expect(factory.connect(alice.wallet).setFeeConfig(alice.address, 100)).to.be.revertedWithCustomError(factory, "NotAdmin")
      const F = await ethers.getContractFactory("KeelGuardianFactoryV2")
      await expect(F.deploy(await protocolStruct(), TREASURY, 6_000)).to.be.revertedWithCustomError(factory, "FeeTooHigh")
      await factory.connect(deployer.wallet).setFeeConfig(TREASURY, 5_000)
      expect((await factory.feeInfo())[1]).to.equal(5_000n)
    })

    it("transfers admin in two steps", async () => {
      await factory.connect(deployer.wallet).transferAdmin(alice.address)
      await expect(factory.connect(bob.wallet).acceptAdmin()).to.be.revertedWithCustomError(factory, "NotAdmin")
      await factory.connect(alice.wallet).acceptAdmin()
      expect(await factory.admin()).to.equal(alice.address)
      await expect(factory.connect(deployer.wallet).setFeeConfig(TREASURY, 1)).to.be.revertedWithCustomError(factory, "NotAdmin")
    })
  })

  describe("full rescue", () => {
    it("restores the target, pays the keeper its tip minus the treasury's 20% share", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      const { coll } = await openGuardianTrove(g, alice, "10,000", 1.6)
      await g.fundReserve({ value: (coll * 30n) / 100n })
      await setIcr(addr, to1e18("1.25"))

      const [eligible, plan] = await g.previewProtect()
      expect(eligible).to.equal(true)
      expect(plan.result).to.equal(FULL)
      expect(plan.btcShortfallToTarget).to.equal(0n)

      const k0 = await bal(dennis.address)
      const t0 = await bal(TREASURY)
      const { result, rc, gas } = await protect(g, dennis)
      expect(result).to.equal(FULL)
      const icr = await icrOf(addr)
      expect(icr).to.be.gt(to1e18("1.4985"))
      expect(icr).to.be.lt(to1e18("1.5015"))
      expect(eventArgs(rc, g, "Protected")).to.not.equal(null)
      expect(eventArgs(rc, g, "PartialRescue")).to.equal(null)

      // interest accrues by the second, so use what was actually applied
      const totalTip = (eventArgs(rc, g, "Protected").btcAdded * 20n) / 10_000n
      const fee = (totalTip * 2_000n) / 10_000n
      expect((await bal(TREASURY)) - t0).to.equal(fee)
      expect((await bal(dennis.address)) + gas - k0).to.equal(totalTip - fee)
      const feeEv = eventArgs(rc, g, "ProtocolFeePaid")
      expect(feeEv.btc).to.equal(fee)
    })

    it("pays no protocol share when the treasury is unset", async () => {
      await factory.connect(deployer.wallet).setFeeConfig(ZERO_ADDRESS, 5_000)
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      const { coll } = await openGuardianTrove(g, alice, "10,000", 1.6)
      await g.fundReserve({ value: coll })
      await setIcr(addr, to1e18("1.25"))
      const { rc } = await protect(g, dennis)
      expect(eventArgs(rc, g, "ProtocolFeePaid")).to.equal(null)
      const p = eventArgs(rc, g, "Protected")
      expect(p.tipBTC).to.equal((p.btcAdded * 20n) / 10_000n)
    })
  })

  describe("partial rescue", () => {
    it("applies the whole reserve, emits PartialRescue with the exact shortfall, and the shortfall really completes it", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      const { coll } = await openGuardianTrove(g, alice, "10,000", 1.6)
      const reserve = coll / 50n
      await g.fundReserve({ value: reserve })
      await g.configure(true, 20, 600, to1e18("1.3"), to1e18("1.5"))
      await setIcr(addr, to1e18("1.2"))
      const before = await icrOf(addr)

      const { result, rc } = await protect(g, dennis)
      expect(result).to.equal(PARTIAL)
      const ev = eventArgs(rc, g, "PartialRescue")
      expect(ev.icrAfter).to.be.gt(before)
      expect(ev.icrAfter).to.be.lt(to1e18("1.5"))
      expect(ev.btcShortfall).to.be.gt(0n)
      // the reserve is used up (top-up + tip) but never overspent
      expect(await bal(addr)).to.be.lt(reserve / 500n + 10n)

      // owner adds the reported shortfall (+0.1% for the 10 minutes of interest the cooldown adds); the next call
      // reaches the target
      await fastForwardTime(601)
      await g.fundReserve({ value: (ev.btcShortfall * 1001n) / 1000n })
      const [, plan] = await g.previewProtect()
      expect(plan.result).to.equal(FULL)
      const second = await protect(g, dennis)
      expect(second.result).to.equal(FULL)
      expect(await icrOf(addr)).to.be.gt(to1e18("1.497"))
    })

    it("combines BTC and MUSD in one adjustment when BTC alone would leave the loan under 110%", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      const { coll } = await openGuardianTrove(g, alice, "10,000", 1.6)
      await setIcr(addr, to1e18("1.05")) // liquidatable, Normal Mode
      expect(await contracts.troveManager.checkRecoveryMode(await contracts.priceFeed.fetchPrice())).to.equal(false)
      // BTC reserve worth ~2% of the collateral (not enough alone), plus 1,500 MUSD to repay
      await g.fundReserve({ value: coll / 50n })
      await contracts.musd.connect(alice.wallet).transfer(addr, to1e18("1,500"))
      const [, plan] = await g.previewProtect()
      expect(plan.btcToAdd).to.be.gt(0n)
      expect(plan.musdToRepay).to.be.gt(0n)
      expect(plan.icrAfter).to.be.gte(to1e18("1.1"))
      const { result, rc } = await protect(g, dennis)
      expect([FULL, PARTIAL]).to.include(result)
      expect(eventArgs(rc, g, "Protected").action).to.equal(3n) // Both
      expect(await icrOf(addr)).to.be.gte(to1e18("1.1"))
    })
  })

  describe("impossible rescue (Normal Mode, below 110%)", () => {
    it("moves nothing, pays no tip, keeps the cooldown free, and reports the BTC needed to clear 110%", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      const { coll } = await openGuardianTrove(g, alice, "10,000", 1.6)
      await g.fundReserve({ value: coll / 200n }) // ~0.5%: can't lift 105% to 110%
      await setIcr(addr, to1e18("1.05"))
      const icr0 = await icrOf(addr)
      const g0 = await bal(addr)
      const k0 = await bal(dennis.address)

      // the protocol rule V1 tripped over: in Normal Mode MUSD rejects a top-up that leaves ICR < 110%
      await expect(g.connect(alice.wallet).addCollateral(ZERO_ADDRESS, ZERO_ADDRESS, { value: coll / 200n })).to.be.revertedWith(
        "BorrowerOps: An operation that would result in ICR < MCR is not permitted",
      )
      const { result, rc, gas } = await protect(g, dennis)
      expect(result).to.equal(INSUFFICIENT)
      const ev = eventArgs(rc, g, "InsufficientReserve")
      expect(ev.recoveryMode).to.equal(false)
      expect(ev.btcShortfallToMCR).to.be.gt(0n)
      expect(ev.btcShortfallToTarget).to.be.gt(ev.btcShortfallToMCR)
      expect(eventArgs(rc, g, "Protected")).to.equal(null)
      expect(await bal(addr)).to.equal(g0) // nothing moved
      expect(await bal(dennis.address)).to.equal(k0 - gas) // no tip
      expect(await g.lastProtectedAt()).to.equal(0n) // cooldown untouched
      expect(await icrOf(addr)).to.be.closeTo(icr0, icr0 / 10_000n)
      expect((await g.protectionStatus()).canProtect).to.equal(false)

      // adding the reported shortfall (+0.1% for interest accrued since) makes a rescue possible right away
      await g.fundReserve({ value: (ev.btcShortfallToMCR * 1001n) / 1000n })
      const after = await protect(g, dennis)
      expect([FULL, PARTIAL]).to.include(after.result)
      expect(await icrOf(addr)).to.be.gte(to1e18("1.1"))
    })

    it("respects MUSD's minimum net debt: a minimum-size loan can only be repaid down to the minimum", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      await openGuardianTrove(g, alice, "1,800", 1.6) // net debt 1,801.8 (borrowing fee included)
      await contracts.musd.connect(bob.wallet).transfer(addr, to1e18("1,000"))
      await setIcr(addr, to1e18("1.2"))
      const [, plan] = await g.previewProtect()
      expect(plan.musdToRepay).to.be.gt(0n)
      expect(plan.musdToRepay).to.be.lt(to1e18("1.81")) // only the room above 1,800, not the 1,000 available
      expect(plan.result).to.equal(PARTIAL)
      const { result } = await protect(g, dennis)
      expect(result).to.equal(PARTIAL)
      const [, principal, interest, , pp, pi] = await contracts.troveManager.getEntireDebtAndColl(addr)
      const netDebt = principal + interest + pp + pi - to1e18("200")
      expect(netDebt).to.be.gte(await contracts.borrowerOperations.minNetDebt())
      // a second call (after the cooldown) has no room left: nothing to do, no revert, the MUSD stays
      await fastForwardTime(301)
      await setIcr(addr, to1e18("1.2"))
      const before = await contracts.musd.balanceOf(addr)
      expect((await protect(g, dennis)).result).to.equal(INSUFFICIENT)
      expect(await contracts.musd.balanceOf(addr)).to.equal(before)
    })
  })

  describe("Recovery Mode", () => {
    it("allows a partial top-up even if the loan stays under 110% (MUSD permits pure top-ups there)", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      // a big guardian loan so a price drop pushes the whole system under 150%
      const { coll } = await openGuardianTrove(g, alice, "20,000", 1.6)
      await setIcr(addr, to1e18("1.05"))
      const price = await contracts.priceFeed.fetchPrice()
      expect(await contracts.troveManager.checkRecoveryMode(price)).to.equal(true)
      await g.fundReserve({ value: coll / 200n })
      const before = await icrOf(addr)
      const { result, rc } = await protect(g, dennis)
      expect(result).to.equal(PARTIAL)
      const ev = eventArgs(rc, g, "PartialRescue")
      expect(ev.icrAfter).to.be.gt(before)
      expect(ev.icrAfter).to.be.lt(to1e18("1.1"))
    })
  })

  describe("dust, repeated calls and tip limits", () => {
    it("treats a dust reserve as nothing to do (no revert, no tip)", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      await openGuardianTrove(g, alice, "10,000", 1.6)
      await g.fundReserve({ value: 1_000_000n }) // 1e-12 BTC
      await setIcr(addr, to1e18("1.25"))
      const { result } = await protect(g, dennis)
      expect(result).to.equal(INSUFFICIENT)
      expect(await bal(addr)).to.equal(1_000_000n)
    })

    it("an insufficient result can repeat (no cooldown), a rescue can't (cooldown applies)", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      const { coll } = await openGuardianTrove(g, alice, "10,000", 1.6)
      await g.configure(true, 20, 600, to1e18("1.3"), to1e18("1.5"))
      await setIcr(addr, to1e18("1.25"))
      expect((await protect(g, dennis)).result).to.equal(INSUFFICIENT)
      expect((await protect(g, dennis)).result).to.equal(INSUFFICIENT)
      await g.fundReserve({ value: coll / 100n })
      expect((await protect(g, dennis)).result).to.equal(PARTIAL)
      await expect(g.connect(dennis.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithCustomError(g, "CooldownActive")
      await fastForwardTime(601)
      await g.fundReserve({ value: coll })
      expect((await protect(g, dennis)).result).to.equal(FULL)
      await expect(g.connect(dennis.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithCustomError(g, "HealthyEnough")
    })

    it("at the maximum (1% tip, 50% share) the owner pays exactly 1% of what was applied", async () => {
      await factory.connect(deployer.wallet).setFeeConfig(TREASURY, 5_000)
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      const { coll } = await openGuardianTrove(g, alice, "10,000", 1.6)
      await g.configure(true, 100, 0, to1e18("1.3"), to1e18("1.5"))
      await expect(g.configure(true, 101, 0, to1e18("1.3"), to1e18("1.5"))).to.be.revertedWithCustomError(g, "InvalidConfig")
      const reserve = coll
      await g.fundReserve({ value: reserve })
      await setIcr(addr, to1e18("1.2"))
      const t0 = await bal(TREASURY)
      const { rc } = await protect(g, dennis)
      const p = eventArgs(rc, g, "Protected")
      const fee = (await bal(TREASURY)) - t0
      expect(p.tipBTC + fee).to.equal(p.btcAdded / 100n)
      expect(fee).to.equal(p.btcAdded / 100n / 2n)
      // and the reserve paid exactly top-up + 1%
      expect(reserve - (await bal(addr))).to.equal(p.btcAdded + p.btcAdded / 100n)
    })

    it("a keeper contract can't re-enter protect() through its tip", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      const { coll } = await openGuardianTrove(g, alice, "10,000", 1.6)
      await g.fundReserve({ value: coll })
      await g.configure(true, 20, 0, to1e18("1.3"), to1e18("1.5"))
      await setIcr(addr, to1e18("1.25"))
      const K = await ethers.getContractFactory("KeelReentrantKeeper")
      const k = await K.deploy()
      await expect(k.run(addr)).to.be.revertedWithCustomError(g, "TransferFailed")
      // a normal keeper still works afterwards
      expect((await protect(g, dennis)).result).to.equal(FULL)
    })

    it("only the owner controls funds and settings", async () => {
      const g = await guardianFor(alice)
      await g.fundReserve({ value: to1e18("1") })
      const asBob = g.connect(bob.wallet)
      await expect(asBob.withdrawReserveBTC(1, bob.address)).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.withdrawReserveMUSD(1, bob.address)).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.configure(true, 10, 0, to1e18("1.3"), to1e18("1.5"))).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.sweepToken(await contracts.musd.getAddress(), bob.address)).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.closeTrove()).to.be.revertedWithCustomError(g, "NotOwner")
    })

    it("still reverts when not eligible: disabled, no trove, healthy", async () => {
      const g = await guardianFor(alice)
      await expect(g.connect(dennis.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithCustomError(g, "NoTrove")
      await openGuardianTrove(g, alice, "10,000", 1.6)
      await expect(g.connect(dennis.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithCustomError(g, "HealthyEnough")
      await g.configure(false, 20, 0, to1e18("1.3"), to1e18("1.5"))
      await expect(g.connect(dennis.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithCustomError(g, "NotEnabled")
    })
  })

  describe("KeelPro subscriptions", () => {
    it("takes MUSD straight to the treasury, stacks time, and caps the price", async () => {
      const P = await ethers.getContractFactory("KeelPro")
      const pro: any = await P.connect(deployer.wallet).deploy(await contracts.musd.getAddress(), TREASURY, to1e18("5"))
      await expect(P.deploy(await contracts.musd.getAddress(), TREASURY, to1e18("101"))).to.be.revertedWithCustomError(pro, "PriceTooHigh")
      const proAddr = await pro.getAddress()
      await contracts.musd.connect(bob.wallet).approve(proAddr, to1e18("100"))
      const t0 = await contracts.musd.balanceOf(TREASURY)
      await pro.connect(bob.wallet).subscribe(alice.address, 2)
      expect((await contracts.musd.balanceOf(TREASURY)) - t0).to.equal(to1e18("10"))
      expect(await pro.isPro(alice.address)).to.equal(true)
      const until1 = await pro.paidUntil(alice.address)
      await pro.connect(bob.wallet).subscribe(alice.address, 1)
      expect((await pro.paidUntil(alice.address)) - until1).to.equal(30n * 86400n)
      await expect(pro.connect(bob.wallet).subscribe(alice.address, 0)).to.be.revertedWithCustomError(pro, "BadPeriods")
      await expect(pro.connect(alice.wallet).setPrice(1)).to.be.revertedWithCustomError(pro, "NotAdmin")
      await expect(pro.connect(deployer.wallet).setPrice(to1e18("100.1"))).to.be.revertedWithCustomError(pro, "PriceTooHigh")
      expect(await pro.isPro(carol.address)).to.equal(false)
    })
  })
})

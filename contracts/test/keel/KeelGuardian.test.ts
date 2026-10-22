import { expect } from "chai"
import { ethers } from "hardhat"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import {
  fastForwardTime,
  getOpenTroveTotalDebt,
  openTrove,
  setupTests,
  User,
} from "../helpers"
import { to1e18 } from "../utils"
import { Contracts } from "../helpers/interfaces"
import { ZERO_ADDRESS } from "../../helpers/constants"
import type { KeelGuardian, KeelGuardianFactory } from "../../typechain"

describe("Keel: GuardianFactory + Guardian (against the real MUSD protocol)", () => {
  let contracts: Contracts
  let alice: User
  let bob: User
  let carol: User
  let deployer: User
  let factory: KeelGuardianFactory

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

  async function guardianFor(user: User): Promise<KeelGuardian> {
    await factory.connect(user.wallet).createGuardian()
    const addr = await factory.guardianOf(user.address)
    return (await ethers.getContractAt(
      "KeelGuardian",
      addr,
      user.wallet,
    )) as unknown as KeelGuardian
  }

  /** Opens a trove owned by the guardian at the given ICR (e.g. 1.6) with `musdAmount` of debt. */
  async function openGuardianTrove(
    g: KeelGuardian,
    owner: User,
    musdAmount: string,
    icr: number,
  ) {
    const price = await contracts.priceFeed.fetchPrice()
    const amount = to1e18(musdAmount)
    const totalDebt = await getOpenTroveTotalDebt(contracts, amount)
    const coll = (BigInt(Math.round(icr * 1e6)) * 10n ** 12n * totalDebt) / price
    await g
      .connect(owner.wallet)
      .openTrove(amount, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, {
        value: coll,
      })
    return { coll, totalDebt }
  }

  /** Move the oracle price so that `addr` ends up at exactly `targetICR` (1e18 = 100%). */
  async function setIcr(addr: string, targetICR: bigint) {
    const price = await contracts.priceFeed.fetchPrice()
    const icr = await contracts.troveManager.getCurrentICR(addr, price)
    const newPrice = (targetICR * price) / icr
    await contracts.mockAggregator.connect(deployer.wallet).setPrice(newPrice)
  }

  async function icrOf(addr: string) {
    const price = await contracts.priceFeed.fetchPrice()
    return contracts.troveManager.getCurrentICR(addr, price)
  }

  beforeEach(async () => {
    const t = await setupTests()
    contracts = t.contracts
    alice = t.alice
    bob = t.bob
    carol = t.carol
    deployer = t.deployer

    // Some background troves so the sorted list is non-trivial.
    await openTrove(contracts, {
      musdAmount: "10,000",
      ICR: "300",
      sender: carol.wallet,
    })
    await openTrove(contracts, {
      musdAmount: "20,000",
      ICR: "250",
      sender: bob.wallet,
    })

    const F = await ethers.getContractFactory("KeelGuardianFactory")
    factory = (await F.deploy(await protocolStruct())) as unknown as KeelGuardianFactory
    await factory.waitForDeployment()
  })

  describe("factory", () => {
    it("creates one deterministic guardian per owner", async () => {
      const predicted = await factory.predict(alice.address)
      await factory.connect(alice.wallet).createGuardian()
      expect(await factory.guardianOf(alice.address)).to.equal(predicted)
      await expect(
        factory.connect(alice.wallet).createGuardian(),
      ).to.be.revertedWithCustomError(factory, "AlreadyHasGuardian")
    })

    it("lists guardians with pagination", async () => {
      await factory.connect(alice.wallet).createGuardian()
      await factory.connect(bob.wallet).createGuardian()
      expect(await factory.totalGuardians()).to.equal(2n)
      expect((await factory.guardians(0, 10)).length).to.equal(2)
      expect((await factory.guardians(1, 10)).length).to.equal(1)
      expect((await factory.guardians(5, 10)).length).to.equal(0)
    })

    it("cannot initialize the implementation or a clone twice", async () => {
      const impl = await ethers.getContractAt(
        "KeelGuardian",
        await factory.implementation(),
      )
      await expect(
        impl.initialize(alice.address, await protocolStruct()),
      ).to.be.reverted
      const g = await guardianFor(alice)
      await expect(
        g.initialize(bob.address, await protocolStruct()),
      ).to.be.reverted
    })
  })

  describe("trove lifecycle (owner only)", () => {
    it("opens a trove owned by the guardian and forwards MUSD to the owner", async () => {
      const g = await guardianFor(alice)
      const before = await contracts.musd.balanceOf(alice.address)
      await openGuardianTrove(g, alice, "10,000", 1.6)
      expect(await contracts.troveManager.getTroveStatus(await g.getAddress())).to.equal(1n)
      expect((await contracts.musd.balanceOf(alice.address)) - before).to.equal(to1e18("10,000"))
      expect(await contracts.musd.balanceOf(await g.getAddress())).to.equal(0n)
    })

    it("rejects non-owners on every privileged function", async () => {
      const g = await guardianFor(alice)
      const asBob = g.connect(bob.wallet)
      await expect(asBob.openTrove(1, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, { value: 1 })).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.addCollateral(ZERO_ADDRESS, ZERO_ADDRESS, { value: 1 })).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.withdrawCollateral(1, ZERO_ADDRESS, ZERO_ADDRESS, bob.address)).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.borrowMore(1, ZERO_ADDRESS, ZERO_ADDRESS, bob.address)).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.repay(1, ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.closeTrove()).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.refinance(ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.withdrawReserveBTC(1, bob.address)).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.withdrawReserveMUSD(1, bob.address)).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.configure(true, 10, 0, to1e18("1.3"), to1e18("1.5"))).to.be.revertedWithCustomError(g, "NotOwner")
      await expect(asBob.transferOwnership(bob.address)).to.be.revertedWithCustomError(g, "NotOwner")
    })

    it("adds collateral, borrows more and repays", async () => {
      const g = await guardianFor(alice)
      await openGuardianTrove(g, alice, "10,000", 2.0)
      const addr = await g.getAddress()

      const icr0 = await icrOf(addr)
      await g.addCollateral(ZERO_ADDRESS, ZERO_ADDRESS, { value: to1e18("0.5") })
      expect(await icrOf(addr)).to.be.gt(icr0)

      const musd0 = await contracts.musd.balanceOf(alice.address)
      await g.borrowMore(to1e18("2,000"), ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS)
      expect((await contracts.musd.balanceOf(alice.address)) - musd0).to.equal(to1e18("2,000"))

      await contracts.musd.connect(alice.wallet).approve(addr, to1e18("1,000"))
      const icr1 = await icrOf(addr)
      await g.repay(to1e18("1,000"), ZERO_ADDRESS, ZERO_ADDRESS)
      expect(await icrOf(addr)).to.be.gt(icr1)
    })

    it("closes the trove and returns collateral and reserve to the owner", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      await openGuardianTrove(g, alice, "10,000", 2.0)
      await g.fundReserve({ value: to1e18("0.25") })
      // Alice needs a little extra MUSD to cover fee + interest + gas comp offsets.
      await contracts.musd.connect(bob.wallet).transfer(alice.address, to1e18("5,000"))
      await contracts.musd.connect(alice.wallet).approve(addr, ethers.MaxUint256)

      const btc0 = await ethers.provider.getBalance(alice.address)
      const tx = await g.closeTrove()
      const rc = await tx.wait()
      const gas = rc!.gasUsed * rc!.gasPrice
      const btc1 = await ethers.provider.getBalance(alice.address)

      expect(await contracts.troveManager.getTroveStatus(addr)).to.equal(2n) // closedByOwner
      expect(btc1 + gas).to.be.gt(btc0) // got collateral + reserve back
      expect(await ethers.provider.getBalance(addr)).to.equal(0n)
    })

    it("supports two-step ownership transfer", async () => {
      const g = await guardianFor(alice)
      await g.transferOwnership(bob.address)
      await expect(g.connect(carol.wallet).acceptOwnership()).to.be.revertedWithCustomError(g, "NotPendingOwner")
      await g.connect(bob.wallet).acceptOwnership()
      expect(await g.owner()).to.equal(bob.address)
      await expect(g.connect(alice.wallet).configure(true, 10, 0, to1e18("1.3"), to1e18("1.5"))).to.be.revertedWithCustomError(g, "NotOwner")
    })
  })

  describe("configuration", () => {
    it("validates bounds", async () => {
      const g = await guardianFor(alice)
      // trigger must be above the 110% liquidation threshold
      await expect(g.configure(true, 10, 0, to1e18("1.1"), to1e18("1.5"))).to.be.revertedWithCustomError(g, "InvalidConfig")
      // target must exceed trigger
      await expect(g.configure(true, 10, 0, to1e18("1.5"), to1e18("1.5"))).to.be.revertedWithCustomError(g, "InvalidConfig")
      // tip is capped at 1%
      await expect(g.configure(true, 101, 0, to1e18("1.3"), to1e18("1.5"))).to.be.revertedWithCustomError(g, "InvalidConfig")
      // target capped at 500%
      await expect(g.configure(true, 10, 0, to1e18("1.3"), to1e18("5.1"))).to.be.revertedWithCustomError(g, "InvalidConfig")
      await expect(g.configure(true, 50, 60, to1e18("1.25"), to1e18("1.6"))).to.emit(g, "ConfigUpdated")
    })
  })

  describe("protect() - the permissionless keeper path", () => {
    it("tops up with reserve BTC, restores the target ICR and pays a bounded tip", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      const { coll } = await openGuardianTrove(g, alice, "10,000", 1.6)
      await g.fundReserve({ value: (coll * 30n) / 100n })

      // healthy -> keeper cannot act
      await expect(g.connect(bob.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithCustomError(g, "HealthyEnough")
      expect((await g.protectionStatus()).canProtect).to.equal(false)

      // price drops: ICR 125% < 130% trigger, still above the 110% liquidation line
      await setIcr(addr, to1e18("1.25"))
      const status = await g.protectionStatus()
      expect(status.canProtect).to.equal(true)
      expect(status.btcToAdd).to.be.gt(0n)
      expect(status.musdToRepay).to.equal(0n)

      const keeperBefore = await ethers.provider.getBalance(carol.address)
      const tx = await g.connect(carol.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)
      const rc = await tx.wait()
      const gas = rc!.gasUsed * rc!.gasPrice

      const icrAfter = await icrOf(addr)
      const target = to1e18("1.5")
      // within 0.1% of the target (interest accrues by the second)
      expect(icrAfter).to.be.gt((target * 999n) / 1000n)
      expect(icrAfter).to.be.lt((target * 1001n) / 1000n)

      await expect(tx).to.emit(g, "Protected")
      // keeper tip = 0.2% of the BTC added, paid out of the reserve (never out of the trove)
      const tip = (status.btcToAdd * 20n) / 10_000n
      const keeperAfter = await ethers.provider.getBalance(carol.address)
      expect(keeperAfter + gas - keeperBefore).to.be.closeTo(tip, tip / 100n + 1n)
    })

    it("enforces the cooldown", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      const { coll } = await openGuardianTrove(g, alice, "10,000", 1.6)
      await g.fundReserve({ value: coll })
      await g.configure(true, 20, 600, to1e18("1.3"), to1e18("1.5"))

      await setIcr(addr, to1e18("1.2"))
      await g.connect(bob.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)

      await setIcr(addr, to1e18("1.2"))
      await expect(g.connect(bob.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithCustomError(g, "CooldownActive")
      await fastForwardTime(601)
      await setIcr(addr, to1e18("1.2"))
      await expect(g.connect(bob.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)).to.emit(g, "Protected")
    })

    it("repays debt with the MUSD reserve when there is no BTC reserve", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      await openGuardianTrove(g, alice, "20,000", 1.6)
      // owner parks 6,000 MUSD in the guardian as a repay reserve
      await contracts.musd.connect(alice.wallet).transfer(addr, to1e18("6,000"))

      await setIcr(addr, to1e18("1.25"))
      const status = await g.protectionStatus()
      expect(status.canProtect).to.equal(true)
      expect(status.btcToAdd).to.equal(0n)
      expect(status.musdToRepay).to.be.gt(0n)

      const kMusd0 = await contracts.musd.balanceOf(carol.address)
      await g.connect(carol.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)
      const icrAfter = await icrOf(addr)
      expect(icrAfter).to.be.gt(to1e18("1.49"))
      expect(icrAfter).to.be.lt(to1e18("1.51"))
      // tip paid in MUSD, bounded by 1% of repay
      const tip = (await contracts.musd.balanceOf(carol.address)) - kMusd0
      expect(tip).to.be.gt(0n)
      expect(tip).to.be.lte(status.musdToRepay / 100n)
    })

    it("does a partial rescue when the reserve is too small, and never overspends it", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      const { coll } = await openGuardianTrove(g, alice, "10,000", 1.6)
      const reserve = coll / 50n // far less than the shortfall
      await g.fundReserve({ value: reserve })

      await setIcr(addr, to1e18("1.2"))
      const icrBefore = await icrOf(addr)
      await g.connect(bob.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)
      expect(await icrOf(addr)).to.be.gt(icrBefore)
      // reserve is fully used up (top-up + tip) but never exceeded
      expect(await ethers.provider.getBalance(addr)).to.be.lt(reserve / 100n + 10n)
    })

    it("reverts with NothingToDo when the reserve is empty", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      await openGuardianTrove(g, alice, "10,000", 1.6)
      await setIcr(addr, to1e18("1.2"))
      await expect(g.connect(bob.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithCustomError(g, "NothingToDo")
    })

    it("does nothing when protection is disabled or the trove is not open", async () => {
      const g = await guardianFor(alice)
      await expect(g.connect(bob.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithCustomError(g, "NoTrove")
      await g.configure(false, 20, 0, to1e18("1.3"), to1e18("1.5"))
      await expect(g.connect(bob.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWithCustomError(g, "NotEnabled")
    })

    it("a keeper can never redirect owner funds: reserve withdrawals stay owner-only", async () => {
      const g = await guardianFor(alice)
      await g.fundReserve({ value: to1e18("1") })
      await expect(g.connect(carol.wallet).withdrawReserveBTC(to1e18("1"), carol.address)).to.be.revertedWithCustomError(g, "NotOwner")
      const before = await ethers.provider.getBalance(alice.address)
      await g.withdrawReserveBTC(to1e18("1"), alice.address)
      expect(await ethers.provider.getBalance(await g.getAddress())).to.equal(0n)
      expect(await ethers.provider.getBalance(alice.address)).to.be.gt(before - to1e18("0.01"))
    })

    it("works in Recovery Mode (adding collateral raises ICR)", async () => {
      const g = await guardianFor(alice)
      const addr = await g.getAddress()
      // The guardian trove is the healthiest in the system, so a crash that pushes the
      // system into Recovery Mode (TCR < 150%) leaves it above the 110% liquidation line.
      const { coll } = await openGuardianTrove(g, alice, "10,000", 3.5)
      await g.fundReserve({ value: coll })

      // crash the price so TCR < 150% but the guardian trove is still > 110%
      const price = await contracts.priceFeed.fetchPrice()
      const tcr = await contracts.troveManager.getTCR(price)
      const newPrice = (to1e18("1.4") * price) / tcr
      await contracts.mockAggregator.connect(deployer.wallet).setPrice(newPrice)
      expect(await contracts.troveManager.checkRecoveryMode(await contracts.priceFeed.fetchPrice())).to.equal(true)

      const icr = await icrOf(addr)
      expect(icr).to.be.gt(to1e18("1.1"))
      await g.configure(true, 20, 0, icr + to1e18("0.05"), icr + to1e18("0.3"))
      await expect(g.connect(bob.wallet).protect(ZERO_ADDRESS, ZERO_ADDRESS)).to.emit(g, "Protected")
      expect(await icrOf(addr)).to.be.gt(icr)
    })
  })
})

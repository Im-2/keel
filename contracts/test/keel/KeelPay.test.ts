import { expect } from "chai"
import { ethers } from "hardhat"
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { openTrove, setupTests, User } from "../helpers"
import { to1e18 } from "../utils"
import { Contracts } from "../helpers/interfaces"
import type { KeelPay } from "../../typechain"

describe("Keel: KeelPay claim links", () => {
  let contracts: Contracts
  let alice: User
  let bob: User
  let carol: User
  let pay: KeelPay
  let payAddr: string
  let chainId: bigint

  const types = {
    Claim: [
      { name: "link", type: "address" },
      { name: "to", type: "address" },
    ],
  }

  async function domain() {
    return { name: "KeelPay", version: "1", chainId, verifyingContract: payAddr }
  }

  async function signClaim(link: ReturnType<typeof ethers.Wallet.createRandom>, to: string) {
    return link.signTypedData(await domain(), types, { link: link.address, to })
  }

  async function expiryIn(seconds: number) {
    return BigInt((await time.latest()) + seconds)
  }

  beforeEach(async () => {
    const t = await setupTests()
    contracts = t.contracts
    alice = t.alice
    bob = t.bob
    carol = t.carol
    await openTrove(contracts, { musdAmount: "10,000", ICR: "300", sender: alice.wallet })

    const F = await ethers.getContractFactory("KeelPay")
    pay = (await F.deploy(await contracts.musd.getAddress())) as unknown as KeelPay
    await pay.waitForDeployment()
    payAddr = await pay.getAddress()
    chainId = (await ethers.provider.getNetwork()).chainId
    await contracts.musd.connect(alice.wallet).approve(payAddr, ethers.MaxUint256)
  })

  it("lets a relayer deliver MUSD to a recipient who signs with the link key", async () => {
    const link = ethers.Wallet.createRandom()
    await pay.connect(alice.wallet).create(link.address, to1e18("250"), await expiryIn(3600))
    expect(await contracts.musd.balanceOf(payAddr)).to.equal(to1e18("250"))

    const sig = await signClaim(link, carol.address)
    const before = await contracts.musd.balanceOf(carol.address)
    // bob is the relayer (e.g. the Keel bot) - the recipient needs no gas
    await expect(pay.connect(bob.wallet).claim(link.address, carol.address, sig))
      .to.emit(pay, "LinkClaimed")
      .withArgs(link.address, carol.address, to1e18("250"), bob.address)
    expect((await contracts.musd.balanceOf(carol.address)) - before).to.equal(to1e18("250"))
  })

  it("cannot be claimed twice", async () => {
    const link = ethers.Wallet.createRandom()
    await pay.connect(alice.wallet).create(link.address, to1e18("10"), await expiryIn(3600))
    const sig = await signClaim(link, carol.address)
    await pay.claim(link.address, carol.address, sig)
    await expect(pay.claim(link.address, carol.address, sig)).to.be.revertedWithCustomError(pay, "LinkSettled")
  })

  it("binds the destination: a front-runner cannot redirect the funds", async () => {
    const link = ethers.Wallet.createRandom()
    await pay.connect(alice.wallet).create(link.address, to1e18("10"), await expiryIn(3600))
    const sigForCarol = await signClaim(link, carol.address)
    await expect(pay.connect(bob.wallet).claim(link.address, bob.address, sigForCarol)).to.be.revertedWithCustomError(pay, "BadSignature")
  })

  it("rejects signatures from anyone but the link key", async () => {
    const link = ethers.Wallet.createRandom()
    const attacker = ethers.Wallet.createRandom()
    await pay.connect(alice.wallet).create(link.address, to1e18("10"), await expiryIn(3600))
    const forged = await attacker.signTypedData(await domain(), types, { link: link.address, to: attacker.address })
    await expect(pay.claim(link.address, attacker.address, forged)).to.be.revertedWithCustomError(pay, "BadSignature")
  })

  it("rejects unknown links, duplicates and bad params", async () => {
    const link = ethers.Wallet.createRandom()
    await expect(pay.claim(link.address, carol.address, "0x")).to.be.revertedWithCustomError(pay, "LinkUnknown")
    await expect(pay.connect(alice.wallet).create(ethers.ZeroAddress, 1, await expiryIn(60))).to.be.revertedWithCustomError(pay, "BadParams")
    await expect(pay.connect(alice.wallet).create(link.address, 0, await expiryIn(60))).to.be.revertedWithCustomError(pay, "BadParams")
    await expect(pay.connect(alice.wallet).create(link.address, 1, BigInt(await time.latest()))).to.be.revertedWithCustomError(pay, "BadParams")
    await pay.connect(alice.wallet).create(link.address, 1, await expiryIn(60))
    await expect(pay.connect(alice.wallet).create(link.address, 1, await expiryIn(60))).to.be.revertedWithCustomError(pay, "LinkExists")
  })

  it("lets the sender cancel any time, and anyone refund after expiry", async () => {
    const l1 = ethers.Wallet.createRandom()
    const l2 = ethers.Wallet.createRandom()
    await pay.connect(alice.wallet).create(l1.address, to1e18("5"), await expiryIn(3600))
    await pay.connect(alice.wallet).create(l2.address, to1e18("7"), await expiryIn(100))

    // strangers cannot cancel an active link
    await expect(pay.connect(bob.wallet).cancel(l1.address)).to.be.revertedWithCustomError(pay, "NotSender")
    const bal0 = await contracts.musd.balanceOf(alice.address)
    await pay.connect(alice.wallet).cancel(l1.address)
    expect((await contracts.musd.balanceOf(alice.address)) - bal0).to.equal(to1e18("5"))
    await expect(pay.connect(alice.wallet).cancel(l1.address)).to.be.revertedWithCustomError(pay, "LinkSettled")

    // after expiry: claims fail, and anyone can trigger the refund to the sender
    await time.increase(200)
    await expect(pay.claim(l2.address, carol.address, await signClaim(l2, carol.address))).to.be.revertedWithCustomError(pay, "Expired")
    const bal1 = await contracts.musd.balanceOf(alice.address)
    await pay.connect(bob.wallet).cancel(l2.address)
    expect((await contracts.musd.balanceOf(alice.address)) - bal1).to.equal(to1e18("7"))
  })

  it("supports one-signature creation with an EIP-2612 permit", async () => {
    // Fresh allowance: revoke, then fund the link with only a permit.
    await contracts.musd.connect(alice.wallet).approve(payAddr, 0)
    const link = ethers.Wallet.createRandom()
    const amount = to1e18("40")
    const deadline = BigInt((await time.latest()) + 3600)
    const musdAddr = await contracts.musd.getAddress()
    const permitSig = ethers.Signature.from(
      await alice.wallet.signTypedData(
        { name: "Mezo USD", version: "1", chainId, verifyingContract: musdAddr },
        {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        {
          owner: alice.address,
          spender: payAddr,
          value: amount,
          nonce: await contracts.musd.nonces(alice.address),
          deadline,
        },
      ),
    )
    await pay
      .connect(alice.wallet)
      .createWithPermit(link.address, amount, await expiryIn(3600), deadline, permitSig.v, permitSig.r, permitSig.s)
    expect((await pay.links(link.address)).amount).to.equal(amount)
  })
})

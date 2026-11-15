# Guardian protection

A **guardian** is a small smart contract that owns your MUSD loan on your behalf. It lets anyone keep the loan healthy, and it lets nobody but you take funds out.

## Design

- **One guardian per wallet.** `KeelGuardianFactoryV2` deploys a minimal-proxy clone (EIP-1167) of an immutable implementation at a deterministic address.
- **You are the owner.** Only you can open, add to, repay, close or refinance the loan, withdraw the reserve, or change the settings. Ownership transfer takes two steps.
- **The reserve.** You fund it with BTC (and optionally MUSD). It sits in the guardian, separate from your loan's collateral, and is spent only by `protect()`, only into this loan.
- **The settings:**

  | Setting | Meaning | Default | Limits |
  |---|---|---|---|
  | trigger (`minICR`) | Act when the ratio is below this | 130% | above 110% |
  | target (`targetICR`) | Restore to this ratio | 150% | above the trigger, at most 500% |
  | tip (`tipBps`) | Keeper's reward, as a share of the amount applied | 0.2% | at most 1% |
  | cooldown | Minimum time between two rescues | 5 minutes | |

## The keeper

`protect()` is **permissionless**: any address may call it, which means no single operator is a point of failure. Keel runs a keeper that checks every guardian on every factory about every 30 seconds.

**A keeper can:**
- move reserve BTC into this loan as collateral;
- repay this loan's debt from the reserve MUSD;
- receive the tip.

**A keeper cannot:** withdraw anything, borrow, change your settings, move funds to any other address, or act while your ratio is above the trigger or during the cooldown.

## How a rescue is planned

When the ratio is below the trigger, the guardian computes what it takes to reach the target:

1. **BTC first.** Add reserve BTC as collateral, keeping enough in the reserve for the tip.
2. **Then MUSD.** If BTC alone isn't enough, repay debt from the reserve MUSD. It never repays below Mezo's minimum net debt, and never more than debt minus the gas compensation.
3. When both are used, they go in **one** `adjustTrove` call, so Mezo checks the combined result.

## What Mezo allows (and why v2 exists)

From Mezo's `BorrowerOperations._adjustTrove`:

- **Normal Mode:** any adjustment, even a pure top-up, must leave the loan at **110% or more** (and the system at 150% or more). A top-up that lifts a 105% loan only to 108% is **rejected**.
- **Recovery Mode:** a pure collateral top-up and/or repayment is allowed at **any** resulting ratio.

**Guardian v1** asked for the full target and reverted when the reserve couldn't deliver it, or when Mezo rejected the result. **Guardian v2** never fails just because the reserve is small.

## v2 result codes

`protect()` returns a `Result` and emits matching events:

| Result | When | What happens | Events |
|---|---|---|---|
| `Full` (0) | The reserve reaches the target | Funds move; the tip is paid | `Protected` |
| `Partial` (1) | The reserve helps but runs out before the target | The whole usable reserve is applied; the tip is paid on what moved | `Protected`, `PartialRescue(…, btcShortfall)` |
| `Insufficient` (2) | Nothing Mezo would accept is affordable (a dust reserve, or under 110% in Normal Mode) | **Nothing moves, no tip, the cooldown stays free, no revert** | `InsufficientReserve(icr, btcShortfallToMCR, btcShortfallToTarget, recoveryMode)` |

`protect()` still reverts when the guardian isn't eligible at all: `NotEnabled`, `NoTrove`, `HealthyEnough` or `CooldownActive`.

The shortfall fields are exactly the extra **reserve BTC** needed, tip included:
- `btcShortfallToMCR` to make a rescue possible (lift the loan to 110%);
- `btcShortfallToTarget` to reach your target.

Keel tells you **"add X BTC"** with a 2% margin for interest and price moves, plus a one-tap button that opens the funding transaction. `previewProtect()` returns the same plan without sending anything, and the bot and keeper use it.

## Fees from protection

The owner pays at most `tipBps` (≤ 1%) of the amount applied. In v2 a share of that tip goes to Keel's treasury: 20% today, **hard-capped at 50%** in both the factory and the guardian. The owner never pays more because of it. See [Business model](../BUSINESS.md).

## What's proven on testnet

- **v1:** four keeper protections on testnet, two triggered by real BTC price moves. Both price-triggered ones were partial top-ups, because the reserves were almost empty; that is exactly the case v2 now reports explicitly. See [Live stats](https://keel-miniapp.vercel.app/stats).
- **v2:** 17 contract tests against the real MUSD stack, covering full, partial and impossible rescues, Recovery Mode, minimum net debt, dust, repeated calls, tip limits, re-entrancy and owner-only control.
- **v2 on testnet:** a fresh wallet ran an insufficient, a partial and a full rescue, with `protect()` signed by the keeper wallet's key, with transaction links in the [Wave 2 checklist](../WAVE2_CHECKLIST.md).

## Your control

At any time you can:
- turn protection off;
- change the trigger, target or tip;
- withdraw the reserve;
- repay or close the loan.

The keeper can only act within the limits above.

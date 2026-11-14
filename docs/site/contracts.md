# Contracts and verification

All Keel contracts are deployed on **Mezo testnet (chain id 31611)**, and each one has **verified source code** on the Mezo explorer ([explorer.test.mezo.org](https://explorer.test.mezo.org), a Blockscout instance).

The source of truth for addresses is [`shared/deployments/testnet.json`](https://github.com/Im-2/keel/blob/main/shared/deployments/testnet.json).

## Current (v2): new guardians and new claim links

| Contract | Address | Verified source |
|---|---|---|
| KeelGuardianFactoryV2 | `0x85579beE60dc659e014610e57935379F8A9B79E1` | [View on explorer ✓](https://explorer.test.mezo.org/address/0x85579beE60dc659e014610e57935379F8A9B79E1?tab=contract) |
| KeelGuardianV2 (implementation) | `0xCCF76173D1F312b3b5c3e55A6dDBD8046f30E8eF` | [View on explorer ✓](https://explorer.test.mezo.org/address/0xCCF76173D1F312b3b5c3e55A6dDBD8046f30E8eF?tab=contract) |
| KeelPay v2 | `0x3777b89a32cD85FfA0a49b062CDb80e66E66740d` | [View on explorer ✓](https://explorer.test.mezo.org/address/0x3777b89a32cD85FfA0a49b062CDb80e66E66740d?tab=contract) |
| KeelPro | `0x59b1CEB919378C59FB5F3D735f81c353aA1D8654` | [View on explorer ✓](https://explorer.test.mezo.org/address/0x59b1CEB919378C59FB5F3D735f81c353aA1D8654?tab=contract) |

## Earlier (v1): existing guardians and links keep working

| Contract | Address | Verified source |
|---|---|---|
| KeelGuardianFactory | `0x44AA5CBb78eA506Fd91FA7942d9326De29bF2E49` | [View on explorer ✓](https://explorer.test.mezo.org/address/0x44AA5CBb78eA506Fd91FA7942d9326De29bF2E49?tab=contract) |
| KeelGuardian (implementation) | `0x07F411F2EE6AC7BA758ab234FC20Eb6F5f13445D` | [View on explorer ✓](https://explorer.test.mezo.org/address/0x07F411F2EE6AC7BA758ab234FC20Eb6F5f13445D?tab=contract) |
| KeelPay | `0xa0C53049202A655f5Ca5fE3131971C1B79cBEe29` | [View on explorer ✓](https://explorer.test.mezo.org/address/0xa0C53049202A655f5Ca5fE3131971C1B79cBEe29?tab=contract) |

Each user's guardian is a minimal-proxy clone of an implementation. The explorer shows the clone's code as the verified implementation's.

## Treasury

The protocol share of keeper tips (20% of the tip, hard-capped at 50%) and KeelPro payments go to the treasury set on `KeelGuardianFactoryV2` and `KeelPro`: `0x5C22A7612D3B67C68bA84873F16C01bc06041ADD`, today the team's deployer wallet. It's a plain address, not a contract; the admin can point it at a multisig.

## Mezo contracts Keel uses

| Contract | Address |
|---|---|
| MUSD | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` |
| BorrowerOperations | `0xCdF7028ceAB81fA0C6971208e83fa7872994beE5` |
| TroveManager | `0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0` |
| PriceFeed | `0x86bCF0841622a5dAC14A313a15f96A95421b9366` |
| HintHelpers | `0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6` |
| SortedTroves | `0x722E4D24FD6Ff8b0AC679450F3D91294607268fA` |

## How the sources were verified

- **Tool:** `contracts/scripts/verify-blockscout.py` submits the exact compiler input hardhat used (standard JSON) to the explorer's verification API.
- **Compiler:** solc **0.8.24+commit.e11b9ed9**, optimizer on with 100 runs, EVM version **london**, license GPL-3.0.
- **Source set:** only the files listed in each contract's own metadata, which is the same set solc hashed into the bytecode.
- **Constructor arguments:** detected from the creation transaction.

```bash
python contracts/scripts/verify-blockscout.py              # every contract in shared/deployments/testnet.json
python contracts/scripts/verify-blockscout.py 0x85579b…    # one address
```

Screenshots of each verified page are in [`docs/images/verified`](https://github.com/Im-2/keel/tree/main/docs/images/verified).

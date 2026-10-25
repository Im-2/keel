import { defineChain } from "viem"

export type NetworkName = "testnet" | "mainnet" | "local"

export const mezoTestnet = defineChain({
  id: 31611,
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.test.mezo.org"], webSocket: ["wss://rpc-ws.test.mezo.org"] },
  },
  blockExplorers: { default: { name: "Mezo Explorer", url: "https://explorer.test.mezo.org" } },
  testnet: true,
})

export const mezoMainnet = defineChain({
  id: 31612,
  name: "Mezo",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.mezo.public.validationcloud.io"] } },
  blockExplorers: { default: { name: "Mezo Explorer", url: "https://explorer.mezo.org" } },
})

/** Local `hardhat node` (the MUSD hardhat config simulates Mezo mainnet's chain id). */
export const mezoLocal = defineChain({
  id: 31612,
  name: "Mezo Local",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  blockExplorers: { default: { name: "Local", url: "http://localhost:8545" } },
  testnet: true,
})

export const chainFor = (network: NetworkName) => (network === "mainnet" ? mezoMainnet : network === "local" ? mezoLocal : mezoTestnet)

export const explorerTx = (network: NetworkName, hash: string) =>
  `${chainFor(network).blockExplorers.default.url}/tx/${hash}`
export const explorerAddress = (network: NetworkName, addr: string) =>
  `${chainFor(network).blockExplorers.default.url}/address/${addr}`

/** Where to get test BTC; null on mainnet. */
export const faucetUrl = (network: NetworkName) => (network === "testnet" ? "https://faucet.test.mezo.org" : null)

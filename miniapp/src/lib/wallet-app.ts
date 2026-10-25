import { useAccount } from "wagmi"
import { chosenWallet, inTelegram, walletFor, type WalletApp } from "./telegram"

/** The wallet app the user is signing with: the one picked in Telegram's connect sheet, else the wagmi connector's. */
export function useWalletApp(): WalletApp | undefined {
  const { connector } = useAccount()
  return (inTelegram() ? chosenWallet() : undefined) ?? walletFor(connector) ?? chosenWallet()
}

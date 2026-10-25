import { useState } from "react"
import qrcode from "qrcode-generator"
import { claimLink, fmtMusd } from "@keel/shared"
import { tg, type AppConfig } from "../lib/api"
import { usePosition } from "../lib/data"
import { Button, Glass, KeelMark, MezoBadge, Notice } from "./kit"

function Qr({ text }: { text: string }) {
  const qr = qrcode(0, "M")
  qr.addData(text)
  qr.make()
  return <div className="qr" dangerouslySetInnerHTML={{ __html: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }} />
}

/** The claim link plus everything needed to hand it over: Telegram share, the phone's share sheet, copy, QR. */
export function ShareClaim({ cfg, keyHex, amount, forName }: { cfg: AppConfig; keyHex: string; amount: bigint; forName?: string }) {
  const me = usePosition().data?.user
  const [copied, setCopied] = useState(false)
  const [qr, setQr] = useState(false)
  const link = claimLink(cfg.botUsername, cfg.miniappShortName, keyHex)
  const from = me?.username ? "@" + me.username : me?.firstName ?? "Someone"
  const text = `${from} sent you ${fmtMusd(amount, 2)}${forName ? ` (for ${forName})` : ""} — tap to claim:`
  const copy = () => void navigator.clipboard?.writeText(`${text} ${link}`).then(() => setCopied(true))
  return (
    <>
      <div className="share-card">
        <span className="orb orb-gold" aria-hidden />
        <div className="share-top"><KeelMark size={30} /><MezoBadge label="Mezo" /></div>
        <span className="label">{from} sent you</span>
        <strong className="huge">{fmtMusd(amount, 2)}</strong>
        <p className="muted small">{forName ? `For ${forName} · ` : ""}Tap the link to claim in one step, no wallet needed. Refunds to the sender after 72h if unclaimed.</p>
        {qr && <Qr text={link} />}
      </div>
      <Glass>
        <Notice tone="info">Anyone with this link can claim it, so send it only to them.</Notice>
        <Button onClick={() => {
          const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`
          if (tg?.openTelegramLink) tg.openTelegramLink(share)
          else window.open(share, "_blank", "noopener")
        }}>Share in Telegram</Button>
        {typeof navigator.share === "function" && <Button variant="ghost" onClick={() => void navigator.share({ title: "Claim your MUSD", text, url: link }).catch(() => undefined)}>Share to WhatsApp, SMS…</Button>}
        <div className="row-between">
          <button className="link-btn" onClick={copy}>{copied ? "Copied ✓" : "Copy link"}</button>
          <button className="link-btn" onClick={() => setQr(!qr)}>{qr ? "Hide QR" : "Show QR"}</button>
        </div>
      </Glass>
    </>
  )
}

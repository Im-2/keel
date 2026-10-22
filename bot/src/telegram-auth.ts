import { createHmac, timingSafeEqual } from "node:crypto"

export interface TgUser {
  id: number
  username?: string
  first_name?: string
  last_name?: string
  language_code?: string
}

export interface InitData {
  user: TgUser
  authDate: number
  startParam?: string
  chatType?: string
}

/**
 * Validate Telegram Mini App `initData` per https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * secret = HMAC_SHA256(key="WebAppData", msg=bot_token); hash = HMAC_SHA256(key=secret, msg=data_check_string)
 */
export function validateInitData(initData: string, botToken: string, maxAgeSeconds = 24 * 3600, now = Date.now() / 1000): InitData {
  const params = new URLSearchParams(initData)
  const hash = params.get("hash")
  if (!hash) throw new Error("initData: missing hash")
  params.delete("hash")
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n")
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest()
  const expected = createHmac("sha256", secret).update(dataCheckString).digest()
  const given = Buffer.from(hash, "hex")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("initData: bad signature")

  const authDate = Number(params.get("auth_date"))
  if (!authDate || now - authDate > maxAgeSeconds) throw new Error("initData: expired")
  const userRaw = params.get("user")
  if (!userRaw) throw new Error("initData: no user")
  const user = JSON.parse(userRaw) as TgUser
  if (!user.id) throw new Error("initData: invalid user")
  return { user, authDate, startParam: params.get("start_param") ?? undefined, chatType: params.get("chat_type") ?? undefined }
}

/** Test helper: build a correctly signed initData string. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const entries = Object.entries(fields)
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).sort().join("\n")
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest()
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex")
  return new URLSearchParams({ ...fields, hash }).toString()
}

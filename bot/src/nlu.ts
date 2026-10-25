/**
 * Deterministic natural-language understanding for the bot. No models, no network: normalisation,
 * number parsing, fuzzy keyword correction, weighted patterns and slot extraction.
 * The text is only ever data: the result is mapped onto the same intents the slash commands create.
 */

export type NluIntent =
  | "borrow" | "repay" | "add_collateral" | "fund_reserve"
  | "protect_on" | "protect_off" | "protect_info"
  | "send" | "claim_link" | "request" | "split"
  | "position" | "safety" | "liquidation" | "whatif"
  | "alerts" | "mute" | "unmute"
  | "fees" | "what_musd" | "help" | "greeting" | "link_wallet" | "disconnect" | "premium" | "history" | "balance"

export interface Slots {
  /** Decimal string, e.g. "2000" or "0.01". */
  amount?: string
  unit?: "musd" | "btc"
  /** "repay everything", "pay it all off". */
  all?: boolean
  /** Ratios / percentages in the order they appear (e.g. borrow at 180%, protect at 170 to 180). */
  percents: number[]
  /** what-if: a price drop in percent... */
  drop?: number
  /** ...or an absolute BTC price in USD. */
  priceTarget?: number
  usernames: string[]
  /** "split 120 between everyone": a group split people join themselves. */
  everyone?: boolean
  /** "split 90 with ada and bob, not me": the requester pays no share. */
  excludeMe?: boolean
  address?: string
  memo?: string
}

export interface Parsed {
  intent: NluIntent | null
  confidence: number
  slots: Slots
  /** Ranked other candidates, for "Did you mean...?" */
  alternatives: NluIntent[]
  /** Words we corrected with fuzzy matching (typo → keyword). */
  corrections: Array<[string, string]>
  normalized: string
}

/** Above this the bot acts (after echoing the details back); between ASK and ACCEPT it asks "Did you mean...?". */
export const ACCEPT = 1.0
export const ASK = 0.45

// ------------------------------------------------------------------------------------------ numbers

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, k: 1000, million: 1_000_000, grand: 1000 }

/** "two thousand five hundred" -> "2500" inside the text (also "a hundred", "half a"). */
function wordsToNumbers(s: string): string {
  const words = s.split(" ")
  const out: string[] = []
  let i = 0
  while (i < words.length) {
    let total = 0
    let cur = 0
    let used = 0
    let j = i
    for (; j < words.length; j++) {
      const w = words[j]
      if (w in UNITS) {
        cur += UNITS[w]
        used++
      } else if (w in SCALES && w !== "k" && (used > 0 || words[j - 1] === "a")) {
        const sc = SCALES[w]
        if (cur === 0) cur = 1
        if (sc >= 1000) {
          total += cur * sc
          cur = 0
        } else cur *= sc
        used++
      } else if (w === "and" && used > 0 && j + 1 < words.length && (words[j + 1] in UNITS)) {
        continue
      } else if (w === "a" && j + 1 < words.length && words[j + 1] in SCALES && words[j + 1] !== "k") {
        continue
      } else break
    }
    if (used > 0) {
      out.push(String(total + cur))
      i = j
    } else {
      out.push(words[i])
      i++
    }
  }
  return out.join(" ")
}

// ------------------------------------------------------------------------------------------ fuzzy

const VOCAB = [
  "borrow", "loan", "repay", "collateral", "deposit", "protect", "protection", "guardian", "reserve", "fund",
  "send", "transfer", "request", "split", "position", "status", "balance", "alerts", "alert", "notifications", "history", "activity", "transactions",
  "mute", "unmute", "liquidated", "liquidation", "liquidate", "safe", "risk", "help", "fees", "interest",
  "bitcoin", "musd", "dollars", "everything", "premium", "wallet", "connect", "enable", "disable", "drops", "falls",
]

/** Damerau-Levenshtein distance (optimal string alignment), small inputs only. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

function correct(word: string): string | null {
  if (word.length < 4 || /\d/.test(word) || VOCAB.includes(word)) return null
  const max = word.length >= 7 ? 2 : 1
  let best: string | null = null
  let bestD = max + 1
  for (const v of VOCAB) {
    if (Math.abs(v.length - word.length) > max) continue
    const dist = editDistance(word, v)
    if (dist < bestD) {
      bestD = dist
      best = v
    }
  }
  return bestD <= max ? best : null
}

// ------------------------------------------------------------------------------------------ normalise

export function normalize(input: string): { text: string; usernames: string[]; address?: string; quoted?: string } {
  let s = input.normalize("NFKC").replace(/[‘’“”]/g, "'")
  const quoted = s.match(/["']([^"']{2,60})["']/)?.[1]
  const address = s.match(/0x[0-9a-fA-F]{40}/)?.[0]
  if (address) s = s.replace(address, " ")
  const usernames = [...s.matchAll(/@([A-Za-z0-9_]{3,32})/g)].map((m) => m[1])
  s = s.replace(/@[A-Za-z0-9_]{3,32}/g, " @user ")
  s = s.toLowerCase()
  s = s.replace(/(\d),(\d{3})\b/g, "$1$2") // 2,000 -> 2000
  s = s.replace(/(^|[^\d])\.(\d)/g, "$10.$2") // .5 -> 0.5
  s = s.replace(/\$\s*(\d+(?:\.\d+)?k?)/g, " $1 usd ").replace(/(\d+(?:\.\d+)?k?)\s*\$/g, " $1 usd ") // $20 / 20$ -> 20 usd
  s = s.replace(/(\d)(btc|musd|usd|usdc|usdt|k|%)\b/g, "$1 $2")
  s = s.replace(/(\d)\s*k\b/g, (_m, d) => `${d}k`) // keep 2k together for scaling below
  s = s.replace(/(\d+(?:\.\d+)?)k\b/g, (_m, n) => String(Math.round(parseFloat(n) * 1000)))
  s = s.replace(/(\d)\s*%/g, "$1 percent")
  s = s.replace(/[^a-z0-9.@\s-]/g, " ").replace(/(?<!\d)\.|\.(?!\d)/g, " ").replace(/-(?!\d)/g, " ")
  s = s.replace(/\s+/g, " ").trim()
  s = wordsToNumbers(s)
  s = s.replace(/\bhalf an? (\d)/g, "0.5 $1")
  return { text: s, usernames, address, quoted }
}

// ------------------------------------------------------------------------------------------ intents

interface Rule { re: RegExp; w: number }
const R = (re: RegExp, w: number): Rule => ({ re, w })

const RULES: Record<NluIntent, Rule[]> = {
  borrow: [
    R(/\b(borrow|borow)\b/, 1.1), R(/\b(take out|open|start|get) (a |me a |my )?loan\b/, 1.1), R(/\bloan me\b/, 1.1),
    R(/\b(get me|give me|i need|need|want)\b/, 0.45), R(/\bagainst (my )?(btc|bitcoin|collateral)\b/, 0.7), R(/\bmint\b/, 0.6),
    R(/\bloan\b/, 0.3), R(/\b(cash out|liquidity)\b/, 0.4),
  ],
  repay: [
    R(/\b(repay|re pay|payback)\b/, 1.2), R(/\bpay (it )?(back|off|down)\b/, 1.2), R(/\b(settle|clear) (my )?(loan|debt)\b/, 1.2),
    R(/\bpay\b.*\b(loan|debt)\b/, 0.8), R(/\b(close|reduce) (my )?(loan|debt)\b/, 0.9),
  ],
  add_collateral: [
    R(/\b(add|deposit|put in|top up|increase)\b/, 0.5), R(/\bcollateral\b/, 0.7), R(/\b\d+(\.\d+)? (btc|bitcoin|sats)\b/, 0.45),
    R(/\bmore (btc|bitcoin)\b/, 0.4), R(/\b(raise|improve|boost) (my )?(ratio|health)\b/, 0.6),
  ],
  fund_reserve: [R(/\breserve\b/, 0.9), R(/\bfund\b/, 0.55), R(/\b(top up|refill|fill) (the |my )?(guardian|reserve)\b/, 0.6)],
  protect_on: [
    R(/\b(turn on|enable|activate|switch on|start|set up|setup)\b.*\b(protect|protection|guardian|auto protect)\w*/, 1.3),
    R(/\bprotect me\b/, 1.1), R(/\bprotection on\b/, 1.2), R(/\b(protect|protection|guardian)\b/, 0.5),
    R(/\b(trigger|act) (at|below|under)\b/, 0.5), R(/\bkeep (my loan|me) safe\b/, 0.9),
  ],
  protect_off: [
    R(/\b(turn off|disable|deactivate|switch off|stop|pause|cancel)\b.*\b(protect|protection|guardian)\w*/, 1.4), R(/\bprotection off\b/, 1.3),
  ],
  protect_info: [
    R(/\bwhat (does|is|s) (the )?(protection|guardian|auto protection)\b/, 1.5), R(/\bhow does (the )?(protection|guardian) work\b/, 1.5),
    R(/\bexplain (the )?(protection|guardian)\b/, 1.4),
  ],
  send: [
    R(/\b(send|transfer|give|tip|pay)\b/, 0.7), R(/\bto @user\b/, 0.4), R(/\bto 0xaddr\b/, 0.4),
  ],
  claim_link: [
    R(/\bclaim ?links?\b/, 1.4), R(/\bgift (link|card)\b/, 1.3), R(/\b(send|make|create) (a |me a )?link\b/, 1.1),
    R(/\b(no|without a?) wallet\b/, 0.5),
  ],
  request: [
    R(/\b(request|ask for|collect|charge|invoice)\b/, 1.0), R(/\bfrom (the |this )?(group|everyone|chat|people)\b/, 0.4), R(/\b(owe|owes) me\b/, 1.1),
  ],
  split: [R(/\bsplit\b/, 1.3), R(/\b(divide|share) (the )?(bill|cost|check)\b/, 1.2), R(/\bgo halves\b/, 1.0)],
  position: [
    R(/\b(my )?(position|status|portfolio|dashboard|overview)\b/, 1.0), R(/\bhow much (do i|i) owe\b/, 1.2), R(/\bmy (loan|debt)\b/, 0.7),
    R(/\bshow (me )?(my )?(loan|position|account)\b/, 1.0),
  ],
  safety: [
    R(/\bhow safe\b/, 1.4), R(/\bam i (at risk|safe|ok|okay|in danger|fine)\b/, 1.4), R(/\bis my (loan|position) (safe|ok|okay|at risk|healthy)\b/, 1.4),
    R(/\b(my )?(ratio|health|risk level)\b/, 0.7), R(/\brisk\b/, 0.5), R(/\bsafe\b/, 0.4),
  ],
  liquidation: [
    R(/\b(when|at what price|what price)\b.*\bliquidat\w*/, 1.5), R(/\bliquidation price\b/, 1.4), R(/\bget liquidated\b/, 1.0), R(/\bliquidat\w*/, 0.6),
  ],
  whatif: [
    R(/\bwhat if\b/, 0.9), R(/\b(btc|bitcoin|price)\b.*\b(drops?|falls?|crash\w*|dumps?|goes down|tanks?|hits?|goes to)\b/, 0.9),
    R(/\b(drops?|falls?|down) (by )?\d+(\.\d+)? percent\b/, 0.6),
  ],
  alerts: [R(/\b(alerts?|notifications?|notify)\b/, 1.0), R(/\bwarn me\b/, 0.8)],
  mute: [R(/\b(mute|silence|stop|turn off|disable|pause|no more)\b.*\b(alerts?|notifications?|messages?)\b/, 1.5), R(/^mute\b/, 1.3), R(/\bunsubscribe\b/, 1.0)],
  unmute: [R(/\bunmute\b/, 1.5), R(/\b(turn on|enable|resume|start)\b.*\b(alerts?|notifications?)\b/, 1.5)],
  fees: [R(/\b(fees?|costs?|charges?|apr)\b/, 1.1), R(/\binterest( rate)?\b/, 1.0), R(/\bhow much does (it|this|borrowing) cost\b/, 1.3)],
  what_musd: [R(/\bwhat (is|s|are) musd\b/, 1.6), R(/\bmusd\b/, 0.3), R(/\bwhat is mezo\b/, 1.3)],
  help: [
    R(/^(help|menu|commands|options|\?)$/, 1.5), R(/\bwhat can you do\b/, 1.5), R(/\bhow (does this|do you|do i use (this|you)) work\b/, 1.3), R(/\bhelp\b/, 1.0),
  ],
  greeting: [R(/^(hi|hello|hey|hiya|gm|good (morning|afternoon|evening)|yo|sup|start)\b/, 1.1)],
  link_wallet: [R(/\b(connect|link|bind|add) (my |a )?wallet\b/, 1.4), R(/\bmetamask\b/, 0.6), R(/\b(switch|change) (my |to a |to another )?wallets?\b/, 1.4)],
  disconnect: [R(/\b(disconnect|unlink|log ?out|sign out|remove|forget)\b.*\bwallet\b/, 1.6), R(/^(disconnect|unlink|logout|log out)$/, 1.6)],
  premium: [R(/\bpremium\b/, 1.3), R(/\bfaster alerts\b/, 1.2)],
  history: [
    R(/^(my )?(history|activity|transactions?|txs?)$/, 1.8), R(/\b(what ?s|what is|show|see|check|view) (me )?(my )?(transaction |tx |payment )?(history|activity)\b/, 1.6),
    R(/\b(recent|past|last|latest) (transactions|activity|payments|txs?)\b/, 1.5), R(/\bwhat (did|have) i (do|done|sent|send|received)\b/, 1.5),
    R(/\bmy (history|activity|transactions|payments)\b/, 1.3), R(/\b(history|transactions)\b/, 0.6),
  ],
  balance: [
    R(/^(my )?(balance|balances|wallet)$/, 1.8), R(/\b(what ?s|what is|show|check|see) (me )?(my )?(wallet )?(balance|balances)\b/, 1.6),
    R(/\bhow much (do i have|have i got|money do i have|is in my wallet|musd do i have|btc do i have|bitcoin do i have)\b/, 1.6),
    R(/\bmy (wallet|balance|balances|funds)\b/, 0.9),
  ],
}

// ------------------------------------------------------------------------------------------ slots

function extractSlots(text: string, usernames: string[], address: string | undefined, quoted: string | undefined): Slots {
  const slots: Slots = { percents: [], usernames: [...usernames], address }
  const t = text

  // percents: "180 percent", "ratio 200", "at 170" when it looks like a ratio
  for (const m of t.matchAll(/\b(\d+(?:\.\d+)?) percent\b/g)) slots.percents.push(parseFloat(m[1]))
  for (const m of t.matchAll(/\b(?:ratio|cr|icr|trigger|target)(?: of| at| to)? (\d{3}(?:\.\d+)?)\b(?! percent)/g)) slots.percents.push(parseFloat(m[1]))

  // what-if
  const drop = t.match(/\b(?:drops?|falls?|down|dumps?|crash\w*|tanks?|loses?)\s+(?:by\s+)?(\d+(?:\.\d+)?) percent\b/) ?? t.match(/\b(\d+(?:\.\d+)?) percent\s+(?:drop|fall|crash|dip|down)\b/) ?? t.match(/-(\d+(?:\.\d+)?) percent\b/)
  if (drop) slots.drop = parseFloat(drop[1])
  const target = t.match(/\b(?:to|at|hits?|reaches?|goes to|falls to|drops to)\s+(\d{4,7}(?:\.\d+)?)(?: usd| dollars)?\b/)
  if (target && !drop) slots.priceTarget = parseFloat(target[1])

  // amount: first number that isn't a percent / ratio / price target
  const used = new Set<number>()
  for (const m of t.matchAll(/\b(\d+(?:\.\d+)?) percent\b/g)) used.add(m.index!)
  const numbers = [...t.matchAll(/(?<![\w.])(-?\d+(?:\.\d+)?)(?![\w.])/g)].filter((m) => !used.has(m.index!))
  for (const m of numbers) {
    const n = m[1]
    const after = t.slice(m.index! + n.length, m.index! + n.length + 12)
    const before = t.slice(Math.max(0, m.index! - 14), m.index!)
    if (/^ percent/.test(after)) continue
    if (/(ratio|cr|icr|trigger|target)( of| at| to)? $/.test(before)) continue
    if (slots.priceTarget !== undefined && parseFloat(n) === slots.priceTarget) continue
    if (n.startsWith("-")) continue
    if (slots.amount === undefined) {
      slots.amount = n
      if (/^ ?(btc|bitcoin|sats|sat)\b/.test(after)) slots.unit = "btc"
      else if (/^ ?(usd|musd|usdc|usdt|dollars?|bucks|dai)\b/.test(after)) slots.unit = "musd"
      if (/^ ?sats?\b/.test(after)) slots.amount = String(Number(n) / 1e8)
    } else if (slots.percents.length < 2) {
      // a second bare number: "borrow 1500 180" / "protect 170 180"
      const v = parseFloat(n)
      if (v > 100 && v <= 1000) slots.percents.push(v)
    }
  }
  if (/\b(everything|all of it|in full|the whole (loan|thing|debt)|it all|all my debt|whole loan|max|maximum)\b/.test(t)) slots.all = true

  // memo: "for lunch", "for the pizza" (not "for @user", not a number)
  const memo = t.match(/\bfor (?!@user\b|\d)(?:the |a |our )?([a-z][a-z0-9 ]{1,40}?)(?=$| with | to | from | and @user)/)
  if (memo && !/^(me|my loan|my debt|it|protection|everyone|the group|real)$/.test(memo[1])) slots.memo = memo[1].trim()
  if (quoted) slots.memo = quoted

  // splits name people without @: "split 90 with ada, bob and chidi" (commas are spaces by now)
  if (/\b(split|divide|share)\b/.test(t)) {
    if (/\b(everyone|everybody|all of us|the group|whoever)\b/.test(t)) slots.everyone = true
    if (/\b(without|not|excluding|exclude|except) me\b|\bnot including me\b/.test(t)) slots.excludeMe = true
    const list = t.match(/\b(?:with|between|among|amongst)\s+(.+?)(?=\s+for\s|\s+without\s|\s+not\s|\s+excluding\s|\s+except\s|$)/)
    if (list && !slots.usernames.length) {
      const stop = /^(and|me|us|everyone|everybody|all|of|the|group|friends|them|whoever|@user|musd|usd|dollars|equally|evenly)$/
      for (const w of list[1].split(/\s+/)) if (/^[a-z][a-z0-9_]{2,31}$/.test(w) && !stop.test(w) && !/^\d/.test(w)) slots.usernames.push(w)
    }
  }

  // bare recipient: "send 20 to ada" (Telegram usernames are 5+ chars)
  if (!slots.usernames.length && !slots.address) {
    const bare = t.match(/\bto ([a-z][a-z0-9_]{4,31})\b/)
    if (bare && !/^(the|my|your|group|everyone|wallet|keel|bitcoin|reserve|loan|protection|guardian|collateral)$/.test(bare[1])) slots.usernames.push(bare[1])
  }
  return slots
}

// ------------------------------------------------------------------------------------------ parse

export function parse(input: string): Parsed {
  const { text: raw, usernames, address, quoted } = normalize(input)
  const corrections: Array<[string, string]> = []
  const text = raw
    .split(" ")
    .map((w) => {
      const c = correct(w)
      if (c) corrections.push([w, c])
      return c ?? w
    })
    .join(" ")
  const slots = extractSlots(text, usernames, address, quoted)
  const scoringText = text.replace(/@user/g, "@user").concat(address ? " to 0xaddr" : "")

  const scores = new Map<NluIntent, number>()
  for (const [intent, rules] of Object.entries(RULES) as Array<[NluIntent, Rule[]]>) {
    let sc = 0
    for (const r of rules) if (r.re.test(scoringText)) sc += r.w
    if (sc > 0) scores.set(intent, sc)
  }
  const bump = (i: NluIntent, by: number) => scores.has(i) && scores.set(i, scores.get(i)! + by)
  const hasRecipient = slots.usernames.length > 0 || !!slots.address

  // slot-aware adjustments
  if (hasRecipient) bump("send", 0.5)
  if (slots.amount) bump("send", 0.35) // "send 15": a payment verb plus an amount is enough to ask who
  if (/\b(back|off|down)\b/.test(text) && /\bpay\b/.test(text)) scores.set("send", Math.max(0, (scores.get("send") ?? 0) - 0.8))
  if (slots.usernames.length >= 2 || /\bwith @user\b/.test(text)) bump("split", 0.4)
  if (scores.has("split")) scores.set("request", Math.max(0, (scores.get("request") ?? 0) - 0.5))
  if (scores.has("claim_link")) scores.set("send", Math.max(0, (scores.get("send") ?? 0) - 0.6))
  if (slots.unit === "btc") {
    bump("add_collateral", 0.2)
  }
  if (slots.unit === "musd") scores.set("add_collateral", Math.max(0, (scores.get("add_collateral") ?? 0) - 0.4))
  if (scores.has("fund_reserve") && /\breserve\b/.test(text)) scores.set("add_collateral", Math.max(0, (scores.get("add_collateral") ?? 0) - 0.4))
  if (scores.has("protect_off")) scores.set("protect_on", Math.max(0, (scores.get("protect_on") ?? 0) - 1.3))
  if (scores.has("protect_info")) scores.set("protect_on", Math.max(0, (scores.get("protect_on") ?? 0) - 1.0))
  if (scores.has("mute") || scores.has("unmute")) {
    scores.set("alerts", Math.max(0, (scores.get("alerts") ?? 0) - 0.6))
    scores.set("protect_on", Math.max(0, (scores.get("protect_on") ?? 0) - 1.0))
    scores.set("protect_off", Math.max(0, (scores.get("protect_off") ?? 0) - 1.0))
  }
  if ((scores.has("protect_on") || scores.has("protect_off")) && /\b(alerts?|notifications?)\b/.test(text)) {
    scores.set("protect_on", 0)
    scores.set("protect_off", 0)
  }
  if (scores.has("whatif") && (slots.drop !== undefined || slots.priceTarget !== undefined)) bump("whatif", 0.6)
  if (scores.has("whatif")) {
    for (const k of ["safety", "liquidation", "position"] as NluIntent[]) scores.set(k, Math.max(0, (scores.get(k) ?? 0) - 0.5))
  }
  if (scores.has("liquidation") && (scores.get("liquidation") ?? 0) >= 1.4) scores.set("safety", Math.max(0, (scores.get("safety") ?? 0) - 0.6))
  if (scores.has("fees") && /\b(what|how much|which)\b/.test(text)) bump("fees", 0.3)
  if (scores.has("what_musd") && (scores.get("what_musd") ?? 0) >= 1.3) scores.set("help", 0)
  // pay + a request id-like flow is a send; "request" with a recipient-from is still a request
  if (scores.has("request") && /\bfrom @user\b/.test(text)) bump("request", 0.4)
  if (scores.has("request") && /\bfrom\b/.test(text)) scores.set("send", Math.max(0, (scores.get("send") ?? 0) - 0.5))
  // bare amount with no verb at all is not enough to act on
  for (const [k, v] of scores) if (v <= 0) scores.delete(k)

  const rank = () => [...scores.entries()].sort((a, b) => b[1] - a[1])
  let ranked = rank()
  // protection talks in ratios: "protect me at 170", "protect 170 180" -> the bare numbers are percents
  if (ranked[0]?.[0] === "protect_on" && slots.amount && !slots.unit) {
    const v = parseFloat(slots.amount)
    if (v > 110 && v <= 500) {
      slots.percents.unshift(v)
      slots.amount = undefined
      bump("protect_on", 0.6)
      ranked = rank()
    }
  }
  if (!ranked.length) return { intent: null, confidence: 0, slots, alternatives: [], corrections, normalized: text }
  const [top, topScore] = ranked[0]
  const second = ranked[1]?.[1] ?? 0
  // close race: lower the confidence so the user is asked
  let confidence = topScore
  if (second > 0 && topScore - second < 0.25) confidence = Math.min(confidence, ACCEPT - 0.01)
  // corrected typos are trusted a little less
  if (corrections.length) confidence -= 0.15 * corrections.length
  return {
    intent: confidence >= ASK ? top : null,
    confidence,
    slots,
    alternatives: ranked.slice(confidence >= ACCEPT ? 1 : 0, 4).map(([k]) => k),
    corrections,
    normalized: text,
  }
}

/** Human labels for buttons and "Did you mean...?" */
export const INTENT_LABEL: Record<NluIntent, string> = {
  borrow: "Borrow MUSD", repay: "Repay", add_collateral: "Add collateral", fund_reserve: "Fund reserve",
  protect_on: "Turn on protection", protect_off: "Turn off protection", protect_info: "How protection works",
  send: "Send MUSD", claim_link: "Claim link", request: "Request payment", split: "Split a bill",
  position: "My position", safety: "How safe am I", liquidation: "Liquidation price", whatif: "What if BTC drops",
  alerts: "Alert settings", mute: "Mute alerts", unmute: "Unmute alerts",
  fees: "Fees", what_musd: "What is MUSD", help: "Help", greeting: "Hi", link_wallet: "Connect wallet", disconnect: "Disconnect wallet", premium: "Premium alerts",
  history: "My history", balance: "My balance",
}

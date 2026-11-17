// kwtSMS one-time codes for TanStack Start (kwtsms-tanstack add-on). Server-only.
// Codes and limits live in this server process's memory: fine for one server and for trying it out.
// For several servers or serverless, keep the same logic and move the maps below to Redis or your database.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { validatePhoneInput } from 'kwtsms'
import { isTestMode, sendSms, toKwtsmsNumber } from './kwtsms.server'

const CODE_TTL_MS = 5 * 60_000
const RESEND_COOLDOWN_MS = 60_000
const MAX_ATTEMPTS = 5
const IP_WINDOW_MS = 10 * 60_000
const IP_MAX_SENDS = 10
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const NUMBER_MAX_PER_DAY = 10
const MAX_TRACKED = 10_000 // upper bound for each map, so a flood cannot exhaust memory

type Entry = { hash: Buffer; expiresAt: number; attempts: number }
const codes = new Map<string, Entry>()
const lastSent = new Map<string, number>() // kept after a code is used, so the resend wait still applies
const ipHits = new Map<string, number[]>()
const numberHits = new Map<string, number[]>()
let allHits: number[] = []

export type OtpSendResult =
  | { ok: true; phone: string; expiresInSec: number; testMode: boolean; devCode?: string }
  | { ok: false; code: string; message: string; retryAfterSec?: number }

export type OtpVerifyResult =
  | { ok: true; phone: string }
  | { ok: false; code: 'NO_CODE' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS' | 'WRONG_CODE'; message: string }

function secret(): string {
  const s = process.env.KWTSMS_OTP_SECRET
  if (!s || s.length < 32) {
    throw new Error('kwtSMS OTP: set KWTSMS_OTP_SECRET in .env.local to a random string of 32 or more characters.')
  }
  return s
}

function digest(phone: string, code: string, expiresAt: number): Buffer {
  return createHmac('sha256', secret()).update(`${phone}:${code}:${expiresAt}`).digest()
}

// Only these country codes can receive codes (SMS pumping guard). Comma list, default Kuwait.
function allowed(phone: string): boolean {
  const list = (process.env.KWTSMS_OTP_ALLOWED_PREFIXES || '965').split(',').map((p) => p.trim()).filter(Boolean)
  return list.some((p) => phone.startsWith(p))
}

// One bucket per IPv4 address or per IPv6 /64 (one client can rotate inside its /64). No IP = one shared bucket.
function ipKey(ip?: string): string {
  if (!ip) return 'unknown'
  const addr = ip.split('%')[0].toLowerCase()
  if (!addr.includes(':') || addr.startsWith('::ffff:')) return addr.replace(/^::ffff:/, '')
  const [head, tail] = addr.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`
}

function recent(hits: number[] | undefined, now: number, window: number): number[] {
  return (hits ?? []).filter((t) => now - t < window)
}

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value as string) // drop the oldest
}

// Drops old entries so the maps do not grow without limit.
function prune(now: number) {
  for (const [k, t] of lastSent) if (now - t > RESEND_COOLDOWN_MS) lastSent.delete(k)
  for (const [k, e] of codes) if (now > e.expiresAt) codes.delete(k)
  for (const [k, hits] of ipHits) if (hits.every((t) => now - t >= IP_WINDOW_MS)) ipHits.delete(k)
  for (const [k, hits] of numberHits) if (hits.every((t) => now - t >= DAY_MS)) numberHits.delete(k)
  allHits = recent(allHits, now, HOUR_MS)
}

function tooMany(message: string, since: number, window: number, now: number): OtpSendResult {
  return { ok: false, code: 'TOO_MANY_REQUESTS', message, retryAfterSec: Math.ceil((window - (now - since)) / 1000) }
}

/**
 * Sends a 6-digit code by SMS. Pass the client IP so one visitor cannot send codes to many numbers.
 * Limits: 60 s between codes per number, 10 codes per number per day, 10 per IP (IPv6: per /64) per 10 minutes,
 * and KWTSMS_OTP_MAX_PER_HOUR codes per hour in total (default 100).
 */
export async function sendOtp(phoneInput: string, opts: { ip?: string } = {}): Promise<OtpSendResult> {
  secret() // fail before any SMS is sent when the secret is missing
  const phone = toKwtsmsNumber(phoneInput)
  const [valid, error] = validatePhoneInput(phone)
  if (!valid) return { ok: false, code: 'INVALID_NUMBER', message: error ?? 'This phone number is not valid.' }
  if (!allowed(phone)) {
    return { ok: false, code: 'COUNTRY_NOT_ALLOWED', message: 'Codes can only be sent to the countries in KWTSMS_OTP_ALLOWED_PREFIXES.' }
  }
  const now = Date.now()
  prune(now)
  const last = lastSent.get(phone)
  if (last && now - last < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000)
    return { ok: false, code: 'COOLDOWN', message: `Wait ${wait} seconds before asking for a new code.`, retryAfterSec: wait }
  }
  const maxPerHour = Number(process.env.KWTSMS_OTP_MAX_PER_HOUR || 100)
  if (allHits.length >= maxPerHour) return tooMany('Too many codes requested. Try again later.', allHits[0], HOUR_MS, now)
  const perNumber = recent(numberHits.get(phone), now, DAY_MS)
  if (perNumber.length >= NUMBER_MAX_PER_DAY) {
    return tooMany('Too many codes for this number today. Try again tomorrow.', perNumber[0], DAY_MS, now)
  }
  const ip = ipKey(opts.ip)
  const perIp = recent(ipHits.get(ip), now, IP_WINDOW_MS)
  if (perIp.length >= IP_MAX_SENDS) return tooMany('Too many codes requested. Try again later.', perIp[0], IP_WINDOW_MS, now)
  remember(ipHits, ip, [...perIp, now])
  remember(numberHits, phone, [...perNumber, now])
  allHits.push(now)
  remember(lastSent, phone, now)

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = now + CODE_TTL_MS
  // Keep the template plain ASCII: one non-GSM character makes the SMS Unicode (70 characters per part, not 160).
  const text = (process.env.KWTSMS_OTP_TEMPLATE || 'Your verification code is {code}. It expires in 5 minutes.').replace('{code}', code)
  const sent = await sendSms(phone, text)
  if (!sent.ok) return sent
  remember(codes, phone, { hash: digest(phone, code, expiresAt), expiresAt, attempts: 0 })
  const showCode = sent.testMode && process.env.NODE_ENV !== 'production'
  return { ok: true, phone, expiresInSec: CODE_TTL_MS / 1000, testMode: sent.testMode, ...(showCode ? { devCode: code } : {}) }
}

/** Checks a code. A code works once; after 5 wrong tries the user must ask for a new one. */
export function verifyOtp(phoneInput: string, code: string): OtpVerifyResult {
  const phone = toKwtsmsNumber(phoneInput)
  const entry = codes.get(phone)
  if (!entry) return { ok: false, code: 'NO_CODE', message: 'Ask for a code first.' }
  if (Date.now() > entry.expiresAt) {
    codes.delete(phone)
    return { ok: false, code: 'EXPIRED', message: 'This code has expired. Ask for a new one.' }
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    codes.delete(phone)
    return { ok: false, code: 'TOO_MANY_ATTEMPTS', message: 'Too many wrong codes. Ask for a new one.' }
  }
  entry.attempts++
  const given = digest(phone, String(code).trim(), entry.expiresAt)
  if (!timingSafeEqual(given, entry.hash)) {
    return { ok: false, code: 'WRONG_CODE', message: 'Wrong code. Check the SMS and try again.' }
  }
  codes.delete(phone)
  return { ok: true, phone }
}

export { isTestMode }

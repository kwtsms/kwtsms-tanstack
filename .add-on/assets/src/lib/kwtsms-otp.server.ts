// kwtSMS one-time codes for TanStack Start (kwtsms-tanstack add-on). Server-only.
// Codes live in this server process's memory: fine for one server and for trying it out.
// For several servers or serverless, keep the same logic and move `codes` and `ipHits` to Redis or your database.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { validatePhoneInput } from 'kwtsms'
import { isTestMode, sendSms, toKwtsmsNumber } from './kwtsms.server'

const CODE_TTL_MS = 5 * 60_000
const RESEND_COOLDOWN_MS = 60_000
const MAX_ATTEMPTS = 5
const IP_WINDOW_MS = 10 * 60_000
const IP_MAX_SENDS = 10

type Entry = { hash: Buffer; expiresAt: number; attempts: number }
const codes = new Map<string, Entry>()
const lastSent = new Map<string, number>() // kept after a code is used, so the resend wait still applies
const ipHits = new Map<string, number[]>()

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

// Drops old entries so the maps do not grow without limit.
function prune(now: number) {
  for (const [k, t] of lastSent) if (now - t > RESEND_COOLDOWN_MS) lastSent.delete(k)
  for (const [k, e] of codes) if (now > e.expiresAt) codes.delete(k)
  for (const [k, hits] of ipHits) if (hits.every((t) => now - t >= IP_WINDOW_MS)) ipHits.delete(k)
}

/** Sends a 6-digit code by SMS. Pass the client IP so one visitor cannot send codes to many numbers. */
export async function sendOtp(phoneInput: string, opts: { ip?: string } = {}): Promise<OtpSendResult> {
  const phone = toKwtsmsNumber(phoneInput)
  const [valid, error] = validatePhoneInput(phone)
  if (!valid) return { ok: false, code: 'INVALID_NUMBER', message: error ?? 'This phone number is not valid.' }
  if (!allowed(phone)) {
    return { ok: false, code: 'COUNTRY_NOT_ALLOWED', message: 'Codes can only be sent to the countries in KWTSMS_OTP_ALLOWED_PREFIXES.' }
  }
  const now = Date.now()
  prune(now)
  if (opts.ip) {
    const hits = (ipHits.get(opts.ip) ?? []).filter((t) => now - t < IP_WINDOW_MS)
    if (hits.length >= IP_MAX_SENDS) {
      return { ok: false, code: 'TOO_MANY_REQUESTS', message: 'Too many codes requested. Try again later.', retryAfterSec: Math.ceil((IP_WINDOW_MS - (now - hits[0])) / 1000) }
    }
    ipHits.set(opts.ip, [...hits, now])
  }
  const last = lastSent.get(phone)
  if (last && now - last < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000)
    return { ok: false, code: 'COOLDOWN', message: `Wait ${wait} seconds before asking for a new code.`, retryAfterSec: wait }
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = now + CODE_TTL_MS
  // Keep the template plain ASCII: one non-GSM character makes the SMS Unicode (70 characters per part, not 160).
  const text = (process.env.KWTSMS_OTP_TEMPLATE || 'Your verification code is {code}. It expires in 5 minutes.').replace('{code}', code)
  const sent = await sendSms(phone, text)
  if (!sent.ok) return sent
  codes.set(phone, { hash: digest(phone, code, expiresAt), expiresAt, attempts: 0 })
  lastSent.set(phone, now)
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

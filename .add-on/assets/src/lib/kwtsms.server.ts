// kwtSMS for TanStack Start: server-only SMS helpers (kwtsms-tanstack add-on).
// Reads KWTSMS_* from the environment. Never import this file from client code.
import { KwtSMS, normalizePhone } from 'kwtsms'

export type SmsResult =
  | {
      ok: true
      msgId: string
      numbers: number
      pointsCharged: number
      balanceAfter: number | null
      testMode: boolean
    }
  | { ok: false; code: string; message: string; invalid?: { input: string; error: string }[] }

let client: KwtSMS | null = null

/** True unless KWTSMS_TEST_MODE is set to 0. Test messages are queued, never delivered. */
export function isTestMode(): boolean {
  return process.env.KWTSMS_TEST_MODE !== '0'
}

/** The kwtSMS client, created on first use from KWTSMS_USERNAME, KWTSMS_PASSWORD and KWTSMS_SENDER_ID. */
export function kwtsms(): KwtSMS {
  if (client) return client
  const username = process.env.KWTSMS_USERNAME
  const password = process.env.KWTSMS_PASSWORD
  if (!username || !password) {
    throw new Error(
      'kwtSMS: set KWTSMS_USERNAME and KWTSMS_PASSWORD in .env.local (your API username and password from the API page of your kwtSMS account, not your website login).',
    )
  }
  client = new KwtSMS(username, password, {
    senderId: process.env.KWTSMS_SENDER_ID || 'KWT-SMS',
    testMode: isTestMode(),
    logFile: '',
    appName: 'kwtsms-tanstack/0.1.0',
  })
  return client
}

/**
 * Normalizes a number the way kwtSMS expects it: Arabic-Indic digits to Latin, no +, 00 or spaces.
 * A local 8-digit number gets KWTSMS_DEFAULT_COUNTRY_CODE (965 when not set).
 */
export function toKwtsmsNumber(input: string): string {
  const n = normalizePhone(input)
  return n.length === 8 ? (process.env.KWTSMS_DEFAULT_COUNTRY_CODE || '965') + n : n
}

/** Sends one SMS to one or more numbers. Never throws for API errors: check result.ok. */
export async function sendSms(
  to: string | string[],
  message: string,
  senderId?: string,
): Promise<SmsResult> {
  const numbers = (Array.isArray(to) ? to : [to]).map(toKwtsmsNumber)
  const r = await kwtsms().send(numbers, message, senderId)
  if (r.result === 'OK') {
    const ids = 'msg-ids' in r ? (r['msg-ids'] as string[]) : [String(r['msg-id'])]
    return {
      ok: true,
      msgId: ids.join(','),
      numbers: Number(r.numbers),
      pointsCharged: Number(r['points-charged']),
      balanceAfter: r['balance-after'] == null ? null : Number(r['balance-after']),
      testMode: isTestMode(),
    }
  }
  const action = 'action' in r && typeof r.action === 'string' ? ` ${r.action}` : ''
  return {
    ok: false,
    code: String(r.code ?? 'ERROR'),
    message: `${String(r.description ?? 'Sending failed.')}${action}`.trim(),
    ...(r.invalid?.length ? { invalid: r.invalid } : {}),
  }
}

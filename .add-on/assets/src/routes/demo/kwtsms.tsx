// kwtSMS demo (kwtsms-tanstack add-on): send an SMS and try a one-time code.
// Turned off in production unless KWTSMS_DEMO=1, so nobody can spend your credits from this page.
import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getRequestIP } from '@tanstack/react-start/server'
import { isTestMode, kwtsms, sendSms } from '#/lib/kwtsms.server'
import { sendOtp, verifyOtp } from '#/lib/kwtsms-otp.server'

// Server functions accept any JSON from the network: check type and size before use.
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new Error(`${name}: enter 1 to ${max} characters.`)
  }
  return value
}

function demoAllowed() {
  if (process.env.NODE_ENV === 'production' && process.env.KWTSMS_DEMO !== '1') {
    throw new Error('The kwtSMS demo is off in production. Set KWTSMS_DEMO=1 to turn it on.')
  }
}

const isProduction = () => process.env.NODE_ENV === 'production'

const getStatus = createServerFn({ method: 'GET' }).handler(async () => {
  demoAllowed()
  const [ok, balance, error] = await kwtsms().verify()
  // Visitors of a production demo do not need your balance.
  return { testMode: isTestMode(), ok, balance: isProduction() ? null : balance, error, senderId: kwtsms().senderId }
})

const sendSmsFn = createServerFn({ method: 'POST' })
  .validator((d: { to: string; message: string }) => ({
    to: text(d?.to, 'Phone number', 40),
    message: text(d?.message, 'Message', 1000),
  }))
  .handler(async ({ data }) => {
    demoAllowed()
    // Free text to any number would make a public demo an open SMS relay: development only.
    if (isProduction()) throw new Error('Send SMS is off in production. The one-time code demo stays on with KWTSMS_DEMO=1.')
    return sendSms(data.to, data.message)
  })

const sendOtpFn = createServerFn({ method: 'POST' })
  .validator((d: { phone: string }) => ({ phone: text(d?.phone, 'Phone number', 40) }))
  .handler(async ({ data }) => {
    demoAllowed()
    // Trust X-Forwarded-For only behind your own proxy (KWTSMS_TRUST_PROXY=1): a client can set it to dodge the IP limit.
    return sendOtp(data.phone, { ip: getRequestIP({ xForwardedFor: process.env.KWTSMS_TRUST_PROXY === '1' }) })
  })

const verifyOtpFn = createServerFn({ method: 'POST' })
  .validator((d: { phone: string; code: string }) => ({
    phone: text(d?.phone, 'Phone number', 40),
    code: text(d?.code, 'Code', 10),
  }))
  .handler(async ({ data }) => {
    demoAllowed()
    return verifyOtp(data.phone, data.code)
  })

export const Route = createFileRoute('/demo/kwtsms')({
  loader: () => getStatus(),
  component: KwtsmsDemo,
})

const box = 'island-shell rounded-2xl p-6 sm:p-8 mb-6'
const input = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900'
const button = 'rounded-lg bg-[#FFA200] px-5 py-2 font-semibold text-black disabled:opacity-50'

function Result({ value }: { value: unknown }) {
  if (!value) return null
  return <pre className="mt-4 overflow-x-auto rounded-lg bg-gray-900 p-3 text-sm text-gray-100">{JSON.stringify(value, null, 2)}</pre>
}

function KwtsmsDemo() {
  const status = Route.useLoaderData()
  const [to, setTo] = useState('')
  const [message, setMessage] = useState('Hello from TanStack Start and kwtSMS')
  const [sendResult, setSendResult] = useState<unknown>(null)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [otpResult, setOtpResult] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<unknown>, set: (v: unknown) => void) {
    setBusy(true)
    try {
      set(await fn())
    } catch (e) {
      set({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page-wrap px-4 py-12">
      <section className={box}>
        <h1 className="mb-3 text-3xl font-bold">kwtSMS</h1>
        {status.testMode ? (
          <p className="mb-2 inline-block rounded-md bg-[#FFF3D4] px-3 py-1 text-sm font-semibold text-[#8B6000]">
            TEST MODE: messages are queued, not delivered. Set KWTSMS_TEST_MODE=0 to send for real.
          </p>
        ) : (
          <p className="mb-2 inline-block rounded-md bg-red-100 px-3 py-1 text-sm font-semibold text-red-800">
            LIVE: messages are delivered and use credits.
          </p>
        )}
        <p className="m-0 text-sm">
          {status.ok
            ? `Connected.${status.balance == null ? '' : ` Balance: ${status.balance} credits.`} Sender ID: ${status.senderId}`
            : `Not connected: ${status.error}`}
        </p>
      </section>

      <section className={box}>
        <h2 className="mb-4 text-xl font-bold">Send SMS</h2>
        <label className="mb-1 block text-sm font-medium" htmlFor="to">Phone number</label>
        <input id="to" className={input} value={to} onChange={(e) => setTo(e.target.value)} placeholder="965XXXXXXXX" inputMode="tel" />
        <label className="mb-1 mt-4 block text-sm font-medium" htmlFor="msg">Message</label>
        <textarea id="msg" className={input} rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
        <button className={`${button} mt-4`} disabled={busy || !to || !message} onClick={() => run(() => sendSmsFn({ data: { to, message } }), setSendResult)}>
          Send SMS
        </button>
        <Result value={sendResult} />
      </section>

      <section className={box}>
        <h2 className="mb-4 text-xl font-bold">One-time code</h2>
        <label className="mb-1 block text-sm font-medium" htmlFor="phone">Phone number</label>
        <input id="phone" className={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="965XXXXXXXX" inputMode="tel" />
        <button className={`${button} mt-4`} disabled={busy || !phone} onClick={() => run(() => sendOtpFn({ data: { phone } }), setOtpResult)}>
          Send code
        </button>
        <label className="mb-1 mt-6 block text-sm font-medium" htmlFor="code">Code</label>
        <input id="code" className={input} value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 digits" inputMode="numeric" maxLength={6} />
        <button className={`${button} mt-4`} disabled={busy || !phone || code.length !== 6} onClick={() => run(() => verifyOtpFn({ data: { phone, code } }), setOtpResult)}>
          Verify
        </button>
        <Result value={otpResult} />
      </section>
    </main>
  )
}

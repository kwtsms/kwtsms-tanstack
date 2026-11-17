# kwtSMS for TanStack Start

[![CI](https://github.com/kwtsms/kwtsms-tanstack/actions/workflows/ci.yml/badge.svg)](https://github.com/kwtsms/kwtsms-tanstack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Send SMS and one-time codes (OTP) from your TanStack Start app, through kwtSMS, the Kuwaiti SMS gateway.

A TanStack CLI add-on. It adds server-only SMS helpers, a one-time code service and a demo page to a new or existing app.

## Requirements

- TanStack CLI (`@tanstack/cli`), React, file-router mode
- Node.js 20 or later
- A kwtSMS account (free test account, no papers): https://www.kwtsms.com/cportal/signup/

## Installation

New app:

```bash
npx @tanstack/cli create my-app --add-ons https://raw.githubusercontent.com/kwtsms/kwtsms-tanstack/v0.1.0/add-on.json
```

With other add-ons, for example Better Auth and TanStack Query:

```bash
npx @tanstack/cli create my-app --add-ons better-auth,tanstack-query,https://raw.githubusercontent.com/kwtsms/kwtsms-tanstack/v0.1.0/add-on.json
```

## Setup

1. Open `.env.local` and set `KWTSMS_USERNAME` and `KWTSMS_PASSWORD`: the API username and password from the API page of your kwtSMS account, not your website login.
2. Run `npm run dev` and open http://localhost:3000/demo/kwtsms.
3. Test mode is on (`KWTSMS_TEST_MODE=1`): messages are queued, not delivered, and the demo shows the one-time code on screen. Test messages stay in your Sending Queue and hold their credits until you delete them there.
4. When you are ready, set your own Sender ID in `KWTSMS_SENDER_ID` and `KWTSMS_TEST_MODE=0`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KWTSMS_USERNAME`, `KWTSMS_PASSWORD` | | API login (required) |
| `KWTSMS_SENDER_ID` | `KWT-SMS` | The name people see. `KWT-SMS` is for testing only. |
| `KWTSMS_TEST_MODE` | `1` | `1` queues messages without delivery; `0` sends for real |
| `KWTSMS_DEFAULT_COUNTRY_CODE` | `965` | Added to local 8-digit numbers |
| `KWTSMS_OTP_SECRET` | generated | Signs one-time codes (32 or more characters) |
| `KWTSMS_OTP_ALLOWED_PREFIXES` | `965` | Country codes that may receive codes (comma list) |
| `KWTSMS_OTP_TEMPLATE` | see below | Code text, `{code}` is replaced |
| `KWTSMS_DEMO` | | Set `1` to keep the demo page on in production |

## What you get

| File | What it does |
| --- | --- |
| `src/lib/kwtsms.server.ts` | `sendSms(to, message)`, `kwtsms()` client, `isTestMode()`, `toKwtsmsNumber()` |
| `src/lib/kwtsms-otp.server.ts` | `sendOtp(phone, { ip })` and `verifyOtp(phone, code)` |
| `src/routes/demo/kwtsms.tsx` | Demo: account status, send SMS, send and check a code |

Both `lib` files are server-only. Call them from server functions or server routes, never from client code.

### Send an SMS

```ts
import { createServerFn } from '@tanstack/react-start'
import { sendSms } from '#/lib/kwtsms.server'

export const notifyOrder = createServerFn({ method: 'POST' })
  .validator((d: { phone: string; orderId: string }) => d)
  .handler(async ({ data }) => {
    const r = await sendSms(data.phone, `Your order ${data.orderId} is on its way.`)
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
    return r.msgId
  })
```

`sendSms` never throws for API errors: check `ok`. On success you get `msgId`, `numbers`, `pointsCharged` and `balanceAfter`; on failure the kwtSMS `code` (for example `ERR003`) and a plain `message`.

### One-time codes

```ts
import { getRequestIP } from '@tanstack/react-start/server'
import { sendOtp, verifyOtp } from '#/lib/kwtsms-otp.server'

await sendOtp(phone, { ip: getRequestIP({ xForwardedFor: true }) })
const r = verifyOtp(phone, code) // { ok: true } or { ok: false, code: 'WRONG_CODE' | 'EXPIRED' | ... }
```

Built in: 6-digit codes, 5 minutes expiry, 5 tries, 60 seconds before a new code, 10 codes per IP address in 10 minutes, and only the countries in `KWTSMS_OTP_ALLOWED_PREFIXES`. Codes are stored as an HMAC, never as plain text.

The default text is `Your verification code is {code}. It expires in 5 minutes.` Keep your own template in plain ASCII: one Unicode character (an emoji, a curly quote) makes the SMS Unicode, 70 characters per message instead of 160.

Codes live in the memory of one server process. That is fine for one server. For several servers or serverless, keep the same logic and move the two maps in `kwtsms-otp.server.ts` to Redis or your database.

### Better Auth phone number sign-in

With the Better Auth add-on, send its codes through kwtSMS (Better Auth `phoneNumber` plugin):

```ts
import { phoneNumber } from 'better-auth/plugins'
import { sendSms } from '#/lib/kwtsms.server'

phoneNumber({
  sendOTP: ({ phoneNumber, code }) => {
    // Do not await: keeps response times equal (Better Auth advice against timing attacks)
    void sendSms(phoneNumber, `Your verification code is ${code}.`)
  },
})
```

Add it to `plugins` in `src/lib/auth.ts` and follow the Better Auth guide for the client side and the database fields: https://www.better-auth.com/docs/plugins/phone-number

## Arabic

Arabic text is sent as is. One Arabic SMS holds 70 characters (67 per part in a long message). Arabic-Indic digits in phone numbers are converted for you, and emoji and hidden characters are removed from messages before sending.

## Security

- The demo page is off in production unless `KWTSMS_DEMO=1`.
- Your API password stays on the server. `.env.local` is in `.gitignore`.
- Report a security problem: see [SECURITY.md](SECURITY.md).

## Changelog

[CHANGELOG.md](CHANGELOG.md)

## Support

Help: https://www.kwtsms.com/support.html | FAQ: https://www.kwtsms.com/faq/ | API reference: https://www.kwtsms.com/api-documentation.html

## License

MIT, (c) kwtSMS (BoxLink Center)

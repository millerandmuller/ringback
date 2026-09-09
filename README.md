# Ringback

The automated call that can listen.

Clinics, pharmacies and school districts already call people automatically. Those calls play a
recording and count a keypress — press 1 to confirm, press 2 to cancel. There is no button for
"I can't come Thursday, my ride fell through, can you do Friday?"

Ringback is that call, made two-way, running on nothing but phone calls. You speak a message in
the browser; the line reads the back-translation to you in your own language and waits for your
permission; the recipient's ordinary phone rings and speaks it in hers; her spoken answer is
translated and rings your browser back. No app, no login and no data plan on her side — the only
address you need is a phone number.

## How it works

1. You click **Call the inbox** in the browser (Vonage Client SDK, in-app call).
2. The line asks who the message is for, then records the message (Vonage speech recognition).
3. Claude translates it, and the line reads back the back-translation before anything is sent.
4. Press 1: an outbound call rings the recipient's phone and speaks the message in her language.
5. She answers by keypad ("understood") or by voice — her reply is translated and rings your
   browser back.

Every step is a real Vonage Voice API primitive: speech input, text-to-speech in two languages,
two outbound calls, DTMF, call recording with transcription, and an in-app call via the Client
SDK. See `src/voice/ncco.ts` for the exact call-flow scripts and `src/voice/flow.ts` for the
state machine that drives them.

## Setup

Requires Node.js 20+, a Vonage Voice application (with an RTC/Client SDK capability enabled for
the in-app "manager" call), one Vonage number linked to it, and an Anthropic API key.

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `VONAGE_APPLICATION_ID` — from the Vonage dashboard application you created.
- `VONAGE_PRIVATE_KEY_PATH` — path to the `.key` file Vonage gave you when the application was
  created (only shown once, at creation time).
- `VONAGE_NUMBER` — the number linked to that application, E.164 without the leading `+`.
- `SERVER_BASE_URL` — the public HTTPS URL this server will be reachable at. This **must match**
  the Answer URL / Event URL configured on the Vonage application, both set to **POST**
  (`{SERVER_BASE_URL}/voice/answer` and `{SERVER_BASE_URL}/voice/event`).
- `ANTHROPIC_API_KEY` — for the translation calls.
- `DEMO_WORKER_PHONE` — the phone that plays the recipient, "Marisol", in the demo (a real phone
  you control).
- `M0_TEST_DESTINATION` — same number, used only by the M0 verification script below.

### 1. Verify the number can actually call out (M0)

Before touching anything else, confirm the Vonage application + number can place a real call:

```bash
npm run m0-test-call
```

If your phone rings and speaks the test message, everything downstream will work. If it fails,
the error message names the likely cause (unlinked number, trial account restriction, wrong
private key, insufficient balance).

### 2. Seed the demo directory

```bash
npm run seed
```

Creates the sender (you, in-app) and the seeded directory, including three curated,
never-dialed entries used only for the Vision beat (`pt-BR`, `bn-IN`, `ht` — the last one
demonstrates the honest unsupported-language stop).

### 3. Run it

```bash
npm run dev
```

Open `http://localhost:3000` (or wherever `SERVER_BASE_URL` points once tunneled/hosted) and
click **Call the inbox**.

### Between rehearsal runs

```bash
npm run reset
```

Clears messages and calls, keeps the seeded directory.

## Testing

```bash
npm run typecheck
npm test
```

Unit tests cover the state machine and NCCO scripts (recording notice on every call, the
unsupported-language stop, the dtmf-vs-speech reply branching) against a real in-memory SQLite
store, with the Anthropic and outbound-call boundaries mocked. They do not call live Vonage or
Anthropic APIs — that verification is the M0 script and a live rehearsal run.

## Architecture

- **Runtime:** Node.js + TypeScript, one Fastify process (`src/server.ts`).
- **Voice:** `@vonage/server-sdk` for NCCO/outbound calls, `@vonage/client-sdk` for the
  browser's in-app call. Call-flow scripts live in `src/voice/ncco.ts`; the state machine keyed
  by call UUID lives in `src/voice/flow.ts`.
- **Translation:** `@anthropic-ai/sdk`, one frozen system prompt, structured output via
  `client.beta.messages.parse` (`src/translate.ts`). A live-call 8-second deadline races the
  request; if it's still running, the message moves to a "translation pending" state and a
  background retry runs every 30 seconds for up to 10 minutes.
- **Persistence:** SQLite via `better-sqlite3`, one file, no ORM (`src/db/store.ts`).
- **Board:** static HTML + a small TypeScript bundle, state pushed over server-sent events
  (`src/board/`).

## Known limitations

- The translation and voicemail retry timers are in-process (`setTimeout`); a server restart
  during a pending retry window loses it. Acceptable for a single rehearsed demo session, not
  for production use.
- `ALL_PARTY_CONSENT_STATE` (a press-1-to-continue consent gate) is implemented for the capture
  leg only; the deliver and ring-back legs always play the notice and continue. The demo is
  staged in New York (one-party consent); this flag exists for the honesty record, not because
  the demo needs it.
- Consent events are logged at call-creation time as an approximation of "notice played," since
  Vonage does not send a separate "notice finished playing" webhook.

## Note on how this was built

This project was built with AI-assisted coding (Claude, via Anthropic's Claude Code). The
Vonage integration, translation pipeline, and board were scaffolded and implemented with an AI
pair; the product decisions, testing, and the Vonage account itself are the author's own.

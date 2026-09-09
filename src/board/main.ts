import VonageClient from "@vonage/client-sdk";

// Mirrors what /api/people returns: no phone number reaches the browser.
interface Person {
  id: number;
  name: string;
  language: string;
  app_user: string | null;
}

interface Message {
  id: number;
  from_person_id: number;
  to_person_id: number;
  source_text: string | null;
  source_lang: string;
  target_text: string | null;
  target_lang: string;
  back_translation: string | null;
  flags: string;
  state: string;
  reply_text: string | null;
  reply_translation: string | null;
  created_at: string;
  updated_at: string;
}

// If nobody clicks Answer, pick the ring-back up anyway rather than let Vonage
// drop it — a live demo must not lose the reply to a missed click.
const AUTO_ANSWER_AFTER_MS = 15_000;

let people: Person[] = [];
let messages: Message[] = [];

const directoryEl = document.getElementById("directory")!;
const messagesEl = document.getElementById("messages")!;
const emptyHintEl = document.getElementById("empty-hint")!;
const callButton = document.getElementById("call") as HTMLButtonElement;
const callStatusEl = document.getElementById("call-status")!;

function personName(id: number): string {
  return people.find((p) => p.id === id)?.name ?? `#${id}`;
}

function renderDirectory(): void {
  directoryEl.innerHTML = "";
  for (const person of people) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = person.name;
    const lang = document.createElement("span");
    lang.className = "lang";
    lang.textContent = person.language;
    li.append(name, lang);
    directoryEl.appendChild(li);
  }
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderMessages(): void {
  messagesEl.innerHTML = "";
  emptyHintEl.hidden = messages.length > 0;

  for (const message of messages) {
    const flags: string[] = (() => {
      try {
        return JSON.parse(message.flags);
      } catch {
        return [];
      }
    })();

    const li = document.createElement("li");
    li.className = "card";
    li.dataset.state = message.state;

    const route = document.createElement("div");
    route.className = "route";
    route.textContent = `${personName(message.from_person_id)} → ${personName(message.to_person_id)}`;
    li.appendChild(route);

    const langPair = document.createElement("div");
    langPair.className = "lang-pair";
    langPair.textContent = `${message.source_lang} → ${message.target_lang}`;
    li.appendChild(langPair);

    if (message.source_text) {
      const en = document.createElement("div");
      en.className = "text";
      en.innerHTML = `<span class="label">English</span>${escapeHtml(message.source_text)}`;
      li.appendChild(en);
    }

    if (message.target_text) {
      const target = document.createElement("div");
      target.className = "text";
      target.innerHTML = `<span class="label">${escapeHtml(message.target_lang)}</span>${escapeHtml(message.target_text)}`;
      li.appendChild(target);
    }

    if (message.back_translation) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Back-translation";
      const body = document.createElement("div");
      body.textContent = message.back_translation;
      details.append(summary, body);
      li.appendChild(details);
    }

    if (message.reply_translation) {
      const reply = document.createElement("div");
      reply.className = "text";
      reply.innerHTML = `<span class="label">Reply</span>${escapeHtml(message.reply_translation)}`;
      li.appendChild(reply);
    }

    const stateRow = document.createElement("div");
    stateRow.className = "state-row";
    const state = document.createElement("span");
    state.className = flags.length > 0 ? "state flagged" : "state";
    // The state word is the thing that changes on screen, so it carries its own
    // value for styling rather than being coloured by position.
    state.dataset.state = message.state;
    state.textContent = message.state;
    const timestamp = document.createElement("span");
    timestamp.className = "timestamp";
    timestamp.textContent = formatTimestamp(message.updated_at);
    stateRow.append(state, timestamp);
    li.appendChild(stateRow);

    messagesEl.appendChild(li);
  }
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

let lastReplyFrom: string | null = null;

function upsertMessage(message: Message): void {
  if (message.state === "replied") lastReplyFrom = personName(message.to_person_id);
  const index = messages.findIndex((m) => m.id === message.id);
  if (index === -1) {
    messages.unshift(message);
  } else {
    messages[index] = message;
  }
  renderMessages();
}

async function loadInitialState(): Promise<void> {
  const [peopleRes, messagesRes] = await Promise.all([fetch("/api/people"), fetch("/api/messages")]);
  people = await peopleRes.json();
  messages = await messagesRes.json();
  renderDirectory();
  renderMessages();
}

function connectEvents(): void {
  const source = new EventSource("/events");
  source.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "message") upsertMessage(payload.message);
  };
}

/**
 * A generated ring tone (the North American 440 + 480 Hz pair) rather than an audio
 * file: no asset to load, nothing to fail on a conference network. The page has
 * always had a click before this plays, so autoplay policy is satisfied.
 */
function createRinger() {
  let context: AudioContext | null = null;
  let timer: number | null = null;

  const burst = () => {
    if (!context) return;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.05);
    gain.gain.setValueAtTime(0.12, context.currentTime + 1.0);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 1.2);
    gain.connect(context.destination);
    for (const frequency of [440, 480]) {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start();
      oscillator.stop(context.currentTime + 1.25);
    }
  };

  return {
    start(): void {
      if (timer !== null) return;
      try {
        context = context ?? new AudioContext();
        void context.resume();
        burst();
        timer = window.setInterval(burst, 2000);
      } catch (error) {
        // A blocked AudioContext must never cost the manager the call itself.
        console.error(error);
      }
    },
    stop(): void {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    },
  };
}

async function setUpCallButton(): Promise<void> {
  const client = new VonageClient();
  const keypad = document.querySelector<HTMLDivElement>("#keypad")!;
  const hangupButton = document.querySelector<HTMLButtonElement>("#hangup")!;
  const banner = document.querySelector<HTMLDivElement>("#ringback-banner")!;
  const ringbackWhoEl = document.querySelector<HTMLSpanElement>("#ringback-who")!;
  const answerButton = document.querySelector<HTMLButtonElement>("#answer")!;
  const declineButton = document.querySelector<HTMLButtonElement>("#decline")!;
  const ringer = createRinger();
  let activeCallId: string | null = null;
  let ringingCallId: string | null = null;
  let autoAnswerTimer: number | null = null;

  const stopRinging = () => {
    ringer.stop();
    banner.hidden = true;
    ringingCallId = null;
    if (autoAnswerTimer !== null) window.clearTimeout(autoAnswerTimer);
    autoAnswerTimer = null;
  };

  const answerRingback = async () => {
    const callId = ringingCallId;
    if (!callId) return;
    stopRinging();
    activeCallId = callId;
    callStatusEl.textContent = "On the call. Listening to the reply.";
    try {
      await client.answer(callId);
    } catch (error) {
      console.error(error);
      callStatusEl.textContent = "Could not answer. Check the console.";
    }
  };

  answerButton.addEventListener("click", () => void answerRingback());
  declineButton.addEventListener("click", async () => {
    const callId = ringingCallId;
    stopRinging();
    callStatusEl.textContent = "Ring-back declined. The reply is on the board.";
    if (callId) {
      try {
        await client.reject(callId);
      } catch (error) {
        console.error(error);
      }
    }
  });

  // A browser call has no phone keypad, but the read-back and the flagged-send gate ask
  // for a digit — the on-screen keypad sends real DTMF into the live call.
  const showKeypad = (visible: boolean) => {
    keypad.hidden = !visible;
  };
  keypad.querySelectorAll<HTMLButtonElement>("button[data-digit]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!activeCallId) return;
      try {
        await client.sendDTMF(activeCallId, button.dataset.digit!);
        callStatusEl.textContent = `Sent ${button.dataset.digit}.`;
      } catch (error) {
        console.error(error);
        callStatusEl.textContent = "Keypress failed. Check the console.";
      }
    });
  });
  hangupButton.addEventListener("click", async () => {
    if (!activeCallId) return;
    try {
      await client.hangup(activeCallId);
    } catch (error) {
      console.error(error);
    }
  });

  client.on("callInvite", (callId: string) => {
    // The ring-back is the point of the product: it rings, it says who is calling,
    // and the manager decides. Auto-answering made the reply arrive as silence.
    ringingCallId = callId;
    ringbackWhoEl.textContent = lastReplyFrom ? `${lastReplyFrom} is calling back` : "Ringback is calling";
    banner.hidden = false;
    callStatusEl.textContent = "Ringing back...";
    ringer.start();
    // Safety net for a live demo: an unanswered invite would be dropped by Vonage,
    // so pick it up after a while rather than lose the reply on a missed click.
    autoAnswerTimer = window.setTimeout(() => void answerRingback(), AUTO_ANSWER_AFTER_MS);
  });

  client.on("callHangup", (callId: string) => {
    if (callId === ringingCallId) stopRinging();
    if (callId !== activeCallId) return;
    activeCallId = null;
    showKeypad(false);
    callStatusEl.textContent = "Call ended.";
    callButton.disabled = false;
  });

  callButton.addEventListener("click", async () => {
    callButton.disabled = true;
    callStatusEl.textContent = "Connecting...";
    try {
      const { token, apiUrl } = await fetch("/api/session-jwt").then((r) => r.json());
      // Point the SDK at the account's home region: the generic host redirects, and a
      // redirect inside a CORS request surfaces as "Failed to fetch" on serverCall().
      if (apiUrl) client.setConfig({ apiUrl });
      await client.createSession(token);
      activeCallId = await client.serverCall();
      showKeypad(true);
      callStatusEl.textContent = "On the call. Press 1 to send when you hear the read-back.";
    } catch (error) {
      console.error(error);
      callStatusEl.textContent = "Call failed. Check the console.";
      callButton.disabled = false;
    }
  });
}

loadInitialState();
connectEvents();
setUpCallButton();

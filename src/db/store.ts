import Database from "better-sqlite3";

export type MessageState =
  | "draft"
  | "sent"
  | "delivered"
  | "understood"
  | "replied"
  | "left on voicemail"
  | "unsupported language"
  | "translation pending"
  | "failed";

export type CallLeg = "capture" | "deliver" | "ringback";

export interface Person {
  id: number;
  name: string;
  language: string;
  phone: string | null;
  app_user: string | null;
}

export interface Message {
  id: number;
  from_person_id: number;
  to_person_id: number;
  source_text: string | null;
  source_lang: string;
  target_text: string | null;
  target_lang: string;
  back_translation: string | null;
  flags: string; // JSON-encoded string[]
  state: MessageState;
  reply_text: string | null;
  reply_translation: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallRow {
  uuid: string;
  message_id: number | null;
  direction: "inbound" | "outbound";
  leg: CallLeg;
  status: string;
  machine_detection: string | null;
  started_at: string;
  ended_at: string | null;
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      language TEXT NOT NULL,
      phone TEXT,
      app_user TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_person_id INTEGER NOT NULL REFERENCES people(id),
      to_person_id INTEGER NOT NULL REFERENCES people(id),
      source_text TEXT,
      source_lang TEXT NOT NULL,
      target_text TEXT,
      target_lang TEXT NOT NULL,
      back_translation TEXT,
      flags TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'draft',
      reply_text TEXT,
      reply_translation TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS calls (
      uuid TEXT PRIMARY KEY,
      message_id INTEGER REFERENCES messages(id),
      direction TEXT NOT NULL,
      leg TEXT NOT NULL,
      status TEXT NOT NULL,
      machine_detection TEXT,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS consent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_uuid TEXT NOT NULL,
      language TEXT NOT NULL,
      notice_played_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- Webhook event UUIDs from Vonage can arrive more than once for the same status.
    -- This table makes handling idempotent: a duplicate (uuid, status) pair is a no-op.
    CREATE TABLE IF NOT EXISTS processed_events (
      call_uuid TEXT NOT NULL,
      status TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (call_uuid, status)
    );
  `);
  return db;
}

export class Store {
  constructor(private db: Database.Database) {}

  // --- people ---

  insertPerson(person: Omit<Person, "id">): Person {
    const result = this.db
      .prepare(
        `INSERT INTO people (name, language, phone, app_user) VALUES (?, ?, ?, ?)`,
      )
      .run(person.name, person.language, person.phone, person.app_user);
    return this.getPerson(Number(result.lastInsertRowid))!;
  }

  getPerson(id: number): Person | undefined {
    return this.db.prepare(`SELECT * FROM people WHERE id = ?`).get(id) as Person | undefined;
  }

  listPeople(): Person[] {
    return this.db.prepare(`SELECT * FROM people ORDER BY id`).all() as Person[];
  }

  findPersonByName(name: string): Person | undefined {
    const normalized = name.trim().toLowerCase();
    return this.listPeople().find((p) => p.name.toLowerCase() === normalized);
  }

  findPersonByPhone(phone: string): Person | undefined {
    const digits = phone.replace(/\D/g, "");
    return this.listPeople().find((p) => p.phone && p.phone.replace(/\D/g, "") === digits);
  }

  findPersonByAppUser(appUser: string): Person | undefined {
    return this.listPeople().find((p) => p.app_user === appUser);
  }

  clearPeople(): void {
    this.db.exec(`DELETE FROM people`);
  }

  // --- messages ---

  createMessage(input: {
    from_person_id: number;
    to_person_id: number;
    source_text: string;
    source_lang: string;
    target_lang: string;
  }): Message {
    const result = this.db
      .prepare(
        `INSERT INTO messages (from_person_id, to_person_id, source_text, source_lang, target_lang, state)
         VALUES (?, ?, ?, ?, ?, 'draft')`,
      )
      .run(
        input.from_person_id,
        input.to_person_id,
        input.source_text,
        input.source_lang,
        input.target_lang,
      );
    return this.getMessage(Number(result.lastInsertRowid))!;
  }

  getMessage(id: number): Message | undefined {
    return this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Message | undefined;
  }

  listMessages(): Message[] {
    return this.db.prepare(`SELECT * FROM messages ORDER BY id DESC`).all() as Message[];
  }

  setTranslation(
    id: number,
    fields: { target_text: string; back_translation: string; flags: string[] },
  ): void {
    this.db
      .prepare(
        `UPDATE messages SET target_text = ?, back_translation = ?, flags = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(fields.target_text, fields.back_translation, JSON.stringify(fields.flags), id);
  }

  setMessageState(id: number, state: MessageState): void {
    this.db
      .prepare(
        `UPDATE messages SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(state, id);
  }

  setReply(id: number, replyText: string, replyTranslation: string): void {
    this.db
      .prepare(
        `UPDATE messages SET reply_text = ?, reply_translation = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(replyText, replyTranslation, id);
  }

  clearMessages(): void {
    this.db.exec(`DELETE FROM messages`);
  }

  // --- calls ---

  createCall(call: {
    uuid: string;
    message_id: number | null;
    direction: "inbound" | "outbound";
    leg: CallLeg;
    status: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO calls (uuid, message_id, direction, leg, status) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(call.uuid, call.message_id, call.direction, call.leg, call.status);
  }

  getCall(uuid: string): CallRow | undefined {
    return this.db.prepare(`SELECT * FROM calls WHERE uuid = ?`).get(uuid) as
      | CallRow
      | undefined;
  }

  updateCallStatus(uuid: string, status: string, machineDetection?: string): void {
    const ended = ["completed", "failed", "rejected", "busy", "cancelled", "timeout"].includes(
      status,
    );
    this.db
      .prepare(
        `UPDATE calls SET status = ?, machine_detection = COALESCE(?, machine_detection), ended_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE ended_at END
         WHERE uuid = ?`,
      )
      .run(status, machineDetection ?? null, ended ? 1 : 0, uuid);
  }

  // --- consent ---

  recordConsent(callUuid: string, language: string): void {
    this.db
      .prepare(`INSERT INTO consent_events (call_uuid, language) VALUES (?, ?)`)
      .run(callUuid, language);
  }

  // --- idempotency ---

  /** Returns true if this is the first time (uuid, status) has been seen. */
  markEventOnce(callUuid: string, status: string): boolean {
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO processed_events (call_uuid, status) VALUES (?, ?)`)
      .run(callUuid, status);
    return result.changes > 0;
  }

  resetAll(): void {
    this.db.exec(
      `DELETE FROM consent_events; DELETE FROM calls; DELETE FROM processed_events; DELETE FROM messages; DELETE FROM people;`,
    );
  }

  /** Clears messages, calls and consent history but keeps the seeded directory. */
  resetToSeededStart(): void {
    this.db.exec(`DELETE FROM consent_events; DELETE FROM calls; DELETE FROM processed_events; DELETE FROM messages;`);
  }
}

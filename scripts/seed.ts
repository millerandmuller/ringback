// Demo directory: the two real, live-called people, plus three curated
// entries for the Vision beat (never dialed — Ringback only ever calls
// en-US/es-US). Never lorem ipsum on camera.
import { config } from "../src/config.js";
import { openDb, Store } from "../src/db/store.js";
import { ensureManagerUser } from "../src/voice/client.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env — see .env.example`);
  return value;
}

async function main() {
  await ensureManagerUser();

  const db = openDb(config.databasePath);
  const store = new Store(db);
  store.resetAll();

  store.insertPerson({ name: "Lutfiya", language: "en-US", phone: null, app_user: "manager" });
  store.insertPerson({ name: "Marisol", language: "es-US", phone: requireEnv("DEMO_WORKER_PHONE"), app_user: null });
  store.insertPerson({ name: "Ana", language: "pt-BR", phone: null, app_user: null });
  store.insertPerson({ name: "Priya", language: "bn-IN", phone: null, app_user: null });
  store.insertPerson({ name: "Jean", language: "ht", phone: null, app_user: null });

  console.log("Seeded directory:");
  for (const person of store.listPeople()) {
    console.log(`  ${person.name} (${person.language})${person.app_user ? ` [app_user: ${person.app_user}]` : ""}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

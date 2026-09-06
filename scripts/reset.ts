// Returns the demo to the seeded start between rehearsal runs: clears
// messages, calls and consent history, keeps the seeded directory.
import { config } from "../src/config.js";
import { openDb, Store } from "../src/db/store.js";

const db = openDb(config.databasePath);
const store = new Store(db);
store.resetToSeededStart();
console.log("Reset to seeded start. Directory kept, messages and calls cleared.");

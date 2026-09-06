import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { config } from "./config.js";
import { openDb, Store } from "./db/store.js";
import { registerBoardRoutes } from "./api.js";
import { registerVoiceRoutes } from "./voice/routes.js";
import { ensureManagerUser } from "./voice/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const boardHtmlPath = join(__dirname, "board", "index.html");
const boardJsPath = join(__dirname, "..", "dist", "public", "board.js");

async function main() {
  await ensureManagerUser();

  const db = openDb(config.databasePath);
  const store = new Store(db);

  const app = Fastify({ logger: true });

  registerVoiceRoutes(app, store);
  registerBoardRoutes(app, store);

  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(readFileSync(boardHtmlPath, "utf-8"));
  });
  app.get("/board.js", async (_req, reply) => {
    reply.type("application/javascript").send(readFileSync(boardJsPath, "utf-8"));
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

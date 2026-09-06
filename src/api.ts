import type { FastifyInstance } from "fastify";
import { tokenGenerate } from "@vonage/jwt";
import { config } from "./config.js";
import type { Store } from "./db/store.js";
import { subscribeSse } from "./events.js";
import { MANAGER_APP_USER } from "./voice/client.js";

const SESSION_JWT_TTL_SECONDS = 60 * 60; // 1 hour — long enough for a rehearsal run

function mintManagerSessionToken(): string {
  return tokenGenerate(config.vonage.applicationId, config.vonage.privateKey, {
    subject: MANAGER_APP_USER,
    ttl: SESSION_JWT_TTL_SECONDS,
    acl: {
      // Vonage's standard Client SDK permission set: a browser call (serverCall) creates a
      // leg and a device registration, not only a session — without "/*/legs/**" the
      // call request is rejected.
      paths: {
        "/*/users/**": {},
        "/*/conversations/**": {},
        "/*/sessions/**": {},
        "/*/devices/**": {},
        "/*/image/**": {},
        "/*/media/**": {},
        "/*/applications/**": {},
        "/*/push/**": {},
        "/*/knocking/**": {},
        "/*/legs/**": {},
      },
    },
  });
}

export function registerBoardRoutes(app: FastifyInstance, store: Store): void {
  app.get("/api/session-jwt", async () => ({ token: mintManagerSessionToken(), apiUrl: config.vonage.clientApiUrl }));

  app.get("/api/messages", async () => store.listMessages());

  app.get("/api/people", async () => store.listPeople());

  app.get("/events", async (_req, reply) => {
    subscribeSse(reply);
  });
}

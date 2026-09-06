import { EventEmitter } from "node:events";
import type { FastifyReply } from "fastify";
import type { Message } from "./db/store.js";

const bus = new EventEmitter();
bus.setMaxListeners(50);

export function publishMessageUpdate(message: Message): void {
  bus.emit("message", message);
}

/** Subscribes a Fastify reply to the SSE stream until the client disconnects. */
export function subscribeSse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  reply.raw.write(": connected\n\n");

  const onMessage = (message: Message) => {
    reply.raw.write(`data: ${JSON.stringify({ type: "message", message })}\n\n`);
  };
  bus.on("message", onMessage);

  reply.raw.on("close", () => {
    bus.off("message", onMessage);
  });
}

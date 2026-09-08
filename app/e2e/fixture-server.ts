import { createServer } from "node:http";
import { fixturePayload } from "./fixtures";

// An isolated, read-only API for browser tests. Never forwards to real hardware.
createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") {
    response.writeHead(405);
    response.end(
      JSON.stringify({ error: "Device writes are disabled in this preview." }),
    );
    return;
  }
  response.end(
    JSON.stringify(
      fixturePayload(new URL(request.url ?? "/", "http://localhost").pathname),
    ),
  );
}).listen(43884, "127.0.0.1", () =>
  console.log("Read-only preview API: http://127.0.0.1:43884"),
);

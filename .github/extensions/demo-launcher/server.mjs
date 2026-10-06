import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { FEATURE_PROMPT } from "./controller.mjs";

const assets = new Map([
  ["", ["index.html", "text/html; charset=utf-8"]],
  ["app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["style.css", ["style.css", "text/css; charset=utf-8"]],
]);

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw new Error("Request is too large.");
  }
  const input = JSON.parse(body || "{}");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a JSON object.");
  return input;
}

export async function startServer(controller) {
  const token = randomBytes(24).toString("hex");
  const prefix = `/${token}/`;
  let origin;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.headers.host !== new URL(origin).host ||
          (request.headers.origin && request.headers.origin !== origin) ||
          (request.headers["sec-fetch-site"] === "cross-site" && request.method !== "GET")) {
        json(403, { error: "Foreign origin or host rejected." });
        return;
      }
      const pathname = new URL(request.url, origin).pathname;
      if (!pathname.startsWith(prefix)) {
        json(404, { error: "Not found." });
        return;
      }
      const route = pathname.slice(prefix.length);
      if (request.method === "GET" && assets.has(route)) {
        const [file, contentType] = assets.get(route);
        response.writeHead(200, { "Content-Type": contentType });
        response.end(await readFile(new URL(file, import.meta.url)));
        return;
      }
      if (request.method === "GET" && route === "state") {
        json(200, await controller.state());
        return;
      }
      if (request.method === "GET" && route === "prompt") {
        json(200, { prompt: FEATURE_PROMPT });
        return;
      }
      const methods = new Map([
        ["create", "create"], ["resume", "resume"], ["retry-session", "retrySession"],
        ["feature", "feature"], ["refresh", "refresh"], ["select", "select"],
        ["scenario", "scenario"], ["scenario-status", "refreshScenario"],
      ]);
      if (request.method !== "POST" || !methods.has(route)) {
        json(404, { error: "Not found." });
        return;
      }
      if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json") {
        json(403, { error: "Same-origin JSON required." });
        return;
      }
      json(200, await controller[methods.get(route)](await readJson(request)));
    } catch (error) {
      json(400, { error: error.message });
    }
  });
  server.requestTimeout = 180_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}${prefix}`,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    }),
  };
}

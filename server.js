"use strict";

const http = require("node:http");
const path = require("node:path");
const { createStore } = require("./src/db");
const { createHandler } = require("./src/app");

const PORT = Number(process.env.PORT || 3020);
const HOST = process.env.HOST || "127.0.0.1";
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

async function main() {
  const store = createStore({ file: DB_FILE, seedDemo: process.env.SEED_DEMO !== "0" });
  await store.load();
  const { handle, ROUTES } = createHandler(store);
  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`Rubbing repair API running at http://${HOST}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`DB file: ${DB_FILE}`);
    void ROUTES;
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("failed to start server:", err);
  process.exit(1);
});

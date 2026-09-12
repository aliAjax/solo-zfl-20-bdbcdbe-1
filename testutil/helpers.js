"use strict";

const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createStore } = require("../src/db");
const { createHandler } = require("../src/app");

/**
 * 启动一个隔离的测试服务：
 * - 每个用例使用独立临时目录下的 db.json，互不污染；
 * - 可注入 persist 包装器，用于模拟磁盘写入失败（回滚测试）。
 */
async function startServer(t, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rubbing-test-"));
  const file = path.join(dir, "db.json");

  let persistImpl;
  if (opts.persistWrapper) {
    const { defaultPersist } = require("../src/db");
    persistImpl = opts.persistWrapper((f, json) => defaultPersist(f, json));
  }

  const store = createStore({
    file,
    seedDemo: false,
    ...(persistImpl ? { persist: persistImpl } : {})
  });
  await store.load();

  const { handle } = createHandler(store);
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  return { baseUrl, file, store };
}

async function request(baseUrl, method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, raw: text };
}

async function readDbFile(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function createRubbing(api, code = `TP-${Math.random().toString(36).slice(2, 8)}`) {
  const res = await request(api, "POST", "/rubbings", {
    code,
    source: "测试碑刻",
    paperSize: "30x40cm"
  });
  if (res.status !== 201) throw new Error(`createRubbing failed: ${res.raw}`);
  return res.body.data;
}

async function createDamage(api, rubbingId, overrides = {}) {
  const res = await request(api, "POST", `/rubbings/${rubbingId}/damages`, {
    position: "测试位置",
    type: "虫蛀孔",
    beforePhotoUrl: "https://example.local/before.jpg",
    ...overrides
  });
  if (res.status !== 201) throw new Error(`createDamage failed: ${res.raw}`);
  return res.body.data;
}

async function createBatch(api, damageIds, overrides = {}) {
  return request(api, "POST", "/batches", {
    name: "测试批次",
    damageIds,
    ...overrides
  });
}

function goodResults(damages) {
  return {
    results: damages.map((d, i) => ({
      damageId: d.id,
      afterPhotoUrl: `https://example.local/after-${d.id || i}.jpg`,
      repairNote: `已修补：${d.id || i}`
    }))
  };
}

module.exports = {
  startServer,
  request,
  readDbFile,
  createRubbing,
  createDamage,
  createBatch,
  goodResults
};

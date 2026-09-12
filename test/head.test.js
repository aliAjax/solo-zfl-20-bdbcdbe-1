"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer,
  request,
  createRubbing,
  createDamage,
  createBatch
} = require("../testutil/helpers");

/** 发起 HEAD 请求，返回状态、关键响应头与（必须为空的）响应体。 */
async function head(baseUrl, urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`, { method: "HEAD" });
  const body = await res.text();
  return {
    status: res.status,
    body,
    contentType: res.headers.get("content-type"),
    contentLength: Number(res.headers.get("content-length")),
    allow: res.headers.get("allow")
  };
}

async function getMeta(baseUrl, urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`, { method: "GET" });
  const body = await res.text();
  return { status: res.status, bodyLength: Buffer.byteLength(body) };
}

test("[HEAD] 健康检查、列表、筛选、详情资源都支持 HEAD：状态同 GET、响应体为空、Content-Length 与 GET 一致", async (t) => {
  const { baseUrl } = await startServer(t);
  const rubbing = await createRubbing(baseUrl, "TP-HEAD-1");
  const d1 = await createDamage(baseUrl, rubbing.id, { position: "p1" });
  const d2 = await createDamage(baseUrl, rubbing.id, { position: "p2" });
  const batchId = (await createBatch(baseUrl, [d1.id])).body.data.id;

  const paths = [
    "/health",
    "/rubbings",
    "/damages",
    "/damages?status=pending",
    `/rubbings/${rubbing.id}/damages`,
    "/batches",
    `/batches/${batchId}`
  ];

  for (const p of paths) {
    const h = await head(baseUrl, p);
    const g = await getMeta(baseUrl, p);
    assert.equal(h.status, g.status, `${p} 状态应与 GET 一致`);
    assert.equal(h.status, 200, `${p} 应为 200`);
    assert.equal(h.body, "", `${p} HEAD 响应体必须为空`);
    assert.equal(h.contentLength, g.bodyLength, `${p} Content-Length 应等于 GET 实际字节数`);
    assert.match(h.contentType, /^application\/json/);
  }

  // 筛选确实生效：只收录 d1，批次详情包含 1 项
  const d2StillPending = await head(baseUrl, "/damages?status=pending");
  assert.equal(d2StillPending.status, 200);
  assert.equal(d2StillPending.body, "");
  const repairedList = await head(baseUrl, "/damages?status=repaired");
  assert.equal(repairedList.status, 200);
  // repaired 列表为空时 Content-Length 是空数组 JSON 的长度
  assert.equal(repairedList.contentLength, Buffer.byteLength('{\n  "data": []\n}'));
});

test("[HEAD] HEAD 与 GET 共享错误状态：不存在的详情资源返回 404 空体", async (t) => {
  const { baseUrl } = await startServer(t);

  for (const p of ["/batches/batch_missing", "/rubbings/rubbing_missing/damages"]) {
    const h = await head(baseUrl, p);
    const g = await getMeta(baseUrl, p);
    assert.equal(h.status, 404, p);
    assert.equal(g.status, 404, p);
    assert.equal(h.body, "");
    assert.equal(h.contentLength, g.bodyLength, "错误响应的 Content-Length 也应与 GET 一致");
  }
});

test("[HEAD] 未知路径的 HEAD 仍按不存在处理（404），不误当成 405", async (t) => {
  const { baseUrl } = await startServer(t);
  const h = await head(baseUrl, "/totally-unknown-path");
  assert.equal(h.status, 404);
  assert.equal(h.body, "");
  assert.equal(h.allow, null);
});

test("[HEAD] 写资源不开放 HEAD：开工/完工/PATCH 路径收到 HEAD 返回 405，Allow 不含 HEAD", async (t) => {
  const { baseUrl } = await startServer(t);

  const start = await head(baseUrl, "/batches/any/start");
  assert.equal(start.status, 405);
  assert.equal(start.allow, "POST");
  assert.equal(start.body, "");

  const complete = await head(baseUrl, "/batches/any/complete");
  assert.equal(complete.status, 405);
  assert.equal(complete.allow, "POST");

  // GET 资源的 Allow 列表在其他错误方法触发时应包含 HEAD
  const res = await fetch(`${baseUrl}/rubbings`, { method: "DELETE" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD, POST");
});

test("[HEAD] HEAD 不改变数据；GET 行为完全不变", async (t) => {
  const { baseUrl } = await startServer(t);
  const rubbing = await createRubbing(baseUrl, "TP-HEAD-2");
  const d1 = await createDamage(baseUrl, rubbing.id);

  // 连发多个 HEAD，不会创建批次、不改变缺损状态
  await head(baseUrl, "/batches");
  await head(baseUrl, `/batches/${"x"}`);
  await head(baseUrl, `/rubbings/${rubbing.id}/damages`);
  await head(baseUrl, "/health");

  const batches = await request(baseUrl, "GET", "/batches");
  assert.equal(batches.body.data.length, 0);
  const damages = await request(baseUrl, "GET", `/rubbings/${rubbing.id}/damages`);
  assert.equal(damages.body.data[0].status, "pending");
  assert.equal(damages.body.data[0].batchId, null);

  // GET 正常返回完整 JSON 体（与 HEAD 唯一区别就是有响应体）
  const g = await getMeta(baseUrl, "/health");
  assert.equal(g.status, 200);
  assert.ok(g.bodyLength > 0);
  const healthJson = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(healthJson.ok, true);
});

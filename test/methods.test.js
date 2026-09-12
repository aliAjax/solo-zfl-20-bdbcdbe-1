"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("../testutil/helpers");

async function raw(baseUrl, method, urlPath) {
  const res = await fetch(`${baseUrl}${urlPath}`, { method });
  const body = await res.json().catch(() => null);
  return { status: res.status, allow: res.headers.get("allow"), body };
}

test("[方法限制] 路径存在但方法不被支持 → 405 + Allow 头 + 明确错误码", async (t) => {
  const { baseUrl } = await startServer(t);

  const cases = [
    { method: "DELETE", path: "/health", allow: "GET, HEAD" },
    { method: "PUT", path: "/rubbings", allow: "GET, HEAD, POST" },
    { method: "PATCH", path: "/rubbings", allow: "GET, HEAD, POST" },
    { method: "DELETE", path: "/damages", allow: "GET, HEAD" },
    { method: "PUT", path: "/batches", allow: "GET, HEAD, POST" },
    { method: "GET", path: "/batches/any/start", allow: "POST" },
    { method: "GET", path: "/batches/any/complete", allow: "POST" },
    { method: "DELETE", path: "/batches/any", allow: "GET, HEAD" },
    { method: "GET", path: "/damages/any", allow: "PATCH" },
    { method: "PUT", path: "/rubbings/r1/damages", allow: "GET, HEAD, POST" }
  ];

  for (const c of cases) {
    const res = await raw(baseUrl, c.method, c.path);
    assert.equal(res.status, 405, `${c.method} ${c.path}`);
    assert.equal(res.allow, c.allow, `${c.method} ${c.path} Allow 头`);
    assert.equal(res.body.error.code, "E_METHOD_NOT_ALLOWED");
    assert.ok(res.body.error.message.includes(c.method), "错误消息应指出实际方法");
    assert.deepEqual(res.body.error.details.method, c.method);
  }
});

test("[方法限制] 未支持的方法不触发任何写入，也不影响正常请求", async (t) => {
  const { baseUrl } = await startServer(t);

  // 对开工/完工发 GET（错误方法）不得改变状态
  await raw(baseUrl, "GET", "/batches/batch_x/start");
  await raw(baseUrl, "GET", "/batches/batch_x/complete");

  const health = await raw(baseUrl, "GET", "/health");
  assert.equal(health.status, 200);
  const batches = await raw(baseUrl, "GET", "/batches");
  assert.equal(batches.status, 200);
  assert.equal(batches.body.data.length, 0);

  // 未知路径仍返回 404，而不是 405
  const unknown = await raw(baseUrl, "DELETE", "/no-such-path");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "E_ROUTE_NOT_FOUND");
});

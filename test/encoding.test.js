"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  startServer,
  request,
  readDbFile,
  createRubbing,
  createDamage,
  createBatch,
  goodResults
} = require("../testutil/helpers");

/** 各种畸形百分号编码：均会让 decodeURIComponent 抛 URIError。 */
const MALFORMED = ["%E0%A4%A", "%zz", "%", "%E4%B8%AD%E0", "abc%"];

async function assertMalformed(baseUrl, method, urlPath, body) {
  const res = await request(baseUrl, method, urlPath, body);
  assert.equal(res.status, 400, `${method} ${urlPath} 应返回 400，实际 ${res.status}`);
  assert.equal(res.body.error.code, "E_MALFORMED_PATH");
  assert.ok(typeof res.body.error.message === "string" && res.body.error.message.length > 0);
  return res;
}

test("[畸形编码] 登记缺损：rubbingId 百分号编码畸形时返回 400 而非 500，且不落库", async (t) => {
  const { baseUrl, file } = await startServer(t);

  for (const bad of MALFORMED) {
    const res = await assertMalformed(baseUrl, "POST", `/rubbings/${bad}/damages`, {
      position: "p",
      type: "t",
      beforePhotoUrl: "u"
    });
    assert.equal(res.body.error.details.parameter, "rubbingId");
    assert.ok(res.body.error.details.raw.includes("%"));
  }

  // GET 同样适用
  await assertMalformed(baseUrl, "GET", `/rubbings/${MALFORMED[0]}/damages`);

  const db = await readDbFile(file);
  assert.equal(db.rubbings.length, 0);
  assert.equal(db.damages.length, 0);
});

test("[畸形编码] 开工：batchId 畸形时返回 400 而非 500", async (t) => {
  const { baseUrl } = await startServer(t);
  for (const bad of MALFORMED) {
    const res = await assertMalformed(baseUrl, "POST", `/batches/${bad}/start`);
    assert.equal(res.body.error.details.parameter, "batchId");
  }
});

test("[畸形编码] 批次查询、PATCH 缺损、批次完工：路径参数畸形均为 400", async (t) => {
  const { baseUrl } = await startServer(t);

  for (const bad of MALFORMED) {
    await assertMalformed(baseUrl, "GET", `/batches/${bad}`);
    await assertMalformed(baseUrl, "PATCH", `/damages/${bad}`, { position: "新位置" });
    await assertMalformed(baseUrl, "POST", `/batches/${bad}/complete`, {
      results: [{ damageId: "x", afterPhotoUrl: "u", repairNote: "n" }]
    });
  }
});

test("[畸形编码] 正常请求不受影响：合法百分号编码可正常解码，普通流程全部 200", async (t) => {
  const { baseUrl } = await startServer(t);
  const rubbing = await createRubbing(baseUrl, "TP-ENC-OK");
  const d1 = await createDamage(baseUrl, rubbing.id);

  // 合法的百分号编码（%62 = 'b'）必须被正常解码：解码后是不存在的批次 id，应得 404 而不是 400
  const decoded = await request(baseUrl, "GET", "/batches/%62atch_not_exist");
  assert.equal(decoded.status, 404);
  assert.equal(decoded.body.error.code, "E_BATCH_NOT_FOUND");

  // 普通开工/查询/完工流程不受影响
  const batchId = (await createBatch(baseUrl, [d1.id])).body.data.id;

  const started = await request(baseUrl, "POST", `/batches/${batchId}/start`);
  assert.equal(started.status, 200);
  assert.equal(started.body.data.status, "in_progress");

  const got = await request(baseUrl, "GET", `/batches/${batchId}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.data.id, batchId);

  const completed = await request(
    baseUrl,
    "POST",
    `/batches/${batchId}/complete`,
    goodResults([d1])
  );
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.status, "completed");
});

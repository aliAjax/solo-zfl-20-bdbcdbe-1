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

// ---------- 基础与唯一性 ----------

test("健康检查返回 200", async (t) => {
  const { baseUrl } = await startServer(t);
  const res = await request(baseUrl, "GET", "/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test("拓片编号唯一：重复编号返回 409，含并发请求也只有一个成功", async (t) => {
  const { baseUrl } = await startServer(t);

  const first = await request(baseUrl, "POST", "/rubbings", {
    code: "TP-UNIQUE-1",
    source: "s",
    paperSize: "1x1cm"
  });
  assert.equal(first.status, 201);

  const dup = await request(baseUrl, "POST", "/rubbings", {
    code: "TP-UNIQUE-1",
    source: "s2",
    paperSize: "2x2cm"
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, "E_CODE_DUPLICATE");

  // 并发两个相同编号：恰好一个成功
  const concurrent = await Promise.all(
    [0, 1].map(() =>
      request(baseUrl, "POST", "/rubbings", {
        code: "TP-RACE-1",
        source: "s",
        paperSize: "1x1cm"
      })
    )
  );
  const created = concurrent.filter((r) => r.status === 201);
  const rejected = concurrent.filter((r) => r.status === 409);
  assert.equal(created.length, 1);
  assert.equal(rejected.length, 1);
});

test("缺损项只归属一张拓片；不存在拓片下创建返回 404", async (t) => {
  const { baseUrl } = await startServer(t);
  const r1 = await createRubbing(baseUrl);
  const d = await createDamage(baseUrl, r1.id);
  assert.equal(d.rubbingId, r1.id);
  assert.equal(d.status, "pending");

  const res = await request(baseUrl, "POST", "/rubbings/no-such-id/damages", {
    position: "x",
    type: "撕裂",
    beforePhotoUrl: "u"
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "E_RUBBING_NOT_FOUND");
});

test("创建缺损项缺少修补前照片被拒绝", async (t) => {
  const { baseUrl } = await startServer(t);
  const r = await createRubbing(baseUrl);
  const res = await request(baseUrl, "POST", `/rubbings/${r.id}/damages`, {
    position: "x",
    type: "撕裂"
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.details.missing.includes("beforePhotoUrl"));
});

// ---------- 批次收录规则 ----------

test("批次只收待修项：请求内重复、跨拓片混批、已收录项再次收录都被挡住", async (t) => {
  const { baseUrl } = await startServer(t);
  const r1 = await createRubbing(baseUrl);
  const r2 = await createRubbing(baseUrl);
  const d1 = await createDamage(baseUrl, r1.id, { position: "d1" });
  const d2 = await createDamage(baseUrl, r1.id, { position: "d2" });
  const d3 = await createDamage(baseUrl, r2.id, { position: "d3" });

  // 请求内重复
  const dupInReq = await createBatch(baseUrl, [d1.id, d1.id]);
  assert.equal(dupInReq.status, 400);
  assert.equal(dupInReq.body.error.code, "E_DUPLICATE_IN_REQUEST");

  // 跨拓片混批
  const cross = await createBatch(baseUrl, [d1.id, d3.id]);
  assert.equal(cross.status, 409);
  assert.equal(cross.body.error.code, "E_CROSS_RUBBING_BATCH");

  // 正常收录（open，缺损项仍是 pending 但已占用）
  const ok = await createBatch(baseUrl, [d1.id, d2.id]);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.status, "open");
  assert.deepEqual(
    ok.body.data.damages.map((d) => d.status).sort(),
    ["pending", "pending"]
  );

  // 已收录项不能再进别的批次
  const again = await createBatch(baseUrl, [d1.id]);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "E_ALREADY_COLLECTED");
});

test("批次不能收录不存在或非待修状态的缺损项", async (t) => {
  const { baseUrl } = await startServer(t);
  const r = await createRubbing(baseUrl);
  const d1 = await createDamage(baseUrl, r.id);
  const d2 = await createDamage(baseUrl, r.id);

  const missing = await createBatch(baseUrl, [d1.id, "damage_nope"]);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "E_DAMAGE_NOT_FOUND");

  const batch = await createBatch(baseUrl, [d1.id]);
  assert.equal(batch.status, 201);
  await request(baseUrl, "POST", `/batches/${batch.body.data.id}/start`);
  // d1 已开工（in_repair），不能再被任何批次收录
  const afterStart = await createBatch(baseUrl, [d1.id, d2.id]);
  assert.equal(afterStart.status, 409);
  assert.equal(afterStart.body.error.code, "E_NOT_PENDING");
});

// ---------- 状态流转 ----------

test("完整状态流转：收录(open/pending) → 开工(in_progress/in_repair) → 完工(completed/repaired)", async (t) => {
  const { baseUrl, file } = await startServer(t);
  const r = await createRubbing(baseUrl);
  const d1 = await createDamage(baseUrl, r.id);
  const d2 = await createDamage(baseUrl, r.id);

  const created = await createBatch(baseUrl, [d1.id, d2.id]);
  assert.equal(created.status, 201);
  const batchId = created.body.data.id;
  assert.equal(created.body.data.status, "open");

  const started = await request(baseUrl, "POST", `/batches/${batchId}/start`);
  assert.equal(started.status, 200);
  assert.equal(started.body.data.status, "in_progress");
  assert.equal(started.body.data.inRepair, 2);
  for (const d of started.body.data.damages) {
    assert.equal(d.status, "in_repair");
    assert.ok(d.startedAt);
  }

  const payload = goodResults([d1, d2]);
  const completed = await request(baseUrl, "POST", `/batches/${batchId}/complete`, payload);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.status, "completed");
  assert.equal(completed.body.data.repaired, 2);
  for (const d of completed.body.data.damages) {
    assert.equal(d.status, "repaired");
    assert.ok(d.afterPhotoUrl);
    assert.ok(d.repairNote);
    assert.ok(d.repairedAt);
  }
  assert.ok(completed.body.data.completedAt);

  // 磁盘上的最终状态一致
  const onDisk = await readDbFile(file);
  const diskBatch = onDisk.batches.find((b) => b.id === batchId);
  assert.equal(diskBatch.status, "completed");
  assert.ok(diskBatch.completedAt);
  for (const id of [d1.id, d2.id]) {
    const d = onDisk.damages.find((item) => item.id === id);
    assert.equal(d.status, "repaired");
    assert.ok(d.afterPhotoUrl && d.repairNote && d.repairedAt);
  }
});

test("未开工不能完工；已开工批次重复开工返回 409", async (t) => {
  const { baseUrl } = await startServer(t);
  const r = await createRubbing(baseUrl);
  const d1 = await createDamage(baseUrl, r.id);
  const batch = await createBatch(baseUrl, [d1.id]);
  const batchId = batch.body.data.id;

  const completeBeforeStart = await request(
    baseUrl,
    "POST",
    `/batches/${batchId}/complete`,
    goodResults([d1])
  );
  assert.equal(completeBeforeStart.status, 409);
  assert.equal(completeBeforeStart.body.error.code, "E_BATCH_NOT_STARTED");

  await request(baseUrl, "POST", `/batches/${batchId}/start`);
  const secondStart = await request(baseUrl, "POST", `/batches/${batchId}/start`);
  assert.equal(secondStart.status, 409);
  assert.equal(secondStart.body.error.code, "E_ALREADY_STARTED");
});

// ---------- 完工校验 ----------

test("缺少修补照片或结果的项不能完工，且整批回滚：无状态落盘、批次仍在处理中", async (t) => {
  const { baseUrl, file } = await startServer(t);
  const r = await createRubbing(baseUrl);
  const d1 = await createDamage(baseUrl, r.id);
  const d2 = await createDamage(baseUrl, r.id);
  const batchId = (await createBatch(baseUrl, [d1.id, d2.id])).body.data.id;
  await request(baseUrl, "POST", `/batches/${batchId}/start`);

  // d1 完整，d2 缺 repairNote
  const res = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
    results: [
      { damageId: d1.id, afterPhotoUrl: "u1", repairNote: "note1" },
      { damageId: d2.id, afterPhotoUrl: "u2", repairNote: "" }
    ]
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "E_INCOMPLETE_RESULT");
  assert.deepEqual(res.body.error.details.items, [
    { damageId: d2.id, missing: ["repairNote"] }
  ]);

  // d1 缺照片
  const noPhoto = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
    results: [
      { damageId: d1.id, afterPhotoUrl: "", repairNote: "note1" },
      { damageId: d2.id, afterPhotoUrl: "u2", repairNote: "note2" }
    ]
  });
  assert.equal(noPhoto.status, 422);

  // 缺项（results 没覆盖全部本批缺损项）
  const missingOne = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
    results: [{ damageId: d1.id, afterPhotoUrl: "u1", repairNote: "note1" }]
  });
  assert.equal(missingOne.status, 422);

  // 回滚验证：批次仍 in_progress，缺损项仍 in_repair，未写入照片/结果
  const db = await readDbFile(file);
  const batch = db.batches.find((b) => b.id === batchId);
  assert.equal(batch.status, "in_progress");
  assert.equal(batch.completedAt, null);
  for (const d of db.damages) {
    assert.equal(d.status, "in_repair");
    assert.equal(d.afterPhotoUrl, "");
    assert.equal(d.repairNote, "");
    assert.equal(d.repairedAt, null);
  }
});

test("完工只处理本批项目：results 中夹带其他批次/不存在的缺损项会被拒绝", async (t) => {
  const { baseUrl } = await startServer(t);
  const r = await createRubbing(baseUrl);
  const d1 = await createDamage(baseUrl, r.id, { position: "d1" });
  const d2 = await createDamage(baseUrl, r.id, { position: "d2" });

  const batchId = (await createBatch(baseUrl, [d1.id])).body.data.id;
  await request(baseUrl, "POST", `/batches/${batchId}/start`);

  // 夹带不属于本批次的缺损项
  const foreign = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
    results: [
      { damageId: d1.id, afterPhotoUrl: "u1", repairNote: "note1" },
      { damageId: d2.id, afterPhotoUrl: "u2", repairNote: "note2" }
    ]
  });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.error.code, "E_RESULT_NOT_IN_BATCH");

  // results 内同一缺损项重复
  const dupResult = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
    results: [
      { damageId: d1.id, afterPhotoUrl: "u1", repairNote: "note1" },
      { damageId: d1.id, afterPhotoUrl: "u1b", repairNote: "note1b" }
    ]
  });
  assert.equal(dupResult.status, 400);
  assert.equal(dupResult.body.error.code, "E_DUPLICATE_IN_REQUEST");
});

test("重复完工不能覆盖记录：第二次返回 409，照片/结果/时间戳保持首次值", async (t) => {
  const { baseUrl, file } = await startServer(t);
  const r = await createRubbing(baseUrl);
  const d1 = await createDamage(baseUrl, r.id);
  const batchId = (await createBatch(baseUrl, [d1.id])).body.data.id;
  await request(baseUrl, "POST", `/batches/${batchId}/start`);

  const first = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
    results: [{ damageId: d1.id, afterPhotoUrl: "https://first.jpg", repairNote: "首次结果" }]
  });
  assert.equal(first.status, 200);
  const firstCompletedAt = first.body.data.completedAt;
  const firstRepairedAt = first.body.data.damages[0].repairedAt;

  const second = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
    results: [{ damageId: d1.id, afterPhotoUrl: "https://second.jpg", repairNote: "第二次结果" }]
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "E_ALREADY_COMPLETED");

  const db = await readDbFile(file);
  const damage = db.damages.find((d) => d.id === d1.id);
  assert.equal(damage.afterPhotoUrl, "https://first.jpg");
  assert.equal(damage.repairNote, "首次结果");
  assert.equal(damage.repairedAt, firstRepairedAt);
  assert.equal(db.batches[0].completedAt, firstCompletedAt);
});

// ---------- 并发与回滚 ----------

test("并发创建两个包含同一缺损项的批次：只有一个成功，缺损项只归属一个批次", async (t) => {
  const { baseUrl, file } = await startServer(t);
  const r = await createRubbing(baseUrl);
  const d1 = await createDamage(baseUrl, r.id);
  const d2 = await createDamage(baseUrl, r.id);

  const results = await Promise.all([
    createBatch(baseUrl, [d1.id]),
    createBatch(baseUrl, [d1.id, d2.id])
  ]);
  const success = results.filter((r2) => r2.status === 201);
  const failed = results.filter((r2) => r2.status === 409);
  assert.equal(success.length, 1);
  assert.equal(failed.length, 1);

  const db = await readDbFile(file);
  assert.equal(db.batches.length, 1);
  assert.equal(db.damages.filter((d) => d.batchId !== null).length, success[0].body.data.total);
  const d1OnDisk = db.damages.find((d) => d.id === d1.id);
  assert.equal(d1OnDisk.batchId, success[0].body.data.id);
});

test("并发完工同一批次：只有一个成功，且记录不被覆盖", async (t) => {
  const { baseUrl, file } = await startServer(t);
  const r = await createRubbing(baseUrl);
  const d1 = await createDamage(baseUrl, r.id);
  const batchId = (await createBatch(baseUrl, [d1.id])).body.data.id;
  await request(baseUrl, "POST", `/batches/${batchId}/start`);

  const payloadA = { results: [{ damageId: d1.id, afterPhotoUrl: "a.jpg", repairNote: "A" }] };
  const payloadB = { results: [{ damageId: d1.id, afterPhotoUrl: "b.jpg", repairNote: "B" }] };
  const results = await Promise.all([
    request(baseUrl, "POST", `/batches/${batchId}/complete`, payloadA),
    request(baseUrl, "POST", `/batches/${batchId}/complete`, payloadB)
  ]);
  assert.equal(results.filter((r2) => r2.status === 200).length, 1);
  assert.equal(results.filter((r2) => r2.status === 409).length, 1);

  const db = await readDbFile(file);
  const damage = db.damages.find((d) => d.id === d1.id);
  assert.equal(damage.status, "repaired");
  assert.ok(["a.jpg", "b.jpg"].includes(damage.afterPhotoUrl));
  // 落盘值必须与成功响应完全一致（两次提交不会各写一半）
  const winner = results.find((r2) => r2.status === 200).body.data.damages[0];
  assert.equal(damage.afterPhotoUrl, winner.afterPhotoUrl);
  assert.equal(damage.repairNote, winner.repairNote);
});

test("异常写入后回滚：磁盘落盘失败时返回 500，内存与磁盘均保持上一版本", async (t) => {
  // 批次创建的那一次落盘注入 ENOSPC（仅一次），其余落盘正常
  const { baseUrl, file } = await startServer(t, {
    persistWrapper: (real) => {
      let failed = false;
      return async (f, json) => {
        const parsed = JSON.parse(json);
        if (!failed && parsed.batches.length > 0) {
          failed = true;
          const err = new Error("ENOSPC: simulated disk failure");
          err.code = "ENOSPC";
          throw err;
        }
        return real(f, json);
      };
    }
  });

  const before = await readDbFile(file);

  const r = await createRubbing(baseUrl);
  const d1 = await createDamage(baseUrl, r.id);
  // createBatch 触发第二次 persist → 注入的失败
  const res = await createBatch(baseUrl, [d1.id]);
  assert.equal(res.status, 500);
  assert.equal(res.body.error.code, "E_INTERNAL");

  // 内存回滚：批次不存在、缺损项未被占用
  const batches = await request(baseUrl, "GET", "/batches");
  assert.equal(batches.body.data.length, 0);
  const damages = await request(baseUrl, "GET", `/rubbings/${r.id}/damages`);
  assert.equal(damages.body.data[0].batchId, null);
  assert.equal(damages.body.data[0].status, "pending");

  // 磁盘回滚：db.json 仍是失败前版本
  const after = await readDbFile(file);
  assert.deepEqual(after.batches, before.batches);
  const afterDamage = after.damages.find((d) => d.id === d1.id);
  assert.equal(afterDamage.batchId, null);

  // 故障只影响那一个事务：后续写入仍然成功
  const retry = await createBatch(baseUrl, [d1.id], { name: "retry-batch" });
  assert.equal(retry.status, 201);
});

test("原子落盘：写入中途崩溃不会留下半写的 db.json", async (t) => {
  // 批次创建时写完临时文件、rename 之前抛错，模拟进程崩溃：正式 db.json 必须完好
  const { baseUrl, file } = await startServer(t, {
    persistWrapper: (real) => async (f, json) => {
      const parsed = JSON.parse(json);
      if (parsed.batches.length > 0) {
        await require("node:fs/promises").writeFile(`${f}.tmp`, json, "utf8");
        throw new Error("crash before rename");
      }
      return real(f, json);
    }
  });

  const r = await createRubbing(baseUrl);
  const d1 = await createDamage(baseUrl, r.id);
  const res = await createBatch(baseUrl, [d1.id]);
  assert.equal(res.status, 500);

  // 正式文件仍是合法 JSON 且不含失败批次
  const db = await readDbFile(file);
  assert.ok(Array.isArray(db.batches));
  assert.equal(db.batches.length, 0);
});

// ---------- 其他 ----------

test("PATCH 只允许修改待修项的描述字段，不能改状态或批次归属", async (t) => {
  const { baseUrl } = await startServer(t);
  const r = await createRubbing(baseUrl);
  const d1 = await createDamage(baseUrl, r.id);
  const d2 = await createDamage(baseUrl, r.id);
  const batchId = (await createBatch(baseUrl, [d1.id])).body.data.id;
  await request(baseUrl, "POST", `/batches/${batchId}/start`);

  // 非待修项不可改
  const locked = await request(baseUrl, "PATCH", `/damages/${d1.id}`, { position: "新位置" });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error.code, "E_NOT_EDITABLE");

  // 试图改状态字段
  const illegal = await request(baseUrl, "PATCH", `/damages/${d2.id}`, { status: "repaired" });
  assert.equal(illegal.status, 400);
  assert.equal(illegal.body.error.code, "E_FIELD_IMMUTABLE");

  // 合法修改
  const ok = await request(baseUrl, "PATCH", `/damages/${d2.id}`, {
    position: "新位置",
    type: "霉变",
    beforePhotoUrl: "https://example.local/new.jpg"
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.position, "新位置");
  assert.equal(ok.body.data.status, "pending");
});

test("请求错误统一格式：非法 JSON、未知路由、不存在的批次", async (t) => {
  const { baseUrl } = await startServer(t);

  const res = await fetch(`${baseUrl}/rubbings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json"
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "E_BAD_JSON");

  const notFound = await request(baseUrl, "GET", "/batches/batch_nope");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, "E_BATCH_NOT_FOUND");

  const noRoute = await request(baseUrl, "GET", "/nope");
  assert.equal(noRoute.status, 404);
  assert.equal(noRoute.body.error.code, "E_ROUTE_NOT_FOUND");
});

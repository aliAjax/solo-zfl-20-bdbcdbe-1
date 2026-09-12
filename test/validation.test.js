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

/** 每类“伪装成字符串”的非法标量：空数组、非空数组、对象、数字、布尔、null。 */
const NON_STRING = [[], ["x"], { a: 1 }, 42, 12.5, true, null];

test("[类型校验] 登记拓片：编号/来源/纸幅收到数组或对象一律 400 且不落库", async (t) => {
  const { baseUrl, file } = await startServer(t);

  for (const bad of NON_STRING) {
    const res = await request(baseUrl, "POST", "/rubbings", {
      code: bad,
      source: "s",
      paperSize: "1x1"
    });
    assert.equal(res.status, 400, `code=${JSON.stringify(bad)}`);
    assert.equal(res.body.error.code, "E_INVALID_TYPE");
    assert.deepEqual(res.body.error.details.fields.map((x) => x.field), ["code"]);
    const expectedActual = Array.isArray(bad) ? "array" : bad === null ? "null" : typeof bad;
    assert.equal(res.body.error.details.fields[0].actual, expectedActual);
  }

  for (const field of ["source", "paperSize"]) {
    const res = await request(baseUrl, "POST", "/rubbings", {
      code: `TP-${field}-arr`,
      source: field === "source" ? [] : "s",
      paperSize: field === "paperSize" ? [] : "1x1"
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "E_INVALID_TYPE");
    assert.equal(res.body.error.details.fields[0].field, field);
  }

  // 明确校验不落库：只有（如果有）合法拓片存在，非法请求不产生记录
  const list = await request(baseUrl, "GET", "/rubbings");
  assert.equal(list.body.data.length, 0);
  const onDisk = await readDbFile(file);
  assert.equal(onDisk.rubbings.length, 0);
});

test("[类型校验] 登记缺损项：位置/类型/修补前照片是数组或对象一律拒绝", async (t) => {
  const { baseUrl, file } = await startServer(t);
  const rubbing = await createRubbing(baseUrl, "TP-DMG-TYPE");

  for (const bad of NON_STRING) {
    for (const field of ["position", "type", "beforePhotoUrl"]) {
      const res = await request(baseUrl, "POST", `/rubbings/${rubbing.id}/damages`, {
        position: "p",
        type: "t",
        beforePhotoUrl: "u",
        [field]: bad
      });
      assert.equal(res.status, 400, `${field}=${JSON.stringify(bad)}`);
      assert.equal(res.body.error.code, "E_INVALID_TYPE");
    }
  }

  // 明确复现报告的漏洞：空数组照片不能登记成功
  const emptyArrPhoto = await request(baseUrl, "POST", `/rubbings/${rubbing.id}/damages`, {
    position: "p",
    type: "t",
    beforePhotoUrl: []
  });
  assert.equal(emptyArrPhoto.status, 400);

  const onDisk = await readDbFile(file);
  assert.equal(onDisk.damages.length, 0);
});

test("[类型校验] PATCH：描述字段收到数组/对象拒绝且原值不变", async (t) => {
  const { baseUrl, file } = await startServer(t);
  const rubbing = await createRubbing(baseUrl, "TP-PATCH-TYPE");
  const d = await createDamage(baseUrl, rubbing.id, { position: "原位置" });

  for (const bad of [[], {}, 7]) {
    const res = await request(baseUrl, "PATCH", `/damages/${d.id}`, { position: bad });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "E_INVALID_TYPE");
  }
  // 空白字符串仍是 400（E_MISSING_FIELD），与类型错误区分
  const blank = await request(baseUrl, "PATCH", `/damages/${d.id}`, { position: "   " });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error.code, "E_MISSING_FIELD");

  const onDisk = await readDbFile(file);
  assert.equal(onDisk.damages[0].position, "原位置");
});

test("[类型校验] 建批：name 为数组/对象拒绝；damageIds 元素为空数组/对象/数字拒绝", async (t) => {
  const { baseUrl, file } = await startServer(t);
  const rubbing = await createRubbing(baseUrl, "TP-BATCH-TYPE");
  const d1 = await createDamage(baseUrl, rubbing.id);

  for (const bad of [[], {}, 1, true]) {
    const res = await createBatch(baseUrl, [d1.id], { name: bad });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "E_INVALID_TYPE");
  }

  // damageIds 内层元素类型错误
  for (const bad of [[], {}, 123, null, ""]) {
    const res = await createBatch(baseUrl, [bad]);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error.code, "E_INVALID_TYPE");
  }
  // 混合：一个合法一个非法 → 仍然整体拒绝
  const mixed = await createBatch(baseUrl, [d1.id, {}]);
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.error.code, "E_INVALID_TYPE");

  const onDisk = await readDbFile(file);
  assert.equal(onDisk.batches.length, 0);
  assert.equal(onDisk.damages[0].batchId, null);
});

test("[类型校验] 完工：照片/说明为数组或对象返回 400，批次保持处理中且不落库", async (t) => {
  const { baseUrl, file } = await startServer(t);
  const rubbing = await createRubbing(baseUrl, "TP-COMP-TYPE");
  const d1 = await createDamage(baseUrl, rubbing.id);
  const d2 = await createDamage(baseUrl, rubbing.id, { position: "d2" });
  const batchId = (await createBatch(baseUrl, [d1.id, d2.id])).body.data.id;
  await request(baseUrl, "POST", `/batches/${batchId}/start`);

  // 报告的核心漏洞：空数组照片曾让批次完工、落库空值
  const emptyArr = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
    results: [
      { damageId: d1.id, afterPhotoUrl: [], repairNote: "n1" },
      { damageId: d2.id, afterPhotoUrl: "u2", repairNote: "n2" }
    ]
  });
  assert.equal(emptyArr.status, 400);
  assert.equal(emptyArr.body.error.code, "E_INVALID_TYPE");
  assert.deepEqual(emptyArr.body.error.details.items[0].fields.sort(), ["afterPhotoUrl"]);

  for (const bad of [[], ["x"], {}, 9, false]) {
    for (const field of ["afterPhotoUrl", "repairNote"]) {
      const res = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
        results: [
          { damageId: d1.id, afterPhotoUrl: "u1", repairNote: "n1", [field]: bad },
          { damageId: d2.id, afterPhotoUrl: "u2", repairNote: "n2" }
        ]
      });
      assert.equal(res.status, 400, `${field}=${JSON.stringify(bad)}`);
      assert.equal(res.body.error.code, "E_INVALID_TYPE");
    }
  }

  // results 元素本身不是对象
  for (const bad of [null, "x", 42, []]) {
    const res = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
      results: [bad, { damageId: d2.id, afterPhotoUrl: "u2", repairNote: "n2" }]
    });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error.code, "E_INVALID_TYPE");
  }

  // damageId 类型错误 / 缺失
  const badId = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
    results: [
      { damageId: {}, afterPhotoUrl: "u1", repairNote: "n1" },
      { afterPhotoUrl: "u2", repairNote: "n2" }
    ]
  });
  assert.equal(badId.status, 400);
  assert.equal(badId.body.error.code, "E_INVALID_TYPE");

  // 批次级 note 非法
  const badNote = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
    note: [],
    results: goodResults([d1, d2]).results
  });
  assert.equal(badNote.status, 400);
  assert.equal(badNote.body.error.code, "E_INVALID_TYPE");

  // 非法请求后批次仍是处理中，缺损项仍是处理中、照片为空
  const onDisk = await readDbFile(file);
  const batch = onDisk.batches.find((b) => b.id === batchId);
  assert.equal(batch.status, "in_progress");
  assert.equal(batch.completedAt, null);
  for (const d of onDisk.damages) {
    assert.equal(d.status, "in_repair");
    assert.equal(d.afterPhotoUrl, "");
    assert.equal(d.repairNote, "");
    assert.equal(d.repairedAt, null);
  }
});

test("[类型校验] 完工：results 不是数组 / 空数组 / 缺失均为 400", async (t) => {
  const { baseUrl } = await startServer(t);
  const rubbing = await createRubbing(baseUrl, "TP-RES-TYPE");
  const d1 = await createDamage(baseUrl, rubbing.id);
  const batchId = (await createBatch(baseUrl, [d1.id])).body.data.id;
  await request(baseUrl, "POST", `/batches/${batchId}/start`);

  for (const bad of [{}, [], null, "x", 42, undefined]) {
    const res = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
      results: bad
    });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error.code, "E_INVALID_RESULTS");
  }
});

test("[类型校验] 结构合法但缺非空照片/说明仍是 422；补全后正常完工", async (t) => {
  const { baseUrl, file } = await startServer(t);
  const rubbing = await createRubbing(baseUrl, "TP-422-THEN-OK");
  const d1 = await createDamage(baseUrl, rubbing.id);
  const d2 = await createDamage(baseUrl, rubbing.id, { position: "d2" });
  const batchId = (await createBatch(baseUrl, [d1.id, d2.id])).body.data.id;
  await request(baseUrl, "POST", `/batches/${batchId}/start`);

  // 空字符串照片（合法字符串但为空）→ 422
  const blankPhoto = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
    results: [
      { damageId: d1.id, afterPhotoUrl: "   ", repairNote: "n1" },
      { damageId: d2.id, afterPhotoUrl: "u2", repairNote: "n2" }
    ]
  });
  assert.equal(blankPhoto.status, 422);
  assert.equal(blankPhoto.body.error.code, "E_INCOMPLETE_RESULT");
  assert.deepEqual(blankPhoto.body.error.details.items, [
    { damageId: d1.id, missing: ["afterPhotoUrl"] }
  ]);

  // 422 后批次保持处理中
  let onDisk = await readDbFile(file);
  assert.equal(onDisk.batches[0].status, "in_progress");

  // 补全全部非空字符串照片和说明 → 完工成功
  const ok = await request(baseUrl, "POST", `/batches/${batchId}/complete`, {
    results: [
      { damageId: d1.id, afterPhotoUrl: "https://x/a1.jpg", repairNote: "托裱补绢" },
      { damageId: d2.id, afterPhotoUrl: "https://x/a2.jpg", repairNote: "纸浆补裂" }
    ]
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, "completed");
  assert.equal(ok.body.data.repaired, 2);

  onDisk = await readDbFile(file);
  assert.equal(onDisk.batches[0].status, "completed");
  assert.ok(onDisk.batches[0].completedAt);
  for (const d of onDisk.damages) {
    assert.equal(d.status, "repaired");
    assert.ok(typeof d.afterPhotoUrl === "string" && d.afterPhotoUrl.length > 0);
    assert.ok(typeof d.repairNote === "string" && d.repairNote.length > 0);
    assert.ok(d.repairedAt);
  }
});

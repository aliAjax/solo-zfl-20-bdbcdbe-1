"use strict";

const { ApiError } = require("./db");

/**
 * 请求处理器（与 http 服务解耦，方便测试直接注入 store）。
 *
 * 状态机：
 *   缺损项 damage:  pending（待修，可被批次收录）→ in_repair（开工）→ repaired（完工，终态）
 *   批次   batch :  open（已收录未开工）→ in_progress（处理中）→ completed（完工，终态）
 */

const ROUTES = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=&rubbingId=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "POST /batches/:id/start",
  "GET /batches/:id",
  "POST /batches/:id/complete"
];

const MAX_BODY_BYTES = 1024 * 1024;

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 必填字段：必须是“非空白字符串”。数组/对象/数字/布尔/null 一律拒绝。 */
function requireFields(body, fields) {
  const missing = [];
  const wrongType = [];
  for (const field of fields) {
    const value = body[field];
    if (value === undefined || (typeof value === "string" && value.trim() === "")) {
      missing.push(field);
    } else if (typeof value !== "string") {
      wrongType.push({ field, actual: Array.isArray(value) ? "array" : value === null ? "null" : typeof value });
    }
  }
  if (missing.length) {
    throw new ApiError(400, "E_MISSING_FIELD", `缺少必填字段：${missing.join(", ")}`, { missing });
  }
  if (wrongType.length) {
    throw new ApiError(
      400,
      "E_INVALID_TYPE",
      `字段必须是非空字符串：${wrongType.map((i) => i.field).join(", ")}`,
      { fields: wrongType }
    );
  }
}

/** 可选字符串字段：undefined 落默认值；给了就必须是字符串（数组/对象等拒绝）。 */
function optionalString(body, field, fallback = "") {
  const value = body[field];
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    throw new ApiError(400, "E_INVALID_TYPE", `字段必须是字符串：${field}`, {
      fields: [{ field, actual: Array.isArray(value) ? "array" : typeof value }]
    });
  }
  return value.trim();
}

function createHandler(store) {
  // ---------- 纯查询 ----------

  function findRubbing(db, id) {
    const rubbing = db.rubbings.find((r) => r.id === id);
    if (!rubbing) throw new ApiError(404, "E_RUBBING_NOT_FOUND", "拓片不存在");
    return rubbing;
  }

  function findDamage(db, id) {
    const damage = db.damages.find((d) => d.id === id);
    if (!damage) throw new ApiError(404, "E_DAMAGE_NOT_FOUND", "缺损项不存在");
    return damage;
  }

  function findBatch(db, id) {
    const batch = db.batches.find((b) => b.id === id);
    if (!batch) throw new ApiError(404, "E_BATCH_NOT_FOUND", "修补批次不存在");
    return batch;
  }

  function rubbingView(db, rubbing) {
    const damages = db.damages.filter((d) => d.rubbingId === rubbing.id);
    return {
      ...rubbing,
      damageCount: damages.length,
      pendingDamages: damages.filter((d) => d.status === "pending").length,
      inRepairDamages: damages.filter((d) => d.status === "in_repair").length,
      repairedDamages: damages.filter((d) => d.status === "repaired").length
    };
  }

  function enrichBatch(db, batch) {
    const damages = batch.damageIds.map((id) => db.damages.find((d) => d.id === id)).filter(Boolean);
    return {
      ...batch,
      damages,
      total: damages.length,
      pending: damages.filter((d) => d.status === "pending").length,
      inRepair: damages.filter((d) => d.status === "in_repair").length,
      repaired: damages.filter((d) => d.status === "repaired").length
    };
  }

  // ---------- HTTP 辅助 ----------

  async function parseBody(req) {
    let raw = "";
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        throw new ApiError(413, "E_BODY_TOO_LARGE", "请求体超过 1MB 限制");
      }
      raw += chunk;
    }
    if (!raw) return {};
    try {
      const body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("body must be object");
      }
      return body;
    } catch {
      throw new ApiError(400, "E_BAD_JSON", "请求体必须是合法的 JSON 对象");
    }
  }

  // ---------- 业务操作（全部在事务的 draft 上执行） ----------

  function createRubbing(db, body) {
    requireFields(body, ["code", "source", "paperSize"]);
    const code = body.code.trim();
    if (db.rubbings.some((r) => r.code === code)) {
      throw new ApiError(409, "E_CODE_DUPLICATE", `拓片编号已存在：${code}`);
    }
    const rubbing = {
      id: makeId("rubbing"),
      code,
      source: body.source.trim(),
      paperSize: body.paperSize.trim(),
      note: optionalString(body, "note"),
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    return rubbing;
  }

  function createDamage(db, rubbingId, body) {
    findRubbing(db, rubbingId);
    requireFields(body, ["position", "type", "beforePhotoUrl"]);
    const now = new Date().toISOString();
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position.trim(),
      type: body.type.trim(),
      beforePhotoUrl: body.beforePhotoUrl.trim(),
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: now,
      startedAt: null,
      repairedAt: null
    };
    db.damages.push(damage);
    return damage;
  }

  /** 待修项可改的只有描述字段；状态、批次归属等一律不允许通过 PATCH 改。 */
  const DAMAGE_PATCHABLE = new Set(["position", "type", "beforePhotoUrl"]);

  function patchDamage(db, damageId, body) {
    const damage = findDamage(db, damageId);
    if (damage.status !== "pending") {
      throw new ApiError(
        409,
        "E_NOT_EDITABLE",
        `缺损项当前状态为 ${damage.status}，只有待修项可以修改`
      );
    }
    const illegal = Object.keys(body).filter((k) => !DAMAGE_PATCHABLE.has(k));
    if (illegal.length) {
      throw new ApiError(400, "E_FIELD_IMMUTABLE", `字段不可修改：${illegal.join(", ")}`, {
        illegal
      });
    }
    for (const field of ["position", "type", "beforePhotoUrl"]) {
      if (body[field] !== undefined) {
        if (typeof body[field] !== "string") {
          throw new ApiError(400, "E_INVALID_TYPE", `字段必须是非空字符串：${field}`, {
            fields: [{ field, actual: Array.isArray(body[field]) ? "array" : typeof body[field] }]
          });
        }
        if (body[field].trim() === "") {
          throw new ApiError(400, "E_MISSING_FIELD", `字段不能为空：${field}`, { field });
        }
        damage[field] = body[field].trim();
      }
    }
    return damage;
  }

  /**
   * 创建批次（收录待修项）：
   * - 只收 pending 的缺损项；
   * - 同一缺损项不能被重复收录（已归属其他批次即拒绝）；
   * - 一张批次只能属于同一张拓片，跨拓片混批拒绝。
   * 收录即刻占用缺损项（写 batchId），但状态仍为 pending，开工后才变 in_repair。
   */
  function createBatch(db, body) {
    requireFields(body, ["name"]);
    const name = body.name.trim();
    const damageIds = body.damageIds;
    if (!Array.isArray(damageIds) || damageIds.length === 0) {
      throw new ApiError(400, "E_INVALID_DAMAGE_IDS", "damageIds 必须是非空数组");
    }
    const badIndex = damageIds
      .map((id, index) => index)
      .filter((index) => {
        const id = damageIds[index];
        return typeof id !== "string" || id.trim() === "";
      });
    if (badIndex.length) {
      throw new ApiError(400, "E_INVALID_TYPE", "damageIds 的每一项必须是非空字符串 id", {
        index: badIndex
      });
    }
    const ids = damageIds.map((id) => id.trim());

    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (repeated.length) {
      throw new ApiError(400, "E_DUPLICATE_IN_REQUEST", "提交列表中存在重复缺损项", {
        repeated: [...new Set(repeated)]
      });
    }

    const notFound = ids.filter((id) => !db.damages.some((d) => d.id === id));
    if (notFound.length) {
      throw new ApiError(404, "E_DAMAGE_NOT_FOUND", `缺损项不存在：${notFound.join(", ")}`, {
        notFound
      });
    }

    const items = ids.map((id) => db.damages.find((d) => d.id === id));

    const rubbingIds = [...new Set(items.map((d) => d.rubbingId))];
    if (rubbingIds.length > 1) {
      throw new ApiError(409, "E_CROSS_RUBBING_BATCH", "一个批次只能收录同一张拓片的缺损项", {
        rubbingIds
      });
    }

    const notPending = items
      .filter((d) => d.status !== "pending")
      .map((d) => ({ damageId: d.id, status: d.status }));
    if (notPending.length) {
      throw new ApiError(409, "E_NOT_PENDING", "批次只能收录待修项，存在已开工或已完工的缺损项", {
        items: notPending
      });
    }

    const alreadyCollected = items.filter((d) => d.batchId !== null).map((d) => d.id);
    if (alreadyCollected.length) {
      throw new ApiError(409, "E_ALREADY_COLLECTED", "缺损项已被其他批次收录，不能重复收录", {
        damageIds: alreadyCollected
      });
    }

    const now = new Date().toISOString();
    let batchId;
    do {
      batchId = makeId("batch");
    } while (db.batches.some((b) => b.id === batchId));

    const batch = {
      id: batchId,
      name,
      rubbingId: rubbingIds[0],
      status: "open",
      damageIds: ids,
      note: optionalString(body, "note"),
      createdAt: now,
      startedAt: null,
      completedAt: null
    };
    db.batches.push(batch);
    for (const d of items) d.batchId = batchId;
    return enrichBatch(db, batch);
  }

  /** 开工：批次 open → in_progress，本批缺损项统一 pending → in_repair。 */
  function startBatch(db, batchId) {
    const batch = findBatch(db, batchId);
    if (batch.status === "completed") {
      throw new ApiError(409, "E_ALREADY_COMPLETED", "批次已完工，不能重复开工");
    }
    if (batch.status === "in_progress") {
      throw new ApiError(409, "E_ALREADY_STARTED", "批次已开工，不能重复开工");
    }
    const now = new Date().toISOString();
    batch.status = "in_progress";
    batch.startedAt = now;
    for (const id of batch.damageIds) {
      const damage = db.damages.find((d) => d.id === id);
      if (!damage) continue;
      damage.status = "in_repair";
      damage.startedAt = now;
    }
    return enrichBatch(db, batch);
  }

  /**
   * 完工：
   * - 批次必须处于 in_progress（未开工/已完工都拒绝）；
   * - 只处理本批缺损项；results 必须为本批每一项各提交一次修补照片和修补结果；
   * - 缺照片或缺结果 → 422，整批拒绝，任何数据都不落盘；
   * - 重复完工 → 409，已有记录不被覆盖。
   */
  function completeBatch(db, batchId, body) {
    const batch = findBatch(db, batchId);
    if (batch.status === "open") {
      throw new ApiError(409, "E_BATCH_NOT_STARTED", "批次尚未开工，不能完工");
    }
    if (batch.status === "completed") {
      throw new ApiError(409, "E_ALREADY_COMPLETED", "批次已完工，重复完工不会覆盖原记录");
    }

    const results = body.results;
    if (!Array.isArray(results) || results.length === 0) {
      throw new ApiError(400, "E_INVALID_RESULTS", "results 必须是非空数组");
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      throw new ApiError(400, "E_INVALID_TYPE", "字段必须是字符串：note", {
        fields: [{ field: "note", actual: Array.isArray(body.note) ? "array" : typeof body.note }]
      });
    }

    // 结构/类型错误（不是对象、字段不是字符串、id 为空）→ 400，明确且不落库
    const malformed = [];
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      const entry = { index: i, fields: [] };
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        entry.fields.push("entry");
        malformed.push(entry);
        continue;
      }
      for (const field of ["afterPhotoUrl", "repairNote"]) {
        if (r[field] !== undefined && typeof r[field] !== "string") {
          entry.fields.push(field);
        }
      }
      if (typeof r.damageId !== "string" || r.damageId.trim() === "") {
        entry.fields.push("damageId");
      }
      if (entry.fields.length) malformed.push(entry);
    }
    if (malformed.length) {
      throw new ApiError(
        400,
        "E_INVALID_TYPE",
        "results 每项必须是对象，且 damageId/afterPhotoUrl/repairNote 必须是字符串",
        { items: malformed }
      );
    }

    const repeated = results
      .map((r) => r.damageId.trim())
      .filter((id, i, arr) => arr.indexOf(id) !== i);
    if (repeated.length) {
      throw new ApiError(400, "E_DUPLICATE_IN_REQUEST", "results 中存在重复缺损项", {
        repeated: [...new Set(repeated)]
      });
    }

    const unknown = results
      .filter((r) => !batch.damageIds.includes(r.damageId.trim()))
      .map((r) => r.damageId.trim());
    if (unknown.length) {
      throw new ApiError(400, "E_RESULT_NOT_IN_BATCH", "results 包含不属于本批次的缺损项", {
        damageIds: unknown
      });
    }

    // 结构合法但缺少非空照片/修补说明 → 422，整批不完工，批次保持处理中
    const byId = new Map(results.map((r) => [r.damageId.trim(), r]));
    const incomplete = [];
    for (const id of batch.damageIds) {
      const r = byId.get(id);
      const missing = [];
      if (!r || typeof r.afterPhotoUrl !== "string" || r.afterPhotoUrl.trim() === "") {
        missing.push("afterPhotoUrl");
      }
      if (!r || typeof r.repairNote !== "string" || r.repairNote.trim() === "") {
        missing.push("repairNote");
      }
      if (missing.length) incomplete.push({ damageId: id, missing });
    }
    if (incomplete.length) {
      throw new ApiError(
        422,
        "E_INCOMPLETE_RESULT",
        "存在缺少修补照片或修补结果的缺损项，整批不予完工",
        { items: incomplete }
      );
    }

    const now = new Date().toISOString();
    for (const id of batch.damageIds) {
      const damage = db.damages.find((d) => d.id === id);
      if (!damage || damage.status === "repaired") continue; // 防御性：终态不覆盖
      const r = byId.get(id);
      damage.afterPhotoUrl = r.afterPhotoUrl.trim();
      damage.repairNote = r.repairNote.trim();
      damage.status = "repaired";
      damage.repairedAt = now;
    }
    batch.status = "completed";
    batch.completedAt = now;
    if (typeof body.note === "string" && body.note.trim() !== "") batch.note = body.note.trim();
    return enrichBatch(db, batch);
  }

  // ---------- 路由 ----------

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;
    const method = req.method;

    const send = (status, payload) => {
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify(payload, null, 2));
    };
    const ok = (status, data) => send(status, { data });
    const fail = (err) => {
      const body = { error: { code: err.code || "E_INTERNAL", message: err.message } };
      if (err.details) body.error.details = err.details;
      send(err.status || 500, body);
    };

    try {
      if (method === "GET" && pathname === "/health") {
        await store.read();
        return send(200, { ok: true, service: "rubbing-repair-api", routes: ROUTES });
      }

      if (method === "GET" && pathname === "/rubbings") {
        const db = await store.read();
        return ok(200, db.rubbings.map((r) => rubbingView(db, r)));
      }

      if (method === "POST" && pathname === "/rubbings") {
        const body = await parseBody(req);
        const data = await store.tx((db) => createRubbing(db, body));
        return ok(201, data);
      }

      const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
      if (rubbingDamagesMatch) {
        const rubbingId = decodeURIComponent(rubbingDamagesMatch[1]);
        if (method === "GET") {
          const db = await store.read();
          findRubbing(db, rubbingId);
          return ok(200, db.damages.filter((d) => d.rubbingId === rubbingId));
        }
        if (method === "POST") {
          const body = await parseBody(req);
          const data = await store.tx((db) => createDamage(db, rubbingId, body));
          return ok(201, data);
        }
      }

      if (method === "GET" && pathname === "/damages") {
        const status = url.searchParams.get("status");
        const type = url.searchParams.get("type");
        const rubbingId = url.searchParams.get("rubbingId");
        const validStatus = ["pending", "in_repair", "repaired"];
        if (status && !validStatus.includes(status)) {
          throw new ApiError(400, "E_INVALID_STATUS", `status 仅支持：${validStatus.join(", ")}`);
        }
        const db = await store.read();
        const data = db.damages.filter(
          (d) =>
            (!status || d.status === status) &&
            (!type || d.type === type) &&
            (!rubbingId || d.rubbingId === rubbingId)
        );
        return ok(200, data);
      }

      const damageMatch = pathname.match(/^\/damages\/([^/]+)$/);
      if (damageMatch && method === "PATCH") {
        const damageId = decodeURIComponent(damageMatch[1]);
        const body = await parseBody(req);
        const data = await store.tx((db) => patchDamage(db, damageId, body));
        return ok(200, data);
      }

      if (method === "GET" && pathname === "/batches") {
        const db = await store.read();
        return ok(200, db.batches.map((b) => enrichBatch(db, b)));
      }

      if (method === "POST" && pathname === "/batches") {
        const body = await parseBody(req);
        const data = await store.tx((db) => createBatch(db, body));
        return ok(201, data);
      }

      const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
      if (batchMatch && method === "GET") {
        const db = await store.read();
        return ok(200, enrichBatch(db, findBatch(db, decodeURIComponent(batchMatch[1]))));
      }

      const startMatch = pathname.match(/^\/batches\/([^/]+)\/start$/);
      if (startMatch && method === "POST") {
        const data = await store.tx((db) => startBatch(db, decodeURIComponent(startMatch[1])));
        return ok(200, data);
      }

      const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
      if (completeMatch && method === "POST") {
        const body = await parseBody(req);
        const data = await store.tx((db) =>
          completeBatch(db, decodeURIComponent(completeMatch[1]), body)
        );
        return ok(200, data);
      }

      return send(404, { error: { code: "E_ROUTE_NOT_FOUND", message: "接口不存在", routes: ROUTES } });
    } catch (err) {
      if (err instanceof ApiError) return fail(err);
      // eslint-disable-next-line no-console
      console.error("[server] unhandled error:", err);
      return send(500, { error: { code: "E_INTERNAL", message: "服务器内部错误" } });
    }
  }

  return { handle, ROUTES };
}

module.exports = { createHandler, ROUTES };

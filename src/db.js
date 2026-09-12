"use strict";

const { readFile, writeFile, rename, mkdir, open } = require("node:fs/promises");
const path = require("node:path");

/** 统一的业务错误，status 为 HTTP 状态码。 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * 可注入的持久化实现，默认使用「临时文件 + fsync + rename」原子落盘，
 * 进程异常崩溃时 db.json 要么是旧版本、要么是新版本，不会出现半写文件。
 */
async function defaultPersist(file, json) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(json, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

function initialData() {
  const now = new Date().toISOString();
  return {
    rubbings: [
      {
        id: "rubbing_demo",
        code: "TP-清-014",
        source: "地方碑刻残页",
        paperSize: "42x68cm",
        note: "边缘有旧折痕",
        createdAt: now
      }
    ],
    damages: [
      {
        id: "damage_demo_1",
        rubbingId: "rubbing_demo",
        position: "左上角第3列题字旁",
        type: "虫蛀孔",
        beforePhotoUrl: "https://example.local/before-014-1.jpg",
        afterPhotoUrl: "",
        status: "pending",
        repairNote: "",
        batchId: null,
        createdAt: now,
        startedAt: null,
        repairedAt: null
      },
      {
        id: "damage_demo_2",
        rubbingId: "rubbing_demo",
        position: "下边缘中央",
        type: "撕裂",
        beforePhotoUrl: "https://example.local/before-014-2.jpg",
        afterPhotoUrl: "",
        status: "pending",
        repairNote: "",
        batchId: null,
        createdAt: now,
        startedAt: null,
        repairedAt: null
      }
    ],
    batches: []
  };
}

/** 兼容旧版 db.json：补齐新字段。 */
function migrate(data) {
  for (const d of data.damages || []) {
    if (d.startedAt === undefined) d.startedAt = d.status === "pending" ? null : d.createdAt;
  }
  for (const b of data.batches || []) {
    if (b.status === undefined) b.status = "in_progress";
    if (b.startedAt === undefined) b.startedAt = b.createdAt;
  }
  return data;
}

/**
 * 创建一个数据仓库。
 *
 * 一致性保证：
 * - 所有写操作经 tx() 串行化（单写者队列），并发 HTTP 请求不会交叉读写同一份内存状态；
 * - 修改先作用于状态的深拷贝，全部业务校验通过后才原子落盘，
 *   校验失败或磁盘写入失败都会丢弃拷贝，内存与磁盘均保持原值（事务回滚）。
 *
 * @param {object} opts
 * @param {string} opts.file       db.json 路径
 * @param {Function} [opts.persist] 可注入的持久化函数（测试用）
 * @param {boolean} [opts.seedDemo] 文件不存在时是否写入演示数据，默认 true
 */
function createStore(opts = {}) {
  const file = opts.file;
  const persist = opts.persist || defaultPersist;
  const seedDemo = opts.seedDemo !== false;

  /** @type {{rubbings: any[], damages: any[], batches: any[]}|null} */
  let state = null;
  /** 写队列：同一时刻只允许一个事务修改状态。 */
  let chain = Promise.resolve();

  async function load() {
    if (state) return state;
    try {
      const raw = await readFile(file, "utf8");
      state = migrate(JSON.parse(raw));
    } catch (err) {
      if (err && err.code === "ENOENT") {
        state = seedDemo ? initialData() : { rubbings: [], damages: [], batches: [] };
        await persist(file, JSON.stringify(state, null, 2));
      } else {
        throw err;
      }
    }
    return state;
  }

  /** 只读快照（单线程事件循环下读取期间不会有写操作穿插修改字段）。 */
  async function read() {
    return load();
  }

  /**
   * 串行化事务。mutator 接收状态对象；抛错（业务校验失败/落盘失败）即整体回滚。
   * @returns mutator 的返回值
   */
  function tx(mutator) {
    const run = chain.then(async () => {
      const current = await load();
      const draft = structuredClone(current);
      const result = await mutator(draft);
      await persist(file, JSON.stringify(draft, null, 2));
      state = draft;
      return result;
    });
    // 队列本身不能被失败打断：吞掉本事务的 rejection，继续放行后续事务。
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return { file, load, read, tx, ApiError, _persist: persist };
}

module.exports = { createStore, ApiError, defaultPersist, initialData };

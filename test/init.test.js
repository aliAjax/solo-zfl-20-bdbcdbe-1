"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createStore, initialData } = require("../src/db");

async function freshDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rubbing-init-"));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("[初始化] 首次启动在缺失文件时写入固定种子数据，重复启动读到完全一致的状态", async (t) => {
  const dir = await freshDir(t);
  const file = path.join(dir, "db.json");

  // 首次启动：文件不存在 → 写种子
  const first = createStore({ file });
  const state1 = await first.load();
  assert.deepEqual(state1, initialData());

  // 种子时间戳固定，可重复生成
  for (const rubbing of state1.rubbings) {
    assert.equal(rubbing.createdAt, "2026-01-01T00:00:00.000Z");
  }

  // 模拟“重复启动”：新进程、新 store，读同一文件
  const second = createStore({ file });
  const state2 = await second.load();
  assert.deepEqual(state2, initialData());

  // 两个进程看到的状态逐字段一致；磁盘内容也与内存种子一致
  assert.deepEqual(state1, state2);
  const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(onDisk, initialData());
});

test("[初始化] 重复启动不会重复注入种子：启动两次后演示拓片/缺损项数量不变", async (t) => {
  const dir = await freshDir(t);
  const file = path.join(dir, "db.json");

  await createStore({ file }).load();
  await createStore({ file }).load();
  await createStore({ file }).load();

  const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(onDisk.rubbings.length, 1);
  assert.equal(onDisk.rubbings[0].code, "TP-清-014");
  assert.equal(onDisk.damages.length, 2);
  assert.deepEqual(
    onDisk.damages.map((d) => d.id).sort(),
    ["damage_demo_1", "damage_demo_2"]
  );
  assert.equal(onDisk.batches.length, 0);
});

test("[初始化] 已有数据在重启后保留，不会被种子覆盖；SEED_DEMO=0 得到空库", async (t) => {
  const dir = await freshDir(t);
  const file = path.join(dir, "db.json");

  // 空库模式：不写种子
  const empty = createStore({ file: path.join(dir, "empty.json"), seedDemo: false });
  const emptyState = await empty.load();
  assert.deepEqual(emptyState, { rubbings: [], damages: [], batches: [] });

  // 种子库上做一次写入，再用新 store 重启：写入必须保留、种子不被重复添加
  const store = createStore({ file });
  await store.load();
  await store.tx((db) => {
    db.rubbings.push({
      id: "rubbing_custom",
      code: "TP-CUSTOM",
      source: "s",
      paperSize: "1x1",
      note: "",
      createdAt: "2026-02-02T00:00:00.000Z"
    });
    return null;
  });

  const restarted = createStore({ file });
  const state = await restarted.load();
  assert.deepEqual(
    state.rubbings.map((r) => r.code).sort(),
    ["TP-CUSTOM", "TP-清-014"]
  );
});

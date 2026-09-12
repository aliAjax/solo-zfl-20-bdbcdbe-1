"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { ROUTES } = require("../src/app");

const README = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

/** 统计测试目录中声明的 test() 数量（公共工具在 testutil/，不计入）。 */
function countDeclaredTests() {
  const dir = path.join(__dirname);
  let count = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".test.js")) continue;
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const matches = src.match(/^test\(\s*["'`]/gm) || [];
    count += matches.length;
  }
  return count;
}

test("[文档] README 标注的用例数量与实际测试声明一致", () => {
  const actual = countDeclaredTests();
  const m = README.match(/自动化用例[^\d]*(\d+)/);
  assert.ok(m, "README 中应包含“自动化用例：N”说明");
  assert.equal(Number(m[1]), actual, `README 写的是 ${m[1]}，实际声明 ${actual} 个测试`);
});

test("[文档] README 覆盖全部对外路由与关键启动命令", () => {
  for (const route of ROUTES) {
    // 文档里至少出现路径部分
    const pathPart = route.split(" ")[1].split("?")[0];
    assert.ok(
      README.includes(pathPart),
      `README 缺少路由 ${route}（路径片段 ${pathPart}）`
    );
  }
  assert.ok(README.includes("node server.js"), "缺少启动命令");
  assert.ok(README.includes("npm test"), "缺少测试命令");
  assert.ok(README.includes("PORT"), "缺少环境变量说明");
});

test("[文档] README 错误码表覆盖代码实际返回的全部错误码", () => {
  // 从 app.js 源码收集 E_* 错误码（只认字符串字面量，排除标识符子串）
  const appSrc = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const codes = [...new Set(appSrc.match(/["'`](E_[A-Z_]+)["'`]/g) || [])]
    .map((s) => s.slice(1, -1))
    .filter((c) => c !== "E_INTERNAL");
  for (const code of codes) {
    assert.ok(README.includes(code), `README 错误码表缺少 ${code}`);
  }
  assert.ok(README.includes("E_INTERNAL"), "README 缺少 500 E_INTERNAL 说明");
});

test("[文档] README 说明种子数据、重置方式与 405/方法限制", () => {
  assert.ok(README.includes("data/db.json"), "应说明种子文件路径");
  assert.ok(/重置|清空|SEED_DEMO/.test(README), "应说明重置/空库方式");
  assert.ok(README.includes("E_METHOD_NOT_ALLOWED"), "应文档化 405");
  assert.ok(README.includes("Allow"), "应说明 Allow 头");
});

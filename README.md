# 古籍拓片缺损修补服务（rubbing-repair-api）

零依赖 Node.js 后端（仅需 Node ≥ 18），用 JSON 文件原子持久化，内置串行事务，
覆盖拓片登记、缺损项收录、修补批次开工/完工的完整闭环。

## 快速启动

```bash
node server.js                 # 默认 http://127.0.0.1:3020
# 可选环境变量
PORT=8080 HOST=0.0.0.0 DB_FILE=/data/rubbing/db.json SEED_DEMO=0 node server.js
```

首次启动若 `data/db.json` 不存在，会自动写入一条演示拓片和两个待修缺损项；
设 `SEED_DEMO=0` 则使用空库启动。健康检查：`GET /health`。

## 运行测试

```bash
npm test          # node --test，18 个用例，无需先启动服务
```

测试覆盖：状态全流转、各类重复请求拦截、并发收录/并发完工、缺照片缺结果回滚、
磁盘写入失败回滚、原子落盘崩溃恢复。

## 领域模型与状态机

```
缺损项 damage   pending ──(批次开工)──> in_repair ──(批次完工)──> repaired(终态)
                  │ 被批次收录时写入 batchId（占用），状态仍为 pending
批次   batch    open ──(POST /start)──> in_progress ──(POST /complete)──> completed(终态)
```

约束：

- **拓片编号 `code` 全局唯一**；缺损项只能创建在某张拓片下（`rubbingId` 必填且不可变）。
- **批次只收待修项**：非 `pending`、已被其他批次占用的缺损项一律拒绝。
- **不允许重复收录**：同一请求内重复、或跨批次重复收录同一缺损项都返回 409。
- **不允许跨拓片混批**：一个批次的缺损项必须全部来自同一张拓片。
- **开工**后批次与本批缺损项统一进入处理中；重复开工返回 409。
- **完工只处理本批项目**：`results` 必须为本批每个缺损项各提交一次，
  缺少修补照片（`afterPhotoUrl`）或修补结果（`repairNote`）返回 **422 且整批回滚**；
  夹带不属于本批次的缺损项返回 400。
- **重复完工不能覆盖记录**：批次完工是终态，再次完工返回 409，首次照片/结果/时间戳保持不变。
- **字段类型强校验**：所有文本与照片字段（编号/来源/纸幅/位置/类型/照片地址/批次名/修补说明）
  必须是非空字符串；数组（含 `[]`）、对象、数字、布尔、null 一律返回 `400 E_INVALID_TYPE`
  并在 `details` 中标出字段与实际类型，且不落库。区分于“类型合法但完工缺照片/说明”的 422。

## 一致性实现

- 所有写操作通过单写者队列串行化，并发 HTTP 请求不会交叉读写。
- 每个事务先在状态的深拷贝上完成全部校验，再以
  **写临时文件 → fsync → rename** 的方式原子替换 `db.json`；
  校验失败（4xx）或落盘失败（磁盘错误/进程崩溃）都会丢弃拷贝，
  内存与磁盘均回到事务前状态。

## 接口文档

所有请求/响应均为 JSON；成功响应包一层 `{"data": ...}`，
错误响应为 `{"error": {"code": ..., "message": ..., "details"?: ...}}`。

### 拓片

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/rubbings` | 拓片列表（含各状态缺损项计数） |
| POST | `/rubbings` | 登记拓片 |

`POST /rubbings` 请求体：

```json
{ "code": "TP-清-014", "source": "地方碑刻残页", "paperSize": "42x68cm", "note": "" }
```

`code` 重复 → `409 E_CODE_DUPLICATE`。

### 缺损项

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/rubbings/:id/damages` | 某张拓片的缺损项 |
| POST | `/rubbings/:id/damages` | 在该拓片下登记缺损项（拓片不存在 → 404） |
| GET | `/damages?status=&type=&rubbingId=` | 按状态/类型/拓片筛选 |
| PATCH | `/damages/:id` | 修改待修项描述（position/type/beforePhotoUrl） |

创建缺损项请求体（三字段必填，`beforePhotoUrl` 为修补前照片）：

```json
{ "position": "左上角第3列题字旁", "type": "虫蛀孔", "beforePhotoUrl": "https://example.local/before.jpg" }
```

非待修项（已开工/已完工）不可 PATCH → `409 E_NOT_EDITABLE`；
尝试改 `status`/`batchId` 等字段 → `400 E_FIELD_IMMUTABLE`。

### 修补批次

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/batches` | 批次列表（含缺损项明细与计数） |
| POST | `/batches` | 创建批次（收录待修项），批次状态 `open` |
| POST | `/batches/:id/start` | 开工：`open → in_progress`，本批缺损项 `pending → in_repair` |
| GET | `/batches/:id` | 批次详情 |
| POST | `/batches/:id/complete` | 完工：校验照片与结果齐全后 `in_progress → completed` |

创建批次：

```json
{ "name": "六月小批修补", "damageIds": ["damage_xxx", "damage_yyy"], "note": "" }
```

完工请求体（`results` 必须逐项覆盖本批全部缺损项）：

```json
{
  "note": "本批于阴天晾干后拍照存档",
  "results": [
    { "damageId": "damage_xxx", "afterPhotoUrl": "https://example.local/after-1.jpg", "repairNote": "托裱补绢，墨色做旧" },
    { "damageId": "damage_yyy", "afterPhotoUrl": "https://example.local/after-2.jpg", "repairNote": "纤维纸浆补裂" }
  ]
}
```

### 错误码一览

| HTTP | code | 触发场景 |
|---|---|---|
| 400 | `E_MISSING_FIELD` / `E_BAD_JSON` | 缺必填字段/字段为空字符串 / JSON 非法 |
| 400 | `E_INVALID_TYPE` | 文本或照片字段收到数组/对象/数字/布尔/null（必须是非空字符串），错误响应 details 指明具体字段与实际类型 |
| 400 | `E_MALFORMED_PATH` | 路径参数含畸形百分号编码（如 `/batches/%E0%A4%A/start`），details 给出参数名与原始片段；解码在任何读写之前完成，不落库 |
| 400 | `E_DUPLICATE_IN_REQUEST` | damageIds 或 results 内部重复 |
| 400 | `E_INVALID_DAMAGE_IDS` / `E_INVALID_RESULTS` | 字段不是非空数组 |
| 400 | `E_RESULT_NOT_IN_BATCH` | 完工结果夹带非本批缺损项 |
| 400 | `E_FIELD_IMMUTABLE` | PATCH 试图改状态等受控字段 |
| 404 | `E_RUBBING_NOT_FOUND` / `E_DAMAGE_NOT_FOUND` / `E_BATCH_NOT_FOUND` | 资源不存在 |
| 409 | `E_CODE_DUPLICATE` | 拓片编号重复 |
| 409 | `E_CROSS_RUBBING_BATCH` | 跨拓片混批 |
| 409 | `E_NOT_PENDING` / `E_ALREADY_COLLECTED` | 收录非待修项 / 重复收录 |
| 409 | `E_BATCH_NOT_STARTED` / `E_ALREADY_STARTED` / `E_ALREADY_COMPLETED` | 非法状态流转（含重复完工） |
| 422 | `E_INCOMPLETE_RESULT` | 缺损项缺修补照片或缺修补结果，整批回滚 |
| 500 | `E_INTERNAL` | 落盘等服务端异常（事务回滚后返回） |

## curl 闭环示例

```bash
# 1. 看待修项
curl -s http://127.0.0.1:3020/damages?status=pending

# 2. 建批（只收待修项、同一拓片）
curl -s -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'

# 3. 开工（用上一步返回的批次 id 替换 $BID）
curl -s -X POST http://127.0.0.1:3020/batches/$BID/start

# 4. 完工：逐项提交修补照片与结果
curl -s -X POST http://127.0.0.1:3020/batches/$BID/complete \
  -H 'Content-Type: application/json' \
  -d '{"results":[
    {"damageId":"damage_demo_1","afterPhotoUrl":"https://example.local/a1.jpg","repairNote":"托裱补绢"},
    {"damageId":"damage_demo_2","afterPhotoUrl":"https://example.local/a2.jpg","repairNote":"纸浆补裂"}
  ]}'
```

## 目录结构

```
server.js          启动入口（HTTP 监听）
src/db.js          存储层：原子落盘 + 串行事务
src/app.js         路由与全部业务规则（状态机/校验）
test/api.test.js   自动化测试（18 例）
test/helpers.js    测试用隔离服务与请求工具
data/db.json       持久化数据（运行时生成）
```

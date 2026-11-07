# 影子课堂 · 教师端（初始版本）

Coze 工作流 `Shadow_Classroom_6` 的应用外壳。老师在浏览器里完成 **开场白 → 选学生 → 上课 → 下课 → 报告 → 清理** 一整节课堂。

```
浏览器（Vite MPA / React 19）
   │  只认 5 个接口 + 7 种 SSE 指令
   ▼
BFF（Node 22 / TypeScript，内置 http）
   │  PAT 只在这里；前端拿不到 chat_id / tool_call_id
   ▼
Coze POST /v3/chat（stream: true）  ←→  Shadow_Classroom_6
```

默认跑 **mock 模式**：不需要任何 Coze 凭据，用本地剧本按 YAML 的真实分支回放。mock 与真流产出同一套事件，所以切换模式前端一行都不用改。

---

## 快速开始

本机没有全局 Node，仓库自带便携版（`.toolchain/node-v22.14.0-win-x64`）。

```cmd
start.cmd install     :: 装依赖（只需一次）
start.cmd build       :: 构建 shared + web + server
start.cmd             :: 启动，浏览器打开 http://127.0.0.1:8787
```

页面进来就自动开一节新课，直接说一句，例如：

> 初二数学，一次函数的图像

然后按卡片选学生（最多 3 人）→ 开课后继续讲/提问 → 说「今天就上到这里，下课」→ 选「是」生成报告。

**重新开始**：`Ctrl+C` 停掉服务再 `start.cmd`。内存里只留当前一节课，重启即清空。

其他命令：

```cmd
start.cmd dev         :: 打印前后端分离开发的两条命令
start.cmd build       :: 生产构建
npm run typecheck     :: 三个包一起类型检查（需先 PATH 加入 .toolchain）
```

---

## 接真实 Coze

已经接上了，用的是 **JWT 授权**（不用 PAT）：

```cmd
:: .env 里已经写好，直接启动即可
start.cmd
```

`.env` 关键行：

```
COZE_MODE=coze
COZE_AUTH=jwt
COZE_JWT_CONFIG=<coze_oauth_config.json 的绝对路径>
COZE_BOT_ID=7699700095344459791
```

JWT 配置里的私钥不动它，运行时按需换取短期 token（提前 60 秒自动重换，401 时作废重试一次）。
私钥不进仓库——`.env` 只存路径。

想换回本地剧本：把 `COZE_MODE` 改成 `mock`。

**PAT 方式**（如果你以后改用 PAT）：`COZE_AUTH=pat` + `COZE_PAT=...`。

必填变量见 `.env.example`。`COZE_CONVERSATION_NAME` 对应 start 节点参数，
**`159331` 清空会话历史是按这个名字找会话的**，不要随意改。

---

## 真流验证结论（2026-11-04）

完整报告：`docs/coze-live-verification.md`。一句话总结：

- ✅ **开课 → 选学生 → 开课就绪 → 下课 → 生成报告（真实 PDF）→ 清理** 全部走通。
- ❌ **课中轮次完全没有输出**。上游只返回 `empty result`，学生不会说话，报告基本是空的。

另外，官方文档里有三处假设和实际不符，已按实测改正（详见报告 §2）：

1. SSE 的 `data` 没有 `{event, data}` 包装层，直接就是事件对象。
2. 问答节点的 `tool_call` 是 `{"id":"", "function":null}`，没有任何参数可解析。
3. `submit_tool_outputs` 对这个工作流用不了（4000）；正确做法是把答案当普通消息，
   带同一个 `conversation_id` 再发一次 `/v3/chat`。

### 课中无输出的排查入口

```cmd
:: 抓开课 + 选学生 + 课中一轮的原始事件
node --experimental-strip-types apps/server/test/diag-class.ts "<config>" 7699700095344459791

:: 只测知识点相关输入
node --experimental-strip-types apps/server/test/diag-knowledge.ts "<config>" 7699700095344459791
```

输出里如果连续出现 `msg_type: "empty result"`，说明工作流跑完了但没有任何节点产出文本。
按报告 §5 的顺序处理：先看 `1892878` 的分支走向，再修 `1021290` 的输入声明。

---

## 仓库结构

```
packages/shared     前后端共享契约：7 种 SSE 指令、错误码、学生名册、文案信号
apps/server
  src/coze.ts       /v3/chat 协议层：拼请求、逐行解析 SSE、10 种上游事件
  src/orchestrator.ts  上游事件 → 前端指令的唯一翻译层（状态推进、卡片、指标）
  src/mock-source.ts   mock 剧本，实现同一个 UpstreamSource 接口
  src/store.ts      内存会话存储 + 错误类型
  src/app.ts        路由、SSE 写出、静态托管
  test/verify-flow.mjs  全链路接口验收脚本
apps/web
  src/state.ts      reducer：IDLE → INITIALIZING → PICKING_STUDENTS → ON_CLASS → ENDING → ENDED
  src/classroom.tsx 讲台风主界面
  src/report.tsx    报告页（/report.html?session=xxx）
docs/design-decisions.md   工作流真实拓扑与和契约文档的差异（先看这个）
```

---

## 接口一览

前缀 `/api/classroom`，身份用请求头 `X-Teacher-Id`（一期没有账号体系）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sessions` | 开一节新课 |
| GET | `/sessions/:id` | 状态快照（刷新 / 多标签对齐） |
| POST | `/sessions/:id/chat` | 发一条消息（SSE） |
| POST | `/sessions/:id/actions/:actionId` | 回答中断卡片（SSE） |
| POST | `/sessions/:id/close` | 结课 |

SSE 指令：`meta` / `delta` / `message` / `action` / `state` / `error` / `done`，结束时 `data: [DONE]`。

---

## 已经做完的行为

- 三张问答卡片：`pick_students`（多选，硬上限 3 人）、`confirm_report`、`confirm_cleanup`（只能选是/否）。
- 参数校验在 BFF 做：选 4 人返回 `400 BAD_REQUEST`，不静默丢人；非数字编号直接拒。
- 一个老师多节课堂并存；他人的 `sessionId` 返回 `403`，无身份返回 `401`（两者不合并）。
- 卡片提交后立即从对话流移除，输入框解锁。
- 学生指标右栏、轮次进程条、报告下载链接。
- 401/403/404/409/410/502/504 各有对应文案。

## 验证过什么

`node apps/server/test/verify-flow.mjs`（先启动服务）覆盖：开场 → 选 4 人被拒 → 选 2 人 → 课中两轮 → 下课 → 报告 → 清理 → 快照 → 401/403。全部通过。

界面另用浏览器逐屏确认过：选学生卡片、上课中指标栏、报告卡片、清理卡片、结束态。

**没验证的**：真实 Coze 链路（没有凭据）。接上之后请按下一节清单逐条过。

---

## 接真流前必须处理的工作流问题

详细分析见 `docs/design-decisions.md`，这里只列结论：

| 级别 | 问题 | 影响 |
|---|---|---|
| **P0** | `1021290` / `152987` / `152181` 代码按 `k1~k4` 读，YAML 只声明了 `k1~k3`，`1021290` 连 `k1~k3` 都没声明 | 第一次「继续课程」会把 K/C/E 全部清零，**不报错** |
| **P0** | 课中那句话若与知识点不相关，`1603361` 走 false 分支，不写数据表但 `turn` 照样 +1 | 报告缺环节，轮次对不上 |
| **P0** | 数据表没有 `classroom_id`，四个节点只按 `turn` 定位 | 多老师并发必串数据；BFF 的单课堂锁默认关闭，上线前要么加字段要么开 `ENFORCE_SINGLE_CLASS=1` |
| P1 | 槽位只有 3 个，但 `181544` 允许选 6 人 | 已在前端卡到 3 人，并给出拒绝理由 |
| P1 | `113458` 的 `NAMES` 写死前三个学生 | 选赵六/钱七/孙八时台词被过滤，气泡为空 |
| P1 | `1154341` prompt 里 `{{grade}}}` 多了一个 `}` | `grade` 永不替换 |

另外两处与常见认知不同，值得知道：

- **清空会话历史的是开课链路**（`197096 → 159331`），不是结课链路。结课后下节课会带着上一节的历史。
- 报告读的是**整张表**（`155522` 条件为空 + `limit 100`），和上面的租户问题叠加会混入别的课堂数据。

---

## 二期建议

1. 修上面三条 P0，再开真流联调。
2. 在 `197096` / `163003` 这类输出节点追加一行结构化标记（如 `__STATE__:{"state":"ON_CLASS","turn":3}`），BFF 截获后剥离 —— 这样就不用再靠文案猜状态。
3. 会话存储换 Redis/Postgres；报告改自渲染 HTML→PDF，摆脱 Doc Maker 链接过期。
4. 接账号体系，把 `X-Teacher-Id` 换成真实登录态。

# 真实 Coze 链路验证结论

> 2026-11-04 · 用 JWT 授权（`client_id=117688986063470002202`）直连 `bot_id=7699700095344459791`
> 验证方式：BFF 全链路（`apps/server/test/verify-flow.mjs`）+ 原始 SSE 抓包（`apps/server/test/diag-*.ts`）
> **结论：开课 → 选学生 → 开课就绪 → 下课 → 报告 → 清理 全部走通；课中轮次不产出内容。**

---

## 1. 已确认可用

| 环节 | 实测结果 |
|---|---|
| JWT 换 token | ✅ 成功（`czs_...`，69 字符），`/v1/workspaces` 返回 200 |
| 开课 | ✅ 「正在初始化课堂」→ 选学生卡片 |
| 选学生 | ✅ 提交 `1,3` 后返回「课堂已经开始 老师请开课」 |
| 下课 | ✅ 返回「是否生成报告？」中断，卡片正确识别 |
| 生成报告 | ✅ 返回真实 PDF 链接（`lf9-appstore-sign.oceancloudapi.com/...pdf?...expires=...`） |
| 清理数据 | ✅ 正常结束 |
| 用户变量隔离 | ✅ 换新 `user_id` 后状态归零；复用旧 `user_id` 立刻返回「重开课堂请先结束当前课程」 |
| 用户变量跨对话保留 | ✅ 换新 `conversation_id`、同 `user_id`，变量依然生效（`diag-verify-vars.ts`） |

`meta_data`、`additional_params(CONVERSATION_NAME)` 都能正常下发，没有触发 4000。

---

## 2. 与文档假设不符、已按实测修正的地方

| # | 原假设（来自官方文档/契约文档） | 实测 | 处理 |
|---|---|---|---|
| R1 | SSE 的 `data` 形如 `{"event": "...", "data": {...}}` | **直接就是事件对象**（`{"id":..., "conversation_id":...}`） | 已改 `parseEvent`，不再取 `payload.data` |
| R2 | `requires_action` 的 `tool_call` 带 `id` 和 `function.arguments`（含 question/options） | `{"id":"", "type":"reply_message", "function":null, "require_info":null}` —— **id 是空串，没有任何参数** | 问题文案改为取同轮最后一条 `answer` message；`toolCallId` 允许空串 |
| R3 | 续跑用 `POST /v3/chat/{chat_id}/submit_tool_outputs` | 该路径 **404** | 改为 `/v3/chat/submit_tool_outputs` |
| R4 | `submit_tool_outputs` 只要 `tool_outputs` | 必须带 `conversation_id` + `chat_id` 才不是 4000 | 已补 |
| R5 | 补齐 body 后就能续跑 | 仍返回 **4000 Request parameter error**（`tool_call_id` 为空串、传 chat_id、output 传 JSON 都试过） | **放弃该接口**，见 R6 |
| R6 | — | **正确答案：把答案当普通用户消息，带同一个 `conversation_id` 再发一次 `/v3/chat`，工作流会从提问节点之后继续** | 已作为主路径（`CozeClient.continueWithAnswer`），实测越过 `181544` 成功开课 |

R2/R6 这两条是本项目最脆弱的地方。如果 Coze 改变问答节点的中断行为，`continueWithAnswer` 需要重新评估。

---

## 3. 新增发现的问题

### P0-A · 课中轮次完全不产出内容（已实测复现）

现象：开课就绪后，无论输入什么，`/v3/chat` 都只返回
`conversation.message.completed type=verbose {"msg_type":"empty result"}`，
没有任何 `answer` 气泡。

#### 已排除的原因

**变量没有被销毁。** 三个独立证据（`diag-verify-vars.ts`）：

1. 选完学生后再说一句"开课"，返回「重开课堂请先结束当前课程」——
   只有 `classroom_state == ON_CLASS` 才走这个分支。
2. 说"下课"能正确弹出「是否生成报告？」——同样要求 `ON_CLASS`。
3. 换一个**全新的 conversation**、保持同一个 `user_id`，变量依然生效（跨会话保留成立）。

所以用户变量按 `user_id` 跨对话持久化，与预期一致。

#### 真正的原因（待你在 Coze 画布确认）

`1412157`（置 `ON_CLASS`）在**进入选学生问答之前**就执行了。
因此「课堂已经开始 老师请开课」只代表状态被置位，**不代表学生数据已建立**。

学生数据靠问答之后的这条链写入：`198844 → 173665(查 persona) → 1652813 → 142720(逐生打分)
→ 158008 → 110656 → 105616 → 115583(写 slot_k*/slot_ce*/names)`。

课中链路（`152987` / `152181` / `1021290` / `118288` / `181161`）完全依赖 `names` 与 `slot_k1~3`。
这些为空时，整条链路算出空结果，`1816786`/`1205865`/`1599286` 三个输出节点没有内容可推
→ 就是 `empty result`。

**请重点检查这两个节点的运行输出是不是空的：**
- `173665`（查 persona，条件 `student_id IN ids`）——查不到就说明 persona 表没数据或 `ids` 没解析出来
- `142720`（批处理，输入是 `173665.outputList`）——输入为空时批处理不产出任何结果

按 YAML 走查，最可能的原因（需在 Coze 里确认）：

1. `1892878` 判断 `1405727.outputList.turn` 的 `operator: 9`。`turn` 变量在首次开课后才由 `195846` 自增，
   查询时大概率为空 → 走 `true → 1805030 插入` 分支；若 `operator: 9` 在 Coze 里其实是"不为空"，
   分支就会反过来，导致每轮都走更新一个不存在的行。
2. `152987` / `152181` / `1021290` 三个代码节点按 `k1~k4` 读取，YAML 只声明了 `k1~k3`，
   `1021290` 连 `k1~k3` 都没声明（`design-decisions.md` §3.1）→ 输出全空数组。
3. `181161` 批处理依赖 `118288.array_k/c/e`，上游为空则逐生生成台词的批处理没有输入 → `content_list` 为空。
4. 三个台词输出节点（`1816786`/`1205865`/`1599286`）拿到的都是空串 → 输出节点被跳过。

`empty result` 这个 `msg_type` 说明工作流确实跑完了，只是没有任何节点产出可输出文本，与上面 2/3/4 吻合。

**影响**：应用当前能开课、能结课、能出报告，但**上课过程中学生不会说任何话**，报告也基本是空的。
这一条不修，应用在真流上没有使用价值。

### P1-B · 选学生实际按 `1,3` 提交，但学生的 persona 名册来自数据库

开课时提示文案里带的是真实 persona（`4 = 赵六（厚积薄发插班生）`、`5 = 钱七（捧场王））` ——
note 那里还多一个右括号），说明 persona 在表里、且 `181544` 的文案会动态拼接。
前端目前用的是 `packages/shared` 里写死的 6 个名字，**不含 persona**，需要后续从 Coze 侧同步。

### P1-C · 提问文案带选项尾巴

真流返回的是：
```
是否生成报告？
- 是
- 否
```
卡片里已经有独立按钮，重复显示很难看。已在 `orchestrator.cleanQuestion` 里裁掉，只留第一行。

---

## 4. 当前应用在真流上的实际能力

| 能力 | 状态 |
|---|---|
| 开课（说学科+年级+知识点） | ✅ 可用 |
| 选学生卡片（1~3 人，超限拦截） | ✅ 可用 |
| 课中对话 | ❌ **上游无输出**（P0-A） |
| 下课 → 生成报告 | ✅ 可用，链接真实有效（有 `expires` 参数，会过期） |
| 清理数据 | ✅ 可用 |
| 多老师隔离 | ⚠️ 用户变量按 `user_id` 隔离有效；但**数据表无租户字段**，两节课同时进行时报告仍会串数据 |

---

## 5. 建议的下一步（按优先级）

1. **在 Coze 里打开一次真实运行**，看 `1892878` 走了哪个分支、`118288` 的 `array_k` 是不是空列表。
   这一步只能你在画布上做，我没有 Coze 的运行时日志权限。
2. 修 `1021290` / `152987` / `152181` 的 `k1~k3` 声明（补齐 node_inputs）。
3. 数据表加 `classroom_id` 字段，四个读写节点条件改为 `classroom_id AND turn`。
4. 修完后再跑 `node apps/server/test/verify-flow.mjs`，第 4 步应该能看到学生台词。

---

## 6. 复现命令

```cmd
:: 换 token 自检（不打印 token）
node --experimental-strip-types apps/server/src/cli-token.ts "<coze_oauth_config.json 路径>"

:: 抓一次开课的原始 SSE
node --experimental-strip-types apps/server/test/diag-coze.ts "<config>" 7699700095344459791

:: 抓课中一轮
node --experimental-strip-types apps/server/test/diag-class.ts "<config>" 7699700095344459791

:: 全链路（需 BFF 已在 coze 模式启动）
node apps/server/test/verify-flow.mjs
```

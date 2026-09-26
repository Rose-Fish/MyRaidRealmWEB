# 05 · 提示词链路

## 主链顺序

`buildMainTurnPrompt()`（`runtime/standaloneTurn.ts`）组装发给正文模型的五段，顺序**固定**：

| #   | 段                      | role   | 内容                           |
| --- | ----------------------- | ------ | ------------------------------ |
| 0   | `system_protocol`       | system | 预设里的主提示词               |
| 1   | `current_stat_snapshot` | user   | 当前 `stat_data` 快照          |
| 2   | `active_worldbook`      | user   | 生效中的世界书条目（整块注入） |
| 3   | `recent_history`        | user   | 前情提要 + 最近若干轮原文      |
| 4   | `latest_user_input`     | user   | 本轮玩家输入                   |

顺序由 `inspectStandaloneMainChainView()` 暴露出来，界面上有对应的链路视图。

🔴 **不要随意调整这五段的顺序。** 变量快照必须早于历史，否则模型会把快照当成历史的一部分。

## 宏

🔴 **固定运行时宏只有一张表**，实现在 `runtime/standalonePromptUtils.ts` 的
`applyStandalonePromptMacroReplacements()`。全项目 7 个固定宏：

| 宏                                       | 解析为                | 取值来源                                             |
| ---------------------------------------- | --------------------- | ---------------------------------------------------- |
| `{{user}}`                               | 玩家姓名              | `stat_data.玩家.姓名`，缺省「玩家」                  |
| `{{char}}`                               | 当前角色名            | 调用方传入，缺省「当前角色」                         |
| `{{group}}`                              | 当前群组              | 固定文案                                             |
| `{{scenario}}`                           | 当前位置              | `stat_data.世界.空间定位.当前位置`，缺省「当前场景」 |
| `{{personality}}`                        | 角色性格              | 固定文案                                             |
| `{{lastChatMessage}}`                    | 上一条消息            | 固定文案                                             |
| `{{format_message_variable::stat_data}}` | 完整 `stat_data` JSON | 运行时快照                                           |

预设 prompt 另外支持一组**单次组装作用域**的酒馆变量宏：`{{setvar::key::value}}`、`{{addvar::key::value}}`、`{{getvar::key}}`、`{{trim}}` 与 `{{// comment}}`。它们按预设顺序求值，只在当前请求组装期间存在，不写入 `stat_data` 或存档；复杂的酒馆宏仍会原样保留。

🔴 **快照宏（最后一条）必须排在替换链的最后。** 它注入的是整个 JSON，
如果排在前面，后面任何替换都可能命中 JSON 里的内容并二次替换。

## 前情提要

窗口大小：`RECENT_MESSAGE_LIMIT = 8`（`runtime/standaloneTurn.ts`）。

口径唯一在 **`collectStandalonePriorSummaryItems()`**，规则是：

- 取**窗外**的消息——即 `slice(0, 总条数 - 8)`，第 1 ~ N-8 条；
- 只取 `role === 'assistant'` 的消息；
- 只取 `summary_content` 字段，**不是原文**；
- 排除当前轮、排除已归档区间（`message_id <= archivedUntilMessageId` 的跳过）；
- `summary` 为空白的直接丢掉。

最近 8 轮（窗内）**喂原文**。

> 换句话说：老内容走摘要、新内容走原文。改这个口径只改这一处，别在别处再写一套。

## 阶段总结归档

🔴 **只手动、绝不自动。** 归档动作由用户在界面上触发，不要在生成流程里顺手触发。

- 归档后**只保留最新一段**总结，不累积多段。
- 阈值选项 `STAGE_SUMMARY_THRESHOLD_OPTIONS = [100, 200, 300, 500]`
  （`src/utils/stageSummaryThreshold.ts`），单位是消息条数。
- 归档实现见 `src/utils/stageSummaryArchive.ts`。

## 本地内容注入

`resolveStandaloneLocalContentBlocks({ route, ... })` 按**发送目标**筛选：

| route             | 发给谁             |
| ----------------- | ------------------ |
| `main`            | 只发给正文模型     |
| `variable_update` | 只发给变量更新模型 |
| `shared`          | 两边都发           |

主链里有一个特例：**抽奖规则**只在 `scriptedTurn.kind === 'lottery'` 时才注入
（按 `LOTTERY_LOCAL_CONTENT_BLOCK_PREFIX` 前缀过滤）。普通回合不带抽奖规则。

详见 `06-content-assets.md`。

## 变量更新是第二遍请求

`buildVariableUpdateSecondPassPrompt()` 是**独立的一次模型调用**，
和正文生成分开，用单独的 API 配置与单独的本地内容路由。
它的输入是当前 `stat_data` + 本轮最新消息，输出是要应用的变量补丁（见 `08-state-and-save.md`）。

## 改提示词链路时的自检

1. 改宏 → 确认快照宏仍在最后。
2. 改顺序 → 确认 `inspectStandaloneMainChainView()` 的 `orderIndex` 同步。
3. 改前情提要口径 → 只改 `collectStandalonePriorSummaryItems()`。
4. 改归档 → 确认没有引入自动触发。

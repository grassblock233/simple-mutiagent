# Agent Note: Homework2 文档与当前模板验收证据补齐

Status: implemented

## Problem

README 未提供流程图及架构入口，最新变更记录链接到缺失验收文件，真实示例仍引用 2026-10-14 的旧八节点报告，无法直接核对当前六节点默认流程。

## Decision

README 链接到 docs/design.md、示例与本次验收记录。设计文档说明当前六节点流程、三个 Agent 分工、结构化数据与版本状态、模块入口和扩展限制。已有变更记录修复验收引用并明确缺失截图不视为证据。

真实联调脚本继续使用 createTemplate()，新增六节点/六条边、无循环节点、Agent 顺序和轮次断言；报告写入 reports/current/，保留 reports 根目录的历史快照。已结束运行先保存报告再做场景断言，失败保存整体失败状态；完整五场景均通过才写 passed。说明场景自定义提示词和验证配置，不把默认拓扑通过扩大为所有默认配置通过。

### 历史审计

按仓库指定 .agents/docs 检索 implemented/testing、implemented/simplification 及相关 feature 的验收、模板和报告记录；未发现相关 proposed/rejected 记录。

| 记录 | 分类与处理 |
| --- | --- |
| [唯一模板](../simplification/2026-10-21-single-template-only.md) | 部分重叠，互链；延续历史图不迁移的边界，当前真实证据另存 |
| [测试精简](2026-10-21-test-suite-trimming.md) | 部分重叠，互链；保留边界测试策略，不新增坐标或标签复述测试 |
| [大项目与上下文](../feature/2026-10-25-large-project-draft-context.md) | 部分重叠，互链；修复缺失验收引用，不追认未存档截图 |
| [MVP](../feature/2026-10-14-simple-workflow-mvp.md) | 部分重叠，互链；现行架构导读指向原记录，历史联调事实保留 |

## Alternatives considered

- **覆盖旧报告**：读者只需查看一组文件，但会丢失旧模板原始证据，因此当前报告另存并明确入口。
- **只补验收文案**：改动少，但不能证明当前模板运行；执行真实场景与现有回归，失败也保存实际证据。

## Consequences

提交文档可直接阅读流程与架构，历史与当前验证可以区分。真实验收依赖有效模型凭据并产生费用，报告中的状态必须据实际结果判断，不能通过改日期或拓扑伪造成功。

## Verification

检查命令、结果及未覆盖范围统一记录在[验收记录](../../../../docs/reviews/2026-10-25-implementation/verification.md)。

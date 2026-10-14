---
name: write-notes
description: Use when a change is non-trivial by standards (behavior, architecture, cross-file contracts, process/tooling, testing strategy, or on-disk/wire/config formats), when choosing between technical alternatives, superseding a decision, or writing a postmortem. Records the why and rejected options in .agents/notes/ with script-enforced gates; skips purely mechanical edits (CRUD, styling, patches, tagging, formatting).
---

# Write Notes

## 红线：先判要不要写，再谈怎么写

**快速返回——以下修改严禁立 Note，直接改代码：**

- 纯排版格式化、错别字、无歧义重命名
- 样式调整（不改行为）
- 依赖补丁（不改行为）、版本发布打标（RC/Release tag）
- 常规 CRUD、单模块内看 diff 即懂的显式逻辑修复（无跨文件影响）

**非平凡改动必须写。** 命中以下任何一项即非平凡——改了**行为**、改了**架构**、改了**跨文件契约**、改了**流程与工具链**、改了**测试策略**、改了**落盘 / 网络 / 配置格式**——或其他维护者日后可能重访的决定。

**写之前，对照三个方向想清楚这篇笔记守住什么：**

1. **往前看（立新规）**——新建的跨模块通信契约、状态流转规则、访问边界、运行时不变量。不记，后来的 Agent 各写一套、随意击穿模块。
2. **往回看（记妥协）**——为看不见的约束放弃了业界主流或直觉的解法。不记，被否掉的老路会被重走一遍。
3. **做减法（收窄）**——破坏性重构、代码裁剪、API 暴露面收窄。不记，没人知道退出条件和迁移边界，减法做不下去——或者做过了头。

一句话记住：**代码和单测说不出来的意图、边界、取舍，就是非平凡。** 判不准时，从严。

> 优先级：宿主项目的 `AGENTS.md` 与用户的直接指令**高于本 Skill**；本 Skill 是默认契约，不是更高法律。

- **优先就地同步，非必要不新建**：已有归属的改动直接更新对应的那篇文档。
- **禁止把一篇 Note 改成另一个决定**：事实（路径、符号、默认值）就地改；决定或理由翻转 → 新开一篇并互链。禁止把 `## Decision` 改写成反面，禁止只靠 git 当旧理由的唯一副本。
- **写新篇当场审计，不准推迟**：按模块名/关键词搜 proposed + implemented + rejected；每篇命中当场分类：无关 / 部分重叠（互链）/ 完全吸收（删或归档）/ 过时提案（reject 或删）。分类结果和这篇新 Note 一起落盘。
- **垃圾不进归档**：过时提案转 `Status: rejected — <原因>`（严禁归档）；无防坑价值的被否记录直接物理删除。

> 「决定」不重——个人项目里就是「为什么选 A 没选 B」。选型、取舍、踩过的坑，都值得写下。

## 1. 路径即分类

每条 Note 的路径就是身份：`{lifecycle}/{class}/yyyy-mm-dd-topic.md`

**Lifecycle（一层文件夹，这篇走到哪一步）：**

- `proposed` — 想法阶段，有了方案但还没落地
- `implemented` — 已落地，与代码同批改动保持同步
- `rejected` — 审慎否掉的提案，仅当能防止重犯时保留，否则删整组
- `archived` — 已完成且未来参考价值低的 implemented 记录，冻结不可改

**Class（二层文件夹，就这 4 个）：**

- `feature` 新能力 — 用户或模型看得见的选择（不显然的行为也算）
- `bug-fix` 修缺陷 — 修好了什么，或补上复盘里暴露的缺口
- `simplification` 只删不增 — 不增加能力，只删代码、行为或表面
- `testing` 测试怎么写 — 测试策略和基建

> `refactor` 不单列：能看见的行为变了，归到对应类；没变就是 `simplification`。不建 `INDEX.md`。

## 2. 文件格式

前三行固定：

```markdown
# Agent Note: <标题>

Status: <状态>
```

状态必须与所在 lifecycle 文件夹一致（`rejected` 带一句话原因）；文件名日期是**首次提出日**。Body 骨架：

- `proposed`：`## Problem` → `## Proposal` → …自由节… → `## Alternatives considered` → `## Acceptance criteria` → `## Risks`
- `implemented`：`## Problem` → `## Decision`（现在时） → …自由节… → `## Alternatives considered` → `## Consequences`
- `rejected`：冻结的 proposal 形态，结论在 `Status:` 行

> 备选方案必填：只记录真实考虑过的对手方案，先写它最强的理由再否定。没有过的选项不要编。「不做 / 复用现状」仅当当时真的权衡过才写。脚本只检查有没有 `## Alternatives considered`。
> `implemented` 的 `## Decision` 用现在时；门禁只拒提案标题（`## Proposal` / `## Plan` / `## Migration plan` / `## Acceptance criteria` 及其中文别名）。展开见 `references/note-format.md`。

模板见 `docs/templates`。

## 3. 动手前检索历史决策（去中心化 4 法）

动手重构或选型前，先查历史约束，防止重复踩坑或破坏前人妥协：

1. **入口注释（若有）**：代码入口若已有 `// Note: ... 见 .agents/notes/...`，顺着它读。没有就走下面三法，不要为了检索去补锚点。
2. **分类树物理切片**：不扫全库，按意图直切目录（避坑看 `rejected/`）。
3. **精准全局检索**：使用 ripgrep 搜关键词或机制名，**必带 `--hidden` 并排除 `archived/`**：
   ```bash
   rg --hidden --glob '!.agents/notes/archived/**' "<机制名或关键词>" .agents/notes/
   ```
4. **模块文档下钻**：子模块 README 涉及设计依据时，顺着相对 Markdown 链接直达对应 Note。

**问用户之前，先自己查。** 以上四法能答的事实，不要抛给用户；只有真正的决策才占用用户时间。

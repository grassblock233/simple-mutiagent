# 真实示例与报告

示例无需第三方依赖，使用 Node.js 24 自带测试；工作流仍调用真实 DeepSeek，并在每次命令请求时等待批准。先按[根说明](../../README.md)配置 `.env.local` 并启动服务。

新建流程默认使用唯一的“单轮修复”模板：有阻塞问题时修复一次并复审，复审仍有问题也结束。以下既有报告与快照保留生成时的八节点循环模板，不随默认选择变化而改写。

## 可修复项目

打开 `examples/repairable` 的绝对路径，勾选 `src/math.mjs`（单文件）或 `src/`（目录）。`add` 故意使用减法，`src/math.test.mjs` 断言加法结果。

单轮修复模板建议提示词：

- 审查：读取源码和测试，只报告 `add` 中减法错误，提供准确行号与读取证据。
- 修复：仅修复原问题，保留测试，不进行其他重构。
- 复审：读取当前版本，逐项检查原问题，并请求索引 0 的 Node 测试；将“需要验证”开启。通过后保留原问题编号标记 resolved，拒绝时如实保留验证缺失。

确认模式先查看差异再写回；自动模式在满足结束条件后写回，两种模式均暂停命令审核。应用后可撤销恢复故意错误的初始内容。若勾选整个 `src/`，测试也处于修改范围；希望模型不能改测试时只勾选 `src/math.mjs`，测试仍可作为关联上下文读取。

## 轮数内无法解决的项目

打开 `examples/unrepairable`，勾选 `src/`，使用默认单轮修复模板。节点提示词说明：私有 provider 未提供，严禁编造实现、删除 `TODO_EXTERNAL` 或改变抛错契约；修复仅可补充说明，复审保留同一问题编号为 open，无需检查命令。

预期结论为“仍有问题”，实际进入一次修复后结束。自动模式允许应用符合范围的说明变更，同时保留剩余问题；可再撤销。模型可能选择不修改任何文件，此时无应用事务，仍应保留问题。

## 验收报告

[汇总 JSON](reports/live-verification.json)记录当前日期、真实后端、命令状态、轮数及调用次数。每个场景另有 Markdown/JSON 全量报告：

| 场景 | Markdown | JSON | 结果 |
| --- | --- | --- | --- |
| 确认写入 | [报告](reports/repairable-confirm.md) | [快照](reports/repairable-confirm.json) | 通过，应用后撤销 |
| 自动写入 | [报告](reports/repairable-automatic.md) | [快照](reports/repairable-automatic.json) | 通过，应用后撤销 |
| 仅审查 | [报告](reports/review-only.md) | [快照](reports/review-only.json) | 正确源码通过，不应用 |
| 拒绝验证 | [报告](reports/reject-validation.md) | [快照](reports/reject-validation.json) | 验证未完成，不应用 |
| 轮数上限 | [报告](reports/round-limit.md) | [快照](reports/round-limit.json) | 一轮后仍有问题，说明变更应用后撤销 |

执行 `pnpm build` 后运行 `pnpm test:live` 可复现；使用临时项目和数据目录，脚本自动批准这些已知示例的测试或拒绝特定场景，不触及用户真实项目。报告中的临时根替换为 `/tmp/simple-workflow-example`，日期、标识、命令路径、调用次数及费用属于实际运行快照，不能保证未来相同。拒绝后再请求同版本动作返回拒绝记录，不产生新批准或进程。

所有场景均未提供文件或网络隔离，AC-10 延期。报告不含 API 密钥或原始模型推理历史，但包含示例源码、读取证据、输出和备份内容；分享真实项目报告前应检查源码敏感性。

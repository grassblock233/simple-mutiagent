# Agent Note: 使用 Linux 系统目录选择器

Status: implemented

## Problem

页面内的目录列表重复实现系统文件浏览体验；用户希望“浏览目录”直接调用系统窗口，同时后端仍需要真实绝对路径以建立原有工作区授权。

## Decision

本地 Node.js 服务通过无 shell 的 execFile 参数数组调用 Zenity；仅当程序不存在时尝试 KDialog。不增加 npm 依赖或桌面框架。服务必须运行在 Linux 图形会话，窗口出现在服务所在桌面；无 DISPLAY/WAYLAND_DISPLAY、工具缺失或运行失败时提示手动输入路径。

POST /api/workspaces/pick-directory 沿用本地请求、会话、CSRF 与 JSON 请求体校验，接受可选 path，返回 { path: string | null }。有效绝对目录作为起点，其余回退主目录。成功结果规范化并校验为可访问目录；保留合法路径中的空格。取消返回 null，界面不修改输入框或当前项目；选择成功只回填输入框，仍需点击“打开项目”。

进程级单例确保跨会话和开发热更新最多一个选择窗口，重复请求返回 409。请求 AbortSignal 传入 execFile，断开时终止进程并释放锁。删除原 GET /api/workspaces、目录枚举方法及前端浏览状态和样式；项目登记 POST、文件树和授权范围保持原语义。

## Alternatives considered

- 浏览器 showDirectoryPicker：提供原生窗口，但不暴露 Node 服务需要的完整宿主路径，不能替代现有真实项目授权。
- 保留页面目录列表作回退：无图形会话时可用，但增加两套浏览逻辑；现有路径输入足以覆盖回退需求。
- 引入 Electron/Tauri：能提供统一原生对话框，但会改变部署方式并增加本次不需要的框架依赖。

## History audit

搜索 .agents/docs 中“浏览目录 / 目录浏览 / 选择器”，排除 archived。2026-10-14-simple-workflow-mvp.md 部分重叠：其目录枚举实现及 GET/POST 清单被本决定替代，已更新并互链；原工作区授权边界继续有效。2026-10-14-workflow-studio-ui.md 命中 CSS 选择器，属于无关记录。其余生命周期无相关决定。

## Consequences

已有项目、存储工作流和运行数据无需迁移。旧目录枚举 GET 不再提供，手动输入路径仍可用。选择器只适用于 Linux 本地桌面，不能用于在远端服务端选择浏览器客户端目录。

## Verification

新增测试覆盖中文与首尾空格路径、非法初始路径和文件路径回退、取消、KDialog 回退、工具缺失、无图形会话、启动失败、无效结果、并发拒绝和中止锁释放。HTTP 集成测试校验新接口会话/CSRF/请求体以及旧 GET 返回 405。`pnpm test` 75 项、`pnpm test:integration` 13 项、`pnpm lint`、`pnpm typecheck` 和生产构建均通过。真实 Zenity 窗口启动并通过 AbortSignal 终止的冒烟检查通过，终止后返回 null。原生窗口中的中文/空格目录人工选取、视觉和取消按钮检查未执行；对应路径与取消行为由自动测试覆盖，不能等同于人工视觉检查。

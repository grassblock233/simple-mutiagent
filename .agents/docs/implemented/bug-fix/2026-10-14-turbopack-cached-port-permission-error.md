# Agent Note: Turbopack 构建重放旧缓存中的端口权限错误

Status: implemented

## Problem

2026-10-14，项目默认 `pnpm build`（`next build`，Next.js 16.4.0 / Turbopack）报错退出。环境使用 Node.js 24.21.0、pnpm 12.6.0。错误链如下：

```text
Failed to write app endpoint /page
@xyflow/react/dist/style.css.css [app-client] (css)
evaluate_webpack_loader
creating new process
binding to a port
Operation not permitted (os error 1)
```

`next.config.ts` 的 `turbopack.rules["*.css"]` 将全部 CSS 交给 `@tailwindcss/turbopack`，包括 `app/layout.tsx` 引入的 React Flow 样式。Turbopack 执行 JavaScript loader 时需要启动执行进程并建立本地 TCP 通信，因此生产构建也会涉及端口绑定。

报错文本容易让人判断当前环境禁止监听端口，但必须区分实际系统调用失败与缓存重放。此次持续失败的直接原因是旧 Turbopack 文件系统缓存保存并重放了端口权限错误；最初产生该错误的环境策略尚未确认。

## Decision

保留默认 Turbopack、CSS loader 配置和源码，将 `.next/cache/turbopack` 移到仓库外备份，让下一次构建重新生成缓存。本次修复只处理构建缓存，没有修改依赖、源码、监听端口或权限策略。

### 历史审计

按 Turbopack、构建、端口、缓存和隔离检索 `.agents/docs/` 的 proposed、implemented、rejected，排除 archived。检索时没有 rejected 记录，命中分类如下：

| 记录 | 分类与处理 |
| --- | --- |
| [第一阶段引擎与编排基础](../feature/2026-10-14-simple-workflow-mvp.md#第一阶段引擎基础) | 部分重叠：已有构建验证记录，但没有本故障的诊断；后续基础记录已合并至 MVP 历史章节，此处同步引用，构建诊断仍单独保留 |
| [Simple Workflow MVP 实现记录](../feature/2026-10-14-simple-workflow-mvp.md) | 无关：端口指工作流连线或服务访问，隔离指运行命令的能力边界；本次构建诊断不改变其状态。后续已迁移为 implemented，此处同步链接 |
| [暂缓文件与网络隔离](../feature/2026-10-14-simple-workflow-mvp.md#隔离延期与恢复条件) | 无关：讨论产品执行器范围，不解释此次构建缓存错误；后续迁移并合并至 MVP 文档，此处同步链接 |

记录路径遵循根 `AGENTS.md` 的 `.agents/docs/`，优先于 write-notes 技能默认的 `.agents/notes/`。

### 排查证据

1. 默认 `pnpm build` 可以复现错误，panic 日志落在 `/tmp/next-panic-5f08a693318ba10605be70d9e0be45f1.log`。
2. 普通 Node.js 进程对 `127.0.0.1`、`0.0.0.0`、`::1` 的随机端口监听成功；Python 对 `127.0.0.1` 和 `0.0.0.0` 的随机端口绑定、监听也成功。这些探针说明当前环境允许普通进程监听，但单独不足以证明 Turbopack 的执行路径成功。
3. 用 `strace -f` 跟踪默认构建。失败运行没有 TCP `bind` 调用，也没有捕获到 `EPERM`；其中成功的 `AF_NETLINK bind` 不属于 TCP 监听。错误在未实际尝试 TCP 绑定时再次出现。
4. 旧缓存文件 `v16.4.0-e273d5b2/00000093.sst` 中可检出 `Operation not permitted`、`binding to a port`、`creating new process` 三段文本，与错误链一致。
5. 移走旧缓存后，同一环境、同一配置的构建实际调用并成功完成：

   ```text
   bind(... AF_INET, sin_port=htons(0), sin_addr=inet_addr("127.0.0.1") ...) = 0
   listen(..., 128) = 0
   ```

   `127.0.0.1:0` 表示由系统分配随机回环端口，用于构建内部通信。这里与开发服务器默认的 3000 端口无关。

Next.js 随包文档 `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/turbopackFileSystemCache.md` 说明：生产构建的文件系统缓存自 16.3.0 默认开启，目录为 `.next/cache/turbopack`。项目没有覆盖该默认设置。

### 修复步骤

在仓库根目录执行，确保没有其他构建同时使用该缓存：

```bash
cache_backup_dir=$(mktemp -d /tmp/simple-mutiagent-turbopack-cache.XXXXXX)
mv .next/cache/turbopack "$cache_backup_dir/turbopack"
pnpm build
pnpm build
```

第一次构建验证重新计算后是否通过，第二次验证新缓存可正常复用。本次备份的实际目录为 `/tmp/simple-mutiagent-turbopack-cache.ycdQM7/turbopack`。备份保留诊断证据；`/tmp` 可能被清理，不是永久归档位置。

如再次出现同类报错，可先跟踪系统调用并保留日志，再处理缓存：

```bash
strace -f -e trace=socket,bind,listen \
  -o /tmp/simple-mutiagent-turbopack-network.trace \
  pnpm build > /tmp/simple-mutiagent-turbopack-build.log 2>&1
```

## Alternatives considered

- **保留旧缓存直接重试构建** — 可以复用已有编译结果、避免重新生成缓存；但本次多次运行持续重放同一错误，且系统调用跟踪显示没有新的 TCP 绑定尝试，因此采用移走缓存后重新计算的方式。

## Consequences

默认 Turbopack 构建恢复，第一次重新生成缓存需要执行编译工作。旧失败缓存保留供排查，不再参与后续构建。

本次证据确认当前持续失败来自缓存中的错误结果，不能据此认定所有 `EPERM` 都是缓存问题，也不能确定最初是哪条沙箱或操作系统策略拒绝绑定。若移走缓存后仍失败且跟踪捕获到真实 TCP `bind` 返回 `EPERM`，需继续排查当次构建进程的环境限制。

## Verification

2026-10-14 的验证结果：移走旧缓存后，带系统调用跟踪的默认 `pnpm build` 退出码为 0；编译、TypeScript、页面数据收集和静态页面生成通过。随后再次执行默认 `pnpm build`，复用新缓存，退出码仍为 0。

# dsh-plan-build-mode

OpenCode 风格的 Plan / Build 硬权限模型插件。

本插件为 DSH 增加一个独立的 Plan/Build 模式切换，不影响 DSH 原生的 `/plan` 软提示模式：

- **Plan 模式**：强制 `read-only` 沙箱，并拦截写工具（`write`、`edit`）。
- **Build 模式**：恢复 `workspace-write`，允许编辑。

写工具拦截仅在 Plan 模式配置为 `read-only` 时生效。首次使用或未切换时，默认处于 Build 模式。

## 安装

DSH 插件通过 DSH profile 加载。把它装到你实际使用的 profile 里：

```bash
# 装到 web profile
dsh plugin --profile web add @xth26/dsh-plan-build-mode

# 装到 TUI profile
dsh plugin --profile dsh-tui add @xth26/dsh-plan-build-mode
```

插件自带的 `cordis.patch.yml` 会在 DSH profile 加载时自动注入。

## 让 Web 和 TUI 共享同一个 Plan/Build 模式

Plan/Build 模式状态存在会话事件日志里（`sandbox/mode` 事件）。`dsh web` 和 `dsh --profile <名称>` 只有在共用同一个 profile、同一个 session ID 时，才会读写同一个会话事件流。

- **同一个 profile**：比如 `dsh web --profile web` 和 `dsh --profile web` 启动的两个入口，会共享 session 事件，因此模式切换会同步生效。
- **不同 profile**：默认 `web` 和 `dsh-tui` 是两个独立 profile，会话目录也分开。在一处切换不会影响另一处。

想让 web 和 TUI 共享模式状态，最简单的方法是**两个入口都使用同一个 profile**：

```bash
# 两个入口都用 web profile
dsh web --profile web
dsh --profile web
```

如果你确实想用不同 profile，但只想共享会话存储，可以在每个 profile 的 `cordis.patch.yml` 里把 session root 指向同一个目录：

```yaml
- id: session-root
  config:
    root: /path/to/shared/sessions
```

注意：跨 profile 共享会话目录要求两个 profile 挂载的服务组合兼容，否则事件解释可能出现差异。

## 本地开发 / link 试用

想在发布前从本地源码试用：

```bash
# 在插件目录
cd /path/to/dsh-plan-build-mode
pnpm link --global

# 在你的 DSH profile 目录
pnpm link --global @xth26/dsh-plan-build-mode
```

然后启动 DSH。插件 `package.json` 里的 `dsh.bundle.patch` 会自动生效。

## 使用

| 命令 | 效果 |
|---|---|
| `/plan-build` | 显示当前模式 |
| `/plan-build switch plan` | 进入 Plan 模式（只读） |
| `/plan-build switch build` | 进入 Build 模式（可写） |
| `/plan-build switch` | 切换当前模式 |

## 配置

```yaml
- id: plan-build-mode
  name: '@xth26/dsh-plan-build-mode'
  config:
    planSandbox: read-only
    buildSandbox: workspace-write
    denyWriteTools: true
    section: true
```

## 本地集成验证

安装或 link 插件到 DSH profile 后：

1. 启动 DSH。
2. 输入 `/plan-build switch plan`，应提示进入 Plan 模式。
3. 让 agent 调用 `write` 工具，应被拒绝。
4. 输入 `/plan-build switch build`，应提示进入 Build 模式。
5. 再次让 agent 调用 `write`，应允许执行。

## 许可证

MIT

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

## 更新

对于 `0.x` 版本，semver 范围 `^0.1.0` 只会匹配 `0.1.x`，**永远不会**自动更新到 `0.2.0`。升级时必须显式提升声明并重启 DSH 进程：

```bash
# 在目标 profile 中提升已安装版本
# （这条命令需要在非沙箱的终端里执行；DSH agent 无法写入 profile 目录）
dsh plugin --profile dsh-tui add @xth26/dsh-plan-build-mode@0.2.3

# 重启使用该 profile 的 DSH 进程
# （旧的 Node 进程仍缓存着旧插件代码）
Stop-Process -Name dsh -Force   # PowerShell
# 或: taskkill /IM dsh.exe /F   # CMD
```

然后重新启动 `dsh web` 或 `dsh tui`。如果想始终安装最新发布版本：

```bash
dsh plugin --profile dsh-tui add @xth26/dsh-plan-build-mode@latest
```

## 使用

| 命令 | 效果 |
|---|---|
| `/plan-build` | 在 Plan 与 Build 模式之间切换 |
| `/plan-build status` | 显示当前模式 |
| `/plan-build switch plan` | 进入 Plan 模式（只读） |
| `/plan-build switch build` | 进入 Build 模式（可写） |
| `/plan-build switch` | 同 `/plan-build`，切换当前模式 |

## 快捷键

`Ctrl+Alt+Shift+P` 在两个前端里都能切换 Plan / Build 模式（等同裸 `/plan-build`）：

- **dsh-tui** — 通过插件快捷键注册表（`ctx.tuiShortcuts`）绑定。仅在普通聊天态生效；弹层/选择器打开时会独占键盘。
- **dsh web** — 全局 keydown 监听对当前会话执行 `/plan-build`。无会话打开或处于输入法组合期间不生效。

组合键刻意做得复杂（三个修饰键），不会与终端、浏览器或系统的内置快捷键冲突。可通过 `shortcut` 配置修改，支持单个字符串或数组：

```yaml
- id: plan-build-mode
  name: '@xth26/dsh-plan-build-mode'
  config:
    shortcut: ['ctrl+alt+shift+p', 'alt+p']
```

组合键遵循 `ctrl+alt+shift+p` 语法，必须包含 Ctrl 或 Alt。TUI 会拒绝与其内置键位表冲突的组合（仅警告，插件照常运行）。

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

`planSandbox` 和 `buildSandbox` 必须不同。

## Plan 模式：命令行 Python 做数据检查

Plan 模式只读并拦截 `write`/`edit` 工具，但**鼓励**在命令行里跑简短、只读的 Python 片段来读数据和验证假设。例如：

```bash
python -B -c "import json, sys; data = json.load(open('data/sample.json')); print(len(data))"
python -B -c "import pandas as pd; print(pd.read_csv('data.csv').describe())"
pytest -p no:cacheprovider -q tests/test_sanity.py
```

使用 `-B`（或设置 `PYTHONDONTWRITEBYTECODE=1`）以及 `pytest -p no:cacheprovider`，避免写入 `__pycache__` 或 `.pytest_cache`。read-only 沙箱仍是最终防线，任何试图写文件的命令仍会在沙箱层被拒绝。

## 本地集成验证

安装或 link 插件到 DSH profile 后：

1. 启动 DSH。
2. 输入 `/plan-build`，应提示进入 Plan 模式。
3. 让 agent 调用 `write` 工具，应被拒绝。
4. 再次输入 `/plan-build`，应提示进入 Build 模式。
5. 再次让 agent 调用 `write`，应允许执行。
6. 输入 `/plan-build status`，可只查看当前模式而不切换。

## 变更日志

### 0.3.0（未发布）

- 在 TUI（`ctx.tuiShortcuts`）与 web 前端（全局 keydown）都新增 Plan / Build 切换快捷键（默认 `Ctrl+Alt+Shift+P`）。快捷键执行 `/plan-build`，因此模式状态、生命周期事件与授权保持单一来源。可通过新增的 `shortcut` 配置键自定义（单个字符串或组合数组）。

## 许可证

MIT

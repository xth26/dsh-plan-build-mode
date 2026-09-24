# dsh-plan-build-mode

OpenCode 风格的 Plan / Build 硬权限模型插件（DeepSeek Harness）。

本插件为 DSH 增加一个独立的 Plan/Build 模式切换，并用 OpenCode 风格权限引擎
（`allow | ask | deny`）对工具访问做门禁，不影响 DSH 原生的 `/plan` 软提示模式：

- **Plan 模式按策略只读**：所有写类工具都被拒绝，唯一例外是写入配置的
  plans 目录（`.opencode/plans/`）——这样 agent 在其余位置保持只读时，仍能持久化
  计划文件。
- **Build 模式可写**：可以执行已批准的计划。
- **两种模式下读取都不受限**，包括工作区之外的文件——与 DSH 一致，读取在每种
  沙箱模式下都放行。只有**修改**会被门禁（对应 OpenCode 的 `external_directory`）。
- DSH 自带的 `/plan` 软提示模式保持原样。

插件的内置默认值把两个沙箱都配置为 `workspace-write`；Plan 模式的“只读”由权限
门禁而不是沙箱强制——这正是计划文件能写到 `.opencode/plans/`、其余位置保持只读
的原因。随附的 `cordis.patch.yml` 是纯 insert（只含 `id` 与 `name`），因此可以直接
从 DSH 插件市场启用（热挂载），无需重启。

## 版本兼容性

| 插件版本 | DSH 版本 | 说明 |
|---|---|---|
| `0.5.1` | `>= 0.1.5-rc.1` | bundle patch 改为纯 insert；OpenCode 对齐默认值内置到插件代码，插件市场可直接启用，无需重启。 |
| `0.5.x` | `>= 0.1.5-rc.1` | 新增 OpenCode 权限门禁与 `/permission`；模式由 `plan-build/mode` 会话事件承载（旧会话从 `sandbox/mode` 推断）。 |
| `0.4.x` | `>= 0.1.5-rc.1` | 使用 `session.snapshotEvents()`；DSH 0.1.5 移除了 `session.events` 快照 getter。 |
| `<= 0.3.1` | `0.1.0-rc.x` | 旧版本；在 DSH 0.1.5+ 上因上述 API 变更无法工作。 |

## 安装

DSH 插件通过 DSH profile 加载。把它装到你实际使用的 profile 里：

```bash
# 装到 web profile
dsh plugin --profile web add @xth26/dsh-plan-build-mode

# 装到 TUI profile
dsh plugin --profile dsh-tui add @xth26/dsh-plan-build-mode
```

插件自带的 `cordis.patch.yml` 会在 DSH profile 加载时自动注入；它是纯 insert，
因此从 DSH 插件市场启用也可以直接生效，无需重启。

## 让 Web 和 TUI 共享同一个 Plan/Build 模式

Plan/Build 模式状态存在会话事件日志里（插件专属的 `plan-build/mode` 事件，
以及用于沙箱执行的 `sandbox/mode` 事件）。`dsh web` 和 `dsh --profile <名称>`
只有在共用同一个 profile、同一个 session ID 时，才会读写同一个会话事件流。

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
dsh plugin --profile dsh-tui add @xth26/dsh-plan-build-mode@0.5.0

# 重启使用该 profile 的 DSH 进程
# （旧的 Node 进程仍缓存着旧插件代码）
Stop-Process -Name dsh -Force   # PowerShell
# 或: taskkill /IM dsh.exe /F   # CMD
```

然后重新启动 `dsh web` 或 `dsh tui`。如果想始终安装最新发布版本：

```bash
dsh plugin --profile dsh-tui add @xth26/dsh-plan-build-mode@latest
```

### 升级说明（0.5.0 → 0.5.1）

- `cordis.patch.yml` 改为纯 insert（只含 `id` 与 `name`，不带 `config`），插件市场
  可直接启用。原来写在 patch 里的 OpenCode 对齐值现在内置为插件默认值；已按旧配置
  固定值的 profile 无需改动仍可工作。

### 升级说明（0.4.x → 0.5.x）

- `planSandbox` 与 `buildSandbox` **现在可以相等**（随附默认两者都用
  `workspace-write`）；Plan 模式的只读策略由权限门禁强制。旧的“必须不同”限制已移除。
- 模式状态迁移到插件专属的 `plan-build/mode` 事件。只有 `sandbox/mode` 事件的旧
  会话会在加载时被推断并在会话开始时固定为真实的 `plan-build/mode` 事件，历史不丢失。
- 旧的 `denyWriteTools` 选项仍然有效：设为 `false` 允许 agent 在 Plan 模式写入
  （等价于覆盖 `modes.plan.edit = allow`）。

## 使用

| 命令 | 效果 |
|---|---|
| `/plan-build` | 在 Plan 与 Build 模式之间切换 |
| `/plan-build status` | 显示当前模式 |
| `/plan-build switch plan` | 进入 Plan 模式（策略只读） |
| `/plan-build switch build` | 进入 Build 模式（可写） |
| `/plan-build switch` | 同 `/plan-build`，切换当前模式 |
| `/permission status` | 显示外部路径默认值、规则与本次会话的 allowlist |
| `/permission allow <pattern>` | 把模式加入本次会话 allowlist（OpenCode 的 “always”） |
| `/permission deny <pattern>` | 从本次会话 allowlist 移除该模式 |

## 配置

```yaml
- id: plan-build-mode
  name: '@xth26/dsh-plan-build-mode'
  config:
    planSandbox: workspace-write
    buildSandbox: workspace-write
    denyWriteTools: true
    section: true
    plansDirectory: .opencode/plans
    externalDirectory:
      default: allow   # allow | ask | deny —— 工作区之外的读取
```

上面示例中的所有值都是插件内置默认值，因此随附的纯 insert patch（只有 `id` 与
`name`）与示例行为完全一致。`planSandbox` 和 `buildSandbox` 可以相等，也可以不同。
不同时，模式切换还会联动沙箱（`read-only` ↔ `workspace-write` 等）；相等时
（随附默认），Plan 模式的策略由权限门禁强制。

### 权限模型

每个工具映射到一个类别：

| 类别 | 工具 |
|---|---|
| `read` | `read`、`read_image`、`pdf_read`、`docx_read`、`pptx_read`、`xlsx_read` |
| `edit` | `write`、`edit`、`pdf_create`、`docx_create`、`pptx_create`、`xlsx_write`、`xlsx_edit` |
| `glob` | `glob` |
| `grep` | `grep` |
| `bash` | `bash` |
| `pwsh` | `pwsh` |
| `webfetch` | `web_fetch` |
| `websearch` | `web_search` |

类别值可以是标量（`allow | ask | deny`），也可以是带顺序的对象规则，和 OpenCode 一致：

```yaml
permission:
  read:
    '*': allow
    '**/.env': deny
    '**/.env.*': deny
    '**/.env.example': allow   # 最后匹配的规则生效
  bash: ask
  edit: deny
```

模式支持 OpenCode 通配符（`*` 匹配任意字符、含 `/`；`?` 恰好匹配一个字符；
`**` 与 `*` 相同）以及 `~`/`$HOME` 展开。规则按“最后匹配者胜出”求值。默认规则对齐
OpenCode：大多数类别 `allow`；`.env*` 读取被拒绝（`.env.example` 恢复为允许）。

Plan 模式覆盖默认值（除非被 `modes.plan` 或 `denyWriteTools: false` 覆盖）：
`edit: deny`、`bash: ask`、`pwsh: ask`——对应 OpenCode plan agent 的默认值。
`modes.plan` / `modes.build` 按模式覆盖全局权限，类似 OpenCode 的 agent 级覆盖。

```yaml
modes:
  plan:
    bash: deny   # 替代默认的 ask
  build:
    read: allow
```

### Plans 目录例外

在 Plan 模式下，写入 `plansDirectory`（默认 `.opencode/plans/`，相对会话工作区）
下的 `edit` 类工具**始终允许**，保证 `/plan-build` 与计划文件正常工作。Plan 模式下
其它所有写入都会被拒绝，理由中包含 `forbidden in Plan Mode`。

### 外部路径

- **读取**工作区之外的文件在两种模式下默认都允许（`externalDirectory.default:
  allow`）。设为 `ask` 可获得完整的 OpenCode 行为：对外部读取发起审批请求。
- **写入**工作区之外由沙箱决定。在 `workspace-write` 下无法放行，因此插件不会
  弹审批（那也会在沙箱层失败），而是直接拒绝并给出升级提示——用
  `sandbox_permissions` + `justification` 重试同一个工具。
- `/permission allow <pattern>` 会加入一个会话级 allowlist 条目（OpenCode
  “always”），仅在该会话内存中保留。

## Plan 模式：命令行 Python 做数据检查

Plan 模式拒绝 `write`/`edit` 工具，但**鼓励**在命令行里跑简短、只读的 Python
片段来读数据和验证假设。例如：

```bash
python -B -c "import json, sys; data = json.load(open('data/sample.json')); print(len(data))"
python -B -c "import pandas as pd; print(pd.read_csv('data.csv').describe())"
pytest -p no:cacheprovider -q tests/test_sanity.py
```

使用 `-B`（或设置 `PYTHONDONTWRITEBYTECODE=1`）以及 `pytest -p no:cacheprovider`，
避免写入 `__pycache__` 或 `.pytest_cache`。权限门禁与沙箱是最终防线：任何试图写文件的
操作都会在门禁（Plan 模式）或沙箱层（Build 模式）被拦截。

## 本地集成验证

安装或 link 插件到 DSH profile 后：

1. 启动 DSH。
2. 输入 `/plan-build`，应提示进入 Plan 模式（策略只读）。
3. 让 agent 对 `src/x.ts` 调用 `write`，应被拒绝，理由包含 `forbidden in Plan Mode`。
4. 让 agent 对 `.opencode/plans/x.md` 调用 `write`，应**允许**（plans 目录例外）。
5. 再次输入 `/plan-build`，应提示进入 Build 模式。
6. 让 agent 对 `src/x.ts` 调用 `write`，应允许执行。
7. 让 agent 读取工作区之外的文件，应无需提示直接放行（默认 `external_directory: allow`）。
8. 输入 `/permission status` 查看门禁状态；可尝试 `/permission allow ~/projects/**` 添加会话 allowlist。
9. 输入 `/plan-build status`，可只查看当前模式而不切换。

## 许可证

MIT

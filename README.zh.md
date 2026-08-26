# dsh-plan-build-mode

OpenCode 风格的 Plan / Build 硬权限模型插件。

本插件为 DSH 增加一个独立的 Plan/Build 模式切换，不影响 DSH 原生的 `/plan` 软提示模式：

- **Plan 模式**：强制 `read-only` 沙箱，并拦截写工具（`write`、`edit`）。
- **Build 模式**：恢复 `workspace-write`，允许编辑。

## 安装

```bash
npm install dsh-plan-build-mode
```

如果你使用 DSH profile，推荐用：

```bash
dsh plugin --profile <你的profile名> add dsh-plan-build-mode
```

插件自带的 `cordis.patch.yml` 会在 DSH profile 加载时自动注入。

## 本地开发 / link 试用

想在发布前从本地源码试用：

```bash
# 在插件目录
cd /path/to/dsh-plan-build-mode
pnpm link --global

# 在你的 DSH profile 目录
pnpm link --global dsh-plan-build-mode
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
  name: 'dsh-plan-build-mode'
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

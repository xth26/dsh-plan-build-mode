# dsh-plan-build-mode

OpenCode-style Plan / Build hard permission model for DeepSeek Harness.

This plugin adds an independent Plan/Build mode switch to DSH and gates tool
access with an OpenCode-style permission engine (`allow | ask | deny`):

- **Plan mode** is read-only *by policy*: every write-category tool is denied
  except writes under the configured plans directory (`.opencode/plans/`), so
  you can persist plan files while the agent stays read-only everywhere else.
- **Build mode** is writable: the approved plan can be executed.
- **Reads are unrestricted in both modes**, including files outside the
  workspace — matching DSH, where reads pass through every sandbox mode. Only
  *modifications* are gated (OpenCode `external_directory`).
- DSH's built-in `/plan` soft-guidance mode is left untouched.

The plugin's built-in defaults configure both sandboxes as `workspace-write`;
"read-only" in Plan mode is enforced by the permission gate, not by the
sandbox. This is what makes plan files persist under `.opencode/plans/` while
everything else stays read-only. The shipped `cordis.patch.yml` is a pure
insert (only `id` + `name`), so the plugin can be enabled directly from the
DSH plugin market (hot mount) without a restart.

## Version compatibility

| Plugin version | DSH version | Notes |
|---|---|---|
| `0.5.1` | `>= 0.1.5-rc.1` | Bundle patch is now a pure insert; OpenCode-aligned defaults are baked into the plugin code so the plugin can be enabled directly from the plugin market without a restart. |
| `0.5.x` | `>= 0.1.5-rc.1` | Adds the OpenCode permission gate and `/permission`; mode is carried by the `plan-build/mode` session event (legacy sessions are inferred from `sandbox/mode`). |
| `0.4.x` | `>= 0.1.5-rc.1` | Uses `session.snapshotEvents()`; DSH 0.1.5 removed the `session.events` snapshot getter. |
| `<= 0.3.1` | `0.1.0-rc.x` | Legacy releases; broken on DSH 0.1.5+ because of the API change above. |

## Installation

DSH plugins are loaded through a DSH profile. Install the plugin into the profile(s) you use:

```bash
# For the web profile
dsh plugin --profile web add @xth26/dsh-plan-build-mode

# For the TUI profile
dsh plugin --profile dsh-tui add @xth26/dsh-plan-build-mode
```

The plugin ships with a `cordis.patch.yml` that auto-injects the required row
when the package is loaded by a DSH profile. The patch is a pure insert, so
enabling the plugin from the DSH plugin market also works without a restart.

## Using the same Plan/Build mode in both web and TUI

Plan/Build mode state is stored in the session event log (the plugin-owned
`plan-build/mode` event, plus `sandbox/mode` for sandbox enforcement). Both
`dsh web` and `dsh --profile <name>` use the same session store when they share
the same profile and session ID.

- **Same profile**: if you run `dsh web --profile web` and `dsh --profile web`, the mode is shared because the session events are shared.
- **Different profiles**: by default `web` and `dsh-tui` are separate profiles with separate session directories. Switching in one does **not** affect the other.

To make web and TUI share the same mode and session history, use the **same profile** for both:

```bash
# Use the web profile for both interfaces
dsh web --profile web
dsh --profile web
```

Or, if you prefer to keep separate profiles but want to share only the session store, override the session root in each profile's `cordis.patch.yml` to point to the same directory:

```yaml
- id: session-root
  config:
    root: /path/to/shared/sessions
```

Note: sharing session directories across profiles requires both profiles to mount compatible service bundles; otherwise event interpretation may differ.

## Local development / link

To try the plugin from a local checkout without publishing:

```bash
# From the plugin checkout
cd /path/to/dsh-plan-build-mode
pnpm link --global

# From your DSH profile directory
pnpm link --global @xth26/dsh-plan-build-mode
```

Then start DSH with that profile. The `dsh.bundle.patch` field in the plugin's
`package.json` makes the patch apply automatically.

## Updating

For `0.x` versions, the semver range `^0.1.0` only matches `0.1.x` and will **never** auto-update to `0.2.0`. Always bump the declaration explicitly and restart the DSH process:

```bash
# Bump the installed version in the target profile
# (run this outside a sandboxed agent session; the profile directory is not writable from DSH)
dsh plugin --profile dsh-tui add @xth26/dsh-plan-build-mode@0.5.0

# Restart the DSH process that uses that profile
# (old Node process still holds the previous plugin code in memory)
Stop-Process -Name dsh -Force   # PowerShell
# or: taskkill /IM dsh.exe /F   # CMD
```

Then start `dsh web` or `dsh tui` again. To always pull the latest published version:

```bash
dsh plugin --profile dsh-tui add @xth26/dsh-plan-build-mode@latest
```

### Upgrade notes (0.5.0 → 0.5.1)

- `cordis.patch.yml` is now a pure insert (`id` + `name`, no `config`), so the
  plugin can be enabled directly from the DSH plugin market. The OpenCode-aligned
  values it used to carry are now the plugin's built-in defaults; profiles that
  already pinned the old config keep working unchanged.

### Upgrade notes (0.4.x → 0.5.x)

- `planSandbox` and `buildSandbox` **may now be equal** (the shipped defaults
  use `workspace-write` for both); the permission gate enforces the read-only
  policy in Plan mode. The old "must differ" requirement is gone.
- Mode state moves to the plugin-owned `plan-build/mode` event. Sessions that
  only have `sandbox/mode` events are inferred on load and pinned to a real
  `plan-build/mode` event at session start, so no history is lost.
- The legacy `denyWriteTools` option still works: setting it to `false` lets
  the agent write in Plan mode (equivalent to overriding `modes.plan.edit =
  allow`).

## Usage

| Command | Effect |
|---|---|
| `/plan-build` | Toggle between Plan and Build modes |
| `/plan-build status` | Show the current mode |
| `/plan-build switch plan` | Enter Plan mode (read-only by policy) |
| `/plan-build switch build` | Enter Build mode (writable) |
| `/plan-build switch` | Same as `/plan-build`; toggles between modes |
| `/permission status` | Show the external-path default, rules, and the session allowlist |
| `/permission allow <pattern>` | Add a pattern to this session's allowlist (OpenCode "always") |
| `/permission deny <pattern>` | Remove a pattern from this session's allowlist |

## Configuration

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
      default: allow   # allow | ask | deny — reads outside the workspace
```

All values in the example above are the plugin's built-in defaults, so a bare
pure-insert row (the shipped patch) behaves identically. `planSandbox` and
`buildSandbox` may be equal or differ. When they differ, mode switches also
move the sandbox (`read-only` → `workspace-write` etc.). When they are equal
(shipped default), the permission gate is what enforces the Plan-mode policy.

### Permission model

Each tool maps to a category:

| Category | Tools |
|---|---|
| `read` | `read`, `read_image`, `pdf_read`, `docx_read`, `pptx_read`, `xlsx_read` |
| `edit` | `write`, `edit`, `pdf_create`, `docx_create`, `pptx_create`, `xlsx_write`, `xlsx_edit` |
| `glob` | `glob` |
| `grep` | `grep` |
| `bash` | `bash` |
| `pwsh` | `pwsh` |
| `webfetch` | `web_fetch` |
| `websearch` | `web_search` |

A category value is either a scalar (`allow | ask | deny`) or an object of
ordered rules, like OpenCode:

```yaml
permission:
  read:
    '*': allow
    '**/.env': deny
    '**/.env.*': deny
    '**/.env.example': allow   # last matching rule wins
  bash: ask
  edit: deny
```

Patterns support OpenCode wildcards (`*` matches any characters including `/`,
`?` matches exactly one character, `**` behaves like `*`) and `~`/`$HOME`
expansion. Rules are evaluated last-match-wins. The default rules mirror
OpenCode: most categories `allow`; `.env*` reads are denied (`.env.example`
allowed back).

Plan mode overrides (unless overridden by `modes.plan` or `denyWriteTools:
false`): `edit: deny`, `bash: ask`, `pwsh: ask` — mirroring OpenCode's plan
agent defaults. `modes.plan` / `modes.build` override the global permission for
that mode, like OpenCode's agent-specific overrides.

```yaml
modes:
  plan:
    bash: deny   # instead of the default ask
  build:
    read: allow
```

### Plans carve-out

In Plan mode, `edit`-category writes under `plansDirectory` (default
`.opencode/plans/`, relative to the session workspace) are always allowed, so
`/plan-build` and plan files keep working. Every other write in Plan mode is
denied with a reason that includes `forbidden in Plan Mode`.

### External paths

- **Reads** outside the workspace are allowed by default in both modes
  (`externalDirectory.default: allow`). Set it to `ask` for full OpenCode
  behavior: the agent asks for approval on external reads.
- **Writes** outside the workspace are governed by the sandbox. Under
  `workspace-write` they cannot be permitted, so instead of prompting (which
  would just fail at the sandbox), the plugin denies with an escalation hint —
  retry the same tool with `sandbox_permissions` + `justification`.
- `/permission allow <pattern>` adds a session-scoped allowlist entry
  (OpenCode "always"), persisted in memory for the session's lifetime.

## Plan mode: command-line Python for inspection

While Plan mode denies `write`/`edit` tools, it is **encouraged** to run short,
read-only command-line Python snippets to inspect data and validate
assumptions. For example:

```bash
python -B -c "import json, sys; data = json.load(open('data/sample.json')); print(len(data))"
python -B -c "import pandas as pd; print(pd.read_csv('data.csv').describe())"
pytest -p no:cacheprovider -q tests/test_sanity.py
```

Use `-B` (or set `PYTHONDONTWRITEBYTECODE=1`) and `pytest -p no:cacheprovider`
to avoid writing `__pycache__` or `.pytest_cache`. The permission gate and the
sandbox are the final guardrails; anything that tries to write files is blocked
at the gate (Plan mode) or the sandbox layer (Build mode).

## Local integration check

After installing/linking the plugin in a DSH profile:

1. Start DSH with that profile.
2. Run `/plan-build` to enter Plan mode (read-only by policy). You should see a confirmation.
3. Ask the agent to call the `write` tool on `src/x.ts`. It should be denied with a reason containing `forbidden in Plan Mode`.
4. Ask the agent to call `write` on `.opencode/plans/x.md`. It should be **allowed** (plans carve-out).
5. Run `/plan-build` again to enter Build mode (writable). You should see a confirmation.
6. Ask the agent to call `write` on `src/x.ts`. It should now be allowed.
7. Ask the agent to read a file outside the workspace. It should be allowed without prompting (default `external_directory: allow`).
8. Run `/permission status` to inspect the gate; try `/permission allow ~/projects/**` to add a session allowlist entry.
9. Run `/plan-build status` to check the current mode without switching.

## License

MIT

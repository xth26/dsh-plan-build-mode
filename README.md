# dsh-plan-build-mode

OpenCode-style Plan / Build hard permission model for DeepSeek Harness.

This plugin adds an independent Plan/Build mode switch to DSH:

- **Plan mode** enforces a `read-only` sandbox and blocks mutating tools (`write`, `edit`).
- **Build mode** restores `workspace-write` and allows edits.
- DSH's built-in `/plan` soft-guidance mode is left untouched.

The tool denial only takes effect when Plan mode is configured as `read-only`. When the session has not been switched, Build mode is active by default.

## Installation

DSH plugins are loaded through a DSH profile. Install the plugin into the profile(s) you use:

```bash
# For the web profile
dsh plugin --profile web add @xth26/dsh-plan-build-mode

# For the TUI profile
dsh plugin --profile dsh-tui add @xth26/dsh-plan-build-mode
```

The plugin ships with a `cordis.patch.yml` that auto-injects the required row
when the package is loaded by a DSH profile.

## Using the same Plan/Build mode in both web and TUI

Plan/Build mode state is stored in the session event log (`sandbox/mode` event). Both `dsh web` and `dsh --profile <name>` use the same session store when they share the same profile and session ID.

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
dsh plugin --profile dsh-tui add @xth26/dsh-plan-build-mode@0.2.0

# Restart the DSH process that uses that profile
# (old Node process still holds the previous plugin code in memory)
Stop-Process -Name dsh -Force   # PowerShell
# or: taskkill /IM dsh.exe /F   # CMD
```

Then start `dsh web` or `dsh tui` again. To always pull the latest published version:

```bash
dsh plugin --profile dsh-tui add @xth26/dsh-plan-build-mode@latest
```

## Usage

| Command | Effect |
|---|---|
| `/plan-build` | Toggle between Plan and Build modes |
| `/plan-build status` | Show the current mode |
| `/plan-build switch plan` | Enter Plan mode (read-only) |
| `/plan-build switch build` | Enter Build mode (writable) |
| `/plan-build switch` | Same as `/plan-build`; toggles between modes |

## Configuration

```yaml
- id: plan-build-mode
  name: '@xth26/dsh-plan-build-mode'
  config:
    planSandbox: read-only
    buildSandbox: workspace-write
    denyWriteTools: true
    section: true
```

## Plan mode: command-line Python for inspection

While Plan mode is read-only and blocks `write`/`edit` tools, it is **encouraged** to run short, read-only command-line Python snippets to inspect data and validate assumptions. For example:

```bash
python -B -c "import json, sys; data = json.load(open('data/sample.json')); print(len(data))"
python -B -c "import pandas as pd; print(pd.read_csv('data.csv').describe())"
pytest -p no:cacheprovider -q tests/test_sanity.py
```

Use `-B` (or set `PYTHONDONTWRITEBYTECODE=1`) and `pytest -p no:cacheprovider` to avoid writing `__pycache__` or `.pytest_cache`. The read-only sandbox is the final guardrail; any command that tries to write files will still be blocked at the sandbox layer.

## Local integration check

After installing/linking the plugin in a DSH profile:

1. Start DSH with that profile.
2. Run `/plan-build` to enter Plan mode (read-only). You should see a confirmation.
3. Ask the agent to call the `write` tool. It should be denied with a reason.
4. Run `/plan-build` again to enter Build mode (writable). You should see a confirmation.
5. Ask the agent to call `write` again. It should now be allowed.
6. Run `/plan-build status` to check the current mode without switching.

## License

MIT

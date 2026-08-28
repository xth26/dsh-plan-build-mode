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

## Usage

| Command | Effect |
|---|---|
| `/plan-build` | Show the current mode |
| `/plan-build switch plan` | Enter Plan mode (read-only) |
| `/plan-build switch build` | Enter Build mode (writable) |
| `/plan-build switch` | Toggle between plan and build |

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

## Local integration check

After installing/linking the plugin in a DSH profile:

1. Start DSH with that profile.
2. Run `/plan-build switch plan`. You should see a confirmation that Plan mode
   is active.
3. Ask the agent to call the `write` tool. It should be denied with a reason.
4. Run `/plan-build switch build`. You should see a confirmation that Build mode
   is active.
5. Ask the agent to call `write` again. It should now be allowed.

## License

MIT

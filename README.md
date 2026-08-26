# dsh-plan-build-mode

OpenCode-style Plan / Build hard permission model for DeepSeek Harness.

This plugin adds an independent Plan/Build mode switch to DSH:

- **Plan mode** enforces a `read-only` sandbox and blocks mutating tools (`write`, `edit`).
- **Build mode** restores `workspace-write` and allows edits.
- DSH's built-in `/plan` soft-guidance mode is left untouched.

## Installation

```bash
npm install dsh-plan-build-mode
```

If you use a DSH profile, the recommended way is:

```bash
dsh plugin --profile <your-profile-name> add dsh-plan-build-mode
```

The plugin ships with a `cordis.patch.yml` that auto-injects the required row
when the package is loaded by a DSH profile.

## Local development / link

To try the plugin from a local checkout without publishing:

```bash
# From the plugin checkout
cd /path/to/dsh-plan-build-mode
pnpm link --global

# From your DSH profile directory
pnpm link --global dsh-plan-build-mode
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
  name: 'dsh-plan-build-mode'
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

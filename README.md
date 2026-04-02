# PostMX CLI Beta

Official beta CLI for the [PostMX](https://postmx.co) email testing API.

- Interactive inbox browser for development and debugging
- Scriptable terminal commands for CI and local workflows
- Message inspection with OTP, links, and text-only views
- Secure local credential storage when your OS keychain is available

Requires Node.js 18+.

## Install

```bash
npm install -g postmx-cli
```

The installed command is:

```bash
postmx --help
```

## Quick Start

```bash
postmx login
postmx inbox create --label signup-test --lifecycle temporary --ttl 15
postmx inbox wait inb_abc123 --timeout 30
postmx message get msg_abc123 --content-mode otp
```

In interactive mode, creating an inbox now drops you straight into the live watch screen so you can wait for mail immediately.

## Agents And CI

Use `POSTMX_API_KEY` as the default auth path for automation:

```bash
export POSTMX_API_KEY=pmx_live_...
```

For LLMs, coding agents, and CI jobs, prefer `--agent`. It forces JSON envelopes, disables prompts and TUI flows, and avoids browser-assisted login paths.

```bash
npx postmx-cli inbox create --label signup-test --agent
npx postmx-cli inbox wait inb_abc123 --agent
npx postmx-cli message get msg_abc123 --content-mode otp --agent
```

If you want JSON without the stricter agent defaults, use `--output json` or `--json`.

Agents can also discover the CLI contract directly:

```bash
postmx help --json
postmx version --json
```

## Common Commands

```bash
postmx -i
postmx auth logout
postmx auth login --api-key pmx_live_...
postmx inbox list-msg inb_abc123 --limit 20
postmx messages list --recipient-email signup-test@postmx.email
postmx webhook create --label app-events --target-url https://example.com/webhooks/postmx
```

## Notes

- npm package name: `postmx-cli`
- installed executable: `postmx`
- `--agent` implies JSON output, no prompts, no browser flow, and no interactive mode
- Homebrew support should only be documented publicly after the `postmx` formula is live

## License

MIT

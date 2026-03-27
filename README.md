# PostMX CLI

Official CLI for the [PostMX](https://postmx.co) email testing API.

- Interactive inbox browser for development and debugging
- Scriptable terminal commands for CI and local workflows
- Message inspection with OTP, links, and text-only views

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
export POSTMX_API_KEY=pmx_live_...

postmx auth login --api-key pmx_live_...
postmx inbox create --label signup-test --lifecycle temporary --ttl 15
postmx inbox wait inb_abc123 --timeout 30
postmx message get msg_abc123 --content-mode otp
```

## Common Commands

```bash
postmx -i
postmx auth logout
postmx inbox list-msg inb_abc123 --limit 20
postmx messages list --recipient-email signup-test@postmx.email
postmx webhook create --label app-events --target-url https://example.com/webhooks/postmx
```

## Notes

- npm package name: `postmx-cli`
- installed executable: `postmx`
- Homebrew support should only be documented publicly after the `postmx` formula is live

## License

MIT

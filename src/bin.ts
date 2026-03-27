import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PostMX } from "postmx";

// ── ANSI ────────────────────────────────────────────────────────────────────

const S = {
  hide: "\x1b[?25l", show: "\x1b[?25h", el: "\x1b[K",
  altOn: "\x1b[?1049h", altOff: "\x1b[?1049l", // alternate screen buffer
  home: "\x1b[H",
  b: "\x1b[1m", d: "\x1b[2m", r: "\x1b[0m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
} as const;

const bold = (s: string) => `${S.b}${s}${S.r}`;
const dim = (s: string) => `${S.d}${s}${S.r}`;
const cyan = (s: string) => `${S.cyan}${s}${S.r}`;
const green = (s: string) => `${S.green}${s}${S.r}`;
const yellow = (s: string) => `${S.yellow}${s}${S.r}`;
const red = (s: string) => `${S.red}${s}${S.r}`;

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function fit(s: string, n: number): string {
  return trunc(s, n).padEnd(n);
}

type MessageFeedResult = {
  messages: Array<Record<string, unknown>>;
  pageInfo: { has_more: boolean; next_cursor: string | null };
};

type CliConfig = {
  apiKey?: string;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const HELP = `
postmx — CLI for the PostMX email testing API

Usage:
  postmx <command> [options]
  postmx -i                  Launch interactive mode

Commands:
  auth login     Save an API key locally for future CLI use
  auth logout    Remove the locally saved API key
  inbox create    Create a new inbox
  inbox list-msg  List messages in an inbox
  inbox wait      Poll an inbox until a message arrives
  messages list   List messages by exact recipient email
  message get     Get message detail [--content-mode full|otp|links|text_only]
  webhook create  Create a webhook

Global options:
  --api-key <key>          API key (or set POSTMX_API_KEY env var or saved CLI config)
  --base-url <url>         Override API base URL
  --content-mode <mode>    Response mode: full (default), otp, links, text_only
  --json                   Force JSON output (default when piped)
  -i, --interactive        Launch interactive TUI
  --help, -h               Show this help

Examples:
  postmx auth login --api-key pmx_live_...
  postmx -i
  postmx inbox create --label ci-test --lifecycle temporary --ttl 15
  postmx inbox wait inb_abc123 --timeout 30
  postmx messages list --recipient-email signup-test@postmx.email
  postmx message get msg_abc123
`.trim();

function die(msg: string): never {
  console.error(`${S.red}error:${S.r} ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-i") {
      flags["interactive"] = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function getConfigPath(): string {
  const root = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "postmx")
    : join(homedir(), ".config", "postmx");
  return join(root, "config.json");
}

function readCliConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(getConfigPath(), "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

function writeCliConfig(config: CliConfig): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, configPath);
}

function clearCliConfig(): void {
  rmSync(getConfigPath(), { force: true });
}

function resolveApiKey(flags: Record<string, string | true>): string | undefined {
  const flagKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
  if (flagKey) return flagKey;
  if (process.env.POSTMX_API_KEY) return process.env.POSTMX_API_KEY;
  const storedKey = readCliConfig().apiKey;
  return typeof storedKey === "string" && storedKey.length > 0 ? storedKey : undefined;
}

function resolveBaseUrl(flags: Record<string, string | true>): string | undefined {
  return typeof flags["base-url"] === "string"
    ? flags["base-url"]
    : process.env.POSTMX_BASE_URL;
}

function getClient(flags: Record<string, string | true>): PostMX {
  const apiKey = resolveApiKey(flags);

  if (!apiKey) {
    die("Missing API key. Pass --api-key, set POSTMX_API_KEY, or run `postmx auth login --api-key <key>`.");
  }

  if (typeof flags["api-key"] === "string") {
    try {
      writeCliConfig({ ...readCliConfig(), apiKey });
    } catch (err) {
      console.error(dim(`Warning: could not save API key locally (${err instanceof Error ? err.message : String(err)})`));
    }
  }

  const baseUrl = resolveBaseUrl(flags);

  const client = new PostMX(apiKey, { baseUrl });
  const metadataClient = client as unknown as Record<string, unknown>;
  metadataClient["apiKey"] = apiKey;
  metadataClient["baseUrl"] = baseUrl;
  return client;
}

async function listMessagesByRecipientCompat(
  client: PostMX,
  recipientEmail: string,
  params?: { limit?: number; cursor?: string },
): Promise<MessageFeedResult> {
  const reflectiveClient = client as unknown as Record<string, unknown>;
  const method = reflectiveClient["listMessagesByRecipient"];

  if (typeof method === "function") {
    return (method as (
      recipient: string,
      options?: { limit?: number; cursor?: string },
    ) => Promise<MessageFeedResult>).call(client, recipientEmail, params);
  }

  const apiKey = typeof reflectiveClient["apiKey"] === "string"
    ? reflectiveClient["apiKey"]
    : resolveApiKey({});
  const baseUrl = typeof reflectiveClient["baseUrl"] === "string"
    ? reflectiveClient["baseUrl"]
    : process.env.POSTMX_BASE_URL ?? "https://api.postmx.co";
  if (!apiKey) {
    throw new Error("Missing API key. Pass --api-key, set POSTMX_API_KEY, or run `postmx auth login --api-key <key>`.");
  }

  const url = new URL("/v1/messages", baseUrl);
  url.searchParams.set("recipient_email", recipientEmail);
  if (params?.limit !== undefined) url.searchParams.set("limit", String(params.limit));
  if (params?.cursor) url.searchParams.set("cursor", params.cursor);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
      "User-Agent": "postmx-cli/0.1.0",
    },
  });

  const body = await response.json().catch(() => null) as
    | { messages?: Array<Record<string, unknown>>; page_info?: { has_more: boolean; next_cursor: string | null }; error?: { message?: string } }
    | null;

  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Request failed with status ${response.status}`);
  }

  return {
    messages: body?.messages ?? [],
    pageInfo: body?.page_info ?? { has_more: false, next_cursor: null },
  };
}

function output(data: unknown, flags: Record<string, string | true>): void {
  const isJSON = flags["json"] === true || !process.stdout.isTTY;
  if (isJSON) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    printPretty(data);
  }
}

function printPretty(data: unknown, indent = 0): void {
  if (data === null || data === undefined) return;
  if (typeof data !== "object") {
    console.log(`${"  ".repeat(indent)}${data}`);
    return;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      printPretty(item, indent);
      if (typeof item === "object") console.log();
    }
    return;
  }
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      console.log(`${"  ".repeat(indent)}${bold(key + ":")} `);
      printPretty(value, indent + 1);
    } else {
      console.log(`${"  ".repeat(indent)}${bold(key + ":")} ${value}`);
    }
  }
}

// ── Non-interactive commands ────────────────────────────────────────────────

async function authLogin(flags: Record<string, string | true>): Promise<void> {
  const apiKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
  if (!apiKey) die("--api-key is required: postmx auth login --api-key <key>");

  try {
    writeCliConfig({ ...readCliConfig(), apiKey });
  } catch (err) {
    die(`Could not save API key locally: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (flags["json"] === true || !process.stdout.isTTY) {
    console.log(JSON.stringify({ success: true, config_path: getConfigPath() }, null, 2));
  } else {
    console.log(`Saved API key to ${getConfigPath()}`);
  }
}

async function authLogout(flags: Record<string, string | true>): Promise<void> {
  try {
    clearCliConfig();
  } catch (err) {
    die(`Could not remove saved API key: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (flags["json"] === true || !process.stdout.isTTY) {
    console.log(JSON.stringify({ success: true, config_path: getConfigPath() }, null, 2));
  } else {
    console.log(`Removed saved API key from ${getConfigPath()}`);
  }
}

async function inboxCreate(flags: Record<string, string | true>): Promise<void> {
  const client = getClient(flags);
  const label = typeof flags["label"] === "string" ? flags["label"] : undefined;
  if (!label) die("--label is required");

  const lifecycle_mode = (typeof flags["lifecycle"] === "string" ? flags["lifecycle"] : "temporary") as "temporary" | "persistent";
  const ttl = typeof flags["ttl"] === "string" ? parseInt(flags["ttl"], 10) : undefined;

  const inbox = await client.createInbox({ label, lifecycle_mode, ttl_minutes: ttl });
  output(inbox, flags);
}

async function inboxListMessages(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const inboxId = positional[0];
  if (!inboxId) die("inbox ID is required: postmx inbox list-msg <inbox_id>");

  const client = getClient(flags);
  const limit = typeof flags["limit"] === "string" ? parseInt(flags["limit"], 10) : undefined;
  const cursor = typeof flags["cursor"] === "string" ? flags["cursor"] : undefined;

  const result = await client.listMessages(inboxId, { limit, cursor });
  output(result, flags);
}

async function inboxWait(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const inboxId = positional[0];
  if (!inboxId) die("inbox ID is required: postmx inbox wait <inbox_id>");

  const client = getClient(flags);
  const timeoutMs = typeof flags["timeout"] === "string" ? parseInt(flags["timeout"], 10) * 1000 : 60_000;
  const intervalMs = typeof flags["interval"] === "string" ? parseInt(flags["interval"], 10) * 1000 : 1_000;

  if (process.stdout.isTTY) {
    console.error(dim(`Polling inbox ${inboxId} (timeout: ${timeoutMs / 1000}s)...`));
  }

  const message = await client.waitForMessage(inboxId, { timeoutMs, intervalMs });
  output(message, flags);
}

async function messagesList(flags: Record<string, string | true>): Promise<void> {
  const recipientEmail = typeof flags["recipient-email"] === "string" ? flags["recipient-email"] : undefined;
  if (!recipientEmail) die("--recipient-email is required: postmx messages list --recipient-email <email>");

  const client = getClient(flags);
  const limit = typeof flags["limit"] === "string" ? parseInt(flags["limit"], 10) : undefined;
  const cursor = typeof flags["cursor"] === "string" ? flags["cursor"] : undefined;

  const result = await listMessagesByRecipientCompat(client, recipientEmail, { limit, cursor });
  output(result, flags);
}

async function messageGet(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const messageId = positional[0];
  if (!messageId) die("message ID is required: postmx message get <message_id> [--content-mode full|otp|links|text_only]");

  const contentMode = typeof flags["content-mode"] === "string" ? flags["content-mode"] : undefined;
  const validModes = ["full", "otp", "links", "text_only"];
  if (contentMode && !validModes.includes(contentMode)) {
    die(`--content-mode must be one of: ${validModes.join(", ")}`);
  }

  const client = getClient(flags);
  const message = await client.getMessage(messageId, contentMode as any) as unknown as Record<string, unknown>;

  if (contentMode === "otp") {
    const val = message.otp ?? null;
    if (flags["json"] === true || !process.stdout.isTTY) {
      console.log(JSON.stringify({ otp: val }));
    } else {
      console.log(val ?? "(no OTP found)");
    }
    return;
  }
  if (contentMode === "links") {
    const val = message.links ?? [];
    if (flags["json"] === true || !process.stdout.isTTY) {
      console.log(JSON.stringify({ links: val }, null, 2));
    } else {
      const links = val as Array<{ url: string; type: string }>;
      if (links.length === 0) console.log("(no links found)");
      else for (const l of links) console.log(`${l.type}: ${l.url}`);
    }
    return;
  }
  if (contentMode === "text_only") {
    const val = message.text_body ?? null;
    if (flags["json"] === true || !process.stdout.isTTY) {
      console.log(JSON.stringify({ text_body: val }));
    } else {
      console.log(val ?? "(no text body)");
    }
    return;
  }

  output(message, flags);
}

async function webhookCreate(flags: Record<string, string | true>): Promise<void> {
  const client = getClient(flags);
  const label = typeof flags["label"] === "string" ? flags["label"] : undefined;
  const target_url = typeof flags["target-url"] === "string" ? flags["target-url"] : undefined;
  const inbox_id = typeof flags["inbox-id"] === "string" ? flags["inbox-id"] : undefined;

  if (!label) die("--label is required");
  if (!target_url) die("--target-url is required");

  const result = await client.createWebhook({ label, target_url, inbox_id });
  output(result, flags);
}

// ── Interactive TUI ─────────────────────────────────────────────────────────

interface TUI {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  cols: number;
  rows: number;
}

function setupTUI(): TUI {
  const stdin = process.stdin;
  const stdout = process.stdout;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdout.write(S.altOn + S.hide); // switch to alt screen + hide cursor
  return {
    stdin, stdout,
    cols: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  };
}

function teardownTUI(tui: TUI): void {
  tui.stdout.write(S.show + S.altOff); // show cursor + restore main screen
  tui.stdin.setRawMode(false);
  tui.stdin.pause();
  tui.stdin.removeAllListeners("data");
}

/** Move cursor home and erase every line of the screen */
function clear(tui: TUI): void {
  tui.stdout.write(S.home);
  for (let i = 0; i < tui.rows; i++) {
    tui.stdout.write(S.el + (i < tui.rows - 1 ? "\n" : ""));
  }
  tui.stdout.write(S.home);
}

/** Render a picker list — the core building block. Compact, small-terminal safe. */
function drawPicker(tui: TUI, title: string, items: string[], cur: number, hint: string): void {
  clear(tui);
  const w = tui.stdout.write.bind(tui.stdout);

  // Header
  w(`\n  ${bold(title)}\n`);
  w(`  ${dim("─".repeat(Math.min(tui.cols - 4, 60)))}\n`);

  // Scroll window — reserve: 3 header + 2 footer + 2 scroll indicators
  const maxVisible = Math.max(tui.rows - 7, 3);
  const total = items.length;

  let start = 0;
  if (total > maxVisible) {
    start = Math.max(0, Math.min(cur - Math.floor(maxVisible / 2), total - maxVisible));
  }
  const end = Math.min(start + maxVisible, total);

  if (start > 0) w(`  ${dim(`  ↑ ${start} more`)}\n`);
  else w("\n");

  for (let i = start; i < end; i++) {
    const active = i === cur;
    const pointer = active ? `  ${S.cyan}▸${S.r} ` : "    ";
    const line = active ? `${S.b}${items[i]}${S.r}` : `${S.d}${items[i]}${S.r}`;
    w(`${pointer}${line}${S.el}\n`);
  }

  if (end < total) w(`  ${dim(`  ↓ ${total - end} more`)}\n`);
  else w("\n");

  // Status bar at bottom
  w(`\n  ${dim(hint)}\n`);
}

/** Wait for a single keypress and return it. */
function readKey(tui: TUI): Promise<string> {
  return new Promise((resolve) => {
    tui.stdin.once("data", resolve);
  });
}

/** Generic pick-from-list. Returns index or -1 if user backed out. */
async function pick(tui: TUI, title: string, items: string[], hint = "↑↓ select · ↵ open · esc back · q quit"): Promise<number> {
  if (items.length === 0) {
    clear(tui);
    tui.stdout.write(`${bold(title)}\n\n  ${dim("(empty)")}\n\n  ${dim("Press any key to go back")}\n`);
    await readKey(tui);
    return -1;
  }

  let cur = 0;
  drawPicker(tui, title, items, cur, hint);

  while (true) {
    const key = await readKey(tui);

    if (key === "\x03" || key === "q") { // Ctrl+C or q
      return -2; // signal quit
    }
    if (key === "\x1b" || key === "\x1b[D" || key === "b") { // Esc, left, b
      return -1; // signal back
    }
    if (key === "\x1b[A" || key === "k") { // Up
      cur = Math.max(0, cur - 1);
    } else if (key === "\x1b[B" || key === "j") { // Down
      cur = Math.min(items.length - 1, cur + 1);
    } else if (key === "\r" || key === "\n") { // Enter
      return cur;
    }

    drawPicker(tui, title, items, cur, hint);
  }
}

/** Show a detail view. Returns when user presses back/quit. Returns false if quit. */
async function showDetail(tui: TUI, lines: string[]): Promise<boolean> {
  clear(tui);
  const w = tui.stdout.write.bind(tui.stdout);

  const maxLines = tui.rows - 1;
  let scroll = 0;
  const totalLines = lines.length;

  const draw = () => {
    clear(tui);
    const end = Math.min(scroll + maxLines, totalLines);
    for (let i = scroll; i < end; i++) {
      w(lines[i] + S.el + "\n");
    }
    if (end < totalLines) w(dim("  ↓ scroll down for more"));
  };

  draw();

  while (true) {
    const key = await readKey(tui);
    if (key === "\x03" || key === "q") return false;
    if (key === "\x1b" || key === "\x1b[D" || key === "b" || key === "\r") return true;
    if (key === "\x1b[B" || key === "j") {
      if (scroll + maxLines < totalLines) { scroll++; draw(); }
    } else if (key === "\x1b[A" || key === "k") {
      if (scroll > 0) { scroll--; draw(); }
    }
  }
}

/** Format a message detail into compact lines for small terminals. */
function formatMessageDetail(msg: Record<string, unknown>, cols: number): string[] {
  const lines: string[] = [];
  const w = Math.max(cols - 4, 30);

  lines.push(`${bold("Message")}  ${dim("esc back · ↑↓ scroll · q quit")}`);
  lines.push("");
  lines.push(`  ${bold("ID")}       ${msg.id}`);
  lines.push(`  ${bold("From")}     ${trunc(String(msg.from_email ?? ""), w - 12)}`);
  lines.push(`  ${bold("To")}       ${trunc(String(msg.to_email ?? ""), w - 12)}`);
  lines.push(`  ${bold("Subject")}  ${trunc(String(msg.subject ?? "(none)"), w - 12)}`);
  lines.push(`  ${bold("Time")}     ${msg.received_at}`);

  if (msg.otp) lines.push(`  ${bold("OTP")}      ${green(String(msg.otp))}`);
  if (msg.intent) lines.push(`  ${bold("Intent")}   ${yellow(String(msg.intent))}`);

  const links = msg.links as Array<{ url: string; type: string }> | undefined;
  if (links && links.length > 0) {
    lines.push("");
    lines.push(`  ${bold("Links")}`);
    for (const l of links) {
      lines.push(`    ${dim(l.type)}  ${trunc(l.url, w - 6)}`);
    }
  }

  if (msg.text_body) {
    lines.push("");
    lines.push(`  ${bold("Body")}`);
    const bodyLines = String(msg.text_body).split("\n");
    for (const bl of bodyLines) {
      // Wrap long lines
      if (bl.length <= w - 4) {
        lines.push(`    ${bl}`);
      } else {
        for (let i = 0; i < bl.length; i += w - 4) {
          lines.push(`    ${bl.slice(i, i + w - 4)}`);
        }
      }
    }
  }

  return lines;
}

/** Format an inbox detail into compact lines. */
function formatInboxDetail(inbox: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`${bold("Inbox")}  ${dim("esc back · q quit")}`);
  lines.push("");
  lines.push(`  ${bold("ID")}       ${inbox.id}`);
  lines.push(`  ${bold("Email")}    ${cyan(String(inbox.email_address))}`);
  lines.push(`  ${bold("Label")}    ${inbox.label}`);
  lines.push(`  ${bold("Mode")}     ${yellow(String(inbox.lifecycle_mode))}`);
  if (inbox.ttl_minutes) lines.push(`  ${bold("TTL")}      ${inbox.ttl_minutes}m`);
  if (inbox.expires_at) lines.push(`  ${bold("Expires")}  ${inbox.expires_at}`);
  lines.push(`  ${bold("Status")}   ${inbox.status}`);
  if (inbox.last_message_received_at) lines.push(`  ${bold("Last msg")} ${inbox.last_message_received_at}`);
  lines.push(`  ${bold("Created")}  ${inbox.created_at}`);
  return lines;
}

function formatMessageRow(message: Record<string, unknown>, cols: number): string {
  const width = Math.max(cols - 8, 36);
  const time = String(message.received_at ?? "").replace("T", " ").slice(0, 16);
  const timeWidth = Math.min(16, Math.max(5, time.length));
  const fromWidth = Math.min(22, Math.max(12, Math.floor(width * 0.22)));
  const toWidth = Math.min(24, Math.max(14, Math.floor(width * 0.24)));
  const subjectWidth = Math.max(width - fromWidth - toWidth - timeWidth - 6, 12);
  const subject = String(message.subject ?? message.preview_text ?? "(no subject)");

  return [
    fit(String(message.from_email ?? ""), fromWidth),
    dim("→"),
    fit(String(message.to_email ?? ""), toWidth),
    fit(subject, subjectWidth),
    dim(trunc(time || "", timeWidth)),
  ].join(" ");
}

function keepSelection(messages: Array<Record<string, unknown>>, previousId: string | undefined, fallbackIndex: number): number {
  if (messages.length === 0) return 0;
  if (previousId) {
    const nextIndex = messages.findIndex((message) => String(message.id) === previousId);
    if (nextIndex >= 0) return nextIndex;
  }
  return Math.max(0, Math.min(fallbackIndex, messages.length - 1));
}

function drawMessageFeed(
  tui: TUI,
  title: string,
  subtitle: string,
  messages: Array<Record<string, unknown>>,
  selected: number,
  hint: string,
  options?: {
    status?: string;
    error?: string | null;
    emptyMessage?: string;
  },
): void {
  clear(tui);
  const write = tui.stdout.write.bind(tui.stdout);
  const rows = tui.rows;

  write(`\n  ${bold(title)}\n`);
  write(`  ${dim(subtitle)}\n`);
  if (options?.status) {
    write(`  ${dim(options.status)}\n`);
  } else if (options?.error) {
    write(`  ${red(options.error)}\n`);
  } else {
    write("\n");
  }
  write(`  ${dim("─".repeat(Math.min(tui.cols - 4, 72)))}\n`);

  if (messages.length === 0) {
    write(`\n  ${dim(options?.emptyMessage ?? "No messages yet.")}\n`);
    if (options?.error) write(`  ${red(options.error)}\n`);
    write(`\n  ${dim(hint)}\n`);
    return;
  }

  const maxVisible = Math.max(rows - 9, 3);
  const total = messages.length;
  const start = total > maxVisible
    ? Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), total - maxVisible))
    : 0;
  const end = Math.min(start + maxVisible, total);

  if (start > 0) write(`  ${dim(`↑ ${start} earlier messages`)}` + "\n");
  else write("\n");

  for (let index = start; index < end; index++) {
    const active = index === selected;
    const pointer = active ? `  ${cyan("▸")} ` : "    ";
    const row = formatMessageRow(messages[index], tui.cols);
    write(`${pointer}${active ? bold(row) : dim(row)}${S.el}\n`);
  }

  if (end < total) write(`  ${dim(`↓ ${total - end} more messages`)}` + "\n");
  else write("\n");

  if (options?.error) {
    write(`  ${red(options.error)}\n`);
  }
  write(`  ${dim(hint)}\n`);
}

function readKeyWithTimeout(tui: TUI, timeoutMs?: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      tui.stdin.removeListener("data", onData);
      if (timer) clearTimeout(timer);
    };

    const onData = (data: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };

    tui.stdin.on("data", onData);

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(null);
      }, timeoutMs);
    }
  });
}

async function openSelectedMessage(
  tui: TUI,
  client: PostMX,
  messages: Array<Record<string, unknown>>,
  selected: number,
): Promise<boolean> {
  const message = messages[selected];
  if (!message) return true;

  clear(tui);
  tui.stdout.write(dim("  Loading message detail..."));

  try {
    const detail = await client.getMessage(String(message.id)) as unknown as Record<string, unknown>;
    return await showDetail(tui, formatMessageDetail(detail, tui.cols));
  } catch (err) {
    clear(tui);
    tui.stdout.write(`${red("Error:")} ${err instanceof Error ? err.message : String(err)}\n\n  ${dim("Press any key")}\n`);
    await readKey(tui);
    return true;
  }
}

async function browseMessageFeed(
  tui: TUI,
  client: PostMX,
  options: {
    title: string;
    subtitle: string;
    emptyMessage: string;
    load: () => Promise<Array<Record<string, unknown>>>;
  },
): Promise<boolean> {
  let messages: Array<Record<string, unknown>> = [];
  let selected = 0;
  let error: string | null = null;
  let status = "Loading messages...";

  const refresh = async () => {
    const previousId = messages[selected] ? String(messages[selected].id) : undefined;
    try {
      const nextMessages = await options.load();
      messages = nextMessages;
      selected = keepSelection(messages, previousId, selected);
      error = null;
      status = `${messages.length} message${messages.length === 1 ? "" : "s"} loaded · press r to refresh`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      status = "Unable to refresh right now";
    }
  };

  await refresh();

  while (true) {
    drawMessageFeed(
      tui,
      options.title,
      options.subtitle,
      messages,
      selected,
      "↑↓ move · ↵ details · r refresh · esc back · q quit",
      { status, error, emptyMessage: options.emptyMessage },
    );

    const key = await readKey(tui);
    if (key === "\x03" || key === "q") return false;
    if (key === "\x1b" || key === "\x1b[D" || key === "b") return true;
    if (key === "r") {
      status = "Refreshing…";
      await refresh();
      continue;
    }
    if (key === "\x1b[A" || key === "k") {
      selected = Math.max(0, selected - 1);
      continue;
    }
    if (key === "\x1b[B" || key === "j") {
      selected = Math.min(Math.max(messages.length - 1, 0), selected + 1);
      continue;
    }
    if ((key === "\r" || key === "\n") && messages.length > 0) {
      const cont = await openSelectedMessage(tui, client, messages, selected);
      if (!cont) return false;
    }
  }
}

async function recipientLookupScreen(tui: TUI, client: PostMX): Promise<boolean> {
  clear(tui);
  tui.stdout.write(`${bold("Find recipient email")}\n\n`);
  const recipientEmail = await prompt(tui, "  Exact recipient email: ");
  if (recipientEmail === null) return true;

  const normalized = recipientEmail.trim();
  if (!normalized) return true;

  return browseMessageFeed(tui, client, {
    title: "Emails for address",
    subtitle: normalized,
    emptyMessage: "No messages found for that recipient email.",
    load: async () => {
      const result = await listMessagesByRecipientCompat(client, normalized, { limit: 50 });
      return result.messages as unknown as Array<Record<string, unknown>>;
    },
  });
}

async function interactiveMode(client: PostMX): Promise<void> {
  const tui = setupTUI();

  // Listen for terminal resize
  process.stdout.on("resize", () => {
    tui.cols = process.stdout.columns ?? 80;
    tui.rows = process.stdout.rows ?? 24;
  });

  try {
    await mainMenu(tui, client);
  } finally {
    clear(tui);
    teardownTUI(tui);
  }
}

async function mainMenu(tui: TUI, client: PostMX): Promise<void> {
  const items = [
    "Inboxes",
    "Find Emails By Address",
    "Create inbox",
    "Webhooks",
  ];

  while (true) {
    const idx = await pick(tui, "postmx", items, "↑↓ · ↵ select · q quit");
    if (idx === -2 || idx === -1) return; // quit

    if (idx === 0) {
      const cont = await inboxesScreen(tui, client);
      if (!cont) return;
    } else if (idx === 1) {
      const cont = await recipientLookupScreen(tui, client);
      if (!cont) return;
    } else if (idx === 2) {
      const cont = await createInboxScreen(tui, client);
      if (!cont) return;
    } else if (idx === 3) {
      const cont = await webhooksScreen(tui, client);
      if (!cont) return;
    }
  }
}

async function inboxesScreen(tui: TUI, client: PostMX): Promise<boolean> {
  clear(tui);
  tui.stdout.write(dim("  Loading inboxes..."));

  let inboxes: any[];
  let wildcard: { email_address: string; inbox_id: string } | null = null;
  try {
    const result = await client.listInboxes({ limit: 50 });
    inboxes = result.inboxes as any[];
    wildcard = result.wildcard_address ?? null;
  } catch (err) {
    clear(tui);
    tui.stdout.write(`${S.red}Error:${S.r} ${err instanceof Error ? err.message : String(err)}\n\n  ${dim("Press any key")}\n`);
    await readKey(tui);
    return true;
  }

  const items: string[] = [];
  if (wildcard) {
    items.push(`${yellow("★")} ${dim("wildcard")}  ${cyan(wildcard.email_address)}`);
  }
  for (const ib of inboxes) {
    const label = fit(ib.label ?? "", 16);
    const email = trunc(ib.email_address, Math.max(tui.cols - 24, 20));
    items.push(`${label} ${dim(email)}`);
  }

  const wildcardOffset = wildcard ? 1 : 0;

  while (true) {
    const idx = await pick(tui, "Inboxes", items);
    if (idx === -2) return false;
    if (idx === -1) return true;

    // Wildcard row → same Messages/Details/Watch flow as regular inboxes
    if (wildcard && idx === 0) {
      const wildcardInbox = {
        id: wildcard.inbox_id,
        label: "Wildcard",
        email_address: wildcard.email_address,
      };
      const cont = await inboxActionScreen(tui, client, wildcardInbox);
      if (!cont) return false;
      continue;
    }

    const cont = await inboxActionScreen(tui, client, inboxes[idx - wildcardOffset]);
    if (!cont) return false;
  }
}

async function inboxActionScreen(tui: TUI, client: PostMX, inbox: any): Promise<boolean> {
  const label = inbox.label ?? inbox.id;
  const actions = [
    "Messages",
    "Details",
    "Watch (live poll)",
  ];

  while (true) {
    const idx = await pick(tui, label, actions);
    if (idx === -2) return false;
    if (idx === -1) return true;

    if (idx === 0) {
      const cont = await messagesScreen(tui, client, inbox.id, label);
      if (!cont) return false;
    } else if (idx === 1) {
      const cont = await showDetail(tui, formatInboxDetail(inbox));
      if (!cont) return false;
    } else if (idx === 2) {
      const cont = await watchScreen(tui, client, inbox.id, label);
      if (!cont) return false;
    }
  }
}

async function messagesScreen(tui: TUI, client: PostMX, inboxId: string, label: string): Promise<boolean> {
  return browseMessageFeed(tui, client, {
    title: label,
    subtitle: "Inbox messages",
    emptyMessage: "No messages yet in this inbox.",
    load: async () => {
      const result = await client.listMessages(inboxId, { limit: 50 });
      return result.messages as unknown as Array<Record<string, unknown>>;
    },
  });
}

async function watchScreen(tui: TUI, client: PostMX, inboxId: string, label: string): Promise<boolean> {
  let messages: Array<Record<string, unknown>> = [];
  let selected = 0;
  let error: string | null = null;
  let paused = false;
  let lastUpdated = "Not refreshed yet";
  let newCount = 0;
  let initialized = false;
  const knownIds = new Set<string>();
  let nextPollAt = 0;

  const refresh = async () => {
    const previousId = messages[selected] ? String(messages[selected].id) : undefined;
    try {
      const result = await client.listMessages(inboxId, { limit: 50 });
      const nextMessages = result.messages as unknown as Array<Record<string, unknown>>;
      if (!initialized) {
        for (const message of nextMessages) knownIds.add(String(message.id));
        newCount = 0;
      } else {
        newCount = nextMessages.filter((message) => !knownIds.has(String(message.id))).length;
        for (const message of nextMessages) knownIds.add(String(message.id));
      }
      messages = nextMessages;
      selected = keepSelection(messages, previousId, selected);
      error = null;
      initialized = true;
      lastUpdated = new Date().toLocaleTimeString();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  };

  await refresh();
  nextPollAt = Date.now() + 2000;

  while (true) {
    const mode = paused ? yellow("paused") : green("live");
    const status = `${mode} · ${messages.length} message${messages.length === 1 ? "" : "s"} · ${newCount} new · refreshed ${lastUpdated}`;
    drawMessageFeed(
      tui,
      `${label} · watch`,
      "Live inbox polling",
      messages,
      selected,
      "↑↓ move · ↵ details · space pause · r refresh · esc back · q quit",
      { status, error, emptyMessage: "Waiting for messages…" },
    );

    const waitMs = paused ? undefined : Math.max(0, nextPollAt - Date.now());
    const key = await readKeyWithTimeout(tui, waitMs);

    if (key === null) {
      await refresh();
      nextPollAt = Date.now() + 2000;
      continue;
    }
    if (key === "\x03" || key === "q") return false;
    if (key === "\x1b" || key === "\x1b[D" || key === "b") return true;
    if (key === " ") {
      paused = !paused;
      if (!paused) nextPollAt = Date.now() + 2000;
      continue;
    }
    if (key === "r") {
      await refresh();
      nextPollAt = Date.now() + 2000;
      continue;
    }
    if (key === "\x1b[A" || key === "k") {
      selected = Math.max(0, selected - 1);
      continue;
    }
    if (key === "\x1b[B" || key === "j") {
      selected = Math.min(Math.max(messages.length - 1, 0), selected + 1);
      continue;
    }
    if ((key === "\r" || key === "\n") && messages.length > 0) {
      const cont = await openSelectedMessage(tui, client, messages, selected);
      if (!cont) return false;
    }
  }
}

async function createInboxScreen(tui: TUI, client: PostMX): Promise<boolean> {
  clear(tui);
  const w = tui.stdout.write.bind(tui.stdout);

  // Simple inline prompts using raw mode
  w(`${bold("Create inbox")}\n\n`);

  const label = await prompt(tui, "  Label: ");
  if (label === null) return true; // cancelled

  const modes = ["temporary", "persistent"];
  w("\n");
  const modeIdx = await pick(tui, "Lifecycle", modes, "↑↓ · ↵ select · esc cancel");
  if (modeIdx === -2) return false;
  if (modeIdx === -1) return true;
  const mode = modes[modeIdx] as "temporary" | "persistent";

  let ttl: number | undefined;
  if (mode === "temporary") {
    clear(tui);
    w(`${bold("Create inbox")}  ${dim(label)} · ${dim(mode)}\n\n`);
    const ttlStr = await prompt(tui, "  TTL (minutes, empty=default): ");
    if (ttlStr === null) return true;
    if (ttlStr) ttl = parseInt(ttlStr, 10);
  }

  clear(tui);
  w(dim("  Creating inbox..."));

  try {
    const inbox = await client.createInbox({ label, lifecycle_mode: mode, ttl_minutes: ttl });
    const lines = [
      `${bold("Inbox created")}  ${dim("esc back · q quit")}`,
      "",
      `  ${bold("ID")}       ${inbox.id}`,
      `  ${bold("Email")}    ${cyan(inbox.email_address)}`,
      `  ${bold("Mode")}     ${yellow(inbox.lifecycle_mode)}`,
    ];
    if (inbox.ttl_minutes) lines.push(`  ${bold("TTL")}      ${inbox.ttl_minutes}m`);
    if (inbox.expires_at) lines.push(`  ${bold("Expires")}  ${inbox.expires_at}`);
    return await showDetail(tui, lines);
  } catch (err) {
    clear(tui);
    w(`${S.red}Error:${S.r} ${err instanceof Error ? err.message : String(err)}\n\n  ${dim("Press any key")}\n`);
    await readKey(tui);
    return true;
  }
}

async function webhooksScreen(tui: TUI, client: PostMX): Promise<boolean> {
  clear(tui);
  tui.stdout.write(dim("  Webhooks not yet browsable — coming soon.\n\n  Press any key to go back."));
  await readKey(tui);
  return true;
}

/** Tiny inline text prompt. Returns null if user pressed Esc. */
async function prompt(tui: TUI, label: string): Promise<string | null> {
  tui.stdout.write(S.show); // show cursor for typing
  tui.stdout.write(label);

  let buf = "";

  while (true) {
    const key = await readKey(tui);
    if (key === "\x03") { tui.stdout.write(S.hide); return null; } // Ctrl+C
    if (key === "\x1b") { tui.stdout.write(S.hide); return null; } // Esc
    if (key === "\r" || key === "\n") { tui.stdout.write("\n" + S.hide); return buf; }
    if (key === "\x7f" || key === "\b") { // Backspace
      if (buf.length > 0) {
        buf = buf.slice(0, -1);
        tui.stdout.write("\b \b");
      }
      continue;
    }
    // Only accept printable chars
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      buf += key;
      tui.stdout.write(key);
    }
  }
}

// ── Router ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (flags["help"] === true || flags["h"] === true) {
    console.log(HELP);
    process.exit(0);
  }

  // Interactive mode: postmx -i or postmx --interactive
  if (flags["interactive"] === true) {
    const client = getClient(flags);
    await interactiveMode(client);
    return;
  }

  // No args → interactive if TTY, help otherwise
  if (positional.length === 0) {
    if (process.stdout.isTTY && process.stdin.isTTY) {
      const client = getClient(flags);
      await interactiveMode(client);
    } else {
      console.log(HELP);
    }
    return;
  }

  const [group, command, ...rest] = positional;

  try {
    switch (group) {
      case "inbox":
        switch (command) {
          case "create":
            return await inboxCreate(flags);
          case "list-msg":
            return await inboxListMessages(rest, flags);
          case "wait":
            return await inboxWait(rest, flags);
          default:
            die(`Unknown inbox command: ${command}. Run 'postmx --help' for usage.`);
        }
        break;
      case "auth":
        switch (command) {
          case "login":
            return await authLogin(flags);
          case "logout":
            return await authLogout(flags);
          default:
            die(`Unknown auth command: ${command}. Run 'postmx --help' for usage.`);
        }
        break;
      case "messages":
        switch (command) {
          case "list":
            return await messagesList(flags);
          default:
            die(`Unknown messages command: ${command}. Run 'postmx --help' for usage.`);
        }
        break;
      case "message":
        switch (command) {
          case "get":
            return await messageGet(rest, flags);
          default:
            die(`Unknown message command: ${command}. Run 'postmx --help' for usage.`);
        }
        break;
      case "webhook":
        switch (command) {
          case "create":
            return await webhookCreate(flags);
          default:
            die(`Unknown webhook command: ${command}. Run 'postmx --help' for usage.`);
        }
        break;
      default:
        die(`Unknown command: ${group}. Run 'postmx --help' for usage.`);
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      die(err.message);
    }
    die(String(err));
  }
}

main();

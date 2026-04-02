import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PostMX, PostMXApiError, PostMXNetworkError, type Inbox } from "postmx";

const DEFAULT_BASE_URL = "https://api.postmx.co";
const DEFAULT_CLI_VERSION = "0.1.8";
const CLI_CLIENT_NAME = "cli";
const CLI_CALLBACK_HOST = "127.0.0.1";
const CLI_CALLBACK_PATH = "/auth/cli/complete";
const CLI_CALLBACK_TIMEOUT_MS = 90_000;
const CLI_CALLBACK_LISTEN_RETRIES = 3;
const CLI_AUTH_TIMEOUT_MS = 20_000;
const CLI_AUTH_DEFAULT_LABEL = "PostMX CLI";
const CLI_AUTH_NEXT_DASHBOARD_PATH = "/auth/cli/complete";
const CLI_KEYCHAIN_SERVICE = "co.postmx.cli";
const CLI_KEYCHAIN_ACCOUNT = "default";
const DEFAULT_TEMPORARY_INBOX_TTL_MINUTES = 30;
const CREATE_INBOX_RETRY_TIMEOUT_MS = 90_000;
const CREATE_INBOX_ATTEMPT_TIMEOUT_MS = 20_000;
const CREATE_INBOX_RETRY_DELAY_MS = 2_000;
const WATCH_POLL_INTERVAL_MS = 2_000;
const CLI_TITLE = "postmx beta";

function resolveCliVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version.trim().length > 0
      ? packageJson.version.trim()
      : DEFAULT_CLI_VERSION;
  } catch {
    return DEFAULT_CLI_VERSION;
  }
}

const CLI_VERSION = resolveCliVersion();

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

async function withSpinner<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) {
    return await task();
  }

  const frames = ["·  ", "•• ", "•••", " ••", "  •"];
  let frame = 0;
  processStdout.write(`${label} ${dim(frames[frame] ?? "")}`);

  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    processStdout.write(`\r${S.el}${label} ${dim(frames[frame] ?? "")}`);
  }, 160);

  try {
    const result = await task();
    processStdout.write(`\r${S.el}${label}\n`);
    return result;
  } catch (error) {
    processStdout.write(`\r${S.el}`);
    throw error;
  } finally {
    clearInterval(timer);
  }
}

type SecretPromptOptions = {
  helpText?: string;
  maxLength?: number;
  submitOnMaxLength?: boolean;
  validateChar?: (char: string, nextValue: string) => boolean;
  renderValue?: (value: string) => string;
};

type MessageFeedResult = {
  messages: Array<Record<string, unknown>>;
  pageInfo: { has_more: boolean; next_cursor: string | null };
};

type CliCredentialStore = "macos-keychain" | "linux-secret-service" | "config-file";

type CliConfig = {
  apiKey?: string;
  credentialStore?: CliCredentialStore;
  accountId?: string;
  accountSlug?: string;
  email?: string;
  keyExpiresAt?: string;
  dashboardUrl?: string;
  dashboardBillingUrl?: string;
};

type SavedAuthMetadata = {
  accountId?: string;
  accountSlug?: string;
  email?: string;
  keyExpiresAt?: string;
  dashboardUrl?: string;
  dashboardBillingUrl?: string;
};

type SavedCredentialLocation = {
  store: CliCredentialStore;
  location: string;
};

type CliAuthStartResponse = {
  auth_request_id?: string;
  challenge_id?: string;
  expires_at?: string;
  masked_email?: string;
  email?: string;
  delivery_methods?: unknown;
  [key: string]: unknown;
};

type CliAuthSuccessPayload = {
  api_key?: string;
  account_id?: string;
  account_slug?: string;
  email?: string;
  api_key_expires_at?: string;
  key_expires_at?: string;
  dashboard_url?: string;
  dashboard_billing_url?: string;
  account?: unknown;
  [key: string]: unknown;
};

type CliAuthNextAction = {
  type?: string;
  url?: string;
  [key: string]: unknown;
};

type CliAuthFlowResult = SavedAuthMetadata & {
  apiKey: string;
};

type CliCallbackPayload = {
  code: string;
  authRequestId: string;
  state?: string;
};

type CliCallbackListener = {
  callbackUrl: string;
  setExpectedAuthRequestId: (authRequestId: string) => void;
  waitForCallback: (timeoutMs: number) => Promise<CliCallbackPayload | null>;
  close: () => Promise<void>;
};

class CliApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId?: string;
  public readonly retryAfterSeconds?: number;
  public readonly nextAction?: CliAuthNextAction;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    retryAfterSeconds?: number;
    nextAction?: CliAuthNextAction;
  }) {
    super(params.message);
    this.name = "CliApiError";
    this.status = params.status;
    this.code = params.code;
    this.requestId = params.requestId;
    this.retryAfterSeconds = params.retryAfterSeconds;
    this.nextAction = params.nextAction;
  }
}

class LoginRestartRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginRestartRequiredError";
  }
};

function normalizeBaseUrl(baseUrl?: string | null, fallback = DEFAULT_BASE_URL): string {
  const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
  const candidate = trimmed.length > 0 ? trimmed : fallback;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    die(`Invalid PostMX base URL: ${JSON.stringify(baseUrl)}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    die(`Invalid PostMX base URL protocol: ${JSON.stringify(baseUrl)}`);
  }

  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const HELP = `
postmx beta — CLI for the PostMX email testing API

Usage:
  postmx <command> [options]
  postmx login              Sign in with email
  postmx -i                  Launch interactive mode

Commands:
  login           Sign in or create an account with email
  auth login      Sign in or save an API key locally
  auth logout     Remove the locally saved API key
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
  --email <email>          Email address to use for login
  --no-browser             Disable localhost callback and browser auto-complete
  --scopes <csv>           Comma-separated scopes for login
  --label <text>           Label for the API key created during login
  --expires-at <iso8601>   Optional API key expiry for login
  --json                   Force JSON output (default when piped)
  -i, --interactive        Launch interactive TUI
  --help, -h               Show this help

Examples:
  postmx login
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requestIdSuffix(requestId?: string): string {
  return requestId ? ` (request_id: ${requestId})` : "";
}

function isDebugEnabled(flags: Record<string, string | true>): boolean {
  return flags["debug"] === true || process.env.POSTMX_DEBUG === "1";
}

function isInteractivePromptAvailable(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function cliAuthHeaders(): Record<string, string> {
  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": `postmx-cli/${CLI_VERSION}`,
    "X-PostMX-Client": CLI_CLIENT_NAME,
    "X-PostMX-Client-Version": CLI_VERSION,
  };
}

function parseScopesFlag(scopes: string | true | undefined): string[] | undefined {
  if (typeof scopes !== "string") return undefined;
  const values = scopes
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length > 0 ? values : undefined;
}

function validateEmail(value: string): string {
  const email = value.trim();
  if (!email.includes("@") || email.startsWith("@") || email.endsWith("@")) {
    die("Please enter a valid email address.");
  }
  return email;
}

function validateIso8601(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    die(`Invalid --expires-at value: ${JSON.stringify(value)}`);
  }
  return parsed.toISOString();
}

function validateTemporaryInboxTtl(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_TEMPORARY_INBOX_TTL_MINUTES;
  }

  const ttl = Number.parseInt(value, 10);
  if (!Number.isInteger(ttl) || ttl < 10 || ttl > 60) {
    throw new Error("Temporary inbox TTL must be an integer between 10 and 60 minutes.");
  }
  return ttl;
}

function parseTemporaryInboxTtl(value: string | undefined): number | undefined {
  try {
    return validateTemporaryInboxTtl(value);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
}

function parseLifecycleMode(
  value: string | undefined,
  fallback: "temporary" | "persistent" = "temporary",
): "temporary" | "persistent" {
  const normalized = value?.trim() || fallback;
  if (normalized === "temporary" || normalized === "persistent") {
    return normalized;
  }
  die("Lifecycle mode must be either `temporary` or `persistent`.");
}

function finalizeCommandInput(): void {
  try {
    processStdin.setRawMode?.(false);
  } catch {
    // Ignore TTY reset failures during shutdown.
  }
  try {
    processStdin.pause();
  } catch {
    // Ignore pause failures during shutdown.
  }
}

function randomState(): string {
  return randomBytes(24).toString("base64url");
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

function buildSavedConfig(
  metadata: SavedAuthMetadata,
  store: CliCredentialStore,
  apiKey?: string,
): CliConfig {
  return {
    ...(apiKey ? { apiKey } : {}),
    credentialStore: store,
    accountId: metadata.accountId,
    accountSlug: metadata.accountSlug,
    email: metadata.email,
    keyExpiresAt: metadata.keyExpiresAt,
    dashboardUrl: metadata.dashboardUrl,
    dashboardBillingUrl: metadata.dashboardBillingUrl,
  };
}

function tryMacosKeychainRead(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const output = execFileSync(
      "security",
      ["find-generic-password", "-a", CLI_KEYCHAIN_ACCOUNT, "-s", CLI_KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

function tryMacosKeychainWrite(apiKey: string): SavedCredentialLocation | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    execFileSync(
      "security",
      ["add-generic-password", "-U", "-a", CLI_KEYCHAIN_ACCOUNT, "-s", CLI_KEYCHAIN_SERVICE, "-w", apiKey],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    return { store: "macos-keychain", location: "macOS Keychain" };
  } catch {
    return undefined;
  }
}

function tryMacosKeychainDelete(): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-a", CLI_KEYCHAIN_ACCOUNT, "-s", CLI_KEYCHAIN_SERVICE],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch {
    // Ignore missing-key errors during logout.
  }
}

function tryLinuxSecretStoreRead(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const output = execFileSync(
      "secret-tool",
      ["lookup", "service", CLI_KEYCHAIN_SERVICE, "account", CLI_KEYCHAIN_ACCOUNT],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

function tryLinuxSecretStoreWrite(apiKey: string): SavedCredentialLocation | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    execFileSync(
      "secret-tool",
      ["store", "--label=PostMX CLI API key", "service", CLI_KEYCHAIN_SERVICE, "account", CLI_KEYCHAIN_ACCOUNT],
      { input: apiKey, encoding: "utf8", stdio: ["pipe", "ignore", "pipe"] },
    );
    return { store: "linux-secret-service", location: "Secret Service keyring" };
  } catch {
    return undefined;
  }
}

function tryLinuxSecretStoreDelete(): void {
  if (process.platform !== "linux") return;
  try {
    execFileSync(
      "secret-tool",
      ["clear", "service", CLI_KEYCHAIN_SERVICE, "account", CLI_KEYCHAIN_ACCOUNT],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch {
    // Ignore missing-key errors during logout.
  }
}

function readStoredApiKeyFromSecureStore(): string | undefined {
  return tryMacosKeychainRead() ?? tryLinuxSecretStoreRead();
}

function saveApiKey(
  apiKey: string,
  metadata: SavedAuthMetadata = {},
): SavedCredentialLocation {
  const keychainLocation = tryMacosKeychainWrite(apiKey) ?? tryLinuxSecretStoreWrite(apiKey);
  if (keychainLocation) {
    writeCliConfig(buildSavedConfig(metadata, keychainLocation.store));
    return keychainLocation;
  }

  const configPath = getConfigPath();
  writeCliConfig(buildSavedConfig(metadata, "config-file", apiKey));
  return { store: "config-file", location: configPath };
}

function clearSavedApiKey(): void {
  tryMacosKeychainDelete();
  tryLinuxSecretStoreDelete();
  clearCliConfig();
}

function resolveApiKey(flags: Record<string, string | true>): string | undefined {
  const flagKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
  if (flagKey) return flagKey;
  if (process.env.POSTMX_API_KEY) return process.env.POSTMX_API_KEY;
  const secureStoreKey = readStoredApiKeyFromSecureStore();
  if (secureStoreKey) return secureStoreKey;
  const storedKey = readCliConfig().apiKey;
  return typeof storedKey === "string" && storedKey.length > 0 ? storedKey : undefined;
}

function resolveBaseUrl(flags: Record<string, string | true>): string | undefined {
  const explicit = typeof flags["base-url"] === "string" ? flags["base-url"] : process.env.POSTMX_BASE_URL;
  if (explicit === undefined || explicit.trim() === "") return undefined;
  return normalizeBaseUrl(explicit, DEFAULT_BASE_URL);
}

function getClient(flags: Record<string, string | true>): PostMX {
  const apiKey = resolveApiKey(flags);

  if (!apiKey) {
    die("Missing API key. Pass --api-key, set POSTMX_API_KEY, or run `postmx login`.");
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
    ? normalizeBaseUrl(reflectiveClient["baseUrl"], DEFAULT_BASE_URL)
    : normalizeBaseUrl(process.env.POSTMX_BASE_URL, DEFAULT_BASE_URL);
  if (!apiKey) {
    throw new Error("Missing API key. Pass --api-key, set POSTMX_API_KEY, or run `postmx login`.");
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
      "User-Agent": `postmx-cli/${CLI_VERSION}`,
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

async function promptLine(query: string): Promise<string> {
  const rl = createInterface({ input: processStdin, output: processStdout });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
}

function isRawInteractivePromptAvailable(): boolean {
  return isInteractivePromptAvailable() && typeof process.stdin.setRawMode === "function";
}

function renderOtpSlots(value: string, length: number): string {
  return Array.from({ length }, (_, index) => (
    index < value.length ? cyan("●") : dim("○")
  )).join(" ");
}

async function promptSecret(query: string, options?: SecretPromptOptions): Promise<string> {
  if (!isInteractivePromptAvailable() || typeof process.stdin.setRawMode !== "function") {
    die("Secure code entry requires an interactive terminal.");
  }

  const renderValue = options?.renderValue ?? ((value: string) => "•".repeat(value.length));
  const redraw = (value: string) => {
    processStdout.write(`\r${S.el}  ${renderValue(value)}`);
  };

  if (options) {
    processStdout.write(`${bold(query)}\n`);
    if (options.helpText) {
      processStdout.write(`  ${dim(options.helpText)}\n`);
    }
    redraw("");
  } else {
    processStdout.write(query);
  }
  processStdin.resume();
  processStdin.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const previousRawMode = processStdin.isRaw;

    const cleanup = (writeNewline = true) => {
      processStdin.removeListener("data", onData);
      processStdin.setRawMode?.(Boolean(previousRawMode));
      processStdin.pause();
      if (writeNewline) processStdout.write("\n");
    };

    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (char === "\x03") {
          cleanup(false);
          reject(new Error("Login cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (char === "\x7f" || char === "\b") {
          value = value.slice(0, -1);
          if (options) redraw(value);
          continue;
        }
        if (char === "\x1b") {
          cleanup(false);
          reject(new Error("Login cancelled."));
          return;
        }
        if (char.length === 1 && char.charCodeAt(0) >= 32) {
          const nextValue = value + char;
          if (options?.validateChar && !options.validateChar(char, nextValue)) {
            continue;
          }
          if (typeof options?.maxLength === "number" && nextValue.length > options.maxLength) {
            continue;
          }
          value = nextValue;
          if (options) redraw(value);
          if (options?.submitOnMaxLength === true && typeof options.maxLength === "number" && value.length >= options.maxLength) {
            cleanup();
            resolve(value.trim());
            return;
          }
        }
      }
    };

    processStdin.setRawMode?.(true);
    processStdin.on("data", onData);
  });
}

async function promptForEmail(flags: Record<string, string | true>): Promise<string> {
  if (typeof flags["email"] === "string") {
    return validateEmail(flags["email"]);
  }
  if (!isInteractivePromptAvailable()) {
    die("--email is required when stdin/stdout is not interactive.");
  }
  return validateEmail(await promptLine("Email: "));
}

async function promptForChoice(
  title: string,
  options: string[],
): Promise<number> {
  if (!isInteractivePromptAvailable()) {
    return 0;
  }

  console.log(title);
  for (let index = 0; index < options.length; index++) {
    console.log(`  ${index + 1}. ${options[index]}`);
  }

  while (true) {
    const answer = (await promptLine(`Choose 1-${options.length}: `)).trim().toLowerCase();
    const numeric = Number.parseInt(answer, 10);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
      return numeric - 1;
    }
    if (answer === "otp" || answer === "code") return 0;
    if (answer === "browser" || answer === "magic-link" || answer === "magic") {
      return Math.min(1, options.length - 1);
    }
    console.log(`Please enter a number between 1 and ${options.length}.`);
  }
}

function drawLoginMethodPicker(
  tui: TUI,
  maskedEmail: string,
  deliveryMethods: string[],
  options: Array<{ label: string; description: string }>,
  current: number,
): void {
  clear(tui);
  const write = tui.stdout.write.bind(tui.stdout);

  write(`\n  ${bold("Sign in to PostMX")}\n`);
  write(`  ${dim("We sent a sign-in email with both an OTP and a magic link.")}\n\n`);
  write(`  ${bold("Email")}     ${maskedEmail}\n`);
  if (deliveryMethods.length > 0) {
    write(`  ${bold("Delivery")}  ${deliveryMethods.join(", ")}\n`);
  }
  write(`\n  ${dim("Choose how you want to finish signing in.")}\n`);
  write(`  ${dim("─".repeat(Math.min(tui.cols - 4, 64)))}\n\n`);

  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    const active = index === current;
    const badge = active ? cyan(`[${index + 1}]`) : dim(`[${index + 1}]`);
    const marker = active ? `${cyan("▸")} ` : "  ";
    write(`  ${marker}${badge} ${active ? bold(option.label) : option.label}\n`);
    write(`      ${active ? option.description : dim(option.description)}\n\n`);
  }

  write(`  ${dim("↑↓ switch · 1-2 choose · ↵ continue · esc cancel")}\n`);
}

async function promptForLoginMethod(
  maskedEmail: string,
  deliveryMethods: string[],
  callbackListenerAvailable: boolean,
): Promise<number> {
  const options = callbackListenerAvailable
    ? [
        {
          label: "Enter OTP now",
          description: "Stay in the terminal and paste the 6-digit code from the email.",
        },
        {
          label: "Open magic link in browser",
          description: "Finish in the browser and let the CLI complete automatically when possible.",
        },
      ]
    : [
        {
          label: "Enter OTP now",
          description: "Stay in the terminal and paste the 6-digit code from the email.",
        },
        {
          label: "Use magic link and paste the one-time CLI code",
          description: "Open the email link in a browser, then paste the code shown in the dashboard.",
        },
      ];

  if (!isRawInteractivePromptAvailable()) {
    return await promptForChoice(
      callbackListenerAvailable ? "Choose a sign-in method:" : "How would you like to finish signing in?",
      options.map((option) => option.label),
    );
  }

  const tui = setupTUI();
  let current = 0;

  try {
    drawLoginMethodPicker(tui, maskedEmail, deliveryMethods, options, current);

    while (true) {
      const key = await readKey(tui);
      if (key === "\x03" || key === "q" || key === "\x1b") {
        throw new Error("Login cancelled.");
      }
      if (key === "\x1b[A" || key === "k") {
        current = Math.max(0, current - 1);
      } else if (key === "\x1b[B" || key === "j") {
        current = Math.min(options.length - 1, current + 1);
      } else if (key === "\r" || key === "\n") {
        return current;
      } else if (key === "1") {
        return 0;
      } else if (key === "2") {
        return Math.min(1, options.length - 1);
      }
      drawLoginMethodPicker(tui, maskedEmail, deliveryMethods, options, current);
    }
  } finally {
    clear(tui);
    teardownTUI(tui);
  }
}

function describeDeliveryMethods(deliveryMethods: unknown): string[] {
  if (!Array.isArray(deliveryMethods)) return [];
  return deliveryMethods.flatMap((method) => {
    if (typeof method === "string") return [method];
    if (isRecord(method)) {
      return [asNonEmptyString(method.type) ?? asNonEmptyString(method.name)].filter((value): value is string => Boolean(value));
    }
    return [];
  });
}

async function postCliAuthJson<T>(
  flags: Record<string, string | true>,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const baseUrl = resolveBaseUrl(flags) ?? DEFAULT_BASE_URL;
  const url = new URL(path, baseUrl);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: cliAuthHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CLI_AUTH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Network error while contacting PostMX: ${error instanceof Error ? error.message : String(error)}`);
  }

  const json = await response.json().catch(() => null) as Record<string, unknown> | null;

  if (!response.ok) {
    const errorBody = isRecord(json?.error) ? json.error : {};
    throw new CliApiError({
      status: response.status,
      code: asNonEmptyString(errorBody.code) ?? `http_${response.status}`,
      message: asNonEmptyString(errorBody.message) ?? response.statusText,
      requestId: asNonEmptyString(json?.request_id) ?? response.headers.get("x-request-id") ?? undefined,
      retryAfterSeconds: typeof errorBody.retry_after_seconds === "number"
        ? errorBody.retry_after_seconds
        : undefined,
      nextAction: isRecord(json?.next_action) ? json?.next_action as CliAuthNextAction : undefined,
    });
  }

  return (json ?? {}) as T;
}

function formatCliApiError(error: CliApiError): string {
  switch (error.code) {
    case "invalid_client":
    case "unsupported_client_version":
      return `This version of postmx-cli is not supported. Please upgrade and try again${requestIdSuffix(error.requestId)}.`;
    case "challenge_expired":
    case "too_many_attempts":
      return `This sign-in attempt expired or hit the retry limit. Start a new login with \`postmx login\`${requestIdSuffix(error.requestId)}.`;
    case "invalid_exchange_code":
      return `That one-time browser code is no longer valid. Retry the magic-link flow or restart login${requestIdSuffix(error.requestId)}.`;
    case "rate_limited":
      return `PostMX rate limited this login attempt. Try again${error.retryAfterSeconds ? ` in ${error.retryAfterSeconds}s` : " shortly"}${requestIdSuffix(error.requestId)}.`;
    default:
      return `${error.message}${requestIdSuffix(error.requestId)}`;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "::1"
    || address === "127.0.0.1"
    || address === "::ffff:127.0.0.1";
}

async function createCallbackListener(expectedState: string): Promise<CliCallbackListener> {
  let expectedAuthRequestId: string | undefined;
  let server: Server | undefined;
  let resolved = false;
  let closed = false;
  const sockets = new Set<import("node:net").Socket>();
  let resolveCallback: ((payload: CliCallbackPayload) => void) | undefined;
  const callbackPromise = new Promise<CliCallbackPayload>((resolve) => {
    resolveCallback = resolve;
  });

  const closeServer = async (): Promise<void> => {
    if (!server || closed) return;
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    for (const socket of sockets) {
      socket.destroy();
    }
    if (!server.listening) {
      closed = true;
      return;
    }
    await new Promise<void>((resolve) => server?.close(() => {
      closed = true;
      resolve();
    }));
  };

  server = createServer((request, response) => {
    if (!isLoopbackAddress(request.socket.remoteAddress ?? undefined)) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
      response.end("Loopback requests only.");
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${CLI_CALLBACK_HOST}:0`}`);
    if (url.pathname !== CLI_CALLBACK_PATH) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
      response.end("Not found.");
      return;
    }

    const code = asNonEmptyString(url.searchParams.get("code"));
    const authRequestId = asNonEmptyString(url.searchParams.get("auth_request_id"));
    const state = asNonEmptyString(url.searchParams.get("callback_state"))
      ?? asNonEmptyString(url.searchParams.get("state"));

    if (!code || !authRequestId) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
      response.end("Missing code or auth_request_id.");
      return;
    }
    if (state !== expectedState) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
      response.end("Invalid callback state.");
      return;
    }
    if (expectedAuthRequestId && authRequestId !== expectedAuthRequestId) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
      response.end("Unexpected auth request.");
      return;
    }
    if (resolved) {
      response.writeHead(409, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
      response.end("Callback already received.");
      return;
    }

    resolved = true;
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
    response.end("PostMX CLI sign-in complete. You can return to your terminal.");
    resolveCallback?.({ code, authRequestId, state });
    void closeServer();
  });
  server.keepAliveTimeout = 1;
  server.headersTimeout = 5_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  for (let attempt = 0; attempt < CLI_CALLBACK_LISTEN_RETRIES; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server?.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server?.removeListener("error", onError);
          resolve();
        };

        server?.once("error", onError);
        server?.once("listening", onListening);
        server?.listen(0, CLI_CALLBACK_HOST);
      });
      break;
    } catch (error) {
      const code = isRecord(error) ? asNonEmptyString(error.code) : undefined;
      if (code !== "EADDRINUSE" || attempt === CLI_CALLBACK_LISTEN_RETRIES - 1) {
        throw error;
      }
    }
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer();
    throw new Error("Could not determine localhost callback port.");
  }

  return {
    callbackUrl: `http://${CLI_CALLBACK_HOST}:${address.port}${CLI_CALLBACK_PATH}`,
    setExpectedAuthRequestId(authRequestId: string) {
      expectedAuthRequestId = authRequestId;
    },
    async waitForCallback(timeoutMs: number): Promise<CliCallbackPayload | null> {
      return await new Promise<CliCallbackPayload | null>((resolve) => {
        const timer = setTimeout(() => {
          resolve(null);
        }, timeoutMs);

        callbackPromise.then((payload) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });
    },
    async close(): Promise<void> {
      await closeServer();
    },
  };
}

function normalizeAuthSuccess(
  payload: CliAuthSuccessPayload,
  fallbackEmail?: string,
): CliAuthFlowResult {
  const account = isRecord(payload.account) ? payload.account : undefined;
  const apiKey = asNonEmptyString(payload.api_key);
  if (!apiKey) {
    throw new Error("Login succeeded but PostMX did not return an API key.");
  }

  return {
    apiKey,
    accountId: asNonEmptyString(payload.account_id) ?? asNonEmptyString(account?.id),
    accountSlug: asNonEmptyString(payload.account_slug) ?? asNonEmptyString(account?.slug),
    email: asNonEmptyString(payload.email) ?? asNonEmptyString(account?.email) ?? fallbackEmail,
    keyExpiresAt: asNonEmptyString(payload.api_key_expires_at) ?? asNonEmptyString(payload.key_expires_at),
    dashboardUrl: asNonEmptyString(payload.dashboard_url),
    dashboardBillingUrl: asNonEmptyString(payload.dashboard_billing_url),
  };
}

async function verifyOtpLogin(
  flags: Record<string, string | true>,
  authRequestId: string,
  challengeId: string,
  email: string,
): Promise<CliAuthFlowResult> {
  const code = await promptSecret("6-digit OTP", {
    helpText: "Type digits or paste the code. The CLI will submit as soon as all 6 digits are entered.",
    maxLength: 6,
    submitOnMaxLength: true,
    validateChar: (char) => /\d/.test(char),
    renderValue: (value) => renderOtpSlots(value, 6),
  });
  if (!/^\d{6}$/.test(code)) {
    die("OTP codes must be exactly 6 digits.");
  }

  try {
    const payload = await postCliAuthJson<CliAuthSuccessPayload>(flags, "/v1/auth/cli/email/verify", {
      auth_request_id: authRequestId,
      challenge_id: challengeId,
      code,
    });
    return normalizeAuthSuccess(payload, email);
  } catch (error) {
    if (error instanceof CliApiError && (error.code === "challenge_expired" || error.code === "too_many_attempts")) {
      throw new LoginRestartRequiredError(formatCliApiError(error));
    }
    throw error;
  }
}

async function exchangeCliCode(
  flags: Record<string, string | true>,
  authRequestId: string,
  exchangeCode: string,
  email: string,
): Promise<CliAuthFlowResult> {
  try {
    const payload = await postCliAuthJson<CliAuthSuccessPayload>(flags, "/v1/auth/cli/exchange", {
      auth_request_id: authRequestId,
      code: exchangeCode,
    });
    return normalizeAuthSuccess(payload, email);
  } catch (error) {
    if (error instanceof CliApiError && (error.code === "challenge_expired" || error.code === "too_many_attempts")) {
      throw new LoginRestartRequiredError(formatCliApiError(error));
    }
    throw error;
  }
}

async function promptForManualExchangeCode(
  flags: Record<string, string | true>,
  authRequestId: string,
  email: string,
): Promise<CliAuthFlowResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cliCode = await promptSecret("One-time CLI code", {
      helpText: "Paste the code shown in the dashboard, then press Enter.",
      renderValue: (value) => value.length > 0
        ? `${cyan("●".repeat(Math.min(value.length, 24)))}${value.length > 24 ? dim(` +${value.length - 24}`) : ""}`
        : dim("Paste code here"),
    });
    if (cliCode.length === 0) {
      console.log("Please paste the one-time code shown in the dashboard.");
      continue;
    }

    try {
      return await exchangeCliCode(flags, authRequestId, cliCode, email);
    } catch (error) {
      if (error instanceof CliApiError && error.code === "invalid_exchange_code" && attempt === 0) {
        console.log(formatCliApiError(error));
        console.log("Open the magic link from your email again, then paste the new one-time code from the dashboard.");
        continue;
      }
      throw error;
    }
  }

  throw new Error("Could not complete browser sign-in.");
}

async function completeBrowserLogin(
  flags: Record<string, string | true>,
  authRequestId: string,
  callbackListener: CliCallbackListener | undefined,
  email: string,
): Promise<CliAuthFlowResult> {
  if (callbackListener) {
    console.log("Finish sign-in in your browser.");
    if (isDebugEnabled(flags)) {
      console.log(dim(`Debug: waiting for localhost callback on ${callbackListener.callbackUrl}`));
    }
    const callback = await withSpinner("Waiting for browser confirmation", async () => (
      await callbackListener.waitForCallback(CLI_CALLBACK_TIMEOUT_MS)
    ));
    if (callback) {
      if (callback.authRequestId !== authRequestId) {
        throw new Error("Received a callback for a different login attempt.");
      }
      try {
        return await withSpinner("Completing sign-in", async () => (
          await exchangeCliCode(flags, authRequestId, callback.code, email)
        ));
      } catch (error) {
        if (!(error instanceof CliApiError && error.code === "invalid_exchange_code")) {
          throw error;
        }
        console.log(formatCliApiError(error));
      }
    } else {
      console.log("Browser sign-in did not reach the CLI. Paste the one-time code from the dashboard.");
    }
  } else {
    console.log("Finish sign-in in your browser, then paste the one-time code from the dashboard.");
  }

  return await promptForManualExchangeCode(flags, authRequestId, email);
}

function printLoginStartMessage(
  maskedEmail: string,
  deliveryMethods: string[],
): void {
  console.log("");
  console.log(bold("Sign-in email sent"));
  console.log("We sent a sign-in email with both an OTP and a magic link.");
  console.log(`Email: ${maskedEmail}`);
  if (deliveryMethods.length > 0) {
    console.log(`Delivery methods: ${deliveryMethods.join(", ")}`);
  }
  console.log("");
}

function printLoginSuccess(
  result: CliAuthFlowResult,
  savedLocation: SavedCredentialLocation,
  flags: Record<string, string | true>,
): void {
  if (flags["json"] === true || !process.stdout.isTTY) {
    console.log(JSON.stringify({
      success: true,
      email: result.email,
      account_id: result.accountId,
      account_slug: result.accountSlug,
      key_expires_at: result.keyExpiresAt,
      credential_store: savedLocation.store,
      stored_at: savedLocation.location,
      config_path: getConfigPath(),
      dashboard_url: result.dashboardUrl,
      dashboard_billing_url: result.dashboardBillingUrl,
    }, null, 2));
    return;
  }

  console.log("Signed in to PostMX.");
  if (result.email) console.log(`Email: ${result.email}`);
  if (result.accountSlug) console.log(`Account: ${result.accountSlug}`);
  console.log(`Stored API key in ${savedLocation.location}.`);
}

async function runEmailLogin(flags: Record<string, string | true>): Promise<void> {
  if (!isInteractivePromptAvailable()) {
    die("Interactive email login requires a TTY.");
  }

  const email = await promptForEmail(flags);
  const noBrowser = flags["no-browser"] === true;
  const scopes = parseScopesFlag(flags["scopes"]);
  const label = typeof flags["label"] === "string" ? flags["label"].trim() : CLI_AUTH_DEFAULT_LABEL;
  const expiresAt = typeof flags["expires-at"] === "string" ? validateIso8601(flags["expires-at"]) : undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const callbackState = randomState();
    let callbackListener: CliCallbackListener | undefined;

    if (!noBrowser) {
      try {
        callbackListener = await createCallbackListener(callbackState);
      } catch (error) {
        if (isDebugEnabled(flags)) {
          console.error(dim(`Debug: localhost callback unavailable (${error instanceof Error ? error.message : String(error)})`));
        }
      }
    }

    try {
      const startPayload = await withSpinner("Sending sign-in email", async () => (
        await postCliAuthJson<CliAuthStartResponse>(flags, "/v1/auth/cli/email/start", {
          email,
          ...(scopes ? { scopes } : {}),
          ...(label ? { label } : {}),
          ...(expiresAt ? { expires_at: expiresAt } : {}),
          ...(callbackListener ? {
            localhost_callback_url: callbackListener.callbackUrl,
            callback_state: callbackState,
          } : {}),
          next_dashboard_path: CLI_AUTH_NEXT_DASHBOARD_PATH,
        })
      ));

      const authRequestId = asNonEmptyString(startPayload.auth_request_id);
      const challengeId = asNonEmptyString(startPayload.challenge_id);
      if (!authRequestId || !challengeId) {
        throw new Error("PostMX did not return the required auth request details.");
      }

      callbackListener?.setExpectedAuthRequestId(authRequestId);

      const maskedEmail = asNonEmptyString(startPayload.masked_email) ?? asNonEmptyString(startPayload.email) ?? email;
      const deliveryMethods = describeDeliveryMethods(startPayload.delivery_methods);
      printLoginStartMessage(maskedEmail, deliveryMethods);

      const choice = await promptForLoginMethod(
        maskedEmail,
        deliveryMethods,
        !(noBrowser || !callbackListener),
      );

      const result = choice === 0
        ? await verifyOtpLogin(flags, authRequestId, challengeId, email)
        : await completeBrowserLogin(flags, authRequestId, callbackListener, email);

      const savedLocation = saveApiKey(result.apiKey, {
        accountId: result.accountId,
        accountSlug: result.accountSlug,
        email: result.email,
        keyExpiresAt: result.keyExpiresAt,
        dashboardUrl: result.dashboardUrl,
        dashboardBillingUrl: result.dashboardBillingUrl,
      });
      printLoginSuccess(result, savedLocation, flags);
      return;
    } catch (error) {
      if (error instanceof LoginRestartRequiredError && attempt === 0) {
        console.log(error.message);
        console.log("Starting a fresh login attempt…");
        continue;
      }
      throw error;
    } finally {
      await callbackListener?.close();
    }
  }

  throw new Error("Login could not be completed. Please try again.");
}

// ── Non-interactive commands ────────────────────────────────────────────────

async function authLogin(flags: Record<string, string | true>): Promise<void> {
  try {
    const apiKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
    if (apiKey) {
      try {
        const savedLocation = saveApiKey(apiKey, readCliConfig());
        if (flags["json"] === true || !process.stdout.isTTY) {
          console.log(JSON.stringify({
            success: true,
            credential_store: savedLocation.store,
            stored_at: savedLocation.location,
            config_path: getConfigPath(),
          }, null, 2));
        } else {
          console.log(`Saved API key in ${savedLocation.location}.`);
        }
        return;
      } catch (err) {
        die(`Could not save API key locally: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await runEmailLogin(flags);
  } finally {
    finalizeCommandInput();
  }
}

async function authLogout(flags: Record<string, string | true>): Promise<void> {
  try {
    try {
      clearSavedApiKey();
    } catch (err) {
      die(`Could not remove saved API key: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (flags["json"] === true || !process.stdout.isTTY) {
      console.log(JSON.stringify({ success: true, config_path: getConfigPath() }, null, 2));
    } else {
      console.log("Removed saved PostMX credentials.");
    }
  } finally {
    finalizeCommandInput();
  }
}

async function createInboxWithRetry(
  client: PostMX,
  params: { label: string; lifecycle_mode: "temporary" | "persistent"; ttl_minutes?: number },
): Promise<Inbox> {
  const reflectiveClient = client as unknown as Record<string, unknown>;
  const apiKey = typeof reflectiveClient["apiKey"] === "string" ? reflectiveClient["apiKey"] : undefined;
  const baseUrl = typeof reflectiveClient["baseUrl"] === "string" ? reflectiveClient["baseUrl"] : undefined;
  const provisioningClient = apiKey
    ? new PostMX(apiKey, { baseUrl, maxRetries: 0, timeout: CREATE_INBOX_ATTEMPT_TIMEOUT_MS })
    : client;
  const deadline = Date.now() + CREATE_INBOX_RETRY_TIMEOUT_MS;
  let lastError: Error | undefined;

  while (Date.now() < deadline) {
    try {
      return await provisioningClient.createInbox(params, { idempotencyKey: randomUUID() });
    } catch (error) {
      if (error instanceof PostMXNetworkError) {
        lastError = error;

        if (Date.now() + CREATE_INBOX_RETRY_DELAY_MS >= deadline) {
          break;
        }

        await sleep(CREATE_INBOX_RETRY_DELAY_MS);
        continue;
      }

      if (!(error instanceof PostMXApiError)) {
        throw error;
      }

      lastError = error;

      const isProvisioningRetry = error.code === "idempotency_conflict"
        || error.code === "transient_failure"
        || error.code === "rate_limited";

      if (!isProvisioningRetry) {
        throw error;
      }

      const retryDelay = error.retryAfterSeconds
        ? Math.max(CREATE_INBOX_RETRY_DELAY_MS, error.retryAfterSeconds * 1000)
        : CREATE_INBOX_RETRY_DELAY_MS;

      if (Date.now() + retryDelay >= deadline) {
        break;
      }

      await sleep(retryDelay);
    }
  }

  throw lastError ?? new Error("Inbox provisioning timed out.");
}

async function inboxCreate(flags: Record<string, string | true>): Promise<void> {
  const client = getClient(flags);
  const label = typeof flags["label"] === "string" ? flags["label"] : undefined;
  if (!label) die("--label is required");

  const lifecycle_mode = parseLifecycleMode(
    typeof flags["lifecycle"] === "string" ? flags["lifecycle"] : undefined,
  );
  const ttl = lifecycle_mode === "temporary"
    ? parseTemporaryInboxTtl(typeof flags["ttl"] === "string" ? flags["ttl"] : undefined)
    : undefined;

  const inbox = await createInboxWithRetry(client, { label, lifecycle_mode, ttl_minutes: ttl });
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

  const analysis = isRecord(msg.analysis) ? msg.analysis : undefined;
  if (analysis) {
    lines.push("");
    lines.push(`  ${bold("Analysis")}`);
    lines.push(`    ${bold("Status")}          ${yellow(String(analysis.status ?? "none"))}`);
    lines.push(`    ${bold("Eligible")}        ${analysis.eligible === true ? green("yes") : dim("no")}`);
    if (analysis.detected_otp) lines.push(`    ${bold("Detected OTP")}    ${green(String(analysis.detected_otp))}`);
    if (analysis.sender_name) lines.push(`    ${bold("Sender")}          ${analysis.sender_name}`);
    if (analysis.category) lines.push(`    ${bold("Category")}        ${analysis.category}`);
    if (analysis.extracted_id) lines.push(`    ${bold("Reference")}       ${analysis.extracted_id}`);
    if (analysis.amount_mentioned) lines.push(`    ${bold("Amount")}          ${analysis.amount_mentioned}`);
    if (typeof analysis.is_urgent === "boolean") {
      lines.push(`    ${bold("Urgent")}          ${analysis.is_urgent ? green("yes") : dim("no")}`);
    }
    if (typeof analysis.action_required === "boolean") {
      lines.push(`    ${bold("Action required")} ${analysis.action_required ? green("yes") : dim("no")}`);
    }
    if (analysis.summary) lines.push(`    ${bold("Summary")}         ${analysis.summary}`);
    if (analysis.requested_at) lines.push(`    ${bold("Requested")}       ${analysis.requested_at}`);
    if (analysis.completed_at) lines.push(`    ${bold("Completed")}       ${analysis.completed_at}`);
  }

  return lines;
}

/** Format an inbox detail into compact lines. */
function formatInboxDetail(inbox: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const messageAnalysis = isRecord(inbox.message_analysis) ? inbox.message_analysis : undefined;
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
  if (messageAnalysis) {
    lines.push("");
    lines.push(`  ${bold("Analysis")} ${yellow(String(messageAnalysis.mode ?? "disabled"))}`);
    const recipients = Array.isArray(messageAnalysis.recipients)
      ? messageAnalysis.recipients.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    if (recipients.length > 0) {
      lines.push(`  ${bold("Targets")}  ${recipients.join(", ")}`);
    }
  }
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
    initialLive?: boolean;
  },
): Promise<boolean> {
  let messages: Array<Record<string, unknown>> = [];
  let selected = 0;
  let error: string | null = null;
  let paused = false;
  let lastUpdated = "Not refreshed yet";
  let newCount = 0;
  let initialized = false;
  const knownIds = new Set<string>();
  let nextPollAt = 0;
  let isLive = options.initialLive === true;

  const refresh = async () => {
    const previousId = messages[selected] ? String(messages[selected].id) : undefined;
    try {
      const nextMessages = await options.load();
      if (isLive) {
        if (!initialized) {
          for (const message of nextMessages) knownIds.add(String(message.id));
          newCount = 0;
        } else {
          newCount = nextMessages.filter((message) => !knownIds.has(String(message.id))).length;
          for (const message of nextMessages) knownIds.add(String(message.id));
        }
      } else {
        newCount = 0;
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
  if (isLive) {
    nextPollAt = Date.now() + WATCH_POLL_INTERVAL_MS;
  }

  while (true) {
    const polling = isLive
      ? (paused ? yellow("Polling paused") : green("Polling on"))
      : yellow("Polling off");
    const status = isLive
      ? `${polling} · every ${WATCH_POLL_INTERVAL_MS / 1000}s · ${messages.length} message${messages.length === 1 ? "" : "s"} · ${newCount} new · updated ${lastUpdated}`
      : `${polling} · press p to start live polling · ${messages.length} message${messages.length === 1 ? "" : "s"} · updated ${lastUpdated}`;
    const hint = isLive
      ? "↑↓ move · ↵ details · p stop polling · space pause · r refresh · esc back · q quit"
      : "↑↓ move · ↵ details · p start polling · r refresh · esc back · q quit";
    const emptyMessage = isLive
      ? "Waiting for messages. Live polling is on."
      : `${options.emptyMessage} Press p to start live polling.`;
    drawMessageFeed(
      tui,
      options.title,
      options.subtitle,
      messages,
      selected,
      hint,
      { status: error ? undefined : status, error, emptyMessage },
    );

    const waitMs = isLive && !paused ? Math.max(0, nextPollAt - Date.now()) : undefined;
    const key = isLive ? await readKeyWithTimeout(tui, waitMs) : await readKey(tui);

    if (key === null) {
      await refresh();
      nextPollAt = Date.now() + WATCH_POLL_INTERVAL_MS;
      continue;
    }
    if (key === "\x03" || key === "q") return false;
    if (key === "\x1b" || key === "\x1b[D" || key === "b") return true;
    if (key === "p" || key === "l") {
      isLive = !isLive;
      paused = false;
      newCount = 0;
      initialized = false;
      knownIds.clear();
      await refresh();
      if (isLive) {
        nextPollAt = Date.now() + WATCH_POLL_INTERVAL_MS;
      }
      continue;
    }
    if (isLive && key === " ") {
      paused = !paused;
      if (!paused) nextPollAt = Date.now() + WATCH_POLL_INTERVAL_MS;
      continue;
    }
    if (key === "r") {
      await refresh();
      if (isLive) {
        nextPollAt = Date.now() + WATCH_POLL_INTERVAL_MS;
      }
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
    const idx = await pick(tui, CLI_TITLE, items, "↑↓ · ↵ select · q quit");
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
    "Open",
    "Details",
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
    }
  }
}

async function messagesScreen(tui: TUI, client: PostMX, inboxId: string, label: string): Promise<boolean> {
  return browseMessageFeed(tui, client, {
    title: label,
    subtitle: "Inbox",
    emptyMessage: "No messages yet in this inbox.",
    load: async () => {
      const result = await client.listMessages(inboxId, { limit: 50 });
      return result.messages as unknown as Array<Record<string, unknown>>;
    },
  });
}

async function watchScreen(
  tui: TUI,
  client: PostMX,
  inboxId: string,
  label: string,
  options?: { subtitle?: string },
): Promise<boolean> {
  return browseMessageFeed(tui, client, {
    title: label,
    subtitle: options?.subtitle ?? "Inbox",
    emptyMessage: "Waiting for messages…",
    initialLive: true,
    load: async () => {
      const result = await client.listMessages(inboxId, { limit: 50 });
      return result.messages as unknown as Array<Record<string, unknown>>;
    },
  });
}

async function createInboxScreen(tui: TUI, client: PostMX): Promise<boolean> {
  const w = tui.stdout.write.bind(tui.stdout);

  let labelError: string | undefined;
  let label: string | null = null;
  while (true) {
    clear(tui);
    w(`${bold("Create inbox")}\n\n`);
    if (labelError) {
      w(`  ${red(labelError)}\n\n`);
    }
    const nextLabel = await prompt(tui, "  Label: ");
    if (nextLabel === null) return true;
    const normalized = nextLabel.trim();
    if (normalized.length > 0) {
      label = normalized;
      break;
    }
    labelError = "A label is required.";
  }
  const finalLabel = label ?? "";

  const modeChoices = [
    { value: "temporary" as const, label: "temporary · auto-expire after 10-60 minutes" },
    { value: "persistent" as const, label: "persistent · keep the inbox until you archive it" },
  ];
  clear(tui);
  w(`${bold("Create inbox")}  ${dim(finalLabel)}\n\n`);
  const modeIdx = await pick(
    tui,
    "Lifecycle",
    modeChoices.map((choice) => choice.label),
    "↑↓ · ↵ select · esc cancel",
  );
  if (modeIdx === -2) return false;
  if (modeIdx === -1) return true;
  const mode = modeChoices[modeIdx]?.value ?? "temporary";

  let ttl: number | undefined;
  if (mode === "temporary") {
    let ttlError: string | undefined;
    while (true) {
      clear(tui);
      w(`${bold("Create inbox")}  ${dim(finalLabel)} · ${dim(mode)}\n\n`);
      if (ttlError) {
        w(`  ${red(ttlError)}\n\n`);
      }
      const ttlStr = await prompt(tui, `  TTL minutes (10-60, default ${DEFAULT_TEMPORARY_INBOX_TTL_MINUTES}): `);
      if (ttlStr === null) return true;
      try {
        ttl = validateTemporaryInboxTtl(ttlStr);
        break;
      } catch (error) {
        ttlError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  clear(tui);
  w(dim("  Creating inbox..."));

  try {
    const inbox = await createInboxWithRetry(client, { label: finalLabel, lifecycle_mode: mode, ttl_minutes: ttl });
    return await watchScreen(tui, client, inbox.id, finalLabel, {
      subtitle: `Inbox ready · ${inbox.email_address}`,
    });
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
      case "login":
        return await authLogin(flags);
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
    if (err instanceof CliApiError) {
      if (err.code === "plan_limit_reached" && err.nextAction?.type === "open_dashboard" && err.nextAction.url) {
        die(`Plan limit reached. Open ${err.nextAction.url} to upgrade or manage billing${requestIdSuffix(err.requestId)}.`);
      }
      die(formatCliApiError(err));
    }
    if (err instanceof PostMXApiError) {
      die(`${err.message}${requestIdSuffix(err.requestId)}`);
    }
    if (err instanceof Error) {
      die(err.message);
    }
    die(String(err));
  }
}

function isMainInvocation(entryArg: string | undefined, moduleUrl = import.meta.url): boolean {
  if (!entryArg) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryArg);
  } catch {
    return moduleUrl === pathToFileURL(entryArg).href;
  }
}

const isMainModule = isMainInvocation(process.argv[1]);

if (isMainModule) {
  void main();
}

export {
  cliAuthHeaders,
  createInboxWithRetry,
  createCallbackListener,
  formatCliApiError,
  isMainInvocation,
  normalizeAuthSuccess,
  parseScopesFlag,
  parseTemporaryInboxTtl,
  promptSecret,
  postCliAuthJson,
};

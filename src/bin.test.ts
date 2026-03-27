import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PostMXApiError, PostMXNetworkError } from "postmx";
import {
  createInboxWithRetry,
  createCallbackListener,
  formatCliApiError,
  isMainInvocation,
  normalizeAuthSuccess,
  parseScopesFlag,
  parseTemporaryInboxTtl,
  promptSecret,
  postCliAuthJson,
} from "./bin";

const CLI_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("CLI auth helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("parses comma-separated scopes", () => {
    expect(parseScopesFlag("messages:read, inboxes:write ,")).toEqual([
      "messages:read",
      "inboxes:write",
    ]);
    expect(parseScopesFlag(undefined)).toBeUndefined();
  });

  it("defaults temporary inbox ttl to 30 minutes", () => {
    expect(parseTemporaryInboxTtl(undefined)).toBe(30);
    expect(parseTemporaryInboxTtl("")).toBe(30);
    expect(parseTemporaryInboxTtl("45")).toBe(45);
  });

  it("retries inbox creation with a fresh idempotency key", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const createInbox = vi.fn()
      .mockRejectedValueOnce(new PostMXApiError(
        409,
        "idempotency_conflict",
        "A request with this Idempotency-Key is already in progress.",
        "req_busy",
      ))
      .mockResolvedValueOnce({ id: "inb_123", email_address: "test@example.com" });

    const pending = createInboxWithRetry(
      { createInbox } as never,
      { label: "test", lifecycle_mode: "temporary", ttl_minutes: 30 },
    );

    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ id: "inb_123" });
    expect(createInbox).toHaveBeenCalledTimes(2);
    expect(createInbox.mock.calls[0]?.[1]?.idempotencyKey).toBeDefined();
    expect(createInbox.mock.calls[1]?.[1]?.idempotencyKey).toBeDefined();
    expect(createInbox.mock.calls[0]?.[1]?.idempotencyKey).not.toBe(createInbox.mock.calls[1]?.[1]?.idempotencyKey);
  });

  it("retries inbox creation after a network error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const createInbox = vi.fn()
      .mockRejectedValueOnce(new PostMXNetworkError(new Error("fetch failed")))
      .mockResolvedValueOnce({ id: "inb_456", email_address: "test@example.com" });

    const pending = createInboxWithRetry(
      { createInbox } as never,
      { label: "test", lifecycle_mode: "temporary", ttl_minutes: 30 },
    );

    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ id: "inb_456" });
    expect(createInbox).toHaveBeenCalledTimes(2);
  });

  it("sends required CLI auth headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ auth_request_id: "auth_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await postCliAuthJson({}, "/v1/auth/cli/email/start", { email: "user@example.com" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "User-Agent": `postmx-cli/${CLI_VERSION.version}`,
      "X-PostMX-Client": "cli",
      "X-PostMX-Client-Version": CLI_VERSION.version,
    });
    expect(init?.body).toBe(JSON.stringify({ email: "user@example.com" }));
  });

  it("parses CLI auth API errors with request ids and retry metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        request_id: "req_123",
        error: {
          code: "rate_limited",
          message: "Too many requests",
          retry_after_seconds: 12,
        },
        next_action: {
          type: "open_dashboard",
          url: "https://dashboard.postmx.co/billing",
        },
      }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      postCliAuthJson({}, "/v1/auth/cli/exchange", { auth_request_id: "auth_123", code: "cli_123" }),
    ).rejects.toMatchObject({
      name: "CliApiError",
      code: "rate_limited",
      requestId: "req_123",
      retryAfterSeconds: 12,
      nextAction: {
        type: "open_dashboard",
        url: "https://dashboard.postmx.co/billing",
      },
    });
  });

  it("accepts a matching localhost callback and ignores mismatches", async () => {
    const listener = await createCallbackListener("state_123");

    try {
      listener.setExpectedAuthRequestId("auth_123");
      const pending = listener.waitForCallback(2_000);

      const invalidResponse = await fetch(`${listener.callbackUrl}?code=cli_bad&auth_request_id=auth_123&state=wrong`);
      expect(invalidResponse.status).toBe(400);

      const validResponse = await fetch(`${listener.callbackUrl}?code=cli_good&auth_request_id=auth_123&state=state_123`);
      expect(validResponse.status).toBe(200);

      await expect(pending).resolves.toEqual({
        code: "cli_good",
        authRequestId: "auth_123",
        state: "state_123",
      });
    } finally {
      await listener.close();
    }
  });

  it("normalizes auth success metadata", () => {
    expect(normalizeAuthSuccess({
      api_key: "pmx_live_123",
      account: { id: "acct_123", slug: "acme", email: "owner@example.com" },
      api_key_expires_at: "2026-04-01T00:00:00.000Z",
      dashboard_url: "https://dashboard.postmx.co",
    })).toEqual({
      apiKey: "pmx_live_123",
      accountId: "acct_123",
      accountSlug: "acme",
      email: "owner@example.com",
      keyExpiresAt: "2026-04-01T00:00:00.000Z",
      dashboardUrl: "https://dashboard.postmx.co",
      dashboardBillingUrl: undefined,
    });
  });

  it("formats upgrade guidance for unsupported clients", () => {
    expect(formatCliApiError({
      name: "CliApiError",
      message: "unsupported",
      status: 400,
      code: "unsupported_client_version",
      requestId: "req_123",
    } as never)).toContain("Please upgrade");
  });

  it("treats symlinked entry paths as the main module", () => {
    const dir = mkdtempSync(join(tmpdir(), "postmx-cli-"));
    const target = join(dir, "target.js");
    const link = join(dir, "postmx");

    try {
      writeFileSync(target, "export {};\n");
      symlinkSync(target, link);

      expect(isMainInvocation(link, pathToFileURL(target).href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pauses stdin after secret entry cleanup", async () => {
    const stdinAny = process.stdin as NodeJS.ReadStream & {
      isTTY?: boolean;
      setRawMode?: (value: boolean) => void;
      isRaw?: boolean;
    };
    const stdoutAny = process.stdout as NodeJS.WriteStream & { isTTY?: boolean };

    const originalIsTTYIn = stdinAny.isTTY;
    const originalIsTTYOut = stdoutAny.isTTY;
    const originalSetRawMode = stdinAny.setRawMode;
    const originalPause = process.stdin.pause;
    const originalResume = process.stdin.resume;
    const originalSetEncoding = process.stdin.setEncoding;

    const setRawMode = vi.fn();
    const pause = vi.fn();
    const resume = vi.fn();
    const setEncoding = vi.fn();

    stdinAny.isTTY = true;
    stdoutAny.isTTY = true;
    stdinAny.isRaw = false;
    stdinAny.setRawMode = setRawMode;
    process.stdin.pause = pause as typeof process.stdin.pause;
    process.stdin.resume = resume as typeof process.stdin.resume;
    process.stdin.setEncoding = setEncoding as typeof process.stdin.setEncoding;

    try {
      const pending = promptSecret("OTP: ");
      process.stdin.emit("data", "123456\n");

      await expect(pending).resolves.toBe("123456");
      expect(resume).toHaveBeenCalled();
      expect(setEncoding).toHaveBeenCalledWith("utf8");
      expect(setRawMode).toHaveBeenCalledWith(true);
      expect(setRawMode).toHaveBeenLastCalledWith(false);
      expect(pause).toHaveBeenCalled();
    } finally {
      stdinAny.isTTY = originalIsTTYIn;
      stdoutAny.isTTY = originalIsTTYOut;
      stdinAny.setRawMode = originalSetRawMode;
      process.stdin.pause = originalPause;
      process.stdin.resume = originalResume;
      process.stdin.setEncoding = originalSetEncoding;
    }
  });
});

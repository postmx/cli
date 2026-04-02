import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PostMX, PostMXApiError, PostMXNetworkError } from "postmx";
import {
  buildErrorEnvelope,
  createInboxWithRetry,
  createCallbackListener,
  createRuntime,
  formatCliApiError,
  getHelpData,
  getVersionData,
  isMainInvocation,
  normalizeError,
  normalizeFlags,
  normalizeAuthSuccess,
  parseScopesFlag,
  parseTemporaryInboxTtl,
  promptSecret,
  postCliAuthJson,
  run,
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

  it("accepts a matching localhost callback_state and ignores mismatches", async () => {
    let listener: Awaited<ReturnType<typeof createCallbackListener>>;
    try {
      listener = await createCallbackListener("state_123");
    } catch (error) {
      if (error instanceof Error && error.message.includes("EPERM")) return;
      throw error;
    }

    try {
      listener.setExpectedAuthRequestId("auth_123");
      const pending = listener.waitForCallback(2_000);

      const invalidResponse = await fetch(`${listener.callbackUrl}?code=cli_bad&auth_request_id=auth_123&callback_state=wrong`);
      expect(invalidResponse.status).toBe(400);

      const validResponse = await fetch(`${listener.callbackUrl}?code=cli_good&auth_request_id=auth_123&callback_state=state_123`);
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

  it("still accepts legacy state callback parameters", async () => {
    let listener: Awaited<ReturnType<typeof createCallbackListener>>;
    try {
      listener = await createCallbackListener("state_legacy");
    } catch (error) {
      if (error instanceof Error && error.message.includes("EPERM")) return;
      throw error;
    }

    try {
      listener.setExpectedAuthRequestId("auth_legacy");
      const pending = listener.waitForCallback(2_000);

      const validResponse = await fetch(`${listener.callbackUrl}?code=cli_legacy&auth_request_id=auth_legacy&state=state_legacy`);
      expect(validResponse.status).toBe(200);

      await expect(pending).resolves.toEqual({
        code: "cli_legacy",
        authRequestId: "auth_legacy",
        state: "state_legacy",
      });
    } finally {
      await listener.close();
    }
  });

  it("clears the browser callback timeout after an early callback", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let listener: Awaited<ReturnType<typeof createCallbackListener>>;
    try {
      listener = await createCallbackListener("state_timer");
    } catch (error) {
      if (error instanceof Error && error.message.includes("EPERM")) return;
      throw error;
    }

    try {
      listener.setExpectedAuthRequestId("auth_timer");
      const pending = listener.waitForCallback(90_000);

      const validResponse = await fetch(`${listener.callbackUrl}?code=cli_timer&auth_request_id=auth_timer&callback_state=state_timer`);
      expect(validResponse.status).toBe(200);

      await expect(pending).resolves.toEqual({
        code: "cli_timer",
        authRequestId: "auth_timer",
        state: "state_timer",
      });
      expect(vi.getTimerCount()).toBe(0);
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

  it("auto-submits OTP entry once 6 digits are entered", async () => {
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
      const pending = promptSecret("6-digit OTP", {
        maxLength: 6,
        submitOnMaxLength: true,
        validateChar: (char) => /\d/.test(char),
      });

      process.stdin.emit("data", "123456");

      await expect(pending).resolves.toBe("123456");
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

async function captureRun(
  args: string[],
  options?: {
    tty?: boolean;
    env?: Record<string, string | undefined>;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutAny = process.stdout as NodeJS.WriteStream & { isTTY?: boolean };
  const stdinAny = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const originalStdoutIsTTY = stdoutAny.isTTY;
  const originalStdinIsTTY = stdinAny.isTTY;
  const previousEnv = new Map<string, string | undefined>();

  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  stdoutAny.isTTY = options?.tty ?? false;
  stdinAny.isTTY = options?.tty ?? false;

  for (const [key, value] of Object.entries(options?.env ?? {})) {
    previousEnv.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return {
      exitCode: await run(args),
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutAny.isTTY = originalStdoutIsTTY;
    stdinAny.isTTY = originalStdinIsTTY;
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("agent-ready CLI contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes agent flags to machine mode defaults", () => {
    expect(normalizeFlags({ agent: true })).toMatchObject({
      agent: true,
      output: "json",
      "no-browser": true,
    });
  });

  it("describes help and version data for agents", () => {
    expect(getHelpData()).toMatchObject({
      name: "postmx",
      package: "postmx-cli",
      commands: expect.arrayContaining([
        expect.objectContaining({ name: "help" }),
        expect.objectContaining({ name: "version" }),
        expect.objectContaining({ name: "inbox create" }),
      ]),
    });
    expect(getVersionData()).toMatchObject({
      cli_version: CLI_VERSION.version,
      supported_output_modes: ["json", "text"],
      agent_mode: expect.objectContaining({
        env_auth: "POSTMX_API_KEY",
        json_envelope: true,
      }),
    });
  });

  it("auto-switches to JSON envelopes on non-tty stdout", async () => {
    const result = await captureRun(["version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("\x1b");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "version",
      data: expect.objectContaining({
        cli_version: CLI_VERSION.version,
      }),
      meta: expect.objectContaining({
        output: "json",
        agent: false,
      }),
    });
  });

  it("returns structured help from help --json", async () => {
    const result = await captureRun(["help", "--json"], { tty: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "help",
      data: expect.objectContaining({
        global_options: expect.any(Array),
        commands: expect.any(Array),
      }),
      meta: expect.objectContaining({
        output: "json",
      }),
    });
  });

  it("rejects missing API keys in agent mode with exit code 3", async () => {
    const result = await captureRun(
      ["inbox", "create", "--label", "agent-test", "--agent"],
      { tty: true, env: { POSTMX_API_KEY: undefined } },
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "inbox create",
      error: expect.objectContaining({
        code: "missing_api_key",
      }),
    });
  });

  it("rejects interactive login in agent mode with exit code 7", async () => {
    const result = await captureRun(["login", "--agent"], {
      tty: true,
      env: { POSTMX_API_KEY: undefined },
    });

    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "login",
      error: expect.objectContaining({
        code: "interactive_login_unavailable",
      }),
    });
  });

  it("maps wait timeouts to exit code 5 with one JSON object on stdout", async () => {
    vi.spyOn(PostMX.prototype, "waitForMessage").mockRejectedValue(
      new Error("Timed out after 30000ms waiting for a message in inbox inb_timeout"),
    );

    const result = await captureRun(
      ["inbox", "wait", "inb_timeout", "--agent"],
      { tty: true, env: { POSTMX_API_KEY: "pmx_live_test" } },
    );

    expect(result.exitCode).toBe(5);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("\x1b");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "inbox wait",
      error: expect.objectContaining({
        code: "timeout",
      }),
    });
  });

  it("maps network failures to exit code 6", async () => {
    vi.spyOn(PostMX.prototype, "waitForMessage").mockRejectedValue(
      new PostMXNetworkError(new Error("fetch failed")),
    );

    const result = await captureRun(
      ["inbox", "wait", "inb_network", "--agent"],
      { tty: true, env: { POSTMX_API_KEY: "pmx_live_test" } },
    );

    expect(result.exitCode).toBe(6);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "inbox wait",
      error: expect.objectContaining({
        code: "network_error",
      }),
    });
  });

  it("supports the create, wait, and get agent workflow with JSON envelopes", async () => {
    vi.spyOn(PostMX.prototype, "createInbox").mockResolvedValue({
      id: "inb_123",
      email_address: "agent-test@postmx.email",
      label: "agent-test",
      lifecycle_mode: "temporary",
      created_at: "2026-04-03T00:00:00.000Z",
      expires_at: "2026-04-03T00:30:00.000Z",
    } as never);
    vi.spyOn(PostMX.prototype, "waitForMessage").mockResolvedValue({
      id: "msg_123",
      otp: "123456",
      links: [{ type: "magic_link", url: "https://example.com/verify" }],
    } as never);
    vi.spyOn(PostMX.prototype, "getMessage").mockResolvedValue({
      otp: "123456",
    } as never);

    const createResult = await captureRun(
      ["inbox", "create", "--label", "agent-test", "--agent"],
      { tty: true, env: { POSTMX_API_KEY: "pmx_live_test" } },
    );
    const waitResult = await captureRun(
      ["inbox", "wait", "inb_123", "--agent"],
      { tty: true, env: { POSTMX_API_KEY: "pmx_live_test" } },
    );
    const getResult = await captureRun(
      ["message", "get", "msg_123", "--content-mode", "otp", "--agent"],
      { tty: true, env: { POSTMX_API_KEY: "pmx_live_test" } },
    );

    expect(createResult.exitCode).toBe(0);
    expect(waitResult.exitCode).toBe(0);
    expect(getResult.exitCode).toBe(0);

    expect(JSON.parse(createResult.stdout)).toMatchObject({
      ok: true,
      command: "inbox create",
      data: expect.objectContaining({
        id: "inb_123",
        email_address: "agent-test@postmx.email",
      }),
      meta: expect.objectContaining({
        output: "json",
        agent: true,
      }),
    });
    expect(JSON.parse(waitResult.stdout)).toMatchObject({
      ok: true,
      command: "inbox wait",
      data: expect.objectContaining({
        id: "msg_123",
        otp: "123456",
      }),
    });
    expect(JSON.parse(getResult.stdout)).toMatchObject({
      ok: true,
      command: "message get",
      data: {
        otp: "123456",
      },
    });
  });

  it("builds error envelopes with the active command and runtime metadata", () => {
    const normalized = normalizeError(new PostMXApiError(401, "invalid_api_key", "Bad key", "req_123"));
    const envelope = buildErrorEnvelope(
      createRuntime({ agent: true, output: "json" }, "inbox create"),
      {
        code: normalized.code,
        message: normalized.message,
        request_id: normalized.requestId ?? null,
        retry_after_seconds: normalized.retryAfterSeconds ?? null,
        next_action: normalized.nextAction ?? null,
      },
    );

    expect(envelope).toMatchObject({
      ok: false,
      command: "inbox create",
      error: {
        code: "invalid_api_key",
        message: "Bad key",
        request_id: "req_123",
      },
      meta: {
        output: "json",
        agent: true,
      },
    });
  });
});

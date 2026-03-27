import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  createCallbackListener,
  formatCliApiError,
  normalizeAuthSuccess,
  parseScopesFlag,
  postCliAuthJson,
} from "./bin";

const CLI_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("CLI auth helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses comma-separated scopes", () => {
    expect(parseScopesFlag("messages:read, inboxes:write ,")).toEqual([
      "messages:read",
      "inboxes:write",
    ]);
    expect(parseScopesFlag(undefined)).toBeUndefined();
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
});

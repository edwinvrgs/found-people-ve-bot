import assert from "node:assert/strict";
import { test } from "node:test";

type InjectResponse = {
  statusCode: number;
  body: string;
};

type TelegramApiCall = {
  url: string;
  body: Record<string, unknown>;
};

async function createTestApp() {
  process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.ANALYTICS_HASH_SALT = "test-salt";
  process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/test";
  process.env.EXTERNAL_API_SECRET = "external-secret";
  process.env.TELEGRAM_CHAT_REGISTRY_DISABLED = "true";

  const { createApp } = await import("./app.js");
  return createApp();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs).unref();
    }),
  ]);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function mockTelegramApi() {
  const calls: TelegramApiCall[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });

    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test("health endpoint returns service status without touching dependencies", async () => {
  const app = await createTestApp();

  try {
    const response = await app.inject({ method: "GET", url: "/health" });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true, analytics: "disabled" });
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["cache-control"], "no-store");
  } finally {
    await app.close();
  }
});

test("unknown routes return a JSON 404", async () => {
  const app = await createTestApp();

  try {
    const response = await app.inject({ method: "GET", url: "/missing" });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(JSON.parse(response.body), { error: "Not found" });
  } finally {
    await app.close();
  }
});

test("public people route rejects invalid pagination before querying data", async () => {
  const app = await createTestApp();

  try {
    const response = await app.inject({ method: "GET", url: "/api/people?page=0&pageSize=999" });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), { error: "Invalid pagination" });
  } finally {
    await app.close();
  }
});

test("external report route requires bearer auth", async () => {
  const app = await createTestApp();

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/found-people/reports",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ fullName: "María Pérez", location: "Hospital Central" }),
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), { error: "Unauthorized" });
  } finally {
    await app.close();
  }
});

test("external report route requires JSON content", async () => {
  const app = await createTestApp();

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/found-people/reports",
      headers: { authorization: "Bearer external-secret", "content-type": "text/plain" },
      payload: "not-json",
    });

    assert.equal(response.statusCode, 415);
    assert.deepEqual(JSON.parse(response.body), { error: "Content-Type must be application/json" });
  } finally {
    await app.close();
  }
});

test("external report route rejects invalid JSON payloads before writing", async () => {
  const app = await createTestApp();

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/found-people/reports",
      headers: { authorization: "Bearer external-secret", "content-type": "application/json" },
      payload: JSON.stringify({ fullName: "A" }),
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), { error: "Invalid report payload" });
  } finally {
    await app.close();
  }
});

test("telegram webhook responds to /ayuda by sending a Telegram message", async () => {
  const telegram = mockTelegramApi();
  const app = await createTestApp();

  try {
    const response = await withTimeout<InjectResponse>(
      app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "test-secret",
        },
        payload: JSON.stringify({
          message: {
            message_id: 1,
            chat: { id: 123 },
            from: { id: 456 },
            text: "/ayuda",
          },
        }),
      }),
      250,
      "Telegram webhook acknowledgement",
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true });

    await waitFor(() => telegram.calls.length > 0, 250, "Telegram sendMessage call");

    const [call] = telegram.calls;
    assert.match(call.url, /\/bottest-token\/sendMessage$/);
    assert.equal(call.body.chat_id, 123);
    assert.equal(call.body.parse_mode, "HTML");
    assert.match(String(call.body.text), /Personas Encontradas/);
    assert.match(String(call.body.text), /Cómo usarlo/);
  } finally {
    telegram.restore();
    await app.close();
  }
});

test("telegram webhook with an invalid secret returns 401 quickly", async () => {
  const app = await createTestApp();

  try {
    const response = await withTimeout<InjectResponse>(
      app.inject({
        method: "POST",
        url: "/telegram/webhook",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "wrong-secret",
        },
        payload: JSON.stringify({}),
      }),
      250,
      "invalid Telegram webhook request",
    );

    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), { error: "Invalid Telegram webhook secret" });
  } finally {
    await app.close();
  }
});

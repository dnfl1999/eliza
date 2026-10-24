/** Real identity router and PGlite; only SMS delivery is captured locally. */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { createLoginApp } from "../app";
import type { createPGLiteDb } from "../db/pglite";

let app: ReturnType<typeof createLoginApp>;
let database: Awaited<ReturnType<typeof createPGLiteDb>>;
const previous = new Map<string, string | undefined>();
const tenantId = "linked-phone-test";

beforeAll(async () => {
  const environment = {
    NODE_ENV: "test",
    SMS_PROVIDER: "mock",
    WHATSAPP_OTP_ENABLED: "true",
    STEWARD_DB_MODE: "pglite",
    STEWARD_PGLITE_MEMORY: "true",
    APP_URL: "https://login.example.test",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
    STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
    STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
  };
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const { createPGLiteDb } = await import("../db/pglite");
  const { setPGLiteOverride } = await import("../db/client");
  database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  const { tenants, tenantConfigs } = await import("../db/schema");
  await database.db.insert(tenants).values({
    id: tenantId,
    name: "Linked phone test",
    apiKeyHash: randomBytes(32).toString("hex"),
  });
  await database.db
    .insert(tenantConfigs)
    .values({ tenantId, joinMode: "open" });
  const { createLoginApp } = await import("../app");
  app = createLoginApp();
}, 60_000);

afterAll(async () => {
  if (database) await database.client.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function post(path: string, body: object) {
  return app.request(`https://login.example.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("SMS send failures record a bounded cause and request ID without provider secrets", async () => {
  const { logger } = await import("@elizaos/core");
  const { releaseAuthStores } = await import("../api/services/auth-lifecycle");
  const originalFetch = globalThis.fetch;
  const env = {
    SMS_PROVIDER: "blooio",
    BLOOIO_API_KEY: "synthetic-sms-key-do-not-log",
    BLOOIO_FROM_NUMBER: "+14155550100",
    STEWARD_SMS_SEND_GLOBAL_MAX_PER_HOUR: "0",
  };
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  const secretBody = "synthetic-provider-secret OTP 654321 +14155550188";
  const sentCodes: string[] = [];
  let providerResponse = () => new Response(secretBody, { status: 429 });
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      sentCodes.push(body.text.match(/\b\d{6}\b/u)?.[0]);
      return providerResponse();
    },
  });
  // Exercise the real provider and HTTP stack; only its fixed destination is local.
  globalThis.fetch = ((input, init) => {
    if (String(input) !== "https://api.blooio.com/v4/messages")
      throw new Error("Unexpected test network destination");
    return originalFetch(provider.url, init);
  }) as typeof fetch;
  const errors = spyOn(logger, "error");
  const warnings = spyOn(logger, "warn");
  Object.assign(process.env, env);
  releaseAuthStores();
  const expected = [
    "sms_provider_rejected",
    "sms_provider_unconfirmed",
    "sms_delivery_failed",
  ];
  const observed: unknown[][] = [];
  const allCalls: unknown[] = [];
  try {
    providerResponse = () => Response.json({ id: "local-accepted-message" });
    const accepted = await post("/auth/sms/send", {
      phone: "+14155550189",
      tenantId,
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).ok).toBe(true);
    expect(errors.mock.calls).toHaveLength(0);
    providerResponse = () => new Response(secretBody, { status: 429 });
    for (const [index, reason] of expected.entries()) {
      if (index === 1)
        providerResponse = () => Response.json({ error: secretBody });
      if (index === 2) await provider.stop(true);
      errors.mockClear();
      const requestId = `sms-diagnostic-${index}`;
      const response = await app.request(
        "https://login.example.test/auth/sms/send",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": requestId,
          },
          body: JSON.stringify({ phone: `+1415555018${index}`, tenantId }),
        },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        ok: false,
        error: "SMS verification is temporarily unavailable",
      });
      expect(response.headers.get("X-Request-Id")).toBe(requestId);
      observed.push([
        errors.mock.calls.filter(
          (call) => call[1] === "[Login] SMS request failed",
        ),
        { reason, requestId },
      ]);
      allCalls.push(...errors.mock.calls);
    }
    const allDiagnostics = JSON.stringify([allCalls, warnings.mock.calls]);
    expect(sentCodes).toHaveLength(3);
    for (const code of sentCodes) expect(code).toMatch(/^\d{6}$/u);
    for (const secret of [
      env.BLOOIO_API_KEY,
      env.BLOOIO_FROM_NUMBER,
      secretBody,
      "654321",
      "+1415555018",
      ...sentCodes,
    ])
      expect(allDiagnostics).not.toContain(secret);
    for (const [calls, context] of observed)
      expect(calls).toEqual([[context, "[Login] SMS request failed"]]);
  } finally {
    errors.mockRestore();
    warnings.mockRestore();
    globalThis.fetch = originalFetch;
    await provider.stop(true);
    releaseAuthStores();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("SMS configuration and send-budget failures have distinct request diagnostics", async () => {
  const { logger } = await import("@elizaos/core");
  const { releaseAuthStores } = await import("../api/services/auth-lifecycle");
  const { setDatabaseAuthRateLimiter } = await import(
    "../api/services/auth-rate-limit"
  );
  const { checkDatabaseAuthRateLimit } = await import(
    "../auth/database-rate-limit"
  );
  const { tenants, tenantConfigs } = await import("../db/schema");
  const captchaTenant = "sms-diagnostic-captcha";
  await database.db.insert(tenants).values({
    id: captchaTenant,
    name: "SMS diagnostic captcha",
    apiKeyHash: randomBytes(32).toString("hex"),
  });
  await database.db.insert(tenantConfigs).values({
    tenantId: captchaTenant,
    authAbuseConfig: {
      captcha: {
        enabled: true,
        secretKeyEnv: "STEWARD_SMS_TEST_CAPTCHA_SECRET",
      },
    },
  } as never);
  const keys = [
    "NODE_ENV",
    "SMS_PROVIDER",
    "STEWARD_SMS_SEND_GLOBAL_MAX_PER_HOUR",
    "STEWARD_SMS_TEST_CAPTCHA_SECRET",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM",
    "TWILIO_VERIFY_SERVICE_SID",
    "TWILIO_VERIFY_TOKEN_TTL_SECONDS",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const errors = spyOn(logger, "error");
  const observed: unknown[][] = [];
  const check = async (
    reason: string,
    phone: string,
    extra: object,
    expectedError: string,
  ) => {
    errors.mockClear();
    const response = await app.request(
      "https://login.example.test/auth/sms/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Request-Id": reason },
        body: JSON.stringify({ phone, tenantId, ...extra }),
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: expectedError });
    observed.push([
      errors.mock.calls.filter(
        (call) => call[1] === "[Login] SMS request failed",
      ),
      [{ reason, requestId: reason }, "[Login] SMS request failed"],
    ]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(phone);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(
      "synthetic-captcha-token",
    );
    return response;
  };
  setDatabaseAuthRateLimiter(checkDatabaseAuthRateLimit);
  try {
    delete process.env.STEWARD_SMS_TEST_CAPTCHA_SECRET;
    await check(
      "sms_captcha_not_configured",
      "+14155550201",
      {
        tenantId: captchaTenant,
        captchaToken: "synthetic-captcha-token",
      },
      "CAPTCHA provider is not configured",
    );

    for (const key of keys) delete process.env[key];
    process.env.NODE_ENV = "production";
    releaseAuthStores();
    await check(
      "sms_provider_not_configured",
      "+14155550202",
      {},
      "SMS provider not configured",
    );

    process.env.NODE_ENV = "test";
    process.env.SMS_PROVIDER = "mock";
    process.env.STEWARD_SMS_SEND_GLOBAL_MAX_PER_HOUR = "1";
    releaseAuthStores();
    const allowed = await post("/auth/sms/send", {
      phone: "+14155550203",
      tenantId,
    });
    expect(allowed.status).toBe(200);
    const refused = await check(
      "sms_send_budget_exhausted",
      "+14155550204",
      {},
      "SMS verification is temporarily unavailable",
    );
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    for (const [calls, expected] of observed) expect(calls).toEqual([expected]);
  } finally {
    errors.mockRestore();
    setDatabaseAuthRateLimiter(undefined);
    releaseAuthStores();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a verified linked phone signs into its existing email account", async () => {
  const { users, accounts } = await import("../db/schema-auth");
  const phone = "+14155550123";
  const subject = `phone:${createHash("sha256").update(phone).digest("hex")}`;
  const [owner] = await database.db
    .insert(users)
    .values({ email: "phone-owner@example.test", emailVerified: true })
    .returning();
  await database.db.insert(accounts).values({
    userId: owner.id,
    provider: "phone",
    providerAccountId: subject,
  });
  const sent = await post("/auth/sms/send", { phone, tenantId });
  expect(sent.status).toBe(200);
  const { MockSmsInbox } = await import("../auth/sms-provider");
  const code = MockSmsInbox.last(phone)?.code;
  expect(code).toMatch(/^\d{6}$/);
  const verified = await post("/auth/sms/verify", { phone, code, tenantId });
  expect(verified.status).toBe(200);
  const body = await verified.json();
  expect(body.user.id).toBe(owner.id);
  const { verifyToken } = await import("../auth/jwt");
  const claims = await verifyToken(body.token);
  expect(claims.userId).toBe(owner.id);
  const replay = await post("/auth/sms/verify", { phone, code, tenantId });
  expect(replay.status).toBe(401);
});

async function verifyPhone(phone: string, channel = "sms") {
  const sent = await post(`/auth/${channel}/send`, { phone, tenantId });
  expect(sent.status).toBe(200);
  const { MockSmsInbox } = await import("../auth/sms-provider");
  return post(`/auth/${channel}/verify`, {
    phone,
    code: MockSmsInbox.last(phone)?.code,
    tenantId,
  });
}

test("original phone accounts retain their identity", async () => {
  const { users } = await import("../db/schema-auth");
  const phone = "+14155550124";
  const subject = `phone:${createHash("sha256").update(phone).digest("hex")}`;
  const [owner] = await database.db
    .insert(users)
    .values({ walletAddress: subject })
    .returning();
  const response = await verifyPhone(phone);
  expect(response.status).toBe(200);
  expect((await response.json()).user.id).toBe(owner.id);
});

test("conflicting original and linked phone owners receive no session", async () => {
  const { users, accounts } = await import("../db/schema-auth");
  const phone = "+14155550125";
  const subject = `phone:${createHash("sha256").update(phone).digest("hex")}`;
  await database.db.insert(users).values({ walletAddress: subject });
  const [other] = await database.db
    .insert(users)
    .values({ email: "conflict@example.test" })
    .returning();
  await database.db.insert(accounts).values({
    userId: other.id,
    provider: "phone",
    providerAccountId: subject,
  });
  const response = await verifyPhone(phone);
  expect(response.status).toBe(500);
  expect((await response.json()).token).toBeUndefined();
});

test("a refresh into another tenant applies that tenant's login methods and keeps the session on refusal", async () => {
  const { tenants, tenantConfigs } = await import("../db/schema");
  const { userTenants } = await import("../db/schema-auth");
  const login = await verifyPhone("+14155550199");
  expect(login.status).toBe(200);
  const session = (await login.json()) as {
    refreshToken: string;
    user: { id: string };
  };
  await database.db.insert(tenants).values([
    {
      id: "sms-off",
      name: "SMS off",
      apiKeyHash: randomBytes(32).toString("hex"),
    },
    {
      id: "not-joined",
      name: "Not joined",
      apiKeyHash: randomBytes(32).toString("hex"),
    },
  ]);
  await database.db.insert(tenantConfigs).values({
    tenantId: "sms-off",
    authAbuseConfig: { loginMethods: { sms: false } },
  } as never);
  await database.db
    .insert(userTenants)
    .values({ userId: session.user.id, tenantId: "sms-off", role: "member" });

  const refresh = (tenantId?: string) =>
    post("/auth/refresh", {
      refreshToken: session.refreshToken,
      ...(tenantId ? { tenantId } : {}),
    });

  const disabled = await refresh("sms-off");
  expect(disabled.status).toBe(403);
  expect((await disabled.json()).token).toBeUndefined();
  const notMember = await refresh("not-joined");
  expect(notMember.status).toBe(403);
  // Neither refusal spent or revoked the session.
  const same = await refresh();
  expect(same.status).toBe(200);
});

test("a refresh into another tenant applies that tenant's OIDC provider rule to an OIDC session", async () => {
  const { tenants, tenantConfigs } = await import("../db/schema");
  const { userTenants } = await import("../db/schema-auth");
  const { getMfaBackend, getOAuthKeyStore } = await import(
    "../api/services/auth-lifecycle"
  );
  const login = await verifyPhone("+14155550198");
  expect(login.status).toBe(200);
  const session = (await login.json()) as {
    refreshToken: string;
    user: { id: string };
  };
  await database.db.insert(tenants).values({
    id: "idp-off",
    name: "Corp IdP off",
    apiKeyHash: randomBytes(32).toString("hex"),
  });
  await database.db.insert(tenantConfigs).values({
    tenantId: "idp-off",
    authAbuseConfig: { loginMethods: { oidc: { "corp-idp": false } } },
  } as never);
  await database.db
    .insert(userTenants)
    .values({ userId: session.user.id, tenantId: "idp-off", role: "member" });
  // Store the claims an OIDC sign-in through "corp-idp" records on its
  // refresh token (no OIDC provider runs in this test).
  const tokenHash = createHash("sha256")
    .update(session.refreshToken)
    .digest("hex");
  await getMfaBackend().set(
    `refresh:claims:${tokenHash}`,
    JSON.stringify(
      getOAuthKeyStore().encrypt(
        JSON.stringify({
          userId: session.user.id,
          authMethod: "oidc",
          oidcProviderId: "corp-idp",
          oidcSubject: "subject-1",
          emailVerified: false,
        }),
      ),
    ),
    60_000,
  );

  const disabled = await post("/auth/refresh", {
    refreshToken: session.refreshToken,
    tenantId: "idp-off",
  });
  expect(disabled.status).toBe(403);
  expect((await disabled.json()).error).toBe(
    "OIDC login is disabled for this tenant",
  );
});

test("the tenant switch route applies the target tenant's login methods", async () => {
  const { tenants, tenantConfigs } = await import("../db/schema");
  const { userTenants } = await import("../db/schema-auth");
  const { createSessionToken } = await import("../api/services/auth-lifecycle");
  const login = await verifyPhone("+14155550197");
  expect(login.status).toBe(200);
  const { user } = (await login.json()) as { user: { id: string } };
  await database.db.insert(tenants).values([
    {
      id: "switch-sms-off",
      name: "SMS off",
      apiKeyHash: randomBytes(32).toString("hex"),
    },
    {
      id: "switch-open",
      name: "Open",
      apiKeyHash: randomBytes(32).toString("hex"),
    },
  ]);
  await database.db.insert(tenantConfigs).values([
    {
      tenantId: "switch-sms-off",
      authAbuseConfig: { loginMethods: { sms: false } },
    },
    { tenantId: "switch-open" },
  ] as never);
  await database.db.insert(userTenants).values([
    { userId: user.id, tenantId: "switch-sms-off", role: "member" },
    { userId: user.id, tenantId: "switch-open", role: "member" },
  ]);
  const personalTenant = `personal-${user.id}`;
  await database.db
    .insert(userTenants)
    .values({ userId: user.id, tenantId: personalTenant, role: "owner" })
    .onConflictDoNothing();
  const token = await createSessionToken("", personalTenant, {
    userId: user.id,
    tenantId: personalTenant,
    authMethod: "sms",
    mfaVerifiedAt: Date.now(),
  });
  const switchTo = (tenantId: string) =>
    app.request("https://login.example.test/user/me/tenants/switch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ tenantId }),
    });

  const refused = await switchTo("switch-sms-off");
  expect(refused.status).toBe(403);
  expect((await refused.json()).error).toBe(
    "sms login is disabled for this tenant",
  );
  expect((await switchTo("switch-open")).status).toBe(200);
});

test("a phone linked through SMS gets no second account from WhatsApp login", async () => {
  const { users, accounts } = await import("../db/schema-auth");
  const phone = "+14155550126";
  const subject = `phone:${createHash("sha256").update(phone).digest("hex")}`;
  const [owner] = await database.db
    .insert(users)
    .values({ email: "sms-linked@example.test", emailVerified: true })
    .returning();
  await database.db.insert(accounts).values({
    userId: owner.id,
    provider: "phone",
    providerAccountId: subject,
  });
  const whatsapp = await verifyPhone(phone, "whatsapp");
  expect((await whatsapp.json()).token).toBeUndefined();
  const { eq } = await import("drizzle-orm");
  expect(
    await database.db
      .select()
      .from(users)
      .where(eq(users.walletAddress, subject)),
  ).toEqual([]);
  const sms = await verifyPhone(phone);
  expect(sms.status).toBe(200);
  expect((await sms.json()).user.id).toBe(owner.id);
});

test("a phone linked to two users through SMS and WhatsApp signs in to neither", async () => {
  const { users, accounts } = await import("../db/schema-auth");
  const phone = "+14155550127";
  const subject = `phone:${createHash("sha256").update(phone).digest("hex")}`;
  const [smsOwner, whatsappOwner] = await database.db
    .insert(users)
    .values([
      { email: "split-sms@example.test", emailVerified: true },
      { email: "split-whatsapp@example.test", emailVerified: true },
    ])
    .returning();
  await database.db.insert(accounts).values([
    { userId: smsOwner.id, provider: "phone", providerAccountId: subject },
    {
      userId: whatsappOwner.id,
      provider: "whatsapp",
      providerAccountId: subject,
    },
  ]);
  for (const channel of ["sms", "whatsapp"]) {
    const response = await verifyPhone(phone, channel);
    expect((await response.json()).token).toBeUndefined();
  }
});

import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { poolConfig, sslFor } from "@/lib/db/postgres";
import { SUPABASE_ROOT_CA } from "@/lib/db/supabase-ca";

const POOLER =
  "postgres://postgres.ref:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x";
const noEnv = {};

describe("database TLS", () => {
  it("verifies the Supabase pooler against Supabase's root CA", () => {
    expect(poolConfig(POOLER, noEnv).ssl).toEqual({
      ca: SUPABASE_ROOT_CA,
      rejectUnauthorized: true,
    });
    expect(sslFor("aws-1-eu-central-1.pooler.supabase.com", null, noEnv)).toEqual({
      ca: SUPABASE_ROOT_CA,
      rejectUnauthorized: true,
    });
  });

  it("verifies a direct Supabase host against the same CA", () => {
    expect(sslFor("db.cjfomgjoyshusxwjxrzp.supabase.co", null, noEnv)).toEqual({
      ca: SUPABASE_ROOT_CA,
      rejectUnauthorized: true,
    });
  });

  it("does not trust Supabase's CA for a look-alike host", () => {
    expect(sslFor("evilsupabase.com", null, noEnv)).toEqual({ rejectUnauthorized: true });
    expect(sslFor("db.example.com", "require", noEnv)).toEqual({ rejectUnauthorized: true });
  });

  it("ignores sslmode=require or no-verify in the string", () => {
    const config = poolConfig(POOLER.replace("sslmode=require", "sslmode=no-verify"), noEnv);
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(config.connectionString).not.toContain("sslmode");
  });

  it("skips verification only with DATABASE_SSL_INSECURE=1", () => {
    const insecure = { DATABASE_SSL_INSECURE: "1" };
    expect(poolConfig(POOLER, insecure).ssl).toEqual({ rejectUnauthorized: false });
    expect(poolConfig(POOLER, { DATABASE_SSL_INSECURE: "true" }).ssl).toMatchObject({
      rejectUnauthorized: true,
    });
  });

  it("leaves TLS off for a local Postgres or sslmode=disable", () => {
    expect(poolConfig("postgres://u:p@localhost:5432/db", noEnv).ssl).toBe(false);
    expect(poolConfig("postgres://u:p@127.0.0.1:54322/postgres", noEnv).ssl).toBe(false);
    expect(poolConfig("postgres://u:p@[::1]:5432/db", noEnv).ssl).toBe(false);
    expect(poolConfig("postgres://u:p@db.internal:5432/db?sslmode=disable", noEnv).ssl).toBe(
      false
    );
    // Local stays plain even with the escape hatch set.
    expect(poolConfig("postgres://u:p@localhost:5432/db", { DATABASE_SSL_INSECURE: "1" }).ssl).toBe(
      false
    );
  });

  it("ships the Supabase Root 2021 CA, still valid", () => {
    const cert = new X509Certificate(SUPABASE_ROOT_CA);
    expect(cert.subject).toContain("CN=Supabase Root 2021 CA");
    expect(cert.ca).toBe(true);
    expect(cert.fingerprint256).toBe(
      "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA"
    );
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
  });
});

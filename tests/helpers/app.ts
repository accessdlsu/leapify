import { createApp } from "../../src/app";

// Mock KV
//
// Root-cause fix: Cloudflare KV's `get(key, 'json')` automatically JSON-parses
// the stored string before returning.  Our earlier stub always returned the raw
// string, so callers that expected an object got a string instead — causing
// type errors and silent undefined-property crashes (→ 500).
//
// This implementation inspects the second argument and parses JSON when the
// caller requests the 'json' type, mirroring the real KV behaviour.
//
export function createMockKV() {
  const store = new Map<string, string>();

  return {
    _store: store, // exposed so tests can inspect / pre-seed directly

    async get(key: string, type?: string): Promise<any> {
      const raw = store.get(key) ?? null;
      if (raw === null) return null;
      // Mirror real KV: parse JSON when 'json' type is requested
      if (type === "json") {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    },

    async put(key: string, value: string, _options?: object): Promise<void> {
      store.set(key, value);
    },

    async delete(key: string): Promise<void> {
      store.delete(key);
    },

    async list() {
      return { keys: [], list_complete: true, cursor: "" };
    },

    async getWithMetadata(key: string, type?: string) {
      const value = await this.get(key, type);
      return { value, metadata: null };
    },
  };
}

// Mock Queue
export function createMockQueue() {
  return {
    send: async () => {},
    sendBatch: async () => {},
  };
}

// Test App Factory
//
// Returns both the Hono app instance AND the env bindings so individual tests
// can pre-seed the KV namespace before firing requests.
//
export function createTestApp(options?: { allowedOrigins?: string[] }) {
  const kv = createMockKV();

  const env = {
    DB: {} as any, // injected via vi.mock('../../src/db') per test file
    KV: kv as any,
    QUEUE: createMockQueue() as any,
    RESEND_API_KEY: "",
    BETTER_AUTH_SECRET: "test-secret-do-not-use-in-production",
    BETTER_AUTH_URL: "http://localhost:8787",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    GFORMS_SERVICE_ACCOUNT_JSON: "{}",
    INTERNAL_API_SECRET: "secret",
  };


  const app = createApp({ allowedOrigins: options?.allowedOrigins ?? ["*"] });

  return { app, env, kv };
}

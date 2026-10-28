import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Console, manifest } from "./console.mjs";
import { Vault } from "./store.mjs";
const m = {
  schema: 1,
  name: "own-service",
  display_name: "Own Service",
  description: "A bounded operator-owned evaluation service.",
  maintainer: { github: "ordinaryleggi" },
  status: "draft",
  network: "eip155:2368",
  pay_to: "0x" + "c".repeat(40),
  source: "custom",
  upstream: {
    name: "Own implementation",
    url: "https://github.com/ordinaryleggi/kite-merchant-console",
  },
  endpoints: [
    {
      method: "POST",
      path: "/v1/query",
      summary: "Run one bounded query operation",
      price_usd: "0.01",
      example_request: { body: { operation_id: "query-example" } },
    },
  ],
  categories: ["data"],
};
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "console-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let revision = 0,
    config = { price_usd: "0.01", paused: false, manifest_hash: null };
  const fake = async (url, opts) => {
    const path = new URL(url).pathname;
    if (path === "/healthz")
      return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    if (path === "/v1/query")
      return {
        ok: false,
        status: 402,
        json: async () => ({
          x402Version: 2,
          resource: { url: "https://managed.example/v1/query" },
          accepts: [
            {
              scheme: "exact",
              network: m.network,
              payTo: m.pay_to,
              asset: "0x" + "a".repeat(40),
              amount: String(Math.round(Number(config.price_usd) * 1e6)),
              maxTimeoutSeconds: 120,
            },
          ],
        }),
      };
    if (opts.method === "POST") {
      const body = JSON.parse(opts.body);
      assert.equal(body.expected_revision, revision);
      config = body.config;
      revision++;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ revision, config: structuredClone(config) }),
    };
  };
  const app = new Console(
    new Vault(dir, randomBytes(32).toString("hex")),
    {
      local: {
        origin: "https://managed.example",
        token: "synthetic",
        payment: { asset: "0x" + "a".repeat(40), decimals: 6 },
      },
    },
    fake,
  );
  return {
    app,
    drift: () => {
      config = { ...config, price_usd: "0.55" };
    },
  };
}
test("official closed manifest rejects invented fields and live promotion without evidence", async (t) => {
  const { app } = setup(t);
  assert.throws(() => manifest({ ...m, job_id: "invented" }), {
    code: "manifest_schema_invalid",
  });
  await app.import(m, "local");
  await assert.rejects(
    app.release(m.name, {
      ...m,
      status: "testnet",
      base_url: "https://service.example",
    }),
    { code: "live_evidence_required_for_promotion" },
  );
});
test("versioned preflight, managed apply/readback, pause and rollback", async (t) => {
  const { app } = setup(t);
  await app.import(m, "local");
  const release = await app.release(m.name, {
    ...m,
    endpoints: [{ ...m.endpoints[0], price_usd: "0.02" }],
  });
  await assert.rejects(app.apply(release.id), { code: "preflight_required" });
  assert.equal((await app.preflight(release.id)).status, "PREFLIGHTED");
  assert.equal((await app.apply(release.id)).status, "VERIFIED");
  assert.equal(app.list().services[0].applied, release.id);
  assert.equal((await app.pause(m.name)).status, "PAUSED");
  assert.equal((await app.rollback(release.id)).status, "ROLLED_BACK");
  assert(app.export(release.id).includes("source: custom"));
});
test("applied config drift detected, desired release retained", async (t) => {
  const { app, drift } = setup(t);
  await app.import(m, "local");
  const r = await app.release(m.name, m);
  await app.preflight(r.id);
  await app.apply(r.id);
  drift();
  assert.equal((await app.observe(r.id)).status, "DRIFTED");
  assert.equal(app.list().services[0].desired, r.id);
});
test("malformed quotes fail preflight; config success cannot hide live quote drift", async (t) => {
  const { app } = setup(t);
  await app.import(m, "local");
  const r = await app.release(m.name, m);
  const fetcher = app.fetcher;
  app.fetcher = async (url, opts) => {
    const response = await fetcher(url, opts);
    if (new URL(url).pathname === "/v1/query")
      return {
        ...response,
        json: async () => ({
          x402Version: 2,
          resource: { url: "https://managed.example/v1/query" },
          accepts: [
            {
              network: m.network,
              payTo: m.pay_to,
              scheme: "unsupported",
              asset: "invalid",
              amount: "not-an-integer",
            },
          ],
        }),
      };
    return response;
  };
  assert.equal((await app.preflight(r.id)).status, "FAILED");
  app.fetcher = fetcher;
  await app.preflight(r.id);
  await app.apply(r.id);
  app.fetcher = async (url, opts) => {
    const response = await fetcher(url, opts);
    if (new URL(url).pathname !== "/v1/query") return response;
    const data = await response.json();
    data.accepts[0].amount = "999";
    return { ...response, json: async () => data };
  };
  const drift = await app.observe(r.id);
  assert.equal(drift.status, "DRIFTED");
  assert.equal(drift.verification.configuration_verified, true);
  assert.equal(drift.verification.quote_verified, false);
  assert.equal(drift.verification.purchase_verified, false);
});

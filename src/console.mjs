import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fault, hash, audit } from "./store.mjs";
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(
  JSON.parse(
    readFileSync(new URL("../schema/service.schema.json", import.meta.url)),
  ),
);
export function manifest(input) {
  let m;
  try {
    m =
      typeof input === "string"
        ? YAML.parse(input, { uniqueKeys: true })
        : structuredClone(input);
  } catch {
    throw fault("invalid_manifest_yaml");
  }
  if (!validate(m))
    throw Object.assign(fault("manifest_schema_invalid"), {
      details: validate.errors,
    });
  if (
    /(?:gh[pousr]_[a-zA-Z0-9]{20,}|-----BEGIN .*PRIVATE KEY)/.test(
      JSON.stringify(m),
    )
  )
    throw fault("manifest_contains_secret");
  return m;
}
export class Console {
  constructor(vault, targets, fetcher = fetch) {
    Object.assign(this, { vault, targets, fetcher });
  }
  target(id) {
    const t = this.targets[id];
    if (!t || !t.token || new URL(t.origin).origin !== t.origin)
      throw fault("unknown_managed_target");
    return t;
  }
  async request(id, path, method = "GET", input) {
    const t = this.target(id);
    const r = await this.fetcher(new URL(path, t.origin), {
      method,
      headers: {
        authorization: "Bearer " + t.token,
        "content-type": "application/json",
      },
      body: input ? JSON.stringify(input) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    if (!r.ok && r.status !== 402)
      throw fault("managed_target_http_" + r.status, 502);
    return { status: r.status, data };
  }
  list() {
    const s = this.vault.read();
    return {
      services: Object.values(s.services || {}),
      releases: Object.values(s.releases || {}).map((r) => ({
        ...r,
        probe: r.probe ? { ...r.probe } : null,
      })),
      audit: s.audit,
    };
  }
  async import(input, target_id) {
    const m = manifest(input);
    this.target(target_id);
    return this.vault.transaction((s, save) => {
      s.services ??= {};
      if (s.services[m.name]) throw fault("service_exists", 409);
      const service = {
        id: m.name,
        target_id,
        manifest: m,
        desired: null,
        applied: null,
        status: "DRAFT",
      };
      s.services[m.name] = service;
      audit(s, "service_imported", { id: m.name });
      save();
      return service;
    });
  }
  async release(service_id, input) {
    const m = manifest(input);
    if (m.name !== service_id) throw fault("manifest_name_mismatch");
    // Promotion requires independently captured deployment AND paid interoperability evidence. This release has neither.
    if (m.status !== "draft")
      throw fault("live_evidence_required_for_promotion", 409);
    return this.vault.transaction((s, save) => {
      const service = s.services?.[service_id];
      if (!service) throw fault("service_not_found", 404);
      s.releases ??= {};
      const previous = Object.values(s.releases).filter(
        (r) => r.service_id === service_id,
      );
      const release = {
        id: randomUUID(),
        service_id,
        manifest: m,
        manifest_hash: hash(m),
        number: previous.length + 1,
        status: "VALIDATED",
        previous_applied: service.applied,
        created_at: new Date().toISOString(),
      };
      s.releases[release.id] = release;
      service.desired = release.id;
      audit(s, "release_created", { id: release.id });
      save();
      return release;
    });
  }
  async preflight(id) {
    const r = this.vault.read().releases?.[id];
    if (!r) throw fault("release_not_found", 404);
    const svc = this.vault.read().services[r.service_id];
    let probe;
    try {
      const health = await this.request(svc.target_id, "/healthz");
      const quotes = [];
      for (const e of r.manifest.endpoints) {
        const reply = await this.request(
          svc.target_id,
          e.path,
          e.method,
          e.example_request?.body || {},
        );
        const terms = reply.data.accepts?.[0];
        quotes.push({
          path: e.path,
          status: reply.status,
          network: terms?.network,
          amount: terms?.amount,
          payTo: terms?.payTo,
        });
        if (
          reply.status !== 402 ||
          terms?.network !== r.manifest.network ||
          terms?.payTo?.toLowerCase() !== r.manifest.pay_to.toLowerCase()
        )
          throw fault("quote_manifest_mismatch", 409);
      }
      probe = {
        ok: health.data.status === "ok",
        quotes,
        paid_trial: "NOT_RUN",
        observed_at: new Date().toISOString(),
      };
    } catch (e) {
      probe = {
        ok: false,
        error: e.code || "probe_failed",
        paid_trial: "NOT_RUN",
        observed_at: new Date().toISOString(),
      };
    }
    return this.vault.transaction((s, save) => {
      const release = s.releases[id];
      release.probe = probe;
      release.status = probe.ok ? "PREFLIGHTED" : "FAILED";
      audit(s, "preflight", { id, ok: probe.ok });
      save();
      return release;
    });
  }
  async apply(id) {
    const state = this.vault.read(),
      r = state.releases?.[id],
      service = state.services?.[r?.service_id];
    if (!r || r.status !== "PREFLIGHTED")
      throw fault("preflight_required", 409);
    const current = (await this.request(service.target_id, "/admin/config"))
      .data;
    const prices = r.manifest.endpoints.map((e) => e.price_usd);
    if (new Set(prices).size !== 1)
      throw fault("backend_supports_one_fixed_price");
    const config = {
      price_usd: prices[0],
      paused: false,
      manifest_hash: r.manifest_hash,
    };
    await this.vault.transaction((s, save) => {
      s.releases[id].status = "DEPLOYING";
      s.releases[id].base_config = current;
      s.releases[id].desired_config = config;
      save();
    });
    try {
      await this.request(service.target_id, "/admin/config", "POST", {
        expected_revision: current.revision,
        config,
      });
    } catch (e) {
      await this.vault.transaction((s, save) => {
        s.releases[id].status = "UNKNOWN";
        save();
      });
      throw e;
    }
    return this.observe(id);
  }
  async observe(id) {
    const state = this.vault.read(),
      r = state.releases?.[id];
    if (!r) throw fault("release_not_found", 404);
    const service = state.services[r.service_id],
      actual = (await this.request(service.target_id, "/admin/config")).data;
    return this.vault.transaction((s, save) => {
      const release = s.releases[id];
      release.observed = actual;
      release.status =
        hash(actual.config) === hash(release.desired_config)
          ? "VERIFIED"
          : "DRIFTED";
      if (release.status === "VERIFIED") {
        s.services[release.service_id].applied = id;
        s.services[release.service_id].manifest = release.manifest;
      }
      audit(s, "deployment_observed", { id, status: release.status });
      save();
      return release;
    });
  }
  async rollback(id) {
    const s = this.vault.read(),
      r = s.releases?.[id];
    if (!r?.base_config) throw fault("rollback_target_missing", 409);
    const svc = s.services[r.service_id],
      current = (await this.request(svc.target_id, "/admin/config")).data;
    await this.vault.transaction((state, save) => {
      state.releases[id].status = "ROLLBACK_PENDING";
      save();
    });
    try {
      await this.request(svc.target_id, "/admin/config", "POST", {
        expected_revision: current.revision,
        config: r.base_config.config,
      });
      const actual = (await this.request(svc.target_id, "/admin/config")).data;
      if (hash(actual.config) !== hash(r.base_config.config))
        throw fault("rollback_readback_mismatch", 502);
      return await this.vault.transaction((state, save) => {
        state.releases[id].status = "ROLLED_BACK";
        state.services[r.service_id].applied = r.previous_applied;
        state.services[r.service_id].status = "ROLLED_BACK";
        audit(state, "rollback_verified", { id });
        save();
        return state.releases[id];
      });
    } catch (e) {
      await this.vault.transaction((state, save) => {
        state.releases[id].status = "UNKNOWN";
        save();
      });
      throw e;
    }
  }
  async pause(service_id) {
    const s = this.vault.read(),
      svc = s.services?.[service_id];
    if (!svc) throw fault("service_not_found", 404);
    const current = (await this.request(svc.target_id, "/admin/config")).data;
    await this.request(svc.target_id, "/admin/config", "POST", {
      expected_revision: current.revision,
      config: { ...current.config, paused: true },
    });
    const actual = (await this.request(svc.target_id, "/admin/config")).data;
    if (!actual.config.paused) throw fault("pause_unconfirmed", 502);
    return this.vault.transaction((state, save) => {
      state.services[service_id].status = "PAUSED";
      audit(state, "service_paused", { service_id });
      save();
      return { status: "PAUSED" };
    });
  }
  export(id) {
    const r = this.vault.read().releases?.[id];
    if (!r) throw fault("release_not_found", 404);
    return YAML.stringify(manifest(r.manifest));
  }
}

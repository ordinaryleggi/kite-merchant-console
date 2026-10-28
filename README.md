# Merchant Console

Versioned Kite service manifests and managed HTTP deployment control.

Version 0.2.0 is an AI-assisted engineering evaluation release, developed under one operator and assigned to this GitHub account. It is not evidence of independent human adoption, official Kite approval, Electric Capital inclusion or successful live payment.

## Run and verify

Node.js 20.11+ is required; Node.js 24 is used for current CI and is recommended.

```sh
npm ci
npm test
# Set DATA_KEY, OPERATOR_TOKEN and TARGETS_JSON, then:
npm start
```

The first backend is a managed HTTP configuration agent on your own services. TARGETS_JSON maps operator-chosen target IDs to {"origin":"https://your-service","token":"...","payment":{"asset":"YOUR_VERIFIED_TOKEN_ADDRESS","decimals":6}}; targets cannot be supplied in an import. Services 07–10 implement the corresponding protected /admin/config endpoint with expected_revision. Tokens stay in the environment, outside manifests and audit output.

Import a manifest, create an immutable release, preflight /healthz and each free 402 path, apply, then read back. Desired and applied versions are independent. Failures after a write remain UNKNOWN until observed. Observe detects drift. Pause and rollback also require readback. This backend publishes service configuration; source-code/image deployment is performed separately by the operator.

Use GET/POST /services, POST /services/{id}/releases, POST /releases/{id}/preflight|apply|observe|rollback, POST /services/{id}/pause and GET /releases/{id}/manifest. The official closed schema is pinned under schema/. This release keeps exported manifests draft and refuses unverified lifecycle promotion. No catalog submission is sent.

## Configuration and recovery

Use .env.example as a list of required environment variables; the service does not automatically load it. Generate a fresh 32-byte hex DATA_KEY locally, keep it outside the repository and retain it across restarts. Supply strong operator/application bearer tokens and a real receiver and asset before enabling a service. Values are intentionally blank so example configuration cannot silently charge a wrong wallet. The stored payment state UNKNOWN never means unpaid. Inspect the original receipt/activity and restricted journal; do not change an operation key to buy again. Where a writer lock survives a crash, stop all writer processes and review the journal before removing only the stale lock directory.

## Integration evidence

Read [compatibility.json](compatibility.json) and [the protocol boundary](docs/PROTOCOL.md). Local tests are E1; read-only public capability/RPC observations prove only the facts observed. Real Passport approval, funded purchase, SIWX interoperability, public deployment and catalog/EC review are not completed by this release. 

## Scope and evidence

[Original PRD](docs/PRD.md) describes the full target, not a claim that every external acceptance gate has passed. [Event contract](docs/EVENTS.md) defines the application records. The standalone repositories share protocol/storage support code, with distinct business implementations and tests. The license is MIT; third-party dependencies keep their upstream licenses. Reproduce failures without publishing payment signatures, account credentials or private files.

## 2026-10-28 update

Each TARGETS_JSON entry must include payment:{asset:"0x…",decimals:6}, configured by the operator from the real asset profile. Preflight validates v2/exact quotes, resource URL, network, receiver, token, integer amount and timeout. Apply reads back both the protected configuration and the paid endpoint quote at the intended price. verification.configuration_verified and quote_verified are separate from purchase_verified, which remains false until separately captured real evidence. VERIFIED means configuration and unsigned quote readback, not a funded purchase. Exported service manifests remain draft in this release.

See [Kite integration and interoperability boundaries](docs/KITE-INTEGRATION.md) and [this release's changes](CHANGELOG.md).

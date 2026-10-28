# Changes

## 0.2.0 — 2026-10-28

Each TARGETS_JSON entry must include payment:{asset:"0x…",decimals:6}, configured by the operator from the real asset profile. Preflight validates v2/exact quotes, resource URL, network, receiver, token, integer amount and timeout. Apply reads back both the protected configuration and the paid endpoint quote at the intended price. verification.configuration_verified and quote_verified are separate from purchase_verified, which remains false until separately captured real evidence. VERIFIED means configuration and unsigned quote readback, not a funded purchase. Exported service manifests remain draft in this release.

This evaluation update retains explicit blocked real-payment, public-hosting and official-listing gates. Prior releases remain available.

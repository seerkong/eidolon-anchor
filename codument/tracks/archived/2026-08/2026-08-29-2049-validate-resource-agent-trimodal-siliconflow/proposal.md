# Validate resource Agents across three modes on a compatible DeepSeek gateway

## Why

The proposition harness currently hard-codes official DeepSeek in four different layers: command construction, live runtime admission, matrix evidence classification and receipt acceptance. That prevents the same frozen proposition and verifier from being used for a compatible DeepSeek provider, and it risks accidentally relabelling compatible-provider cache observations as official evidence.

This Track introduces one closed provider binding selected by the live runner. It keeps the historical official binding intact and catalogs compatible bindings without relabelling them as official evidence. After the SiliconFlow first pass exposed a provider timeout in ordinary mode, the user selected `deepseek-iqingwa/deepseek-v4-pro` with `deepseek-compatible-chat@1` for the actual three-mode regression. The exact selected binding flows unchanged through ordinary, AI Ctrl and AI Data commands, shim evidence, receipt classification and acceptance.

After deterministic verification, the current Eidolon is rebuilt and locally installed. A bounded three-cell sentinel matrix runs the same stream-pipeline proposition and verifier in all three modes. Results are reported as compatible-provider evidence with correctness, mode identity, retry/error, prefix/cache and normalized-cost facts.

## Outcomes

- One explicit provider binding replaces scattered official-only literals without allowing arbitrary provider substitution.
- Official and compatible bindings use distinct model/profile/provider-class identities.
- The matrix planner and receipt gate accept an explicitly requested compatible live-evidence class while preserving official-only behavior by default.
- The exact rebuilt/local-installed executable epoch is pinned for all three cells.
- One real proposition executes in ordinary, AI Ctrl and AI Data modes on iQingwa, with unchanged source digest and verifier.
- A Chinese report records correctness, stability, cache eligibility/hit ratios, cost availability and any provider limitations without comparing compatible pricing as official DeepSeek cost.

## Non-goals

- Replacing the historical official DeepSeek G1-G7 report.
- Claiming a compatible gateway's cache semantics or prices are identical to official DeepSeek.
- Running the full 18-cell matrix when a three-mode sentinel is sufficient to validate this migration.

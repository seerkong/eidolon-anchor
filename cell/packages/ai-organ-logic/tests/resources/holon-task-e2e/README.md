# Holon task E2E File-XNL resource

This directory is deterministic inspection evidence for the Review Team organization used by the real Holon task E2E.

## What is authoritative inside this fixture

- `authority/head.xnl` points to the accepted File-XNL revision.
- `authority/records/` contains the twelve content-addressed organization records.
- `authority/trees/` contains the revision tree.
- `authority/receipts/` contains the revision-one commit receipt.
- `issued/holon-effective-snapshot.json` and `issued/issuance-receipt.json` are labelled issuer projections, not writable organization tables.
- `manifest.json` contains logical ids and canonical digests only.

The real product E2E does **not** use this directory as its writable organization owner. It creates a separate temporary File-XNL capsule, commits it, reconstructs a fresh issuer and admits those exact issued bytes into its ResourcePackage. This committed directory exists so people can inspect the physical layout and so a byte-exact regeneration gate can detect drift.

Empty `authority/transactions/` and `authority/projections/` directories are created by the capsule during materialization. Git does not retain them when they contain no facts.

## Regenerate into an empty inspection directory

```bash
mkdir /absolute/path/to/empty-holon-resource
bun run --cwd cell/packages/ai-organ-logic generate:holon-e2e-resource -- \
  --output /absolute/path/to/empty-holon-resource
```

The generator refuses relative, linked, non-directory or non-empty output roots and never deletes existing files.

## Verify the committed bytes

```bash
bun run --cwd cell/packages/ai-organ-logic check:holon-e2e-resource
```

The check regenerates into an isolated temporary root, compares every generator-owned path and byte, reconstructs a fresh capsule, and parses the snapshot/receipt. `README.md` is explanatory and is the only file excluded from byte comparison.

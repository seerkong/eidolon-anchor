# TDD plan

1. RED: importing the scenario/materializer and checking the committed resource fails because none exists.
2. GREEN P1-T1: implement closed deterministic scenario data and `materializeFileXnlHolonE2eResource(runtime, input, config)` with explicit effects and empty-root admission.
3. GREEN P1-T2: generate the committed directory, then compare an isolated regeneration path/bytes and fresh capsule output.
4. GREEN P2-T1: retain or strengthen the product fixture assertions proving a separate real authority commit and issuer provenance.
5. REFACTOR: deduplicate scenario literals without sharing writable state or weakening owner boundaries.
6. VERIFY: focused tests, workflow regression, both scoped typechecks, generator check, static privacy/authority scans, strict Codument validation and fresh coding AttractorCheck.

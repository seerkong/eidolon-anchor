# Releasing protocol

Use the current ready receipt and publication authorization. If authorization is absent, present the ready result and stop. If it is true, use the Authoring publication operation once with the exact session and revision. For ResourcePackage mode, preserve the returned registry revision and exact App/Workflow/Agent/Material refs; for explicit legacy mode, preserve the returned VFS workflow ref. Do not rerun validation/proof or infer authorization from request wording, and do not create an instance or run.

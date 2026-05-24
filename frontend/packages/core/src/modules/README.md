# Modules directory

This folder hosts module-level contracts and infrastructure that are shared by Vue and React shells. Use PascalCase for module folder names (e.g., `Example`).
Each module stays UI- and DI-free, focusing on contracts, runtime helpers, state holders, helpers, and API surface. controllers and container bindings now live in `frontend/packages/composer/src/modules/<ModuleName>/`.

Recommended subfolders per module:
- `contract/` – shared types specific to the module (beyond `@shared/composer`).
- `runtime/` – runtime helpers derived from contract definitions.
- `state/` – reactive or plain state holders.
- `api/` – API client definitions for the module.
- `helper/` – pure utility helpers.

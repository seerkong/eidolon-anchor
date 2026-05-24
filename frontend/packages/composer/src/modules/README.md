# Mosaic modules directory

This folder hosts non-core orchestration for each module: controllers plus dependency injection bindings that wrap core contracts, state, runtime helpers, and APIs. Use PascalCase for module folder names (e.g., `Example`).

Recommended subfolders per module:
- `controller/` – orchestration classes that coordinate module logic using core primitives.
- `container/` – Inversify bindings for controllers/APIs; export a `ContainerModule`.

Keep mosaic modules framework-neutral; shell-specific components still live under `frontend/packages/vue|react/modules/<ModuleName>/`.

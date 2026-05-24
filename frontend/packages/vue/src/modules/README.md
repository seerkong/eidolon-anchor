# Modules directory (Vue shell)

Vue shell modules live under `modules/<Name>/` (PascalCase) and provide UI wiring for each feature without polluting the shell root.

Recommended subfolders per module:
- `router/` – route/menu definitions for this module.
- `index.ts` – module entry for registration.
- `view/` – page-level Vue components.
- `component/` – reusable UI components for the module.
- `api/` – thin client wrappers specific to this module’s UI needs.
- `styles/` – module-scoped styles.
- `hooks/` – Vue composables.
- `contract/` – UI-only types/config for the shell.
- `helper/` – pure helper functions.

Add more folders if needed for engineering workflows. Keep logic reusable and isolated so modules can be copied to other apps.

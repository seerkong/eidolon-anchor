# Modules directory (React shell)

React shell modules live under `modules/<Name>/` (PascalCase) and keep UI pieces isolated for reuse.

Recommended subfolders per module:
- `router/` – route/menu definitions for this module.
- `index.ts` – module entry registration.
- `view/` – page components.
- `component/` – reusable components.
- `api/` – UI-specific API helpers.
- `styles/` – module-scoped styles.
- `hooks/` – React hooks.
- `contract/` – UI-only types/config for the shell.
- `helper/` – pure helpers.

Add additional engineering folders as needed; keep modules copy/paste friendly.

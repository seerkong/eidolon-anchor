# Eidolon Config Examples

These files are sanitized examples for local Eidolon configuration.

- `agent-present.json` selects the default preset and fallback model chain.
- `llm-provider.json` declares provider adapters, endpoints, model options, and limits.
- `permissions.json` declares local command and edit permission defaults.

Replace `${OPENAI_API_KEY}`, `${DEEPSEEK_API_KEY}`, and `${ANTHROPIC_API_KEY}` with your own secret loading mechanism before use. Do not commit real API keys or machine-specific absolute paths.

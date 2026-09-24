# Jev Playwright Repair Lab

Build a locator-only Playwright repair tool and compare deterministic rules,
Azure OpenAI GPT-5.5, and Jev on the same finite choices.

This project is under construction. No model benchmark results have been
collected yet. A passing test alone will not count as a successful repair:
an independent target and application-state check must also pass.

The public demo will replay recorded, sanitized results without API keys.
Live model calls run only in the local CLI. Credentials, raw runs, and the
Zenn article are kept outside this repository and all deployment artifacts.

## Guardrails

- Only self-authored fixtures; this is not an arbitrary-repository repair agent.
- Change a supported static locator, never assertions, actions, or input values.
- Never hide ambiguity with `.first()`, forced actions, skips, or longer timeouts.
- Do not attribute deterministic safety guards to model intelligence.
- API spending requires configured credentials, verified pricing, and a shared
  budget ledger capped at USD 10. No automatic purchasing or top-ups.

## License

MIT. See [LICENSE](LICENSE).

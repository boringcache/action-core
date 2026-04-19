# @boringcache/action-core

Legacy shared helpers used by older BoringCache GitHub Actions.

This package is for compatibility with older action code. It is not a workflow entrypoint; use [`boringcache/one@v1`](https://github.com/boringcache/one) for workflows.

Maintained product action code now lives directly in [`boringcache/one`](https://github.com/boringcache/one), including the internal core helpers under `lib/core/`. Do not add new product behavior here first; keep `one` self-contained so action releases do not depend on a separate npm package release train.

Install only when maintaining older action code:

```bash
npm install @boringcache/action-core
```

Exports:
- `ensureBoringCache(options)`: install or reuse the CLI on the runner.
- `execBoringCache(args, options)`: run the CLI from an action.
- token and capability helpers for restore-only versus save-capable flows.
- proxy and compatibility helpers used by older actions.

## Learn more

- [GitHub Actions docs](https://boringcache.com/docs#one-action)
- [GitHub Actions auth and trust model](https://boringcache.com/docs#actions-auth)

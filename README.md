# @boringcache/action-core

Shared helpers used by BoringCache GitHub Actions.

This package is for action authors and internal integrations. It is not a workflow entrypoint; use [`boringcache/one@v1`](https://github.com/boringcache/one) for workflows.

Install:

```bash
npm install @boringcache/action-core
```

Exports:
- `ensureBoringCache(options)`: install or reuse the CLI on the runner.
- `execBoringCache(args, options)`: run the CLI from an action.
- token and capability helpers for restore-only versus save-capable flows.
- proxy and compatibility helpers shared by maintained actions.

## Learn more

- [GitHub Actions docs](https://boringcache.com/docs#one-action)
- [GitHub Actions auth and trust model](https://boringcache.com/docs#actions-auth)

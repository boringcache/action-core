# @boringcache/action-core

Shared helpers used by BoringCache GitHub Actions.

This package is for action authors and internal integrations. If you are setting up a workflow, use [`boringcache/one@v1`](https://github.com/boringcache/one). `action-core` is not a workflow entrypoint, and archived wrapper actions are not the recommended path.

## When to use it

Use this package when you are writing or maintaining a BoringCache action and need shared CLI install, auth, proxy, and compatibility helpers.

## Install

```bash
npm install @boringcache/action-core
```

## What it provides

- `ensureBoringCache(options)`: install or reuse the CLI on the runner.
- `execBoringCache(args, options)`: run the CLI from an action.
- `getAuthTokens()`: read the configured restore/save/legacy tokens.
- `hasRestoreToken()` / `hasSaveToken()`: capability-aware checks for action logic.
- `warnIfUsingLegacyApiToken()`: compatibility warning for old workflows.

## Auth model

- Restore flows prefer `BORINGCACHE_RESTORE_TOKEN`, then `BORINGCACHE_SAVE_TOKEN`, then `BORINGCACHE_API_TOKEN`.
- Save flows prefer `BORINGCACHE_SAVE_TOKEN`, then `BORINGCACHE_API_TOKEN`.
- Combined restore/save actions should skip save cleanly when no save-capable token is configured.
- Proxy-backed actions should downgrade to read-only when only a restore-capable token is available and the backend supports it.
- `BORINGCACHE_API_TOKEN` is a legacy fallback, not the preferred path for new workflows.

## Learn more

- [GitHub Actions docs](https://boringcache.com/docs#action)
- [GitHub Actions auth and trust model](https://boringcache.com/docs#actions-auth)

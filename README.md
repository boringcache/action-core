# @boringcache/action-core

Shared helpers used by BoringCache GitHub Actions.

This package is for action authors and internal integrations. It is not a workflow entrypoint; use [`boringcache/one@v1`](https://github.com/boringcache/one) for workflows.

Install:

```bash
npm install @boringcache/action-core
```

Exports:

- `ensureBoringCache`
- `execBoringCache`
- `getAuthTokens`
- `hasRestoreToken`
- `hasSaveToken`
- `warnIfUsingLegacyApiToken`

# @boringcache/action-core

**Cache once. Reuse everywhere.**

Shared core library for BoringCache GitHub Actions. This package provides the common functionality used by all BoringCache actions to download, install, and execute the BoringCache CLI.

## Installation

```bash
npm install @boringcache/action-core
```

## Usage

```typescript
import { ensureBoringCache, execBoringCache } from '@boringcache/action-core';

// Ensure the CLI is installed
await ensureBoringCache({ version: 'v1.0.1' });

// Execute CLI commands
const exitCode = await execBoringCache(['restore', 'workspace', 'tag:path']);
```

## API

### `ensureBoringCache(options: SetupOptions): Promise<void>`

Downloads and installs the BoringCache CLI if not already available.

**Options:**
- `version` (required): Version to install (e.g., `'v1.0.1'`). Set to `'skip'` to skip installation.
- `token` (optional): API token (defaults to `BORINGCACHE_API_TOKEN` env var)
- `cache` (optional): Enable automatic caching across workflow runs (default: `true`)

**Features:**
- Automatic platform detection (Linux, macOS, Windows)
- **Automatic caching** - CLI is cached across workflow runs using `@actions/cache`
- Uses GitHub Actions tool cache for fast subsequent jobs
- Handles Windows bash fallback
- Masks API token in logs

### `execBoringCache(args: string[], options?: ExecOptions): Promise<number>`

Executes the BoringCache CLI with the given arguments.

**Parameters:**
- `args`: Command line arguments to pass to the CLI
- `options`: Optional exec options (from `@actions/exec`)

**Returns:** Exit code from the command

### `isCliAvailable(): Promise<boolean>`

Checks if the BoringCache CLI is available on the PATH.

### `getToolCacheInfo(version: string): ToolCacheInfo`

Get tool cache information for persisting the CLI across workflow runs.

**Returns:**
```typescript
interface ToolCacheInfo {
  toolName: string;      // 'boringcache'
  version: string;       // Normalized version (e.g., '1.0.0')
  cachePath: string | null;  // Path if cached, null otherwise
  cachePattern: string;  // Glob pattern for actions/cache
  cacheKey: string;      // Cache key for actions/cache
}
```

## Automatic Caching

The CLI is **automatically cached** across workflow runs using `@actions/cache`. No extra configuration needed!

```typescript
// First workflow run: downloads CLI and saves to cache
await ensureBoringCache({ version: 'v1.0.1' });

// Subsequent runs: restores from cache instantly
await ensureBoringCache({ version: 'v1.0.1' });
```

To disable automatic caching:

```typescript
await ensureBoringCache({ version: 'v1.0.1', cache: false });
```

### Manual Cache Control

For advanced use cases, you can use `getToolCacheInfo()` to manage caching yourself:

```typescript
import * as cache from '@actions/cache';
import { ensureBoringCache, getToolCacheInfo } from '@boringcache/action-core';

const info = getToolCacheInfo('v1.0.1');
console.log(info.cacheKey);     // 'boringcache-1.0.0-linux-x64'
console.log(info.cachePattern); // '/opt/hostedtoolcache/boringcache/1.0.0*'
console.log(info.cachePath);    // Path if cached, null otherwise
```

## How Tool Cache Works

```
┌─────────────────────────────────────────────────────────────────┐
│ First Run (no cache)                                            │
├─────────────────────────────────────────────────────────────────┤
│ 1. tc.find('boringcache', '1.0.0') → null                       │
│ 2. tc.downloadTool(url) → /tmp/downloaded-binary                │
│ 3. tc.cacheDir(dir, 'boringcache', '1.0.0')                     │
│    → $RUNNER_TOOL_CACHE/boringcache/1.0.0/x64/                  │
│ 4. core.addPath(cachedPath)                                     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Subsequent Run (same job/workflow)                              │
├─────────────────────────────────────────────────────────────────┤
│ 1. tc.find('boringcache', '1.0.0')                              │
│    → $RUNNER_TOOL_CACHE/boringcache/1.0.0/x64/                  │
│ 2. core.addPath(cachedPath) ✓ (no download needed)              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ With actions/cache (persists across workflow runs)              │
├─────────────────────────────────────────────────────────────────┤
│ 1. actions/cache restores $RUNNER_TOOL_CACHE/boringcache        │
│ 2. tc.find('boringcache', '1.0.0') → cached path ✓              │
│ 3. No download needed on any run!                               │
└─────────────────────────────────────────────────────────────────┘
```

## Environment Variables

- `BORINGCACHE_API_TOKEN`: API token for authentication
- `RUNNER_OS`: GitHub Actions runner OS (auto-detected)
- `RUNNER_ARCH`: GitHub Actions runner architecture (auto-detected)
- `RUNNER_TOOL_CACHE`: Tool cache directory (auto-detected)

## Supported Platforms

| OS      | Architecture |
|---------|-------------|
| Linux   | x64, ARM64  |
| macOS   | ARM64       |
| Windows | x64         |

## License

MIT

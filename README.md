# routedrift

Static analysis for a bug class TypeScript can't see: your frontend calling an API route that doesn't exist.

```
ERROR components/UserCard.tsx:13:3
       calls GET /api/user/:id
       no matching route found in backend
    12 | const load = (id: string) =>
  > 13 |   fetch(`/api/user/${id}`)
       |   ^

ERROR components/UserCard.tsx:16:3
       calls POST /api/posts
       path exists, but the backend only accepts GET
    15 | const create = () =>
  > 16 |   fetch('/api/posts', { method: 'POST' })
       |   ^

WARN  app/api/legacy/export/route.ts:1:1
       defines GET /api/legacy/export
       no call sites found

Resolved 5 of 5 call sites (100%)
Scanned 4 routes
2 errors, 1 warning
```

## The problem

A URL is just a string. `fetch('/api/users/5')` type-checks whether or not that route exists — TypeScript has no way to know. Rename a backend route and every frontend call to the old path still compiles, still passes ESLint, still passes your tests. It ships. Someone clicks the button and gets a 404.

The same blind spot hides the opposite problem: backend routes nobody calls anymore, kept alive because nobody can prove they're dead.

routedrift reads both halves of your codebase — the routes your backend defines and the calls your frontend makes — and reports where they disagree.

## Install

```bash
npm install -g routedrift
```

Or run it without installing:

```bash
npx routedrift
```

## Usage

```bash
routedrift                              # scan the current directory
routedrift ./apps/web                   # scan a specific path
routedrift --strict                     # fail on warnings too, not just errors
routedrift --json > report.json         # machine-readable output for CI
routedrift --ignore "GET /api/health"   # suppress a specific finding
routedrift --update-baseline            # snapshot current findings, adopt incrementally
```

Exit codes are part of the interface: `0` clean, `1` findings at or above your `--fail-on` threshold, `2` the tool itself failed to run. CI needs to tell "your code has drift" apart from "the linter crashed" — collapsing both into exit code `1` is how a check quietly gets disabled six months later.

### Flags

| Flag | Effect |
|---|---|
| `--json` | Emit a machine-readable report on stdout |
| `--fail-on <level>` | `error` (default) \| `warn` \| `never` |
| `--strict` | Shorthand for `--fail-on warn` |
| `--ignore <pattern>` | Suppress findings. Repeatable. Accepts a file glob (`src/legacy/**`) or an endpoint (`GET /api/health`, `* /api/internal/**`) |
| `--config <file>` | Path to a config file |
| `--baseline [file]` | Compare against a baseline (default `.routedrift-baseline.json`) |
| `--update-baseline` | Write current findings to the baseline and exit `0` |
| `--no-dead-routes` | Don't report unused backend routes |
| `--quiet` | Hide unresolved call sites; coverage is still reported |
| `--no-color` | Disable colour |

## What it catches

**Broken call** — the frontend calls a route the backend doesn't define, or calls the right path with the wrong HTTP method. Reported as an error.

**Dead route** — the backend defines a route no frontend call site reaches. Reported as a warning.

**Unresolved** — a call site whose URL couldn't be determined statically (built from a runtime value with no traceable source). Never treated as an error; counted toward a coverage percentage instead, so the tool tells you what it couldn't check rather than guessing.

## Adopting on an existing repo

A large codebase will have real, pre-existing drift. `--update-baseline` snapshots what's already there so only *new* drift fails your build:

```bash
routedrift --update-baseline
git add .routedrift-baseline.json
```

From then on, `routedrift --baseline` only reports findings that aren't in the snapshot.

## Config file

Drop a `routedrift.config.json` in your project root, or add a `"routedrift"` key to `package.json`:

```json
{
  "include": ["**/*.{ts,tsx,js,jsx}"],
  "exclude": ["**/node_modules/**", "**/*.d.ts"],
  "frameworks": ["nextjs"],
  "ignore": ["GET /api/health", "src/legacy/**"],
  "ignoreRoutes": ["POST /api/webhooks/*"],
  "failOn": "error",
  "reportDeadRoutes": true,
  "deadRouteMethods": ["GET", "POST", "PUT", "PATCH", "DELETE"]
}
```

`deadRouteMethods` excludes `HEAD` and `OPTIONS` by default — those are called by browsers and proxies rather than app code, so flagging them unused is almost always noise.

## How resolution works

Most call sites aren't plain string literals:

```ts
const BASE = '/api'
fetch(`${BASE}/users/${userId}/posts`)
```

routedrift parses this with the TypeScript compiler API rather than matching text. Static segments pass through unchanged; each interpolated expression becomes a named parameter. Constants are traced back to their declaration — including one hop across a module boundary — so `BASE` above resolves correctly rather than becoming an opaque wildcard.

It also handles the branching cases that actually show up in real code: a ternary keeps both branches as candidate URLs rather than collapsing to a guess, `??`/`||` fallbacks are treated the same way, and string-valued enum members resolve to their literal value.

What it deliberately does not do: chase a URL built entirely inside a helper function call, or follow a value assigned with `let` (which could be reassigned anywhere). Both are reported as unresolved rather than guessed at. A wrong finding costs more trust than ten correct ones earn, so the tool says "I don't know" instead of pretending.

Both `fetch` and `axios` are recognized — including `axios.get(url)`-style calls, `axios(url, config)`, and instances created with `axios.create(...)`.

## Supported backends

- **Next.js** App Router (`app/**/route.ts`)

Express is deliberately not supported yet. Its routes are registered by function calls and mounted under prefixes (`app.use('/api', router)`), which needs a real mount-tree resolver rather than reading file paths — a bigger job than the file-path case, and one that doesn't touch the resolver, matcher, or reporters when it lands.

## Tested against real repositories

Fixtures prove the tool is correct on cases it was built for. They don't prove much about real code. So I ran it against three open-source repos and checked every "broken" finding by hand before trusting it.

| Repo | Routes | Calls | Broken | Dead | Unresolved | Coverage |
|---|---|---|---|---|---|---|
| [vercel/commerce](https://github.com/vercel/commerce) | 1 | 1 | 0 | 1 | 0 | — |
| [dub](https://github.com/dubinc/dub) (`apps/web`) | 646 | 238 | 0 | 488 | 76 | 68% |
| [papermark](https://github.com/papermark/papermark) | 476 | 378 | 29 | 78 | 78 | 79% |

**vercel/commerce** mostly calls Shopify's external API rather than its own routes — too small a surface to be a fair test, included for completeness.

**dub** is API-first: most of its 488 "dead" routes are public API endpoints meant to be called by external developers, not by dub's own frontend. Zero broken calls, which is itself a useful data point — it means the tool doesn't produce false positives at scale on a 646-route production codebase.

**papermark** is where this got interesting. 29 broken-call findings, and I didn't take the number at face value — I traced every one back to source before believing it:

- **~23** are billing/enterprise routes with no matching open-source route file. Checked whether the calling components are even reachable — some are dead code with zero importers, others are live. Papermark is open-core; billing very plausibly lives in a private hosted backend. Not bugs — this is exactly what `ignoreRoutes` in the config exists for.
- **2** are a real tool limitation, not a papermark bug: a `.pdf` fetched from `/public` gets treated as a call site. Static assets aren't calls. Noted as a known gap, not filtered yet.
- **1 is a real, filed bug**: [the "Revalidate cache" button](https://github.com/papermark/papermark/issues/2201) calls `POST /api/links/:id/revalidate`, which has never existed as a route — the actual endpoint is `GET /api/revalidate`, secured by a server-side secret the button can't supply. Confirmed via git blame the bug was introduced six days before I found it, and confirmed the button is wired to a real, clickable `onClick`, not dead code. Issue filed and open with maintainers.

That last one is the actual point of building this: a fixture can't surprise you. A 9,000-star production repo can, and did.

## Why this exists

TypeScript checks types. ESLint checks a file in isolation. Neither has any notion of "the backend" as a thing separate from "the frontend," so a route that moves or disappears is invisible to both. Existing contract-testing tools (Pact, OpenAPI diffing) require you to already maintain a spec — which is exactly the maintenance burden most `fetch`-based codebases don't have. routedrift needs nothing but the code that's already there.

## License

MIT

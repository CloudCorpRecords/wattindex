# wattindex — Build Report

MCP Rebuild 1000, Batch 11. Rebuild of the `leadgreen-mcp`
package from katonic-dev/leadgreen-ai (rank 443), from the
firsthand spec at `specs-batch11/leadgreen.md` (the package
README's signature tables + Parameters section). Local build
only — nothing pushed or published.

Identity: repo `wattindex`, npm `@reneturcios/wattindex`, MCP
name `io.github.CloudCorpRecords/wattindex`, version `0.1.0`,
bin `wattindex` → `dist/cli.js`.

## Files created (19 template files + this report)

- `package.json`, `server.json` (description "GPU energy per
  million output tokens by model and GPU, with grid carbon
  intensity.", 82 chars ≤100; npm entry carries
  `version: 0.1.0`; OCI entry
  `ghcr.io/cloudcorprecords/wattindex:0.1.0` carries **no**
  `version` field), `Dockerfile` (node:20-alpine two-stage,
  label `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/wattindex"`),
  `tsconfig.json`, `.gitignore`, `LICENSE` (MIT, Copyright (c)
  2026 Rene Turcios), `README.md`, `CHANGELOG.md` (single 0.1.0
  entry, 2026-10-27), `package-lock.json` (Route 3, see below)
- `src/index.ts`, `src/cli.ts` (subcommands mirroring the
  tools: `list-models`, `energy`, `estimate`, `compare-gpus`,
  `concurrency-curve`, `grid-intensity`, `gpu-hardware`,
  `sources`, plus `mcp` and `--version`; exit 2 usage / 1
  runtime error), `src/mcp.ts`, `src/types.ts`,
  `src/wattindex.ts` (core, `VERSION = "0.1.0"`)
- `test/wattindex.test.ts`
- `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`

## Tools implemented (8)

- `list_models` — no args
- `energy_per_million_tokens` — `model` (req), `gpu`,
  `itl_deadline_ms`
- `estimate` — `model`, `output_tokens` (req), `gpu`,
  `country`, `running_batch`, `num_gpus` (integer),
  `itl_deadline_ms`, `pue`, `system_power_ratio`
- `compare_gpus` — `model` (req), `itl_deadline_ms`
- `concurrency_curve` — `model`, `gpu` (req)
- `grid_intensity` — `country` (req)
- `gpu_hardware` — `gpu` (optional)
- `sources` — no args

## Implementation notes

- `src/mcp.ts` uses the SDK's low-level `Server` with explicit
  inputSchema literals exactly matching the fixture; zod
  validates every `tools/call`.
- Data flows through an injectable `Loader` (see `types.ts`).
  The default loader reads `index.json` from the JSON API base
  in `LEADGREEN_API_BASE` (default `https://leadgreen.ai/api/v1`):
  an http(s) base is fetched (`data_source: "live"`), any other
  value is a local folder (`data_source: "local folder"`). All
  lookups and arithmetic are local.
- **Dataset shape (documented local choice):** one dataset
  document — `models[]` each with energy `rows[]` (gpu,
  wh_per_million_tokens, median_itl_ms, running_batch,
  num_gpus), `grid[]` intensities by country (canonical name,
  aliases incl. ISO alpha-2/alpha-3, gco2e_per_kwh,
  latest_year, per-year map), `gpus[]` hardware specs (max TDP,
  memory, MIG profiles, whole-system ceiling), `sources[]`,
  plus `caveat` / `data_updated` / `data_version`. Defined in
  `src/types.ts`.
- Best-row selection: filter by GPU / exact GPU count, keep
  rows at or under `itl_deadline_ms` (default 500), lowest
  energy wins per GPU; `estimate` instead picks the row nearest
  `running_batch` when that is given. Estimate math:
  Wh = Wh-per-million × output_tokens / 1e6; kg CO2e = kWh ×
  gCO2e/kWh / 1000 via the country intensity; at-meter energy =
  GPU energy × system_power_ratio × pue when either factor is
  given (each validated ≥ 1.0), labelled as the caller's
  assumptions.
- Every result carries `caveat`, `boundary: "gpu_only"`,
  `data_source`, `data_updated`, `data_version`.
- Per the task instruction, the upstream
  `running_batch`/`requests_in_flight` conflict validation is
  not implemented: `requests_in_flight` is not in the schema
  and the schema governs.
- Unknown model/GPU/country is an honest error naming what is
  on the index — never a fabricated figure.

## Verification (foreground, firsthand)

- `tsc --noEmit` exit 0; `tsc` build exit 0 (`dist/cli.js`)
- `tsx --test test/*.test.ts`: **18 tests, 18 pass, 0 fail** —
  fake loader over a fixture dataset (no live network):
  envelope fields, best-row selection + ITL filter (default
  and tight deadlines, GPU filter, empty-after-filter error),
  estimate math incl. CO2e via ISO alias and at-meter with
  PUE × system power ratio, nearest-running-batch and
  num_gpus selection, pue/output_tokens validation, compare,
  concurrency curve ordering, grid years, hardware lookup and
  list, sources, unknown model/country/GPU errors
- `dist/cli.js --version` → `0.1.0`; unknown command → usage,
  exit 2
- Parity: `harness/parity.py` vs
  `harness/fixtures/leadgreen-tools-original.json` →
  **PASS, parity 100.0, identical_tools 8/8**

## Lockfile status

`package-lock.json` generated clean via Route 3 (temp copy
with only `package.json`, offline `npm install
--package-lock-only --ignore-scripts --offline`), verified:
parses, name `@reneturcios/wattindex`, **128 package
entries**. Local `node_modules` is a symlink to the sibling
burnmeter tree; gitignored.

## Gaps / honest notes

- The upstream API file layout is not published in the spec;
  the single-document `index.json` dataset shape above is this
  rebuild's documented local choice. Behaviour against the
  live API is unproven in this environment (tests use a fake
  loader by design).
- `compare_gpus` returns the H100/B200 best rows when either
  is present for the model, and falls back to all GPUs' best
  rows otherwise.
- The upstream `leadgreen://manifest` resource is not a tool
  and is out of the parity set, per the spec.
- Container build not exercised locally; the
  publish-container workflow smoke-tests the image at publish
  time.

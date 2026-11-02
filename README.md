# wattindex

How much GPU energy does it take to serve a million output
tokens? wattindex answers from a public index of measured
configurations: watt-hours per million output tokens by model,
GPU and running batch, with grid carbon intensity to price the
energy anywhere.

- Best-row selection keeps only rows whose median inter-token
  latency is at or under your deadline (`itl_deadline_ms`,
  default 500 ms) and the lowest energy wins.
- `estimate` scales a row to any token count, adds kg CO2e for a
  country's grid, and — when you supply `pue` and/or
  `system_power_ratio` (each at least 1.0) — energy at the
  meter, labelled as your assumptions.
- Every response states its boundary (`gpu_only`), the caveat
  from the index, and whether the data came from the live API,
  a bundled snapshot, or a local folder, with update date and
  data version.

Data is read from the JSON API base in `LEADGREEN_API_BASE`
(default `https://leadgreen.ai/api/v1`); a non-URL value is a
local folder holding the API files, for fully-offline use. All
lookups and arithmetic happen locally.

## CLI

```bash
npx @reneturcios/wattindex list-models
npx @reneturcios/wattindex energy --model llama-3.1-70b --gpu H100
npx @reneturcios/wattindex estimate --model llama-3.1-70b --output-tokens 5000000 --country DE --pue 1.2
npx @reneturcios/wattindex compare-gpus --model llama-3.1-70b
npx @reneturcios/wattindex concurrency-curve --model llama-3.1-70b --gpu H100
npx @reneturcios/wattindex grid-intensity --country World
npx @reneturcios/wattindex gpu-hardware --gpu B200
npx @reneturcios/wattindex sources
npx @reneturcios/wattindex --version
```

Output is JSON. Exit codes: `0` on success, `1` on a runtime
error (unknown model/GPU/country, unreadable or unreachable
dataset), `2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/wattindex mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "wattindex": {
      "command": "npx",
      "args": ["-y", "@reneturcios/wattindex", "mcp"]
    }
  }
}
```

### Tools

- `list_models` — models on the index and the GPUs each has
  measurements for
- `energy_per_million_tokens` — best row per GPU for a model
  - `model` (string, required), `gpu` (string, optional),
    `itl_deadline_ms` (number, optional, default 500)
- `estimate` — GPU energy for a token count, kg CO2e, optional
  energy at the meter
  - `model` (string, required), `output_tokens` (number,
    required), `gpu`, `country`, `running_batch`, `num_gpus`,
    `itl_deadline_ms`, `pue`, `system_power_ratio` (optional)
- `compare_gpus` — H100 versus B200 best rows for a model
  - `model` (string, required), `itl_deadline_ms` (optional)
- `concurrency_curve` — energy at every measured running batch
  - `model`, `gpu` (strings, required)
- `grid_intensity` — annual average gCO2e per kWh for a country
  (name, short name, ISO alpha-2/alpha-3, or `World`)
  - `country` (string, required)
- `gpu_hardware` — max TDP, memory, MIG profiles, whole-system
  ceilings
  - `gpu` (string, optional; omit to list every GPU)
- `sources` — every source, version, retrieval date and licence

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/wattindex
docker run --rm ghcr.io/cloudcorprecords/wattindex grid-intensity --country DE
```

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsx --test test/*.test.ts (fake loader, no network)
npm run dev     # run the CLI from source
```

## License

MIT — Copyright (c) 2026 Rene Turcios

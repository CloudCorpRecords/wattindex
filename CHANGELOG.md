# Changelog

## 0.1.0 (2026-10-27)

- Initial release: eight MCP tools over the GPU energy index —
  `list_models`, `energy_per_million_tokens`, `estimate`,
  `compare_gpus`, `concurrency_curve`, `grid_intensity`,
  `gpu_hardware`, `sources` — with matching CLI subcommands.
- Best-row selection honours the inter-token latency deadline
  (default 500 ms); estimates add kg CO2e via grid intensity
  and optional energy at the meter from caller-supplied PUE /
  system power ratio. Every result carries the caveat,
  `gpu_only` boundary, and data provenance fields.

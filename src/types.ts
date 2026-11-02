/**
 * wattindex types.
 *
 * wattindex answers questions about the GPU energy it takes to
 * serve LLM output tokens: watt-hours per million output tokens
 * by model, GPU and serving configuration, plus grid carbon
 * intensity so an energy figure can be priced anywhere.
 *
 * Dataset shape (a documented local choice): the upstream API at
 * LEADGREEN_API_BASE publishes JSON files; this rebuild defines
 * one dataset document with the shape below and the loader in
 * wattindex.ts reads `index.json` from the base (an HTTP URL) or
 * from a local folder of that name. The dataset carries:
 *
 *   models  — each model has energy rows; a row is one measured
 *             configuration: GPU, Wh per million output tokens,
 *             median inter-token latency (ms), average running
 *             batch, and GPU count.
 *   grid    — annual average grid intensities by country
 *             (gCO2e per kWh), with aliases (short name, ISO
 *             alpha-2/alpha-3) and per-year values.
 *   gpus    — hardware specs per GPU: max TDP, memory, MIG
 *             profiles, whole-system power ceiling.
 *   sources — every source behind the index, with version,
 *             retrieval date and licence.
 *   caveat / data_updated / data_version — provenance stamped
 *             onto every result.
 */

/** One measured serving configuration for a model. */
export interface EnergyRow {
  gpu: string;
  /** Watt-hours per million output tokens for this configuration. */
  wh_per_million_tokens: number;
  /** Median inter-token latency, milliseconds. */
  median_itl_ms: number;
  /** Average running batch the measurement was taken at. */
  running_batch: number;
  /** Number of GPUs in the configuration. */
  num_gpus: number;
}

/** A model on the index and its measured configurations. */
export interface ModelEntry {
  name: string;
  rows: EnergyRow[];
}

/** Annual average grid carbon intensity for one country (or World). */
export interface GridEntry {
  country: string;
  /** Alternate names: short name, ISO 3166 alpha-2 / alpha-3 codes. */
  aliases?: string[];
  /** gCO2e per kWh for the latest year. */
  gco2e_per_kwh: number;
  /** The year `gco2e_per_kwh` describes. */
  latest_year: number;
  /** Per-year values, keyed by year, when more than one is known. */
  years?: Record<string, number>;
}

/** Hardware specification for one GPU. */
export interface GpuHardware {
  name: string;
  /** Maximum thermal design power, watts. */
  max_tdp_w: number;
  /** On-package memory, GB. */
  memory_gb: number;
  memory_type?: string;
  /** MIG profile names the GPU supports. */
  mig_profiles?: string[];
  /** Whole-system power ceiling, watts, when published. */
  whole_system_ceiling_w?: number;
}

/** One source behind the index. */
export interface SourceEntry {
  name: string;
  version?: string;
  /** Retrieval date (ISO date). */
  retrieved?: string;
  licence?: string;
  url?: string;
}

/** The whole index dataset, as loaded. */
export interface Dataset {
  /** The caveat sentence stamped on every response. */
  caveat: string;
  data_updated: string;
  data_version: string;
  models: ModelEntry[];
  grid: GridEntry[];
  gpus: GpuHardware[];
  sources: SourceEntry[];
}

/** A dataset plus where it came from: "live", "bundled snapshot", or "local folder". */
export interface LoadedData {
  dataset: Dataset;
  data_source: string;
}

/** Injectable dataset loader; tests substitute a fake over a fixture. */
export type Loader = () => Promise<LoadedData>;

/** Provenance fields present on every tool result. */
export interface Envelope {
  caveat: string;
  boundary: "gpu_only";
  data_source: string;
  data_updated: string;
  data_version: string;
}

/**
 * wattindex core: GPU energy per million output tokens.
 *
 * All computation is local, over a dataset obtained through an
 * injectable Loader. The default loader reads `index.json` from
 * the JSON API base in LEADGREEN_API_BASE (default
 * https://leadgreen.ai/api/v1): an http(s) base is fetched, any
 * other value is treated as a local folder holding the file.
 * Tests inject a fake loader over a small fixture — no network.
 *
 * Row selection: for a model, rows are filtered by GPU (when
 * given), by exact GPU count (when given), and by the latency
 * ceiling — rows whose median inter-token latency is at or under
 * itl_deadline_ms (default 500) are kept and the lowest energy
 * wins. When running_batch is given, the measured configuration
 * nearest to it wins instead. An unknown model, GPU, or country
 * is an error naming what is known — never a fabricated figure.
 *
 * estimate: energy_wh = wh_per_million_tokens / 1e6 *
 * output_tokens. With a country, kg CO2e = energy_kwh *
 * gco2e_per_kwh / 1000. When pue and/or system_power_ratio is
 * given (each at least 1.0), energy at the meter is also
 * returned: GPU energy x system_power_ratio x pue, labelled as
 * the caller's assumptions.
 *
 * Every result carries the provenance envelope: caveat,
 * boundary ("gpu_only"), data_source, data_updated,
 * data_version.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Dataset,
  EnergyRow,
  Envelope,
  GridEntry,
  LoadedData,
  Loader,
  ModelEntry,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ITL_DEADLINE_MS = 500;

export const DEFAULT_API_BASE = "https://leadgreen.ai/api/v1";

/** The default loader: fetch (or read) index.json from the API base. */
export function defaultLoader(base?: string): Loader {
  const root = base ?? process.env.LEADGREEN_API_BASE ?? DEFAULT_API_BASE;
  return async () => {
    if (/^https?:\/\//i.test(root)) {
      const res = await fetch(`${root.replace(/\/$/, "")}/index.json`);
      if (!res.ok) {
        throw new Error(`failed to fetch dataset from ${root}/index.json: HTTP ${res.status}`);
      }
      const dataset = (await res.json()) as Dataset;
      return { dataset, data_source: "live" };
    }
    const raw = await readFile(join(root, "index.json"), "utf8");
    return { dataset: JSON.parse(raw) as Dataset, data_source: "local folder" };
  };
}

function envelope(loaded: LoadedData): Envelope {
  return {
    caveat: loaded.dataset.caveat,
    boundary: "gpu_only",
    data_source: loaded.data_source,
    data_updated: loaded.dataset.data_updated,
    data_version: loaded.dataset.data_version,
  };
}

function eq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function findModel(dataset: Dataset, model: unknown): ModelEntry {
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("model is required and must be a non-empty string");
  }
  const found = dataset.models.find((m) => eq(m.name, model));
  if (!found) {
    const known = dataset.models.map((m) => m.name).join(", ");
    throw new Error(`unknown model: ${model} (models on the index: ${known})`);
  }
  return found;
}

function checkDeadline(value: unknown): number {
  if (value === undefined) return DEFAULT_ITL_DEADLINE_MS;
  if (typeof value !== "number" || !(value > 0)) {
    throw new Error("itl_deadline_ms must be a positive number");
  }
  return value;
}

function checkFactor(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || value < 1.0) {
    throw new Error(`${label} must be a number of at least 1.0`);
  }
  return value;
}

/**
 * Rows for a model after the gpu / num_gpus / latency filters.
 * Throws when a named GPU has no rows for the model, or when no
 * row survives the latency ceiling.
 */
function selectRows(
  entry: ModelEntry,
  opts: { gpu?: unknown; num_gpus?: unknown; itl_deadline_ms?: unknown },
): EnergyRow[] {
  let rows = entry.rows;
  if (opts.gpu !== undefined) {
    if (typeof opts.gpu !== "string" || opts.gpu.length === 0) {
      throw new Error("gpu must be a non-empty string");
    }
    const gpuRows = rows.filter((r) => eq(r.gpu, opts.gpu as string));
    if (gpuRows.length === 0) {
      const known = [...new Set(entry.rows.map((r) => r.gpu))].join(", ");
      throw new Error(`no rows for model ${entry.name} on gpu ${opts.gpu} (gpus: ${known})`);
    }
    rows = gpuRows;
  }
  if (opts.num_gpus !== undefined) {
    if (!Number.isInteger(opts.num_gpus) || (opts.num_gpus as number) < 1) {
      throw new Error("num_gpus must be a positive integer");
    }
    rows = rows.filter((r) => r.num_gpus === opts.num_gpus);
    if (rows.length === 0) {
      throw new Error(`no rows for model ${entry.name} on exactly ${opts.num_gpus} gpu(s)`);
    }
  }
  const deadline = checkDeadline(opts.itl_deadline_ms);
  const within = rows.filter((r) => r.median_itl_ms <= deadline);
  if (within.length === 0) {
    throw new Error(
      `no rows for model ${entry.name} at or under itl_deadline_ms ${deadline}`,
    );
  }
  return within;
}

/** The lowest-energy row per GPU among the given rows. */
function bestPerGpu(rows: EnergyRow[]): EnergyRow[] {
  const best = new Map<string, EnergyRow>();
  for (const row of rows) {
    const cur = best.get(row.gpu.toLowerCase());
    if (!cur || row.wh_per_million_tokens < cur.wh_per_million_tokens) {
      best.set(row.gpu.toLowerCase(), row);
    }
  }
  return [...best.values()].sort((a, b) => a.gpu.localeCompare(b.gpu));
}

function rowView(row: EnergyRow) {
  return {
    gpu: row.gpu,
    wh_per_million_tokens: row.wh_per_million_tokens,
    median_itl_ms: row.median_itl_ms,
    running_batch: row.running_batch,
    num_gpus: row.num_gpus,
  };
}

function findGrid(dataset: Dataset, country: unknown): GridEntry {
  if (typeof country !== "string" || country.length === 0) {
    throw new Error("country is required and must be a non-empty string");
  }
  const found = dataset.grid.find(
    (g) => eq(g.country, country) || (g.aliases ?? []).some((a) => eq(a, country)),
  );
  if (!found) {
    const known = dataset.grid.map((g) => g.country).join(", ");
    throw new Error(`unknown country: ${country} (countries on the index: ${known})`);
  }
  return found;
}

/** list_models: which models are on the index and on which GPUs. */
export async function listModels(loader: Loader) {
  const loaded = await loader();
  return {
    ...envelope(loaded),
    models: loaded.dataset.models.map((m) => ({
      name: m.name,
      gpus: [...new Set(m.rows.map((r) => r.gpu))].sort(),
      configurations: m.rows.length,
    })),
  };
}

/** energy_per_million_tokens: the best row per GPU for a model. */
export async function energyPerMillionTokens(
  loader: Loader,
  args: { model: unknown; gpu?: unknown; itl_deadline_ms?: unknown },
) {
  const loaded = await loader();
  const entry = findModel(loaded.dataset, args.model);
  const rows = selectRows(entry, args);
  return {
    ...envelope(loaded),
    model: entry.name,
    itl_deadline_ms: checkDeadline(args.itl_deadline_ms),
    best_rows: bestPerGpu(rows).map(rowView),
  };
}

/** estimate: GPU energy (and optionally CO2e / at-meter) for a token count. */
export async function estimate(
  loader: Loader,
  args: {
    model: unknown;
    output_tokens: unknown;
    gpu?: unknown;
    country?: unknown;
    running_batch?: unknown;
    num_gpus?: unknown;
    itl_deadline_ms?: unknown;
    pue?: unknown;
    system_power_ratio?: unknown;
  },
) {
  const loaded = await loader();
  const entry = findModel(loaded.dataset, args.model);
  if (typeof args.output_tokens !== "number" || !(args.output_tokens > 0)) {
    throw new Error("output_tokens is required and must be a positive number");
  }
  const pue = checkFactor(args.pue, "pue");
  const spr = checkFactor(args.system_power_ratio, "system_power_ratio");

  const rows = selectRows(entry, args);
  let row: EnergyRow;
  let selection: string;
  if (args.running_batch !== undefined) {
    if (typeof args.running_batch !== "number" || !(args.running_batch > 0)) {
      throw new Error("running_batch must be a positive number");
    }
    const target = args.running_batch;
    row = [...rows].sort(
      (a, b) =>
        Math.abs(a.running_batch - target) - Math.abs(b.running_batch - target) ||
        a.wh_per_million_tokens - b.wh_per_million_tokens,
    )[0];
    selection = "nearest_running_batch";
  } else {
    row = [...rows].sort((a, b) => a.wh_per_million_tokens - b.wh_per_million_tokens)[0];
    selection = "lowest_energy";
  }

  const energyWh = (row.wh_per_million_tokens / 1_000_000) * args.output_tokens;
  const out: Record<string, unknown> = {
    ...envelope(loaded),
    model: entry.name,
    output_tokens: args.output_tokens,
    selection,
    row: rowView(row),
    energy_wh: energyWh,
    energy_kwh: energyWh / 1000,
  };
  if (args.country !== undefined) {
    const grid = findGrid(loaded.dataset, args.country);
    out.country = grid.country;
    out.gco2e_per_kwh = grid.gco2e_per_kwh;
    out.kg_co2e = ((energyWh / 1000) * grid.gco2e_per_kwh) / 1000;
  }
  if (pue !== undefined || spr !== undefined) {
    const atMeter = energyWh * (spr ?? 1) * (pue ?? 1);
    out.energy_at_meter_wh = atMeter;
    out.energy_at_meter_kwh = atMeter / 1000;
    out.at_meter_assumptions = {
      pue: pue ?? 1,
      system_power_ratio: spr ?? 1,
      note: "caller's assumptions: energy at the meter = GPU energy x system_power_ratio x pue",
    };
  }
  return out;
}

/** compare_gpus: H100 versus B200 best rows for a model. */
export async function compareGpus(
  loader: Loader,
  args: { model: unknown; itl_deadline_ms?: unknown },
) {
  const loaded = await loader();
  const entry = findModel(loaded.dataset, args.model);
  const rows = selectRows(entry, args);
  const best = bestPerGpu(rows);
  const pair = best.filter((r) => eq(r.gpu, "H100") || eq(r.gpu, "B200"));
  return {
    ...envelope(loaded),
    model: entry.name,
    itl_deadline_ms: checkDeadline(args.itl_deadline_ms),
    comparison: (pair.length > 0 ? pair : best).map(rowView),
  };
}

/** concurrency_curve: energy at every measured running batch. */
export async function concurrencyCurve(
  loader: Loader,
  args: { model: unknown; gpu: unknown },
) {
  const loaded = await loader();
  const entry = findModel(loaded.dataset, args.model);
  if (typeof args.gpu !== "string" || args.gpu.length === 0) {
    throw new Error("gpu is required and must be a non-empty string");
  }
  const rows = entry.rows
    .filter((r) => eq(r.gpu, args.gpu as string))
    .sort((a, b) => a.running_batch - b.running_batch);
  if (rows.length === 0) {
    const known = [...new Set(entry.rows.map((r) => r.gpu))].join(", ");
    throw new Error(`no rows for model ${entry.name} on gpu ${args.gpu} (gpus: ${known})`);
  }
  return {
    ...envelope(loaded),
    model: entry.name,
    gpu: rows[0].gpu,
    curve: rows.map(rowView),
  };
}

/** grid_intensity: annual average gCO2e per kWh for a country or World. */
export async function gridIntensity(loader: Loader, args: { country: unknown }) {
  const loaded = await loader();
  const grid = findGrid(loaded.dataset, args.country);
  return {
    ...envelope(loaded),
    country: grid.country,
    gco2e_per_kwh: grid.gco2e_per_kwh,
    latest_year: grid.latest_year,
    years: grid.years ?? { [String(grid.latest_year)]: grid.gco2e_per_kwh },
  };
}

/** gpu_hardware: specs for one GPU, or every GPU when omitted. */
export async function gpuHardware(loader: Loader, args: { gpu?: unknown }) {
  const loaded = await loader();
  if (args.gpu !== undefined) {
    if (typeof args.gpu !== "string" || args.gpu.length === 0) {
      throw new Error("gpu must be a non-empty string");
    }
    const found = loaded.dataset.gpus.find((g) => eq(g.name, args.gpu as string));
    if (!found) {
      const known = loaded.dataset.gpus.map((g) => g.name).join(", ");
      throw new Error(`unknown gpu: ${args.gpu} (gpus on the index: ${known})`);
    }
    return { ...envelope(loaded), gpu: found };
  }
  return { ...envelope(loaded), gpus: loaded.dataset.gpus };
}

/** sources: every source, version, retrieval date and licence. */
export async function listSources(loader: Loader) {
  const loaded = await loader();
  return { ...envelope(loaded), sources: loaded.dataset.sources };
}

/** Render a payload as the JSON text block MCP clients show. */
export function formatPayload(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

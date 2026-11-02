import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareGpus,
  concurrencyCurve,
  energyPerMillionTokens,
  estimate,
  gridIntensity,
  gpuHardware,
  listModels,
  listSources,
} from "../src/wattindex.js";
import type { Dataset, Loader } from "../src/types.js";

/**
 * All tests run over a fake loader with a small fixture dataset:
 * no live network. Fixture: one model with H100 rows at batches
 * 8/32/64 (the batch-64 row is over the default 500 ms ITL
 * deadline) and B200 rows at batches 8/32.
 */

const FIXTURE: Dataset = {
  caveat: "GPU energy only; figures are measured, not modelled.",
  data_updated: "2026-10-01",
  data_version: "1.2.0",
  models: [
    {
      name: "TestModel",
      rows: [
        { gpu: "H100", wh_per_million_tokens: 120, median_itl_ms: 40, running_batch: 8, num_gpus: 1 },
        { gpu: "H100", wh_per_million_tokens: 90, median_itl_ms: 120, running_batch: 32, num_gpus: 1 },
        { gpu: "H100", wh_per_million_tokens: 200, median_itl_ms: 600, running_batch: 64, num_gpus: 1 },
        { gpu: "B200", wh_per_million_tokens: 60, median_itl_ms: 30, running_batch: 8, num_gpus: 1 },
        { gpu: "B200", wh_per_million_tokens: 45, median_itl_ms: 90, running_batch: 32, num_gpus: 2 },
      ],
    },
  ],
  grid: [
    { country: "World", aliases: [], gco2e_per_kwh: 480, latest_year: 2024, years: { "2024": 480 } },
    {
      country: "Germany",
      aliases: ["DE", "DEU"],
      gco2e_per_kwh: 350,
      latest_year: 2024,
      years: { "2023": 380, "2024": 350 },
    },
  ],
  gpus: [
    {
      name: "H100",
      max_tdp_w: 700,
      memory_gb: 80,
      memory_type: "HBM3",
      mig_profiles: ["1g.10gb", "7g.80gb"],
      whole_system_ceiling_w: 1000,
    },
    { name: "B200", max_tdp_w: 1000, memory_gb: 192, memory_type: "HBM3e" },
  ],
  sources: [
    { name: "Fixture Measurements", version: "1.0", retrieved: "2026-09-15", licence: "CC BY 4.0" },
    { name: "Fixture Grid Data", version: "2024", retrieved: "2026-09-20", licence: "CC BY 4.0" },
  ],
};

const fakeLoader: Loader = async () => ({ dataset: FIXTURE, data_source: "live" });

describe("listModels / envelope", () => {
  it("lists the model with its GPUs and carries the provenance envelope", async () => {
    const out = await listModels(fakeLoader);
    assert.equal(out.models.length, 1);
    assert.equal(out.models[0].name, "TestModel");
    assert.deepEqual(out.models[0].gpus, ["B200", "H100"]);
    assert.equal(out.boundary, "gpu_only");
    assert.equal(out.data_source, "live");
    assert.equal(out.data_updated, "2026-10-01");
    assert.equal(out.data_version, "1.2.0");
    assert.match(out.caveat, /GPU energy only/);
  });
});

describe("energyPerMillionTokens — best row + ITL filter", () => {
  it("picks the lowest-energy row per GPU under the default 500 ms deadline", async () => {
    const out = await energyPerMillionTokens(fakeLoader, { model: "TestModel" });
    assert.deepEqual(
      out.best_rows.map((r) => [r.gpu, r.wh_per_million_tokens]),
      [
        ["B200", 45],
        ["H100", 90],
      ],
    );
  });

  it("honours a tighter deadline, excluding the batch-32 rows", async () => {
    const out = await energyPerMillionTokens(fakeLoader, {
      model: "TestModel",
      itl_deadline_ms: 50,
    });
    assert.deepEqual(
      out.best_rows.map((r) => [r.gpu, r.wh_per_million_tokens]),
      [
        ["B200", 60],
        ["H100", 120],
      ],
    );
  });

  it("filters to a single GPU when gpu is given", async () => {
    const out = await energyPerMillionTokens(fakeLoader, { model: "TestModel", gpu: "h100" });
    assert.equal(out.best_rows.length, 1);
    assert.equal(out.best_rows[0].gpu, "H100");
  });

  it("errors when no row survives the deadline", async () => {
    await assert.rejects(
      () => energyPerMillionTokens(fakeLoader, { model: "TestModel", itl_deadline_ms: 10 }),
      /at or under itl_deadline_ms 10/,
    );
  });
});

describe("estimate — math", () => {
  it("computes Wh and kWh from the best row (90 Wh per 1M x 2M tokens)", async () => {
    const out = (await estimate(fakeLoader, {
      model: "TestModel",
      output_tokens: 2_000_000,
      gpu: "H100",
    })) as Record<string, unknown>;
    assert.equal(out.energy_wh, 180);
    assert.equal(out.energy_kwh, 0.18);
    assert.equal(out.selection, "lowest_energy");
  });

  it("adds kg CO2e via the country intensity, resolving an ISO alias", async () => {
    const out = (await estimate(fakeLoader, {
      model: "TestModel",
      output_tokens: 2_000_000,
      gpu: "H100",
      country: "de",
    })) as Record<string, unknown>;
    assert.equal(out.country, "Germany");
    assert.equal(out.gco2e_per_kwh, 350);
    assert.equal(out.kg_co2e, 0.063);
  });

  it("adds at-meter energy when pue and system_power_ratio are given", async () => {
    const out = (await estimate(fakeLoader, {
      model: "TestModel",
      output_tokens: 2_000_000,
      gpu: "H100",
      pue: 1.2,
      system_power_ratio: 1.1,
    })) as Record<string, unknown>;
    assert.ok(Math.abs((out.energy_at_meter_wh as number) - 237.6) < 1e-9);
    const assumptions = out.at_meter_assumptions as Record<string, unknown>;
    assert.equal(assumptions.pue, 1.2);
    assert.equal(assumptions.system_power_ratio, 1.1);
  });

  it("uses the measured configuration nearest to running_batch", async () => {
    const out = (await estimate(fakeLoader, {
      model: "TestModel",
      output_tokens: 1_000_000,
      gpu: "H100",
      running_batch: 8,
    })) as Record<string, unknown>;
    assert.equal(out.selection, "nearest_running_batch");
    assert.equal(out.energy_wh, 120);
  });

  it("restricts to configurations on exactly num_gpus GPUs", async () => {
    const out = (await estimate(fakeLoader, {
      model: "TestModel",
      output_tokens: 1_000_000,
      gpu: "B200",
      num_gpus: 2,
    })) as Record<string, unknown>;
    assert.equal(out.energy_wh, 45);
  });

  it("rejects pue below 1.0 and non-positive output_tokens", async () => {
    await assert.rejects(
      () => estimate(fakeLoader, { model: "TestModel", output_tokens: 10, pue: 0.9 }),
      /pue must be a number of at least 1\.0/,
    );
    await assert.rejects(
      () => estimate(fakeLoader, { model: "TestModel", output_tokens: 0 }),
      /output_tokens is required/,
    );
  });
});

describe("compareGpus / concurrencyCurve", () => {
  it("compares the H100 and B200 best rows", async () => {
    const out = await compareGpus(fakeLoader, { model: "TestModel" });
    assert.deepEqual(
      out.comparison.map((r) => [r.gpu, r.wh_per_million_tokens]),
      [
        ["B200", 45],
        ["H100", 90],
      ],
    );
  });

  it("returns the curve sorted by running batch, including over-deadline rows", async () => {
    const out = await concurrencyCurve(fakeLoader, { model: "TestModel", gpu: "H100" });
    assert.deepEqual(
      out.curve.map((r) => [r.running_batch, r.wh_per_million_tokens]),
      [
        [8, 120],
        [32, 90],
        [64, 200],
      ],
    );
  });
});

describe("gridIntensity / gpuHardware / listSources", () => {
  it("returns World intensity and per-year values for Germany", async () => {
    const world = await gridIntensity(fakeLoader, { country: "World" });
    assert.equal(world.gco2e_per_kwh, 480);
    assert.equal(world.latest_year, 2024);
    const de = await gridIntensity(fakeLoader, { country: "DEU" });
    assert.equal(de.country, "Germany");
    assert.deepEqual(de.years, { "2023": 380, "2024": 350 });
  });

  it("looks up one GPU's hardware and lists all GPUs when omitted", async () => {
    const one = (await gpuHardware(fakeLoader, { gpu: "H100" })) as {
      gpu: { max_tdp_w: number; mig_profiles?: string[] };
    };
    assert.equal(one.gpu.max_tdp_w, 700);
    assert.deepEqual(one.gpu.mig_profiles, ["1g.10gb", "7g.80gb"]);
    const all = (await gpuHardware(fakeLoader, {})) as { gpus: unknown[] };
    assert.equal(all.gpus.length, 2);
  });

  it("returns every source with its licence", async () => {
    const out = await listSources(fakeLoader);
    assert.equal(out.sources.length, 2);
    assert.equal(out.sources[0].licence, "CC BY 4.0");
    assert.equal(out.sources[0].retrieved, "2026-09-15");
  });
});

describe("honest errors", () => {
  it("rejects an unknown model, naming the models on the index", async () => {
    await assert.rejects(
      () => energyPerMillionTokens(fakeLoader, { model: "Nope" }),
      /unknown model: Nope \(models on the index: TestModel\)/,
    );
  });

  it("rejects an unknown country and an unknown GPU", async () => {
    await assert.rejects(
      () => gridIntensity(fakeLoader, { country: "Atlantis" }),
      /unknown country: Atlantis/,
    );
    await assert.rejects(
      () => gpuHardware(fakeLoader, { gpu: "V100" }),
      /unknown gpu: V100/,
    );
    await assert.rejects(
      () => concurrencyCurve(fakeLoader, { model: "TestModel", gpu: "V100" }),
      /no rows for model TestModel on gpu V100/,
    );
  });
});

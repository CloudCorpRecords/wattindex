#!/usr/bin/env node
/**
 * wattindex CLI.
 *
 *   wattindex list-models
 *   wattindex energy --model M [--gpu G] [--itl-deadline-ms N]
 *   wattindex estimate --model M --output-tokens N [--gpu G]
 *     [--country C] [--running-batch N] [--num-gpus N]
 *     [--itl-deadline-ms N] [--pue N] [--system-power-ratio N]
 *   wattindex compare-gpus --model M [--itl-deadline-ms N]
 *   wattindex concurrency-curve --model M --gpu G
 *   wattindex grid-intensity --country C
 *   wattindex gpu-hardware [--gpu G]
 *   wattindex sources
 *   wattindex mcp
 *
 * Data comes through the loader in wattindex.ts
 * (LEADGREEN_API_BASE, default https://leadgreen.ai/api/v1);
 * all lookups and arithmetic happen locally. Exit codes: 0
 * success, 1 runtime error, 2 usage error.
 */
import {
  compareGpus,
  concurrencyCurve,
  defaultLoader,
  energyPerMillionTokens,
  estimate,
  gridIntensity,
  gpuHardware,
  listModels,
  listSources,
  formatPayload,
  VERSION,
} from "./wattindex.js";

function usage(): never {
  console.error(`Usage:
  wattindex list-models
  wattindex energy --model M [--gpu G] [--itl-deadline-ms N]
  wattindex estimate --model M --output-tokens N [--gpu G] [--country C] [--running-batch N] [--num-gpus N] [--itl-deadline-ms N] [--pue N] [--system-power-ratio N]
  wattindex compare-gpus --model M [--itl-deadline-ms N]
  wattindex concurrency-curve --model M --gpu G
  wattindex grid-intensity --country C
  wattindex gpu-hardware [--gpu G]
  wattindex sources
  wattindex mcp
  wattindex --version`);
  process.exit(2);
}

/** Parse `--flag value` pairs; anything else is a usage error. */
function parseFlags(rest: string[], allowed: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag?.startsWith("--") || value === undefined || !allowed.has(flag)) usage();
    out[flag.slice(2)] = value;
  }
  return out;
}

function num(flags: Record<string, string>, key: string): number | undefined {
  if (flags[key] === undefined) return undefined;
  const value = Number(flags[key]);
  if (!Number.isFinite(value)) usage();
  return value;
}

function req(flags: Record<string, string>, key: string): string {
  if (flags[key] === undefined) usage();
  return flags[key];
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    if (rest.length !== 0) usage();
    await import("./mcp.js");
    return;
  }
  const loader = defaultLoader();
  try {
    let out: unknown;
    if (cmd === "list-models") {
      if (rest.length !== 0) usage();
      out = await listModels(loader);
    } else if (cmd === "energy") {
      const f = parseFlags(rest, new Set(["--model", "--gpu", "--itl-deadline-ms"]));
      out = await energyPerMillionTokens(loader, {
        model: req(f, "model"),
        gpu: f.gpu,
        itl_deadline_ms: num(f, "itl-deadline-ms"),
      });
    } else if (cmd === "estimate") {
      const f = parseFlags(
        rest,
        new Set([
          "--model",
          "--output-tokens",
          "--gpu",
          "--country",
          "--running-batch",
          "--num-gpus",
          "--itl-deadline-ms",
          "--pue",
          "--system-power-ratio",
        ]),
      );
      const outputTokens = num(f, "output-tokens");
      if (outputTokens === undefined) usage();
      out = await estimate(loader, {
        model: req(f, "model"),
        output_tokens: outputTokens,
        gpu: f.gpu,
        country: f.country,
        running_batch: num(f, "running-batch"),
        num_gpus: num(f, "num-gpus"),
        itl_deadline_ms: num(f, "itl-deadline-ms"),
        pue: num(f, "pue"),
        system_power_ratio: num(f, "system-power-ratio"),
      });
    } else if (cmd === "compare-gpus") {
      const f = parseFlags(rest, new Set(["--model", "--itl-deadline-ms"]));
      out = await compareGpus(loader, {
        model: req(f, "model"),
        itl_deadline_ms: num(f, "itl-deadline-ms"),
      });
    } else if (cmd === "concurrency-curve") {
      const f = parseFlags(rest, new Set(["--model", "--gpu"]));
      out = await concurrencyCurve(loader, { model: req(f, "model"), gpu: req(f, "gpu") });
    } else if (cmd === "grid-intensity") {
      const f = parseFlags(rest, new Set(["--country"]));
      out = await gridIntensity(loader, { country: req(f, "country") });
    } else if (cmd === "gpu-hardware") {
      const f = parseFlags(rest, new Set(["--gpu"]));
      out = await gpuHardware(loader, { gpu: f.gpu });
    } else if (cmd === "sources") {
      if (rest.length !== 0) usage();
      out = await listSources(loader);
    } else {
      usage();
    }
    console.log(formatPayload(out));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();

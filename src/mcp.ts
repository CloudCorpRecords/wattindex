/**
 * wattindex MCP server. Tools: list_models,
 * energy_per_million_tokens, estimate, compare_gpus,
 * concurrency_curve, grid_intensity, gpu_hardware, sources.
 *
 * Why the low-level Server instead of McpServer: the high-level
 * helper converts zod schemas to JSON Schema and injects keys
 * not in this tool set's defined spec ("$schema" and
 * "additionalProperties"), which breaks exact tool-list/schema
 * parity with the spec. This file serves tools/list with the
 * spec's exact input schemas as explicit literals, while zod
 * still validates every tools/call argument set.
 *
 * Data comes through the injectable loader in wattindex.ts
 * (LEADGREEN_API_BASE, default https://leadgreen.ai/api/v1);
 * all lookups and arithmetic happen locally.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
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

const loader = defaultLoader();

const NoArgs = z.object({});
const EnergyArgs = z.object({
  model: z.string(),
  gpu: z.string().optional(),
  itl_deadline_ms: z.number().optional(),
});
const EstimateArgs = z.object({
  model: z.string(),
  output_tokens: z.number(),
  gpu: z.string().optional(),
  country: z.string().optional(),
  running_batch: z.number().optional(),
  num_gpus: z.number().int().optional(),
  itl_deadline_ms: z.number().optional(),
  pue: z.number().optional(),
  system_power_ratio: z.number().optional(),
});
const CompareArgs = z.object({
  model: z.string(),
  itl_deadline_ms: z.number().optional(),
});
const CurveArgs = z.object({
  model: z.string(),
  gpu: z.string(),
});
const GridArgs = z.object({
  country: z.string(),
});
const HardwareArgs = z.object({
  gpu: z.string().optional(),
});

const TOOLS = [
  {
    name: "list_models",
    description:
      "List the models on the index and the GPUs each model has measurements for.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "energy_per_million_tokens",
    description:
      "Return the best energy row per GPU for a model: watt-hours per million output tokens, keeping rows at or under the inter-token latency deadline.",
    inputSchema: {
      type: "object" as const,
      properties: {
        model: { type: "string", description: "Model name on the index" },
        gpu: {
          type: "string",
          description: "GPU name; omit to get the best row for every GPU",
        },
        itl_deadline_ms: {
          type: "number",
          description: "Latency ceiling in milliseconds for choosing the best row (default 500)",
        },
      },
      required: ["model"],
    },
  },
  {
    name: "estimate",
    description:
      "Estimate GPU energy for a token count from the best matching row, with kg CO2e for a grid and optional energy at the meter.",
    inputSchema: {
      type: "object" as const,
      properties: {
        model: { type: "string", description: "Model name on the index" },
        output_tokens: { type: "number", description: "Number of output tokens to price" },
        gpu: {
          type: "string",
          description: "GPU name; omit to use the best row overall",
        },
        country: {
          type: "string",
          description: "Country name, short name, ISO 3166 alpha-2/alpha-3 code, or World",
        },
        running_batch: {
          type: "number",
          description: "Average running batch; the measured configuration nearest to it is used",
        },
        num_gpus: {
          type: "integer",
          description: "Only configurations on exactly this many GPUs",
        },
        itl_deadline_ms: {
          type: "number",
          description: "Latency ceiling in milliseconds for choosing the best row (default 500)",
        },
        pue: {
          type: "number",
          description: "Power usage effectiveness, at least 1.0; enables energy at the meter",
        },
        system_power_ratio: {
          type: "number",
          description: "Whole-system to GPU power ratio, at least 1.0; enables energy at the meter",
        },
      },
      required: ["model", "output_tokens"],
    },
  },
  {
    name: "compare_gpus",
    description: "Compare the best energy rows for a model on H100 versus B200.",
    inputSchema: {
      type: "object" as const,
      properties: {
        model: { type: "string", description: "Model name on the index" },
        itl_deadline_ms: {
          type: "number",
          description: "Latency ceiling in milliseconds for choosing the best row (default 500)",
        },
      },
      required: ["model"],
    },
  },
  {
    name: "concurrency_curve",
    description:
      "Return energy per million tokens at every measured running batch for a model on a GPU.",
    inputSchema: {
      type: "object" as const,
      properties: {
        model: { type: "string", description: "Model name on the index" },
        gpu: { type: "string", description: "GPU name" },
      },
      required: ["model", "gpu"],
    },
  },
  {
    name: "grid_intensity",
    description:
      "Return the annual average grid carbon intensity (gCO2e per kWh) for a country or World.",
    inputSchema: {
      type: "object" as const,
      properties: {
        country: {
          type: "string",
          description: "Country name, short name, ISO 3166 alpha-2/alpha-3 code, or World",
        },
      },
      required: ["country"],
    },
  },
  {
    name: "gpu_hardware",
    description:
      "Return GPU hardware specs: max TDP, memory, MIG profiles and whole-system ceilings.",
    inputSchema: {
      type: "object" as const,
      properties: {
        gpu: {
          type: "string",
          description: "GPU name; omit to list every GPU on the index",
        },
      },
    },
  },
  {
    name: "sources",
    description:
      "List every source behind the index, with version, retrieval date and licence.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const server = new Server(
  { name: "wattindex", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let out: unknown;
    if (name === "list_models") {
      NoArgs.parse(args ?? {});
      out = await listModels(loader);
    } else if (name === "energy_per_million_tokens") {
      out = await energyPerMillionTokens(loader, EnergyArgs.parse(args ?? {}));
    } else if (name === "estimate") {
      out = await estimate(loader, EstimateArgs.parse(args ?? {}));
    } else if (name === "compare_gpus") {
      out = await compareGpus(loader, CompareArgs.parse(args ?? {}));
    } else if (name === "concurrency_curve") {
      out = await concurrencyCurve(loader, CurveArgs.parse(args ?? {}));
    } else if (name === "grid_intensity") {
      out = await gridIntensity(loader, GridArgs.parse(args ?? {}));
    } else if (name === "gpu_hardware") {
      out = await gpuHardware(loader, HardwareArgs.parse(args ?? {}));
    } else if (name === "sources") {
      NoArgs.parse(args ?? {});
      out = await listSources(loader);
    } else {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return textResult(formatPayload(out));
  } catch (err) {
    if (err instanceof McpError) throw err;
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();

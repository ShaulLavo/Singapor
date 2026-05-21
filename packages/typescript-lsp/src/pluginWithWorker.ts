import type { TypeScriptLspPlugin, TypeScriptLspPluginOptions } from "./types";
import { createTypeScriptLspPlugin as createBaseTypeScriptLspPlugin } from "./plugin";

export function createTypeScriptLspPlugin(
  options: TypeScriptLspPluginOptions = {},
): TypeScriptLspPlugin {
  return createBaseTypeScriptLspPlugin({
    workerFactory: defaultWorkerFactory,
    ...options,
  });
}

function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./typescriptLsp.worker.ts", import.meta.url), {
    type: "module",
  });
}

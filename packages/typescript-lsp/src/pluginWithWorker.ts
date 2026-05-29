import type { TypeScriptLspPlugin, TypeScriptLspPluginOptions } from './types'
import { createTypeScriptLspPlugin as createBaseTypeScriptLspPlugin } from './plugin'
import { createTypeScriptLspWorkerOwner } from './workerOwner'

export function createTypeScriptLspPlugin(
  options: TypeScriptLspPluginOptions = {},
): TypeScriptLspPlugin {
  return createBaseTypeScriptLspPlugin({
    ...options,
    workerFactory: () =>
      createTypeScriptLspWorkerOwner({
        workerFactory: options.workerFactory,
        onError: options.onError,
      }),
  })
}

import {
  createWebSocketLspTransport,
  createWorkerLspTransport,
  LspClient,
  LspWorkspace,
  type LspManagedTransport,
} from '@editor/lsp'

import type { TypeScriptLspResolvedOptions } from './pluginTypes'
import type { TypeScriptLspSourceFile, TypeScriptLspStatus } from './types'

type LspConnectionCallbacks = {
  onConnected(): void
  onUnavailable(): void
  onPublishDiagnostics(params: unknown): void
  onStatusChange?: (status: TypeScriptLspStatus) => void
  onError?: (error: unknown) => void
}

export class LspConnection {
  public readonly workspace = new LspWorkspace()
  public readonly client: LspClient

  private transport: LspManagedTransport | null = null
  private disposed = false
  private status: TypeScriptLspStatus = 'idle'

  public constructor(
    private readonly options: TypeScriptLspResolvedOptions,
    private readonly callbacks: LspConnectionCallbacks,
  ) {
    this.client = this.createClient()
  }

  public connect(): void {
    this.setStatus('loading')
    if (this.options.webSocketRoute) {
      void this.connectWebSocket()
      return
    }

    this.connectWorker()
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.client.disconnect()
    this.transport?.close()
    this.transport = null
    this.setStatus('idle')
  }

  public syncWorkspaceFiles(files: readonly TypeScriptLspSourceFile[]): void {
    if (this.disposed) return
    if (!this.client.initialized) return

    void this.client
      .notify('editor/typescript/setWorkspaceFiles', { files })
      .catch((error: unknown) => this.handleError(error))
  }

  private createClient(): LspClient {
    return new LspClient({
      rootUri: this.options.rootUri,
      workspaceFolders: null,
      workspace: this.workspace,
      timeoutMs: this.options.timeoutMs,
      initializationOptions: {
        compilerOptions: this.options.compilerOptions,
        diagnosticDelayMs: this.options.diagnosticDelayMs,
      },
      notificationHandlers: {
        'textDocument/publishDiagnostics': (_client, params) => {
          this.callbacks.onPublishDiagnostics(params)
          return true
        },
      },
    })
  }

  private connectWorker(): void {
    if (!this.options.workerFactory) {
      this.handleConnectError(new Error('TypeScript LSP worker factory was not configured'))
      return
    }

    const transport = createWorkerLspTransport(this.options.workerFactory(), {
      messageFormat: 'json',
      terminateOnClose: true,
    })
    this.transport = transport
    void this.client
      .connect(transport)
      .then(() => this.handleConnected())
      .catch((error: unknown) => this.handleConnectError(error))
  }

  private async connectWebSocket(): Promise<void> {
    const route = this.options.webSocketRoute
    if (!route) return

    try {
      const transport = await createWebSocketLspTransport(route, {
        protocols: this.options.webSocketTransportOptions?.protocols,
        WebSocketCtor: this.options.webSocketTransportOptions?.WebSocketCtor,
      })
      if (this.disposed) {
        transport.close()
        return
      }

      this.transport = transport
      await this.client.connect(transport)
      this.handleConnected()
    } catch (error) {
      this.handleConnectError(error)
    }
  }

  private handleConnected(): void {
    if (this.disposed) return

    this.setStatus('ready')
    this.callbacks.onConnected()
  }

  private handleConnectError(error: unknown): void {
    if (this.disposed) return

    this.closeFailedConnection()
    this.setStatus('error')
    this.handleError(error)
  }

  private closeFailedConnection(): void {
    this.client.disconnect()
    this.transport?.close()
    this.transport = null
    this.callbacks.onUnavailable()
  }

  private setStatus(status: TypeScriptLspStatus): void {
    if (this.status === status) return

    this.status = status
    this.callbacks.onStatusChange?.(status)
  }

  private handleError(error: unknown): void {
    this.callbacks.onError?.(error)
  }
}

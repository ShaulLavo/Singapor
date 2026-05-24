import {
  createWebSocketLspTransport,
  LspClient,
  LspWorkspace,
  type LspManagedTransport,
} from '@editor/lsp'

import type { LanguageServerResolvedOptions } from './pluginTypes'
import type { LanguageServerStatus } from './types'

type LspConnectionCallbacks = {
  onConnected(): void
  onUnavailable(): void
  onPublishDiagnostics(params: unknown): void
  onStatusChange?: (status: LanguageServerStatus) => void
  onError?: (error: unknown) => void
}

export class LspConnection {
  public readonly workspace = new LspWorkspace()
  public readonly client: LspClient

  private transport: LspManagedTransport | null = null
  private disposed = false
  private status: LanguageServerStatus = 'idle'

  public constructor(
    private readonly options: LanguageServerResolvedOptions,
    private readonly callbacks: LspConnectionCallbacks,
  ) {
    this.client = this.createClient()
  }

  public connect(): void {
    this.setStatus('loading')
    void this.connectWebSocket()
  }

  public dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.client.disconnect()
    this.transport?.close()
    this.transport = null
    this.setStatus('idle')
  }

  private createClient(): LspClient {
    return new LspClient({
      rootUri: this.options.rootUri,
      workspaceFolders: null,
      workspace: this.workspace,
      timeoutMs: this.options.timeoutMs,
      initializationOptions: this.options.initializationOptions,
      notificationHandlers: {
        'textDocument/publishDiagnostics': (_client, params) => {
          this.callbacks.onPublishDiagnostics(params)
          return true
        },
      },
    })
  }

  private async connectWebSocket(): Promise<void> {
    const route = this.options.webSocketRoute

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

  private setStatus(status: LanguageServerStatus): void {
    if (this.status === status) return

    this.status = status
    this.callbacks.onStatusChange?.(status)
  }

  private handleError(error: unknown): void {
    this.callbacks.onError?.(error)
  }
}

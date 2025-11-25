import * as monaco from 'monaco-editor'

let ws: WebSocket | null = null
let completionProvider: monaco.IDisposable | null = null
let isConnected = false

interface LSPContext {
  factObject: Record<string, unknown>
  factSchema: Record<string, string>
  bddTests: string
  currentDrl: string
}

/**
 * Initialize LSP client and connect to server
 */
export async function initializeLSP(
  editor: monaco.editor.IStandaloneCodeEditor,
  context: LSPContext
): Promise<boolean> {
  if (isConnected && ws) {
    return true
  }

  try {
    // Create WebSocket connection
    const wsUrl = `ws://localhost:4001`
    ws = new WebSocket(wsUrl)

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('LSP connection timeout'))
      }, 5000)

      ws!.onopen = () => {
        clearTimeout(timeout)
        resolve()
      }

      ws!.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('LSP connection failed'))
      }
    })

    // Send initialization with context
    await sendContext(context)

    // Send initial document content
    const model = editor.getModel()
    if (model) {
      sendDocumentContent(model.getValue())
    }

    // Register Monaco completion provider
    if (completionProvider) {
      completionProvider.dispose()
    }

    completionProvider = monaco.languages.registerCompletionItemProvider('java', {
      provideCompletionItems: async (model, position) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          return { suggestions: [] }
        }

        return new Promise((resolve) => {
          const requestId = Date.now()
          
          const handler = (event: MessageEvent) => {
            try {
              const message = JSON.parse(event.data)
              if (message.id === requestId) {
                ws!.removeEventListener('message', handler)
                const items = message.result?.items || []
                const suggestions = items.map((item: any) => ({
                  label: item.label,
                  kind: item.kind || monaco.languages.CompletionItemKind.Text,
                  detail: item.detail,
                  insertText: item.insertText || item.label,
                  insertTextRules: item.insertTextRules || undefined,
                  range: {
                    startLineNumber: position.lineNumber,
                    startColumn: position.column,
                    endLineNumber: position.lineNumber,
                    endColumn: position.column
                  }
                }))
                resolve({ suggestions })
              }
            } catch (e) {
              console.error('[LSP Client] Parse error:', e)
              ws!.removeEventListener('message', handler)
              resolve({ suggestions: [] })
            }
          }

          ws!.addEventListener('message', handler)

          // Send completion request
          const message = {
            jsonrpc: '2.0',
            id: requestId,
            method: 'textDocument/completion',
            params: {
              textDocument: {
                uri: model.uri.toString()
              },
              position: {
                line: position.lineNumber - 1, // LSP uses 0-based
                character: position.column - 1
              }
            }
          }

          ws!.send(JSON.stringify(message))

          // Timeout after 2 seconds
          setTimeout(() => {
            ws!.removeEventListener('message', handler)
            resolve({ suggestions: [] })
          }, 2000)
        })
      },
      triggerCharacters: ['.', '(', ' ']
    })

    isConnected = true
    console.log('[LSP Client] Connected and initialized')
    return true
  } catch (error) {
    console.error('[LSP Client] Failed to connect:', error)
    isConnected = false
    return false
  }
}

/**
 * Send fact object, BDD tests, and schema to LSP server
 */
export async function sendContext(context: LSPContext): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return
  }

  const message = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'initialize/context',
    params: {
      factObject: context.factObject,
      factSchema: context.factSchema,
      bddTests: context.bddTests,
      currentDrl: context.currentDrl
    }
  }

  ws.send(JSON.stringify(message))
}

/**
 * Send document content updates to LSP server
 */
export function sendDocumentContent(content: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return
  }

  const message = {
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: {
        uri: 'file:///sample.drl',
        version: Date.now()
      },
      contentChanges: [
        {
          text: content
        }
      ]
    }
  }

  ws.send(JSON.stringify(message))
}

/**
 * Disconnect LSP client
 */
export function disconnectLSP(): void {
  if (completionProvider) {
    completionProvider.dispose()
    completionProvider = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
  isConnected = false
}


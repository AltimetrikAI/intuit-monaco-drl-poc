import * as monaco from 'monaco-editor'

let ws: WebSocket | null = null
let completionProvider: monaco.IDisposable | null = null
let isConnected = false
let pendingSuggestions: monaco.languages.CompletionItem[] | null = null

/**
 * Get human-readable name for completion item kind
 */
function getCompletionKindName(kind: monaco.languages.CompletionItemKind | undefined): string {
  if (!kind) return 'Unknown'
  const kindMap: Record<number, string> = {
    1: 'Text',
    2: 'Method',
    3: 'Function',
    4: 'Constructor',
    5: 'Field',
    6: 'Variable',
    7: 'Class',
    8: 'Interface',
    9: 'Module',
    10: 'Property',
    11: 'Unit',
    12: 'Value',
    13: 'Enum',
    14: 'Keyword',
    15: 'Snippet',
    16: 'Color',
    17: 'File',
    18: 'Reference',
    19: 'Folder',
    20: 'EnumMember',
    21: 'Constant',
    22: 'Struct',
    23: 'Event',
    24: 'Operator',
    25: 'TypeParameter'
  }
  return kindMap[kind] || `Kind ${kind}`
}

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
  // Store editor reference for manual triggering
  globalEditorRef = editor
  
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

    console.log('[LSP Client] 📝 Registering completion provider for language: java')
    
    // Verify Java language is registered in Monaco
    const languages = monaco.languages.getLanguages()
    const javaLang = languages.find(l => l.id === 'java')
    console.log('[LSP Client]   - Java language registered in Monaco:', !!javaLang)
    if (javaLang) {
      console.log('[LSP Client]   - Java language details:', javaLang.id, javaLang.aliases)
    }
    
    // Get the current model to verify language
    const currentModel = editor.getModel()
    if (currentModel) {
      console.log('[LSP Client]   - Current model language:', currentModel.getLanguageId())
      console.log('[LSP Client]   - Current model URI:', currentModel.uri.toString())
    }
    
    // Register completion provider for Java language
    // Note: Monaco will call this when suggestions are triggered
    completionProvider = monaco.languages.registerCompletionItemProvider('java', {
      provideCompletionItems: async (model: monaco.editor.ITextModel, position: monaco.Position, context: monaco.languages.CompletionContext) => {
        // Verify language matches
        if (model.getLanguageId() !== 'java') {
          return { suggestions: [] }
        }
        
        // Only return LSP suggestions if we have pending suggestions (from button/right-click)
        // During normal typing, return empty so normal Java suggestions work
        if (pendingSuggestions && pendingSuggestions.length > 0) {
          console.log('[LSP Client] ========================================')
          console.log('[LSP Client] ✅ RETURNING LSP SUGGESTIONS')
          console.log('[LSP Client] ----------------------------------------')
          console.log('[LSP Client] Total suggestions:', pendingSuggestions.length)
          pendingSuggestions.forEach((sug, idx) => {
            const label = typeof sug.label === 'string' ? sug.label : sug.label.label
            console.log(`[LSP Client]   Suggestion ${idx + 1}:`)
            console.log(`[LSP Client]     - Label: "${label}"`)
            console.log(`[LSP Client]     - Kind: ${sug.kind} (${getCompletionKindName(sug.kind)})`)
            console.log(`[LSP Client]     - Detail: "${sug.detail || 'N/A'}"`)
            console.log(`[LSP Client]     - Insert Text Length: ${sug.insertText ? sug.insertText.length : 0} chars`)
            if (sug.insertText) {
              const preview = sug.insertText.substring(0, 100)
              console.log(`[LSP Client]     - Insert Text Preview: "${preview}${sug.insertText.length > 100 ? '...' : ''}"`)
            }
            if (sug.documentation) {
              const doc = typeof sug.documentation === 'string' ? sug.documentation : (sug.documentation as any)?.value || ''
              console.log(`[LSP Client]     - Documentation: "${doc.substring(0, 80)}${doc.length > 80 ? '...' : ''}"`)
            }
          })
          console.log('[LSP Client] ========================================')
          const suggestions = [...pendingSuggestions] // Copy array
          pendingSuggestions = null // Clear after returning
          return { suggestions }
        }
        
        // During normal typing (not button/right-click), return empty
        // This allows normal Java suggestions to work
        return { suggestions: [] }
      },
      // No trigger characters - we only want LSP suggestions on button/right-click
      // This allows normal Java suggestions to work during typing
      _isLSPProvider: true
    } as any)
    
    console.log('[LSP Client] ✅ Completion provider registered successfully')

    // Add keyboard shortcut to manually trigger completion (for testing)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
      console.log('[LSP Client] ⌨️  Ctrl+Space keyboard shortcut triggered manually!')
      sendCompletionRequest(editor)
    })
    
    // Add context menu action to trigger completion
    try {
      editor.addAction({
        id: 'lsp-trigger-completion',
        label: 'Generate Rule Snippet',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.5,
        run: (ed) => {
          console.log('[LSP Client] 🖱️  Right-click "Generate Rule Snippet" triggered!')
          // Cast to IStandaloneCodeEditor since we know it's a standalone editor
          sendCompletionRequest(ed as monaco.editor.IStandaloneCodeEditor)
        }
      })
      console.log('[LSP Client] ✅ Context menu action "Generate Rule Snippet" registered')
    } catch (error) {
      console.error('[LSP Client] ❌ Failed to register context menu action:', error)
    }
    
    isConnected = true
    console.log('[LSP Client] Connected and initialized')
    console.log('[LSP Client] ✅ Completion provider registered, keyboard shortcut and context menu added')
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
 * Manually send completion request to LSP server
 */
function sendCompletionRequest(editor: monaco.editor.IStandaloneCodeEditor): void {
  console.log('[LSP Client] ========================================')
  console.log('[LSP Client] 🔘 STEP 1: INITIATING COMPLETION REQUEST')
  console.log('[LSP Client] ----------------------------------------')
  
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('[LSP Client] ❌ WebSocket not ready!')
    console.error('[LSP Client]   - WebSocket state:', ws?.readyState, ws ? `(OPEN=${WebSocket.OPEN})` : 'NULL')
    console.error('[LSP Client] ========================================')
    return
  }
  console.log('[LSP Client] ✅ WebSocket is OPEN and ready')

  const model = editor.getModel()
  const position = editor.getPosition()
  
  if (!model || !position) {
    console.error('[LSP Client] ❌ Model or position not available')
    console.error('[LSP Client]   - Model:', !!model)
    console.error('[LSP Client]   - Position:', !!position)
    console.error('[LSP Client] ========================================')
    return
  }
  console.log('[LSP Client] ✅ Model and position available')

  const requestId = Date.now()
  console.log('[LSP Client] 📋 Request Details:')
  console.log('[LSP Client]   - Request ID:', requestId)
  console.log('[LSP Client]   - Position: Line', position.lineNumber, 'Column', position.column)
  console.log('[LSP Client]   - Model URI:', model.uri.toString())
  console.log('[LSP Client]   - Model language:', model.getLanguageId())

  // Set up response handler
  const handler = (event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data)
      
      // Log all messages for debugging
      if (message.method) {
        console.log('[LSP Client] 📨 Received message:', message.method, 'ID:', message.id)
      }
      
      if (message.id === requestId && message.result) {
        ws!.removeEventListener('message', handler)
        console.log('[LSP Client] ========================================')
        console.log('[LSP Client] ✅ STEP 2: RECEIVED RESPONSE FROM SERVER')
        console.log('[LSP Client] ----------------------------------------')
        console.log('[LSP Client]   - Response ID:', message.id)
        console.log('[LSP Client]   - Matches Request ID:', requestId, message.id === requestId ? '✅' : '❌')
        
        const items = message.result?.items || []
        console.log('[LSP Client]   - Items count:', items.length)
        items.forEach((item: any, idx: number) => {
          console.log(`[LSP Client]     Item ${idx + 1}:`)
          console.log(`[LSP Client]       - Label: "${item.label}"`)
          console.log(`[LSP Client]       - Kind: ${item.kind}`)
          console.log(`[LSP Client]       - Detail: "${item.detail || 'N/A'}"`)
          console.log(`[LSP Client]       - Insert Text Length: ${(item.insertText || '').length} chars`)
        })
        console.log('[LSP Client] ========================================')
        
        // Convert LSP completion items to Monaco suggestions
        const suggestions = items.map((item: any) => ({
          label: item.label,
          kind: item.kind || monaco.languages.CompletionItemKind.Text,
          detail: item.detail,
          insertText: item.insertText || item.label,
          insertTextRules: item.insertTextRules || undefined,
          documentation: item.documentation,
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column
          }
        }))
        
        // Store suggestions and show them
        if (suggestions.length > 0) {
          console.log('[LSP Client] ========================================')
          console.log('[LSP Client] ✅ STEP 3: PROCESSING SUGGESTIONS FROM SERVER')
          console.log('[LSP Client] ----------------------------------------')
          console.log('[LSP Client]   - Received from server:', suggestions.length, 'suggestion(s)')
          suggestions.forEach((sug: monaco.languages.CompletionItem, idx: number) => {
            const label = typeof sug.label === 'string' ? sug.label : sug.label.label
            console.log(`[LSP Client]     Item ${idx + 1}: "${label}" (${getCompletionKindName(sug.kind)})`)
          })
          console.log('[LSP Client]   - Storing suggestions for display')
          
          pendingSuggestions = suggestions
          
          // Notify UI component that suggestions are ready (for custom dropdown)
          if (onSuggestionsReady) {
            console.log('[LSP Client]   - Notifying UI component to show custom dropdown')
            onSuggestionsReady(suggestions)
          } else {
            console.log('[LSP Client]   ⚠️  No callback registered - suggestions stored but not displayed')
          }
          
          console.log('[LSP Client] ========================================')
        } else {
          console.log('[LSP Client] ⚠️  No suggestions received from server')
          console.log('[LSP Client] ========================================')
        }
      }
    } catch (e) {
      console.error('[LSP Client] Parse error:', e)
      ws!.removeEventListener('message', handler)
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

  console.log('[LSP Client]   📤 Sending request to server:')
  console.log('[LSP Client]     - Method:', message.method)
  console.log('[LSP Client]     - Request ID:', message.id)
  console.log('[LSP Client]     - Position:', message.params.position)
  console.log('[LSP Client]   ⏳ Waiting for server response...')
  ws!.send(JSON.stringify(message))
  console.log('[LSP Client] ✅ Request sent successfully')
  console.log('[LSP Client] ========================================')

  // Timeout after 5 seconds (cleanup only - not an error)
  setTimeout(() => {
    ws!.removeEventListener('message', handler)
    // Only log if handler wasn't already removed (response received)
    // This is just cleanup, not an actual error
  }, 5000)
}

/**
 * Trigger completion manually
 * If editor is not provided, tries to use the global reference
 */
export function triggerCompletion(editor?: monaco.editor.IStandaloneCodeEditor): void {
  const editorToUse = editor || globalEditorRef
  
  if (editorToUse) {
    console.log('[LSP Client] 🔘 Manually triggering completion via button')
    sendCompletionRequest(editorToUse)
  } else {
    console.warn('[LSP Client] ⚠️  Editor not available to trigger completion')
    console.warn('[LSP Client]   - Try refreshing the page or wait for LSP initialization')
  }
}

let globalEditorRef: monaco.editor.IStandaloneCodeEditor | null = null
let onSuggestionsReady: ((suggestions: monaco.languages.CompletionItem[]) => void) | null = null

/**
 * Register callback for when suggestions are ready to display
 */
export function setOnSuggestionsReady(callback: (suggestions: monaco.languages.CompletionItem[]) => void): void {
  onSuggestionsReady = callback
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
  globalEditorRef = null
  isConnected = false
}


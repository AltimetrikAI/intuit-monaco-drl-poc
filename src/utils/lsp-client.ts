async function requestInlineCompletionsFromServer(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  userPrompt?: string
): Promise<Monaco.languages.InlineCompletion[]> {
  const socket = ws
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn('[LSP Client] ⚠️  Cannot request inline completions: WebSocket not ready')
    return []
  }

  const monaco = getMonaco()
  const requestId = Date.now()

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn('[LSP Client] ⚠️  Inline completion request timed out')
      socket.removeEventListener('message', handler)
      resolve([])
    }, 3000)

    const handler = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data)
        if (message.id === requestId && message.result) {
          clearTimeout(timeout)
          socket.removeEventListener('message', handler)

          const items = message.result?.items || []
          if (items.length === 0) {
            resolve([])
            return
          }

          const inlineItems = items.map((item: any) => ({
            insertText: item.insertText || item.label,
            filterText: typeof item.label === 'string' ? item.label : item.label?.label,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            )
          }))

          resolve(inlineItems)
        }
      } catch (error) {
        console.error('[LSP Client] ❌ Inline completion parse error:', error)
        clearTimeout(timeout)
        socket.removeEventListener('message', handler)
        resolve([])
      }
    }

    socket.addEventListener('message', handler)

    const message = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'textDocument/completion',
      params: {
        textDocument: {
          uri: model.uri.toString()
        },
        position: {
          line: position.lineNumber - 1,
          character: position.column - 1
        },
        mode: 'generate',
        userPrompt: userPrompt || undefined
      }
    }

    socket.send(JSON.stringify(message))
  })
}
import loader from '@monaco-editor/loader'
import type * as Monaco from 'monaco-editor'
import 'monaco-editor/esm/vs/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution'

let ws: WebSocket | null = null
let completionProvider: Monaco.IDisposable | null = null
let isConnected = false
let pendingSuggestions: Monaco.languages.CompletionItem[] | null = null
let pendingModifyRuleContext: {ruleContext: RuleContext, existingRule: string} | null = null // Store rule context for modify replacement
let onShowGenerateDialog: ((mode: 'generate' | 'modify', existingRule?: string, ruleContext?: RuleContext) => void) | null = null
let inlineCompletionsProvider: Monaco.IDisposable | null = null
let monacoInstance: typeof import('monaco-editor') | null = null

async function loadMonaco(): Promise<typeof import('monaco-editor')> {
  if (monacoInstance) {
    return monacoInstance
  }
  monacoInstance = await loader.init()
  return monacoInstance
}

function getMonaco(): typeof import('monaco-editor') {
  if (!monacoInstance) {
    throw new Error('[LSP Client] Monaco has not been initialized yet')
  }
  return monacoInstance
}

/**
 * Rule context information
 */
interface RuleContext {
  fullRule: string
  ruleName: string
  startLine: number
  endLine: number
  startColumn: number
  endColumn: number
  isInsideRule: boolean
}

/**
 * Detect if cursor position is inside a DRL rule
 * Returns rule context if inside a rule, null otherwise
 */
function detectRuleAtPosition(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position
): RuleContext | null {
  const content = model.getValue()
  const lines = content.split('\n')
  const currentLineNum = position.lineNumber - 1 // Convert to 0-based
  
  // Find the rule that contains this position
  let ruleStartLine = -1
  let ruleEndLine = -1
  let ruleName = ''
  let inRule = false
  let braceCount = 0
  
  // Search backwards from current line to find rule start
  for (let i = currentLineNum; i >= 0; i--) {
    const line = lines[i]
    const ruleMatch = line.match(/^\s*rule\s+"([^"]+)"/i)
    if (ruleMatch) {
      ruleStartLine = i
      ruleName = ruleMatch[1]
      inRule = true
      break
    }
  }
  
  if (!inRule) {
    return null
  }
  
  // Search forwards from rule start to find matching 'end'
  for (let i = ruleStartLine; i < lines.length; i++) {
    const line = lines[i]
    
    // Count braces to handle nested structures
    for (const char of line) {
      if (char === '{') braceCount++
      if (char === '}') braceCount--
    }
    
    // Check for 'end' keyword (only if not inside braces and on its own line)
    const endMatch = line.match(/^\s*end\s*$/i)
    if (endMatch && braceCount === 0) {
      ruleEndLine = i
      break
    }
  }
  
  // Check if current position is between rule start and end
  if (ruleStartLine >= 0 && ruleEndLine >= 0 && 
      currentLineNum >= ruleStartLine && currentLineNum <= ruleEndLine) {
    // Extract full rule text
    const fullRule = lines.slice(ruleStartLine, ruleEndLine + 1).join('\n')
    
    // Find start and end columns
    const startLineContent = lines[ruleStartLine]
    const endLineContent = lines[ruleEndLine]
    const startColumn = startLineContent.match(/^\s*/)?.[0].length || 0
    const endColumn = endLineContent.length
    
    return {
      fullRule,
      ruleName,
      startLine: ruleStartLine + 1, // Convert back to 1-based
      endLine: ruleEndLine + 1,
      startColumn: startColumn + 1, // Convert to 1-based
      endColumn: endColumn + 1,
      isInsideRule: true
    }
  }
  
  return null
}

/**
 * Get human-readable name for completion item kind
 */
function getCompletionKindName(kind: Monaco.languages.CompletionItemKind | undefined): string {
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
  editor: Monaco.editor.IStandaloneCodeEditor,
  context: LSPContext
): Promise<boolean> {
  const monaco = await loadMonaco()
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
      provideCompletionItems: async (model: Monaco.editor.ITextModel, position: Monaco.Position, context: Monaco.languages.CompletionContext) => {
        console.log('[LSP Client] 🔍 provideCompletionItems CALLED')
        console.log('[LSP Client]   - Language:', model.getLanguageId())
        console.log('[LSP Client]   - Trigger kind:', context.triggerKind, `(${context.triggerKind === monaco.languages.CompletionTriggerKind.Invoke ? 'Invoke' : context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? 'TriggerCharacter' : 'Automatic'})`)
        console.log('[LSP Client]   - Position:', position.lineNumber, position.column)
        
        // Verify language matches
        if (model.getLanguageId() !== 'java') {
          console.log('[LSP Client]   ⚠️  Language mismatch, returning empty')
          return { suggestions: [] }
        }
        
        // Check if this is a manual trigger (Ctrl+Space or programmatic)
        const isManualTrigger = context.triggerKind === monaco.languages.CompletionTriggerKind.Invoke
        console.log('[LSP Client]   - Is manual trigger:', isManualTrigger)
        
        // If we have pending suggestions (from button/right-click), return them
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
        
        // If Ctrl+Space is pressed (manual trigger), return mock LSP suggestion
        if (isManualTrigger) {
          console.log('[LSP Client] ========================================')
          console.log('[LSP Client] ⌨️  CTRL+SPACE DETECTED')
          console.log('[LSP Client] ----------------------------------------')
          console.log('[LSP Client]   - Trigger kind: Invoke (manual trigger)')
          console.log('[LSP Client]   - Returning mock LSP suggestion')
          
          // For now, return a mock suggestion without hitting LSP server
          const mockSuggestion: Monaco.languages.CompletionItem = {
            label: 'Rule "Auto suggested"',
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: 'Auto-suggested DRL Rule',
            insertText: 'rule "Auto suggested"\n\nwhen\n    $quote : Quote()\n\nthen\n    // Auto-generated rule\nend',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: {
              value: 'Auto-suggested rule from LSP (mock)'
            },
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column
            }
          }
          
          console.log('[LSP Client]   - Mock suggestion: "Rule \\"Auto suggested\\""')
          console.log('[LSP Client] ========================================')
          return { suggestions: [mockSuggestion] }
        }
        
        // During normal typing (not manual trigger), return empty
        // This allows normal Java suggestions to work
        return { suggestions: [] }
      },
      // No trigger characters - we only want LSP suggestions on button/right-click
      // This allows normal Java suggestions to work during typing
      _isLSPProvider: true
    } as any)
    
    console.log('[LSP Client] ✅ Completion provider registered successfully')

    // Register inline completions provider for AI suggestions (ghost text)
    if (inlineCompletionsProvider) {
      inlineCompletionsProvider.dispose()
    }
    
    inlineCompletionsProvider = monaco.languages.registerInlineCompletionsProvider('java', {
      provideInlineCompletions: async (model, position, context, token) => {
        console.log('[LSP Client] 🔍 Inline completions requested')
        console.log('[LSP Client]   - Position:', position.lineNumber, position.column)
        console.log('[LSP Client]   - Trigger kind:', context.triggerKind)

        const isExplicitTrigger = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit
        if (!isExplicitTrigger) {
          console.log('[LSP Client]   - Automatic trigger detected, returning no inline suggestions')
          return { items: [] }
        }
        
        try {
          const inlineItems = await requestInlineCompletionsFromServer(model, position)
          return { items: inlineItems }
        } catch (error) {
          console.error('[LSP Client] ❌ Failed to fetch inline completions:', error)
          return { items: [] }
        }
      },
      freeInlineCompletions: (completions) => {
        // Cleanup if necessary
      }
    })
    
    console.log('[LSP Client] ✅ Inline completions provider registered')

    // Mac-friendly keyboard shortcuts for triggering inline suggestions
    // Option+Space (Alt+Space) - Most reliable on Mac
    editor.addCommand(
      monaco.KeyMod.Alt | monaco.KeyCode.Space,
      () => {
        console.log('[LSP Client] ⌨️  Option+Space detected - triggering inline suggestions')
        // Trigger inline suggestions
        editor.trigger('lsp', 'editor.action.inlineSuggest.trigger', {})
      },
      'editorTextFocus'
    )
    
    // Cmd+Space - May conflict with Spotlight, but try it
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space,
      () => {
        console.log('[LSP Client] ⌨️  Cmd+Space detected - triggering inline suggestions')
        editor.trigger('lsp', 'editor.action.inlineSuggest.trigger', {})
      },
      'editorTextFocus'
    )
    
    // DOM event listener fallback for Ctrl+Space
    const domNode = editor.getDomNode()
    if (domNode) {
      const keydownHandler = (e: KeyboardEvent) => {
        if (e.ctrlKey && !e.metaKey && e.code === 'Space') {
          e.preventDefault()
          e.stopPropagation()
          console.log('[LSP Client] ⌨️  Ctrl+Space detected via DOM listener - triggering inline suggestions')
          editor.trigger('lsp', 'editor.action.inlineSuggest.trigger', {})
        }
      }
      
      domNode.addEventListener('keydown', keydownHandler, true)
      ;(editor as any)._lspKeydownHandler = keydownHandler
      console.log('[LSP Client] ✅ DOM event listener registered for Ctrl+Space fallback')
    }
    
    // Add context menu actions for Generate and Modify
    try {
      // Generate Rule action (when outside a rule)
      editor.addAction({
        id: 'lsp-generate-rule',
        label: 'Generate Rule',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.5,
        run: (ed) => {
          console.log('[LSP Client] 🖱️  Right-click "Generate Rule" triggered!')
          const model = ed.getModel()
          const position = ed.getPosition()
          
          if (!model || !position) {
            console.warn('[LSP Client]   ⚠️  Model or position not available')
            return
          }
          
          // Check if inside a rule
          const ruleContext = detectRuleAtPosition(model, position)
          if (ruleContext) {
            console.log('[LSP Client]   ⚠️  Inside a rule - should use Modify instead')
            return
          }
          
          // Use callback to show generate dialog
          if (onShowGenerateDialog) {
            setTimeout(() => {
              onShowGenerateDialog!('generate')
            }, 100)
          }
        }
      })
      
      // Modify Rule action (when inside a rule)
      editor.addAction({
        id: 'lsp-modify-rule',
        label: 'Modify Rule',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.6,
        run: (ed) => {
          console.log('[LSP Client] 🖱️  Right-click "Modify Rule" triggered!')
          const model = ed.getModel()
          const position = ed.getPosition()
          
          if (!model || !position) {
            console.warn('[LSP Client]   ⚠️  Model or position not available')
            return
          }
          
          // Detect rule at position
          const ruleContext = detectRuleAtPosition(model, position)
          if (!ruleContext) {
            console.log('[LSP Client]   ⚠️  Not inside a rule - should use Generate instead')
            return
          }
          
          console.log('[LSP Client]   ✅ Found rule:', ruleContext.ruleName)
          console.log('[LSP Client]   - Rule lines:', ruleContext.startLine, 'to', ruleContext.endLine)
          
          // Use callback to show modify dialog with existing rule and context
          if (onShowGenerateDialog) {
            setTimeout(() => {
              onShowGenerateDialog!('modify', ruleContext.fullRule, ruleContext)
            }, 100)
          }
        }
      })
      
      console.log('[LSP Client] ✅ Context menu actions "Generate Rule" and "Modify Rule" registered')
    } catch (error) {
      console.error('[LSP Client] ❌ Failed to register context menu actions:', error)
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
 * @param editor - Editor instance
 * @param userPrompt - Optional user prompt for rule generation
 */
function sendCompletionRequest(editor: Monaco.editor.IStandaloneCodeEditor, userPrompt?: string): void {
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

  let monaco: typeof import('monaco-editor')
  try {
    monaco = getMonaco()
  } catch (error) {
    console.error('[LSP Client] ❌ Monaco instance not available:', error)
    return
  }

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
          suggestions.forEach((sug: Monaco.languages.CompletionItem, idx: number) => {
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
      },
      // Explicitly set mode to 'generate' for create requests
      mode: 'generate',
      // Include user prompt if provided (for future AI generation)
      userPrompt: userPrompt || undefined
    }
  }
  
  if (userPrompt) {
    console.log('[LSP Client]   - Mode: generate (create new rule)')
    console.log('[LSP Client]   - User prompt:', userPrompt)
  } else {
    console.log('[LSP Client]   - Mode: generate (create new rule, no prompt)')
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
 * @param editor - Optional editor instance
 * @param userPrompt - Optional user prompt/input for rule generation
 */
export function triggerCompletion(editor?: Monaco.editor.IStandaloneCodeEditor, userPrompt?: string): void {
  const editorToUse = editor || globalEditorRef
  
  if (editorToUse) {
    if (userPrompt) {
      console.log('[LSP Client] 🔘 Manually triggering completion with user prompt:', userPrompt)
    } else {
      console.log('[LSP Client] 🔘 Manually triggering completion via button')
    }
    sendCompletionRequest(editorToUse, userPrompt)
  } else {
    console.warn('[LSP Client] ⚠️  Editor not available to trigger completion')
    console.warn('[LSP Client]   - Try refreshing the page or wait for LSP initialization')
  }
}

let globalEditorRef: Monaco.editor.IStandaloneCodeEditor | null = null
let onSuggestionsReady: ((suggestions: Monaco.languages.CompletionItem[]) => void) | null = null

/**
 * Register callback for when suggestions are ready to display
 */
export function setOnSuggestionsReady(callback: (suggestions: Monaco.languages.CompletionItem[]) => void): void {
  onSuggestionsReady = callback
}

/**
 * Register callback for showing the generate/modify dialog (for right-click context menu)
 */
export function setOnShowGenerateDialog(callback: (mode: 'generate' | 'modify', existingRule?: string, ruleContext?: RuleContext) => void): void {
  onShowGenerateDialog = callback
  console.log('[LSP Client] ✅ Registered onShowGenerateDialog callback')
}


/**
 * Replace a rule in the editor with new rule text
 */
export function replaceRuleInEditor(
  editor: Monaco.editor.IStandaloneCodeEditor,
  ruleContext: RuleContext,
  newRuleText: string
): void {
  const model = editor.getModel()
  if (!model) {
    console.error('[LSP Client] ❌ Cannot replace rule: model not available')
    return
  }
  
  console.log('[LSP Client] 🔄 Replacing rule in editor:')
  console.log('[LSP Client]   - Rule name:', ruleContext.ruleName)
  console.log('[LSP Client]   - Lines:', ruleContext.startLine, 'to', ruleContext.endLine)
  console.log('[LSP Client]   - New rule length:', newRuleText.length, 'chars')
  
  const monaco = getMonaco()
  const range = new monaco.Range(
    ruleContext.startLine,
    1, // Start from beginning of start line
    ruleContext.endLine,
    ruleContext.endColumn // End at end column of end line
  )
  
  editor.executeEdits('lsp-modify-rule', [{
    range,
    text: newRuleText
  }])
  
  console.log('[LSP Client] ✅ Rule replaced successfully')
}

/**
 * Trigger modify rule request to LSP server
 */
export function triggerModifyRule(
  editor: Monaco.editor.IStandaloneCodeEditor,
  modifyPrompt: string,
  ruleContext: {startLine: number, endLine: number, startColumn: number, endColumn: number},
  existingRule: string
): void {
  console.log('[LSP Client] ========================================')
  console.log('[LSP Client] 🔄 STEP 1: INITIATING MODIFY REQUEST')
  console.log('[LSP Client] ----------------------------------------')
  
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('[LSP Client] ❌ WebSocket not ready!')
    return
  }
  
  const model = editor.getModel()
  if (!model) {
    console.error('[LSP Client] ❌ Model not available')
    return
  }
  
  const requestId = Date.now()
  console.log('[LSP Client] 📋 Modify Request Details:')
  console.log('[LSP Client]   - Request ID:', requestId)
  console.log('[LSP Client]   - Modify prompt:', modifyPrompt)
  console.log('[LSP Client]   - Rule lines:', ruleContext.startLine, 'to', ruleContext.endLine)
  console.log('[LSP Client]   - Existing rule length:', existingRule.length, 'chars')
  
  // Set up response handler
  const handler = (event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data)
      
      if (message.id === requestId && message.result) {
        ws!.removeEventListener('message', handler)
        console.log('[LSP Client] ========================================')
        console.log('[LSP Client] ✅ STEP 2: RECEIVED MODIFY RESPONSE')
        console.log('[LSP Client] ----------------------------------------')
        
        const items = message.result?.items || []
        if (items.length > 0) {
          console.log('[LSP Client]   - Modified rule suggestions received:', items.length)
          
          // Convert to Monaco suggestions
          const suggestions = items.map((item: any) => ({
            label: item.label,
            kind: item.kind || getMonaco().languages.CompletionItemKind.Snippet,
            detail: item.detail,
            insertText: item.insertText || item.label,
            insertTextRules: item.insertTextRules || undefined,
            documentation: item.documentation,
            range: {
              startLineNumber: ruleContext.startLine,
              startColumn: 1,
              endLineNumber: ruleContext.endLine,
              endColumn: ruleContext.endColumn
            }
          }))
          
          // Store suggestions and rule context for replacement
          pendingSuggestions = suggestions
          pendingModifyRuleContext = {
            ruleContext: {
              fullRule: existingRule,
              ruleName: '',
              startLine: ruleContext.startLine,
              endLine: ruleContext.endLine,
              startColumn: ruleContext.startColumn,
              endColumn: ruleContext.endColumn,
              isInsideRule: true
            },
            existingRule: existingRule
          }
          
          console.log('[LSP Client]   - Storing suggestions for display')
          
          // Notify UI component to show suggestions dropdown
          if (onSuggestionsReady) {
            console.log('[LSP Client]   - Notifying UI component to show suggestions dropdown')
            onSuggestionsReady(suggestions)
          } else {
            console.log('[LSP Client]   ⚠️  No callback registered - suggestions stored but not displayed')
          }
          
          console.log('[LSP Client] ========================================')
        } else {
          console.log('[LSP Client] ⚠️  No modified rule in response')
          console.log('[LSP Client] ========================================')
        }
      }
    } catch (e) {
      console.error('[LSP Client] Parse error:', e)
      ws!.removeEventListener('message', handler)
    }
  }
  
  ws!.addEventListener('message', handler)
  
  // Send modify request
  const message = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'textDocument/completion',
    params: {
      textDocument: {
        uri: model.uri.toString()
      },
      position: {
        line: ruleContext.startLine - 1, // LSP uses 0-based
        character: 0
      },
      userPrompt: modifyPrompt,
      mode: 'modify',
      existingRule: existingRule,
      ruleContext: ruleContext
    }
  }
  
  console.log('[LSP Client]   📤 Sending modify request to server')
  console.log('[LSP Client]   - Mode: modify (update existing rule)')
  ws!.send(JSON.stringify(message))
  console.log('[LSP Client] ✅ Request sent successfully')
  console.log('[LSP Client] ========================================')
  
  // Timeout cleanup
  setTimeout(() => {
    ws!.removeEventListener('message', handler)
  }, 5000)
}

/**
 * Disconnect LSP client
 */
export function disconnectLSP(): void {
  if (completionProvider) {
    completionProvider.dispose()
    completionProvider = null
  }
  
  if (inlineCompletionsProvider) {
    inlineCompletionsProvider.dispose()
    inlineCompletionsProvider = null
  }
  
  // Clean up DOM event listener if it exists
  if (globalEditorRef) {
    const domNode = globalEditorRef.getDomNode()
    const handler = (globalEditorRef as any)?._lspKeydownHandler
    if (domNode && handler) {
      domNode.removeEventListener('keydown', handler, true)
      delete (globalEditorRef as any)._lspKeydownHandler
      console.log('[LSP Client] 🧹 Cleaned up DOM event listener')
    }
  }
  
  if (ws) {
    ws.close()
    ws = null
  }
  globalEditorRef = null
  isConnected = false
}


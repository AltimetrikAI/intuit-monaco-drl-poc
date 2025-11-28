import loader from '@monaco-editor/loader'
import type * as Monaco from 'monaco-editor'
// Import inline completions contribution to enable ghost text suggestions
import 'monaco-editor/esm/vs/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution'

let ws: WebSocket | null = null
let completionProvider: Monaco.IDisposable | null = null
let inlineCompletionsProvider: Monaco.IDisposable | null = null // Inline completions provider for ghost text
let isConnected = false
let pendingSuggestions: Monaco.languages.CompletionItem[] | null = null
let pendingModifyRuleContext: {ruleContext: RuleContext, existingRule: string} | null = null // Store rule context for modify replacement
let onShowGenerateDialog: ((mode: 'generate' | 'modify', existingRule?: string, ruleContext?: RuleContext) => void) | null = null
let autoCompletionEnabled = false // Track if auto-completion is enabled
let onAutoCompletionToggle: ((enabled: boolean) => void) | null = null // Callback for UI updates
let contextMenuActionsRegistered = false // Track if context menu actions are already registered
let toggleActionDisposable: Monaco.IDisposable | null = null // Store reference to toggle action for cleanup
let monacoInstance: typeof import('monaco-editor') | null = null

/**
 * Load Monaco Editor dynamically using the loader
 */
async function loadMonaco(): Promise<typeof import('monaco-editor')> {
  if (monacoInstance) {
    return monacoInstance
  }
  monacoInstance = await loader.init()
  return monacoInstance
}

/**
 * Get the Monaco Editor instance
 * Throws an error if Monaco hasn't been loaded yet
 */
function getMonaco(): typeof import('monaco-editor') {
  if (!monacoInstance) {
    throw new Error('[LSP Client] Monaco has not been initialized yet. Call loadMonaco() first.')
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
  // Ensure Monaco is loaded before using it
  await loadMonaco()
  const monaco = getMonaco()
  
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
        // Verify language matches
        if (model.getLanguageId() !== 'java') {
          return { suggestions: [] }
        }
        
        // Only return LSP suggestions if we have pending suggestions (from button/right-click or inline)
        if (pendingSuggestions && pendingSuggestions.length > 0) {
          console.log('[LSP Client] ========================================')
          console.log('[LSP Client] ✅ RETURNING LSP SUGGESTIONS')
          console.log('[LSP Client] ----------------------------------------')
          console.log('[LSP Client] Total suggestions:', pendingSuggestions.length)
          const suggestions = [...pendingSuggestions] // Copy array
          pendingSuggestions = null // Clear after returning
          return { suggestions }
        }
        
        // If manually triggered (button/right-click), wait for LLM response
        if (context.triggerKind === monaco.languages.CompletionTriggerKind.Invoke) {
          console.log('[LSP Client] ⏳ Waiting for LLM response...')
          return new Promise<Monaco.languages.ProviderResult<Monaco.languages.CompletionList>>((resolve) => {
            sendCompletionRequestPromise(editor, model, position, resolve)
          })
        }
        
        // If auto-completion is enabled, request inline suggestions during typing
        if (autoCompletionEnabled && context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter) {
          return new Promise<Monaco.languages.ProviderResult<Monaco.languages.CompletionList>>((resolve) => {
            sendInlineCompletionRequestPromise(editor, model, position, resolve)
          })
        }
        
        // During normal typing, return empty
        return { suggestions: [] }
      },
      // Trigger characters for auto-completion when enabled
      triggerCharacters: ['.', '(', ' ', '$'],
      _isLSPProvider: true
    } as any)
    
    console.log('[LSP Client] ✅ Completion provider registered successfully')

    // Register inline completions provider for ghost text suggestions
    if (inlineCompletionsProvider) {
      inlineCompletionsProvider.dispose()
      inlineCompletionsProvider = null
    }

    console.log('[LSP Client] 📝 Registering inline completions provider for language: java')
    console.log('[LSP Client]   - Auto-completion state:', autoCompletionEnabled)
    console.log('[LSP Client]   - Provider will be called by Monaco when:')
    console.log('[LSP Client]     1. User types (automatic trigger)')
    console.log('[LSP Client]     2. Manual trigger via keyboard shortcut')
    console.log('[LSP Client]     3. After accepting a completion')
    
    // Create provider object with all required methods
    const providerObject: any = {
      provideInlineCompletions: async (
        model: Monaco.editor.ITextModel,
        position: Monaco.Position,
        context: Monaco.languages.InlineCompletionContext,
        token: Monaco.CancellationToken
      ): Promise<Monaco.languages.InlineCompletions<Monaco.languages.InlineCompletion>> => {
        console.log('[LSP Client] ========================================')
        console.log('[LSP Client] 🔍 STEP 1: INLINE COMPLETIONS PROVIDER CALLED')
        console.log('[LSP Client] ----------------------------------------')
        console.log('[LSP Client]   - Model URI:', model.uri.toString())
        console.log('[LSP Client]   - Model Language:', model.getLanguageId())
        console.log('[LSP Client]   - Position: Line', position.lineNumber, 'Column', position.column)
        console.log('[LSP Client]   - Trigger kind:', context.triggerKind)
        console.log('[LSP Client]   - Auto-completion enabled:', autoCompletionEnabled)
        console.log('[LSP Client]   - Context selected suggestion info:', context.selectedSuggestionInfo)
        console.log('[LSP Client]   - Token cancelled:', token.isCancellationRequested)
        
        // Only provide inline completions if auto-completion is enabled
        if (!autoCompletionEnabled) {
          console.log('[LSP Client]   ⚠️  Auto-completion disabled - skipping inline completions')
          console.log('[LSP Client] ========================================')
          return { items: [] }
        }

        // Check if WebSocket is ready
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          console.log('[LSP Client]   ⚠️  WebSocket not ready - cannot request inline completions')
          console.log('[LSP Client]     - WebSocket state:', ws?.readyState, ws ? `(OPEN=${WebSocket.OPEN})` : 'NULL')
          console.log('[LSP Client] ========================================')
          return { items: [] }
        }

        // Check for explicit trigger (user manually triggered)
        // Based on the reference commit, we only handle explicit triggers
        const isExplicitTrigger = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit
        
        // Only provide inline completions for explicit triggers (manual keyboard shortcuts)
        // Automatic triggers (while typing) are disabled to avoid conflicts
        if (!isExplicitTrigger) {
          console.log('[LSP Client]   - Automatic trigger detected, returning no inline suggestions')
          console.log('[LSP Client]   💡 Inline completions only work with manual triggers (Option+Space, Ctrl+Space)')
          console.log('[LSP Client] ========================================')
          return { items: [] }
        }
        
        console.log('[LSP Client]   - Trigger type: Explicit (manual trigger) ✅')
        console.log('[LSP Client]   ✅ All checks passed - proceeding to request from server')
        console.log('[LSP Client] ========================================')
        
        try {
          const inlineItems = await requestInlineCompletionsFromServer(model, position)
          
          console.log('[LSP Client] ========================================')
          console.log('[LSP Client] 📤 STEP 4: PROPAGATING TO MONACO EDITOR')
          console.log('[LSP Client] ----------------------------------------')
          console.log('[LSP Client]   - Total inline completions to send to Monaco:', inlineItems.length)
          inlineItems.forEach((item: Monaco.languages.InlineCompletion, idx: number) => {
            const text = typeof item.insertText === 'string' ? item.insertText : ''
            console.log(`[LSP Client]     Completion ${idx + 1}:`)
            console.log(`[LSP Client]       - Insert Text: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`)
            console.log(`[LSP Client]       - Insert Text Length: ${text.length} chars`)
            console.log(`[LSP Client]       - Filter Text: "${item.filterText || 'N/A'}"`)
            if (item.range) {
              console.log(`[LSP Client]       - Range: Line ${item.range.startLineNumber}, Col ${item.range.startColumn} to Line ${item.range.endLineNumber}, Col ${item.range.endColumn}`)
            }
          })
          console.log('[LSP Client]   ✅ Returning to Monaco editor')
          console.log('[LSP Client] ========================================')
          
          return { items: inlineItems }
        } catch (error) {
          console.error('[LSP Client] ❌ Failed to fetch inline completions:', error)
          console.log('[LSP Client] ========================================')
          return { items: [] }
        }
      },
      freeInlineCompletions: (completions: Monaco.languages.InlineCompletions<Monaco.languages.InlineCompletion> | undefined) => {
        // Cleanup if necessary
        console.log('[LSP Client] 🧹 Freeing inline completions (cleanup)')
      },
      // Add disposeInlineCompletions method that Monaco expects (runtime API, not in TypeScript types)
      disposeInlineCompletions: (completions: any) => {
        console.log('[LSP Client] 🗑️  Disposing inline completions')
        if (completions) {
          console.log('[LSP Client]   - Completions to dispose:', completions.items?.length || 0)
        }
      }
    }
    
    inlineCompletionsProvider = monaco.languages.registerInlineCompletionsProvider('java', providerObject)
    
    console.log('[LSP Client] ✅ Inline completions provider registered successfully')

    // Add keyboard shortcut to manually trigger completion (for testing)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
      console.log('[LSP Client] ⌨️  Ctrl+Space keyboard shortcut triggered manually!')
      sendCompletionRequest(editor)
    })
    
    // Mac-friendly keyboard shortcuts for triggering inline suggestions
    // Option+Space (Alt+Space) - Most reliable on Mac
    // Based on the reference commit: https://github.com/AltimetrikAI/intuit-monaco-drl-poc/commit/e22e8c433e330a4f0b84d9f195c0b619fdf4a018
    editor.addCommand(
      monaco.KeyMod.Alt | monaco.KeyCode.Space,
      () => {
        console.log('[LSP Client] ⌨️  Option+Space detected - triggering inline suggestions')
        if (autoCompletionEnabled) {
          // Trigger inline suggestions using Monaco's built-in command
          // This should cause Monaco to call our provideInlineCompletions with Explicit trigger
          editor.trigger('lsp', 'editor.action.inlineSuggest.trigger', {})
          console.log('[LSP Client]   ✅ Triggered editor.action.inlineSuggest.trigger')
          console.log('[LSP Client]   💡 Monaco should now call provideInlineCompletions with Explicit trigger')
        } else {
          console.log('[LSP Client] ⚠️  Auto-completion not enabled')
        }
      },
      'editorTextFocus'
    )
    
    // Cmd+Space - May conflict with Spotlight, but try it
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space,
      () => {
        console.log('[LSP Client] ⌨️  Cmd+Space detected - triggering inline suggestions')
        if (autoCompletionEnabled) {
          editor.trigger('lsp', 'editor.action.inlineSuggest.trigger', {})
          console.log('[LSP Client]   ✅ Triggered editor.action.inlineSuggest.trigger')
        } else {
          console.log('[LSP Client] ⚠️  Auto-completion not enabled')
        }
      },
      'editorTextFocus'
    )
    
    // DOM event listener fallback for Ctrl+Space (Windows/Linux)
    const domNode = editor.getDomNode()
    if (domNode) {
      const keydownHandler = (e: KeyboardEvent) => {
        if (e.ctrlKey && !e.metaKey && e.code === 'Space') {
          e.preventDefault()
          e.stopPropagation()
          console.log('[LSP Client] ⌨️  Ctrl+Space detected via DOM listener - triggering inline suggestions')
          if (autoCompletionEnabled) {
            editor.trigger('lsp', 'editor.action.inlineSuggest.trigger', {})
            console.log('[LSP Client]   ✅ Triggered editor.action.inlineSuggest.trigger')
          } else {
            console.log('[LSP Client] ⚠️  Auto-completion not enabled')
          }
        }
      }
      
      domNode.addEventListener('keydown', keydownHandler, true)
      ;(editor as any)._lspKeydownHandler = keydownHandler
      console.log('[LSP Client] ✅ DOM event listener registered for Ctrl+Space fallback')
    }
    
    // Add context menu actions for Generate and Modify (only once)
    if (!contextMenuActionsRegistered) {
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
        
        // Enable/Disable Auto Completion action
        // Store the disposable so we can update it later
        toggleActionDisposable = editor.addAction({
          id: 'lsp-toggle-auto-completion',
          label: autoCompletionEnabled ? 'Disable Auto Completion' : 'Enable Auto Completion',
          contextMenuGroupId: 'navigation',
          contextMenuOrder: 2.0,
          run: (ed) => {
            console.log('[LSP Client] 🖱️  Right-click "Toggle Auto Completion" triggered!')
            toggleAutoCompletion(!autoCompletionEnabled)
          }
        })
        
        contextMenuActionsRegistered = true
        console.log('[LSP Client] ✅ Context menu actions "Generate Rule", "Modify Rule", and "Toggle Auto Completion" registered')
      } catch (error) {
        console.error('[LSP Client] ❌ Failed to register context menu actions:', error)
      }
    } else {
      // Actions already registered - Monaco's addAction with same ID should replace
      // We only update the auto-completion label when state changes (in toggleAutoCompletion)
      console.log('[LSP Client] ℹ️  Context menu actions already registered, skipping duplicate registration')
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
function sendCompletionRequestPromise(
  editor: Monaco.editor.IStandaloneCodeEditor,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  resolve: (result: Monaco.languages.ProviderResult<Monaco.languages.CompletionList>) => void
): void {
  const monaco = getMonaco()
  
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('[LSP Client] ❌ WebSocket not ready!')
    resolve({ suggestions: [] })
    return
  }

  const requestId = Date.now()
    const timeout = setTimeout(() => {
      ws!.removeEventListener('message', handler)
      console.error('[LSP Client] ⏱️  Request timeout after 45 seconds')
      resolve({ suggestions: [] })
    }, 45000)

  const handler = (event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data)
      if (message.id === requestId && message.result) {
        clearTimeout(timeout)
        ws!.removeEventListener('message', handler)
        const items = message.result?.items || []
        const suggestions = items.map((item: any) => ({
          label: item.label,
          kind: item.kind || monaco.languages.CompletionItemKind.Text,
          detail: item.detail,
          insertText: item.insertText || item.label,
          insertTextRules: item.insertTextRules,
          documentation: item.documentation,
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
      clearTimeout(timeout)
      ws!.removeEventListener('message', handler)
      resolve({ suggestions: [] })
    }
  }

  ws.addEventListener('message', handler)
  
  const message = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'textDocument/completion',
    params: {
      textDocument: { uri: model.uri.toString() },
      position: { line: position.lineNumber - 1, character: position.column - 1 },
      mode: 'generate',
      userPrompt: undefined
    }
  }
  ws.send(JSON.stringify(message))
}

function sendCompletionRequest(editor: Monaco.editor.IStandaloneCodeEditor, userPrompt?: string): void {
  const monaco = getMonaco()
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

  // Set up timeout handler (45 seconds for LLM responses)
  const timeout = setTimeout(() => {
    ws!.removeEventListener('message', handler)
    console.error('[LSP Client] ⏱️  Request timeout after 45 seconds')
    console.error('[LSP Client]   - Request ID:', requestId)
    console.error('[LSP Client]   - This may happen if LLM takes too long to respond')
  }, 45000)

  // Set up response handler
  const handler = (event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data)
      
      // Log all messages for debugging
      if (message.method) {
        console.log('[LSP Client] 📨 Received message:', message.method, 'ID:', message.id)
      }
      
      if (message.id === requestId && message.result) {
        clearTimeout(timeout)
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
          
          // Trigger Monaco's completion UI to show the suggestions
          console.log('[LSP Client] ========================================')
          console.log('[LSP Client] ✅ STEP 4: TRIGGERING MONACO COMPLETION UI')
          console.log('[LSP Client] ----------------------------------------')
          console.log('[LSP Client]   - pendingSuggestions set:', suggestions.length, 'items')
          
          // Use setTimeout to ensure suggestions are set before triggering
          setTimeout(() => {
            try {
              console.log('[LSP Client]   - Triggering editor.action.triggerSuggest...')
              editor.trigger('lsp', 'editor.action.triggerSuggest', {})
              console.log('[LSP Client]   ✅ Successfully triggered completion UI')
            } catch (error) {
              console.error('[LSP Client]   ❌ Error triggering completion UI:', error)
            }
          }, 50)
          
          // Notify UI component that suggestions are ready (for custom dropdown)
          if (onSuggestionsReady) {
            console.log('[LSP Client]   - Notifying UI component to show custom dropdown')
            onSuggestionsReady(suggestions)
          }
          
          console.log('[LSP Client] ========================================')
        } else {
          console.log('[LSP Client] ⚠️  No suggestions received from server')
          console.log('[LSP Client] ========================================')
        }
      }
    } catch (e) {
      clearTimeout(timeout)
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
 * Request inline completions from server (ghost text suggestions)
 * This is used by the inline completions provider
 */
async function requestInlineCompletionsFromServer(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  userPrompt?: string
): Promise<Monaco.languages.InlineCompletion[]> {
  const monaco = getMonaco()
  console.log('[LSP Client] ========================================')
  console.log('[LSP Client] 📡 REQUESTING INLINE COMPLETIONS FROM SERVER')
  console.log('[LSP Client] ----------------------------------------')
  
  const socket = ws
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn('[LSP Client] ⚠️  Cannot request inline completions: WebSocket not ready')
    console.warn('[LSP Client]     - WebSocket state:', socket?.readyState, socket ? `(OPEN=${WebSocket.OPEN})` : 'NULL')
    console.log('[LSP Client] ========================================')
    return []
  }

  console.log('[LSP Client] ✅ WebSocket is OPEN and ready')
  console.log('[LSP Client]   - Model URI:', model.uri.toString())
  console.log('[LSP Client]   - Position: Line', position.lineNumber, 'Column', position.column)
  if (userPrompt) {
    console.log('[LSP Client]   - User prompt:', userPrompt)
  }

  const requestId = Date.now()
  console.log('[LSP Client]   - Request ID:', requestId)

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.warn('[LSP Client] ⚠️  Inline completion request timed out after 3 seconds')
      console.log('[LSP Client]     - Request ID:', requestId)
      socket.removeEventListener('message', handler)
      console.log('[LSP Client] ========================================')
      resolve([])
    }, 3000)

    const handler = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data)
        
        // Log all incoming messages for debugging
        if (message.method) {
          console.log('[LSP Client] 📨 Received WebSocket message:', message.method, 'ID:', message.id)
        }
        
        if (message.id === requestId && message.result) {
          clearTimeout(timeout)
          socket.removeEventListener('message', handler)
          
          console.log('[LSP Client] ========================================')
          console.log('[LSP Client] ✅ STEP 3: RECEIVED RESPONSE FROM SERVER')
          console.log('[LSP Client] ----------------------------------------')
          console.log('[LSP Client]   - Response ID:', message.id)
          console.log('[LSP Client]   - Matches Request ID:', requestId, message.id === requestId ? '✅' : '❌')
          console.log('[LSP Client]   - Has result:', !!message.result)
          console.log('[LSP Client]   - Result keys:', message.result ? Object.keys(message.result).join(', ') : 'none')

          const items = message.result?.items || []
          console.log('[LSP Client]   - Raw items count from server:', items.length)
          
          if (items.length === 0) {
            console.log('[LSP Client]   ⚠️  No inline completion items in response')
            console.log('[LSP Client] ========================================')
            resolve([])
            return
          }

          // Log each raw item received from server
          console.log('[LSP Client]   📋 RAW ITEMS FROM SERVER:')
          items.forEach((item: any, idx: number) => {
            console.log(`[LSP Client]     Raw Item ${idx + 1}:`)
            console.log(`[LSP Client]       - Label: "${item.label || 'N/A'}"`)
            console.log(`[LSP Client]       - Kind: ${item.kind || 'N/A'}`)
            console.log(`[LSP Client]       - Detail: "${item.detail || 'N/A'}"`)
            console.log(`[LSP Client]       - Insert Text Type: ${typeof item.insertText}`)
            console.log(`[LSP Client]       - Insert Text Length: ${(item.insertText || '').length} chars`)
            if (item.insertText) {
              const preview = item.insertText.substring(0, 150)
              console.log(`[LSP Client]       - Insert Text Preview: "${preview}${item.insertText.length > 150 ? '...' : ''}"`)
            }
            if (item.insertTextRules) {
              console.log(`[LSP Client]       - Insert Text Rules: ${item.insertTextRules}`)
            }
            console.log(`[LSP Client]       - Full Item JSON:`, JSON.stringify(item, null, 2).substring(0, 200) + '...')
          })

          console.log('[LSP Client]   🔄 Converting raw items to Monaco InlineCompletion format...')
          
          // Convert LSP completion items to Monaco inline completions
          const inlineItems = items.map((item: any, idx: number) => {
            // Handle insertText which can be string or object
            let insertText = ''
            if (typeof item.insertText === 'string') {
              insertText = item.insertText
            } else if (item.insertText?.snippet) {
              insertText = item.insertText.snippet
            } else {
              insertText = item.label || ''
            }
            
            const filterText = typeof item.label === 'string' ? item.label : item.label?.label || insertText
            
            // Create range for inline completion
            // For inline completions, the range should start at current position
            // and end at the same position (replacing nothing, inserting after cursor)
            const range = new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            )
            
            const inlineCompletion: Monaco.languages.InlineCompletion = {
              insertText: insertText,
              filterText: filterText,
              range: range
            }
            
            console.log(`[LSP Client]     ✅ Converted Item ${idx + 1} to Monaco InlineCompletion:`)
            console.log(`[LSP Client]       - Insert Text: "${insertText.substring(0, 100)}${insertText.length > 100 ? '...' : ''}"`)
            console.log(`[LSP Client]       - Insert Text Full Length: ${insertText.length} chars`)
            console.log(`[LSP Client]       - Filter Text: "${filterText}"`)
            console.log(`[LSP Client]       - Range: Line ${range.startLineNumber}, Col ${range.startColumn} to Line ${range.endLineNumber}, Col ${range.endColumn}`)
            console.log(`[LSP Client]       - Monaco InlineCompletion Object:`, {
              insertText: insertText.substring(0, 50) + (insertText.length > 50 ? '...' : ''),
              filterText: filterText,
              range: {
                startLineNumber: range.startLineNumber,
                startColumn: range.startColumn,
                endLineNumber: range.endLineNumber,
                endColumn: range.endColumn
              }
            })
            
            return inlineCompletion
          })

          console.log('[LSP Client]   📤 CONVERSION COMPLETE:')
          console.log('[LSP Client]     - Total converted items:', inlineItems.length)
          console.log('[LSP Client]     - Ready to send to Monaco editor')
          if (inlineItems.length > 0) {
            console.log('[LSP Client]     ✅ Monaco should display these as ghost text')
            console.log('[LSP Client]     💡 If ghost text doesn\'t appear, Monaco may not be rendering inline completions')
          }
          console.log('[LSP Client] ========================================')
          resolve(inlineItems)
        }
      } catch (error) {
        console.error('[LSP Client] ❌ Inline completion parse error:', error)
        console.error('[LSP Client]     - Error details:', error instanceof Error ? error.message : String(error))
        clearTimeout(timeout)
        socket.removeEventListener('message', handler)
        console.log('[LSP Client] ========================================')
        resolve([])
      }
    }

    socket.addEventListener('message', handler)

    // Send inline completion request
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
        mode: 'inline', // Inline completion mode
        userPrompt: userPrompt || undefined,
        context: {
          triggerKind: 1 // Invoked
        }
      }
    }

    console.log('[LSP Client] ========================================')
    console.log('[LSP Client] 📤 STEP 2: SENDING REQUEST TO LSP SERVER')
    console.log('[LSP Client] ----------------------------------------')
    console.log('[LSP Client]   - Method:', message.method)
    console.log('[LSP Client]   - Request ID:', message.id)
    console.log('[LSP Client]   - Mode: inline')
    console.log('[LSP Client]   - Text Document URI:', message.params.textDocument.uri)
    console.log('[LSP Client]   - Position (0-based):', message.params.position)
    console.log('[LSP Client]   - Position (1-based): Line', position.lineNumber, 'Column', position.column)
    console.log('[LSP Client]   - User Prompt:', userPrompt || 'none')
    console.log('[LSP Client]   - Full Request Message:')
    console.log('[LSP Client]     ', JSON.stringify(message, null, 2))
    console.log('[LSP Client]   ⏳ Waiting for server response...')
    console.log('[LSP Client] ========================================')
    
    socket.send(JSON.stringify(message))
    console.log('[LSP Client] ✅ Request sent successfully via WebSocket')
  })
}

/**
 * Send inline completion request for auto-completion during typing (promise-based)
 * This is for regular completion items (dropdown), not inline completions
 */
function sendInlineCompletionRequestPromise(
  editor: Monaco.editor.IStandaloneCodeEditor,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  resolve: (result: Monaco.languages.ProviderResult<Monaco.languages.CompletionList>) => void
): void {
  const monaco = getMonaco()
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    resolve({ suggestions: [] })
    return
  }

  const requestId = Date.now()
  
  // Set up response handler
  const handler = (event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data)
      
      if (message.id === requestId && message.result) {
        ws!.removeEventListener('message', handler)
        
        const items = message.result?.items || []
        
        if (items.length > 0) {
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
          
          console.log('[LSP Client] ✅ Returning inline suggestions:', suggestions.length)
          resolve({ suggestions })
        } else {
          resolve({ suggestions: [] })
        }
      }
    } catch (e) {
      console.error('[LSP Client] Parse error in inline completion:', e)
      ws!.removeEventListener('message', handler)
      resolve({ suggestions: [] })
    }
  }

  ws!.addEventListener('message', handler)

  // Send inline completion request
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
      mode: 'inline', // Inline completion mode
      context: {
        triggerKind: 1 // Invoked
      }
    }
  }
  
  ws!.send(JSON.stringify(message))
  
  // Timeout cleanup
  setTimeout(() => {
    ws!.removeEventListener('message', handler)
    // Resolve with empty if no response received
    resolve({ suggestions: [] })
  }, 2000)
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

/**
 * Toggle auto-completion on/off
 */
export function toggleAutoCompletion(enabled: boolean): void {
  autoCompletionEnabled = enabled
  console.log('[LSP Client] 🔄 Auto-completion', enabled ? 'ENABLED' : 'DISABLED')
  
  // Update context menu label if editor is available
  // Remove old action and add new one with updated label
  if (globalEditorRef && contextMenuActionsRegistered && toggleActionDisposable) {
    try {
      // Dispose the old action first
      toggleActionDisposable.dispose()
      toggleActionDisposable = null
      
      // Add new action with updated label
      toggleActionDisposable = globalEditorRef.addAction({
        id: 'lsp-toggle-auto-completion',
        label: enabled ? 'Disable Auto Completion' : 'Enable Auto Completion',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 2.0,
        run: () => {
          toggleAutoCompletion(!enabled)
        }
      })
      console.log('[LSP Client] ✅ Updated auto-completion action label')
    } catch (error) {
      console.error('[LSP Client] ❌ Failed to update auto-completion action label:', error)
    }
  }
  
  // Notify UI component
  if (onAutoCompletionToggle) {
    onAutoCompletionToggle(enabled)
  }
}

/**
 * Get current auto-completion state
 */
export function isAutoCompletionEnabled(): boolean {
  return autoCompletionEnabled
}

/**
 * Register callback for auto-completion toggle
 */
export function setOnAutoCompletionToggle(callback: (enabled: boolean) => void): void {
  onAutoCompletionToggle = callback
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
  const monaco = getMonaco()
  const model = editor.getModel()
  if (!model) {
    console.error('[LSP Client] ❌ Cannot replace rule: model not available')
    return
  }
  
  console.log('[LSP Client] 🔄 Replacing rule in editor:')
  console.log('[LSP Client]   - Rule name:', ruleContext.ruleName)
  console.log('[LSP Client]   - Lines:', ruleContext.startLine, 'to', ruleContext.endLine)
  console.log('[LSP Client]   - New rule length:', newRuleText.length, 'chars')
  
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
  const monaco = getMonaco()
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
        console.log('[LSP Client]   - Response items count:', items.length)
        if (items.length > 0) {
          console.log('[LSP Client]   - Modified rule suggestions received:', items.length)
          items.forEach((item: any, idx: number) => {
            console.log(`[LSP Client]     Item ${idx + 1}:`)
            console.log(`[LSP Client]       - Label: "${item.label}"`)
            console.log(`[LSP Client]       - Insert Text Length: ${(item.insertText || '').length} chars`)
            console.log(`[LSP Client]       - Insert Text Preview: ${(item.insertText || '').substring(0, 100)}...`)
          })
          
          // Convert to Monaco suggestions with proper range for replacement
          const suggestions = items.map((item: any) => {
            // Calculate end column - use ruleContext endColumn if available, 
            // otherwise use model's line max column for accurate range
            const endColumn = ruleContext.endColumn || model.getLineMaxColumn(ruleContext.endLine)
            
            const suggestion = {
              label: item.label,
              kind: item.kind || monaco.languages.CompletionItemKind.Snippet,
              detail: item.detail,
              insertText: item.insertText || item.label,
              insertTextRules: item.insertTextRules || undefined,
              documentation: item.documentation,
              range: {
                startLineNumber: ruleContext.startLine,
                startColumn: ruleContext.startColumn || 1,
                endLineNumber: ruleContext.endLine,
                endColumn: endColumn
              }
            }
            console.log('[LSP Client]   - Created suggestion with range:', {
              startLine: suggestion.range.startLineNumber,
              startColumn: suggestion.range.startColumn,
              endLine: suggestion.range.endLineNumber,
              endColumn: suggestion.range.endColumn
            })
            return suggestion
          })
          
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
  if (toggleActionDisposable) {
    toggleActionDisposable.dispose()
    toggleActionDisposable = null
  }
  
  // Clean up DOM event listeners
  if (globalEditorRef) {
    const domNode = globalEditorRef.getDomNode()
    const handler = (globalEditorRef as any)._lspKeydownHandler
    if (domNode && handler) {
      domNode.removeEventListener('keydown', handler, true)
      delete (globalEditorRef as any)._lspKeydownHandler
      console.log('[LSP Client] 🧹 Removed DOM event listener')
    }
  }
  
  if (ws) {
    ws.close()
    ws = null
  }
  globalEditorRef = null
  isConnected = false
  contextMenuActionsRegistered = false // Reset flag so actions can be registered again on next init
}


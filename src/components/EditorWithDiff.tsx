import { useMemo, useState, useEffect, useRef } from 'react'
import Editor, { DiffEditor, OnMount, DiffOnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { initializeLSP, sendDocumentContent, disconnectLSP, triggerCompletion, setOnSuggestionsReady, setOnShowGenerateDialog, replaceRuleInEditor, triggerModifyRule } from '../utils/lsp-client'
import { extractFactSchema } from '../utils/factSchema'

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

interface Props {
  value: string
  originalValue: string
  onChange: (value: string) => void
  language: string
  height: string
  loading?: boolean
  error?: string
  onSave: () => void
  saving?: boolean
  disabled?: boolean
  title: string
  filename: string
  factObject?: Record<string, unknown>
  bddTests?: string
  enableLSP?: boolean
}

export function EditorWithDiff({
  value,
  originalValue,
  onChange,
  language,
  height,
  loading,
  error,
  onSave,
  saving,
  disabled,
  title,
  filename,
  factObject,
  bddTests,
  enableLSP = false
}: Props) {
  const [showDiff, setShowDiff] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [lspReady, setLspReady] = useState(false) // Use state instead of ref for button
  const [suggestions, setSuggestions] = useState<monaco.languages.CompletionItem[]>([])
  const [showSuggestionsDropdown, setShowSuggestionsDropdown] = useState(false)
  const [showGenerateDialog, setShowGenerateDialog] = useState(false)
  const [generatePrompt, setGeneratePrompt] = useState('')
  const [dialogMode, setDialogMode] = useState<'generate' | 'modify'>('generate')
  const [existingRule, setExistingRule] = useState<string | null>(null)
  const [modifyPrompt, setModifyPrompt] = useState('') // Separate prompt for modify mode
  const [ruleContext, setRuleContext] = useState<{startLine: number, endLine: number, startColumn: number, endColumn: number} | null>(null) // Store rule position for replacement
  const [editorMounted, setEditorMounted] = useState(false) // Track when editor is mounted
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const lspInitialized = useRef(false)

  const monacoOptions = useMemo(
    () => ({
      fontSize: 14,
      minimap: { enabled: false },
      wordWrap: 'on' as const,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      readOnly: false,
      renderSideBySide: true,
      quickSuggestions: {
        other: true,
        comments: false,
        strings: false
      },
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnCommitCharacter: true,
      tabCompletion: 'on' as const,
      // Enable normal Java suggestions (keywords, words, etc.)
      wordBasedSuggestions: true,
      suggest: {
        showSnippets: true,
        showKeywords: true, // Enable Java keywords
        showWords: true, // Enable word-based suggestions (case matching)
        showClasses: true,
        showFunctions: true,
        showVariables: true,
        showFields: true
      }
    }),
    []
  )

  const diffOptions = useMemo(
    () => ({
      ...monacoOptions,
      readOnly: false,
      renderSideBySide: true,
      enableSplitViewResizing: true
    }),
    [monacoOptions]
  )

  const hasChanges = value !== originalValue

  // Set up callback for when suggestions are ready
  useEffect(() => {
    if (enableLSP && language === 'java') {
      setOnSuggestionsReady((suggestions) => {
        console.log('[Editor] ========================================')
        console.log('[Editor] 📋 SUGGESTIONS RECEIVED - SHOWING DROPDOWN')
        console.log('[Editor] ----------------------------------------')
        console.log('[Editor] Total suggestions:', suggestions.length)
        suggestions.forEach((sug, idx) => {
          const label = typeof sug.label === 'string' ? sug.label : sug.label.label
          console.log(`[Editor]   Suggestion ${idx + 1}:`)
          console.log(`[Editor]     - Label: "${label}"`)
          console.log(`[Editor]     - Kind: ${sug.kind} (${getCompletionKindName(sug.kind)})`)
          console.log(`[Editor]     - Detail: "${sug.detail || 'N/A'}"`)
          console.log(`[Editor]     - Insert Text Length: ${sug.insertText ? sug.insertText.length : 0} chars`)
          if (sug.insertText) {
            const preview = sug.insertText.substring(0, 100)
            console.log(`[Editor]     - Insert Text Preview: "${preview}${sug.insertText.length > 100 ? '...' : ''}"`)
          }
          if (sug.documentation) {
            const doc = typeof sug.documentation === 'string' ? sug.documentation : (sug.documentation as any)?.value || ''
            console.log(`[Editor]     - Documentation: "${doc.substring(0, 80)}${doc.length > 80 ? '...' : ''}"`)
          }
        })
        console.log('[Editor] ========================================')
        setSuggestions(suggestions)
        setShowSuggestionsDropdown(true)
      })
    }
    
    return () => {
      setOnSuggestionsReady(() => {}) // Clear callback on unmount
    }
  }, [enableLSP, language])

  // Initialize LSP when editor mounts and context is available
  useEffect(() => {
    // Only check if editor is mounted
    if (!editorMounted) {
      return
    }
    
    // Only log if LSP is enabled and language is java (to reduce noise)
    if (enableLSP && language === 'java') {
      console.log('[Editor] LSP initialization check:', {
        enableLSP,
        language,
        hasEditor: !!editorRef.current,
        editorMounted,
        alreadyInitialized: lspInitialized.current,
        hasFactObject: !!factObject,
        bddTestsDefined: bddTests !== undefined
      })
    }
    
    if (!enableLSP || language !== 'java' || !editorRef.current || lspInitialized.current) {
      // Only log if LSP is enabled but conditions aren't met (to reduce noise from other editors)
      if (enableLSP && language !== 'java') {
        // Silently skip - this is expected for non-java editors (e.g., markdown in diff view)
        return
      }
      if (enableLSP && !editorRef.current) {
        console.log('[Editor] Editor ref not available')
      }
      if (lspInitialized.current) {
        console.log('[Editor] LSP already initialized')
      }
      return
    }

    if (factObject && bddTests !== undefined) {
      console.log('[Editor] ✅ All conditions met, initializing LSP...')
      const factSchema = extractFactSchema(factObject)
      initializeLSP(editorRef.current, {
        factObject,
        factSchema,
        bddTests: bddTests || '',
        currentDrl: value
      }).then(() => {
        lspInitialized.current = true
        setLspReady(true) // Update state for button
        console.log('[Editor] ✅ LSP initialization complete')
      }).catch((err) => {
        console.error('[Editor] LSP initialization failed:', err)
        setLspReady(false)
      })
    } else {
      console.log('[Editor] ⚠️  Waiting for factObject and bddTests...')
    }
  }, [enableLSP, language, factObject, bddTests, value, editorMounted])

  // Send document updates to LSP
  useEffect(() => {
    if (enableLSP && language === 'java' && lspInitialized.current) {
      sendDocumentContent(value)
    }
  }, [value, enableLSP, language])

  // Handle Escape key to close suggestions dropdown
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showSuggestionsDropdown) {
          setShowSuggestionsDropdown(false)
          setSuggestions([])
        }
        if (showGenerateDialog) {
          setShowGenerateDialog(false)
          setGeneratePrompt('')
          setModifyPrompt('')
          setExistingRule(null)
          setRuleContext(null)
          setDialogMode('generate')
        }
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [showSuggestionsDropdown, showGenerateDialog])

  // Register callback for right-click context menu trigger
  useEffect(() => {
    const showDialog = (mode: 'generate' | 'modify', existingRuleText?: string, ruleCtx?: any) => {
      console.log('[Editor] 📢 Show dialog callback called from right-click')
      console.log('[Editor]   - Mode:', mode)
      console.log('[Editor]   - Existing rule:', existingRuleText ? `${existingRuleText.length} chars` : 'none')
      console.log('[Editor]   - Rule context:', ruleCtx ? `Lines ${ruleCtx.startLine}-${ruleCtx.endLine}` : 'none')
      
      setDialogMode(mode)
      if (mode === 'modify' && existingRuleText) {
        setExistingRule(existingRuleText)
        setRuleContext(ruleCtx || null)
        setGeneratePrompt('') // Clear generate prompt
        setModifyPrompt('') // Clear modify prompt
      } else {
        setExistingRule(null)
        setRuleContext(null)
        setGeneratePrompt('') // Clear for generate mode
        setModifyPrompt('')
      }
      setShowGenerateDialog(true)
      console.log('[Editor] ✅ Dialog state set to true')
    }
    
    // Register callback with LSP client
    setOnShowGenerateDialog(showDialog)
    console.log('[Editor] ✅ Registered show dialog callback with LSP client')
    
    // Also listen for custom event as fallback
    const handleShowDialog = (event: Event) => {
      console.log('[Editor] 📢 Received show-generate-dialog event (fallback)')
      event.stopPropagation()
      setDialogMode('generate')
      setExistingRule(null)
      setGeneratePrompt('')
      setShowGenerateDialog(true)
    }
    window.addEventListener('show-generate-dialog', handleShowDialog)
    
    return () => {
      setOnShowGenerateDialog(() => {}) // Clear callback
      window.removeEventListener('show-generate-dialog', handleShowDialog)
      console.log('[Editor] 🛑 Cleaned up show dialog handlers')
    }
  }, [])

  // Handle generate/modify dialog submission
  const handleGenerateSubmit = () => {
    if (dialogMode === 'modify') {
      // Modify mode: need modify prompt
      if (!modifyPrompt.trim()) {
        console.log('[Editor] ⚠️  Cannot submit: modification prompt is empty')
        return
      }
      
      const prompt = modifyPrompt.trim()
      const currentRuleContext = ruleContext
      console.log('[Editor] 📝 Modify dialog submission:')
      console.log('[Editor]   - Modification prompt:', prompt)
      console.log('[Editor]   - Existing rule:', existingRule ? `${existingRule.length} chars` : 'none')
      
      // Close dialog first
      setShowGenerateDialog(false)
      const currentPrompt = prompt
      const currentContext = currentRuleContext
      setModifyPrompt('')
      setExistingRule(null)
      setRuleContext(null)
      setDialogMode('generate')
      
      // Send modify request to LSP
      setTimeout(() => {
        if (editorRef.current && currentContext && existingRule) {
          sendModifyRequest(editorRef.current, currentPrompt, currentContext, existingRule)
        } else {
          console.warn('[Editor] Editor ref, rule context, or existing rule not available')
        }
      }, 100)
    } else {
      // Generate mode: need generate prompt
      if (!generatePrompt.trim()) {
        console.log('[Editor] ⚠️  Cannot submit: prompt is empty')
        return
      }
      
      const prompt = generatePrompt.trim()
      console.log('[Editor] 📝 Generate dialog submission:')
      console.log('[Editor]   - Prompt:', prompt.substring(0, 50) + '...')
      
      // Close dialog first
      setShowGenerateDialog(false)
      const currentPrompt = prompt
      setGeneratePrompt('')
      
      // Small delay to ensure dialog closes before triggering completion
      setTimeout(() => {
        if (editorRef.current) {
          triggerCompletion(editorRef.current, currentPrompt)
        } else {
          console.warn('[Editor] Editor ref not available')
          triggerCompletion(undefined, currentPrompt)
        }
      }, 100)
    }
  }
  
  // Send modify request to LSP server
  const sendModifyRequest = (
    editor: monaco.editor.IStandaloneCodeEditor,
    modifyPrompt: string,
    ruleCtx: {startLine: number, endLine: number, startColumn: number, endColumn: number},
    existingRuleText: string
  ) => {
    console.log('[Editor] 🔄 Sending modify request to LSP server')
    triggerModifyRule(editor, modifyPrompt, ruleCtx, existingRuleText)
  }

  // Cleanup LSP on unmount
  useEffect(() => {
    return () => {
      if (enableLSP && language === 'java') {
        disconnectLSP()
        lspInitialized.current = false
        setLspReady(false)
      }
      setEditorMounted(false) // Reset editor mounted state
    }
  }, [enableLSP, language])

  async function handleSaveClick() {
    if (hasChanges) {
      setShowSaveDialog(true)
    } else {
      onSave()
    }
  }

  async function handleConfirmSave() {
    setShowSaveDialog(false)
    onSave()
  }

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor
    setEditorMounted(true) // Mark editor as mounted
    
    // Log editor info for debugging
    const model = editor.getModel()
    if (model) {
      console.log('[Editor] Editor mounted - Language:', model.getLanguageId(), 'URI:', model.uri.toString())
    } else {
      console.log('[Editor] Editor mounted but model not available yet')
    }
  }

  const handleDiffEditorMount: DiffOnMount = (editor) => {
    // For diff editor, get the modified editor (the one we can edit)
    const modifiedEditor = editor.getModifiedEditor()
    editorRef.current = modifiedEditor
    setEditorMounted(true) // Mark editor as mounted
    
    // Log editor info for debugging
    const model = modifiedEditor.getModel()
    if (model) {
      console.log('[Editor] Diff Editor mounted - Modified editor Language:', model.getLanguageId(), 'URI:', model.uri.toString())
    }
    
    // Listen for changes in the modified editor
    modifiedEditor.onDidChangeModelContent(() => {
      onChange(modifiedEditor.getValue())
    })
  }

  const handleSuggestionSelect = (suggestion: monaco.languages.CompletionItem, event?: React.MouseEvent) => {
    // Stop event propagation to prevent backdrop click
    if (event) {
      event.stopPropagation()
      event.preventDefault()
    }
    
    // Close dropdown immediately
    setShowSuggestionsDropdown(false)
    setSuggestions([])
    
    if (editorRef.current) {
      const editor = editorRef.current
      const model = editor.getModel()
      
      if (model && suggestion.insertText) {
        // Check if this is a modify suggestion (has range with start/end lines)
        const suggestionRange = suggestion.range as any
        if (suggestionRange && suggestionRange.startLineNumber && suggestionRange.endLineNumber && 
            suggestionRange.startLineNumber !== suggestionRange.endLineNumber) {
          // This is a modify suggestion - replace the rule
          console.log('[Editor] 🔄 Replacing rule with modified version')
          const range = new monaco.Range(
            suggestionRange.startLineNumber,
            suggestionRange.startColumn || 1,
            suggestionRange.endLineNumber,
            suggestionRange.endColumn || 1000
          )
          editor.executeEdits('lsp-modify-rule', [{
            range,
            text: suggestion.insertText
          }])
          console.log('[Editor] ✅ Rule replaced with modified version:', suggestion.label)
        } else {
          // This is a generate suggestion - insert at cursor
          const position = editor.getPosition()
          if (position) {
            const range = new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            )
            editor.executeEdits('lsp-suggestion', [{
              range,
              text: suggestion.insertText
            }])
            console.log('[Editor] ✅ Inserted suggestion:', suggestion.label)
          }
        }
      }
    }
  }

  return (
    <>
      {/* Generate Rule Input Dialog */}
      {showGenerateDialog && (
        <>
          {/* Backdrop */}
          <div 
            onClick={() => {
              setShowGenerateDialog(false)
              setGeneratePrompt('')
              setModifyPrompt('')
              setExistingRule(null)
              setRuleContext(null)
              setDialogMode('generate')
            }}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
              zIndex: 9999
            }}
          />
          {/* Dialog */}
          <div 
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              zIndex: 10000,
              backgroundColor: '#1e1e1e',
              border: '1px solid #3c3c3c',
              borderRadius: '8px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              width: '500px',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              padding: '20px'
            }}
          >
            <div style={{ marginBottom: '16px' }}>
              <h3 style={{ margin: '0 0 8px 0', color: '#ffffff', fontSize: '18px', fontWeight: '600' }}>
                {dialogMode === 'modify' ? '✏️ Modify DRL Rule' : '✨ Generate DRL Rule'}
              </h3>
              <p style={{ margin: '0', color: '#858585', fontSize: '13px' }}>
                {dialogMode === 'modify' 
                  ? 'Describe what changes you want to make to the rule below' 
                  : 'Describe what rule you want to generate'}
              </p>
            </div>
            
            {/* Show existing rule in modify mode */}
            {dialogMode === 'modify' && existingRule && (
              <div style={{ marginBottom: '16px' }}>
                <div style={{ marginBottom: '8px', fontSize: '12px', color: '#858585', fontWeight: '500' }}>
                  Current Rule:
                </div>
                <div style={{
                  padding: '12px',
                  backgroundColor: '#252526',
                  border: '1px solid #3c3c3c',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  color: '#a8d8a8',
                  whiteSpace: 'pre-wrap',
                  maxHeight: '200px',
                  overflow: 'auto',
                  lineHeight: '1.5'
                }}>
                  {existingRule}
                </div>
              </div>
            )}
            
            {/* Input field - different for generate vs modify */}
            {dialogMode === 'modify' ? (
              <textarea
                value={modifyPrompt}
                onChange={(e) => setModifyPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    handleGenerateSubmit()
                  }
                }}
                placeholder="e.g., Change the premium threshold from 500 to 1000, or add a new condition..."
                style={{
                  width: '100%',
                  minHeight: '80px',
                  padding: '12px',
                  backgroundColor: '#252526',
                  color: '#cccccc',
                  border: '1px solid #3c3c3c',
                  borderRadius: '4px',
                  fontSize: '14px',
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  marginBottom: '16px',
                  outline: 'none'
                }}
                autoFocus
              />
            ) : (
              <textarea
                value={generatePrompt}
                onChange={(e) => setGeneratePrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    handleGenerateSubmit()
                  }
                }}
                placeholder="e.g., Flag quotes with premium greater than 500 for review"
                style={{
                  width: '100%',
                  minHeight: '100px',
                  padding: '12px',
                  backgroundColor: '#252526',
                  color: '#cccccc',
                  border: '1px solid #3c3c3c',
                  borderRadius: '4px',
                  fontSize: '14px',
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  marginBottom: '16px',
                  outline: 'none'
                }}
                autoFocus
              />
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                onClick={() => {
                  setShowGenerateDialog(false)
                  setGeneratePrompt('')
                }}
                style={{
                  padding: '8px 16px',
                  fontSize: '13px',
                  backgroundColor: 'transparent',
                  color: '#cccccc',
                  border: '1px solid #3c3c3c',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateSubmit}
                disabled={dialogMode === 'modify' ? !modifyPrompt.trim() : !generatePrompt.trim()}
                style={{
                  padding: '8px 16px',
                  fontSize: '13px',
                  backgroundColor: (dialogMode === 'modify' ? modifyPrompt.trim() : generatePrompt.trim()) ? '#3b82f6' : '#9ca3af',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: (dialogMode === 'modify' ? modifyPrompt.trim() : generatePrompt.trim()) ? 'pointer' : 'not-allowed',
                  fontWeight: '500'
                }}
              >
                {dialogMode === 'modify' ? 'Update Rule' : 'Generate'}
              </button>
            </div>
            <div style={{ marginTop: '12px', fontSize: '11px', color: '#6a6a6a', textAlign: 'center' }}>
              Press Ctrl+Enter (Cmd+Enter on Mac) to submit
            </div>
          </div>
        </>
      )}

      {/* Custom Suggestions Dropdown */}
      {showSuggestionsDropdown && suggestions.length > 0 && (
        <>
          {/* Backdrop */}
          <div 
            onClick={() => {
              setShowSuggestionsDropdown(false)
              setSuggestions([])
            }}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
              zIndex: 9999
            }}
          />
          {/* Dropdown */}
          <div 
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              zIndex: 10000,
              backgroundColor: '#1e1e1e',
              border: '1px solid #3c3c3c',
              borderRadius: '4px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              width: '600px',
              maxHeight: '500px',
              overflow: 'auto',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              fontFamily: 'monospace'
            }}
          >
          <div style={{ padding: '4px 8px', borderBottom: '1px solid #3c3c3c', fontSize: '12px', color: '#cccccc' }}>
            Select a suggestion:
          </div>
          {suggestions.map((suggestion, index) => (
            <div
              key={index}
              onClick={(e) => {
                e.stopPropagation()
                handleSuggestionSelect(suggestion, e)
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#2a2d2e'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent'
              }}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                borderBottom: index < suggestions.length - 1 ? '1px solid #2a2d2e' : 'none',
                color: '#cccccc'
              }}
            >
              <div style={{ fontWeight: 'bold', marginBottom: '6px', color: '#4fc3f7' }}>
                {typeof suggestion.label === 'string' ? suggestion.label : suggestion.label.label}
              </div>
              {suggestion.detail && (
                <div style={{ fontSize: '11px', color: '#858585', marginBottom: '8px' }}>
                  {suggestion.detail}
                </div>
              )}
              {suggestion.insertText && (
                <div style={{ 
                  fontSize: '12px', 
                  color: '#a8d8a8',
                  backgroundColor: '#1a1a1a',
                  padding: '10px',
                  borderRadius: '4px',
                  border: '1px solid #3c3c3c',
                  marginBottom: '6px',
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'monospace',
                  lineHeight: '1.5',
                  maxHeight: '300px',
                  overflow: 'auto'
                }}>
                  {suggestion.insertText}
                </div>
              )}
              {suggestion.documentation && (
                <div style={{ fontSize: '10px', color: '#6a6a6a', fontStyle: 'italic', marginTop: '4px' }}>
                  {typeof suggestion.documentation === 'string' 
                    ? suggestion.documentation 
                    : (suggestion.documentation as any)?.value || ''}
                </div>
              )}
            </div>
          ))}
          <div 
            onClick={(e) => {
              e.stopPropagation()
              setShowSuggestionsDropdown(false)
              setSuggestions([])
            }}
            style={{
              padding: '6px 12px',
              borderTop: '1px solid #3c3c3c',
              fontSize: '11px',
              color: '#858585',
              cursor: 'pointer',
              textAlign: 'center'
            }}
          >
            Close (or press Esc)
          </div>
        </div>
        </>
      )}

      <div className="editor-card" style={{ position: 'relative' }}>
        <div className="card-header">
          <h2>{title}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="muted">{filename}</span>
            {hasChanges && (
              <button
                type="button"
                onClick={() => setShowDiff(!showDiff)}
                style={{ padding: '6px 12px', fontSize: '12px' }}
                className="diff-toggle"
              >
                {showDiff ? 'Hide Diff' : 'View Diff'}
              </button>
            )}
            {enableLSP && language === 'java' && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  // Disabled - using right-click context menu instead
                  console.log('[Editor] ✨ AI button clicked (disabled - use right-click context menu)')
                }}
                disabled={true}
                style={{ 
                  padding: '8px 10px', 
                  fontSize: '18px', 
                  backgroundColor: lspReady ? '#3b82f6' : '#9ca3af', 
                  color: 'white', 
                  border: 'none', 
                  borderRadius: '4px', 
                  cursor: lspReady ? 'pointer' : 'not-allowed',
                  opacity: lspReady ? 1 : 0.6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: '36px',
                  height: '36px'
                }}
                title="AI button disabled - Use right-click context menu (Generate Rule / Modify Rule)"
              >
                ✨
              </button>
            )}
            <button
              onClick={handleSaveClick}
              disabled={loading || disabled || saving || !hasChanges}
              style={{ padding: '6px 12px', fontSize: '12px' }}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
        {loading && <p className="muted">Loading {title.toLowerCase()}…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && !error && (
          <>
            {showDiff ? (
              <DiffEditor
                height={height}
                language={language}
                theme="vs-dark"
                original={originalValue}
                modified={value}
                options={diffOptions}
                onMount={handleDiffEditorMount}
              />
            ) : (
              <Editor
                height={height}
                defaultLanguage={language}
                theme="vs-dark"
                value={value}
                onChange={(val) => onChange(val ?? '')}
                options={monacoOptions}
                onMount={handleEditorMount}
              />
            )}
            {hasChanges && !showDiff && (
              <p className="muted" style={{ marginTop: '8px', fontSize: '12px' }}>
                You have unsaved changes. Click "View Diff" to see what changed.
              </p>
            )}
          </>
        )}
      </div>

      {/* Save Confirmation Dialog with Diff */}
      {showSaveDialog && (
        <div className="modal-overlay" onClick={() => setShowSaveDialog(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Confirm Save - {filename}</h3>
              <button
                className="modal-close"
                onClick={() => setShowSaveDialog(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: '12px', color: '#cbd5e1' }}>
                Review your changes before saving:
              </p>
              <DiffEditor
                height="400px"
                language={language}
                theme="vs-dark"
                original={originalValue}
                modified={value}
                options={{ ...diffOptions, readOnly: true }}
                onMount={handleDiffEditorMount}
              />
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowSaveDialog(false)}>Cancel</button>
              <button className="primary" onClick={handleConfirmSave}>
                Confirm Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}


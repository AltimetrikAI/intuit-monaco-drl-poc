import { useMemo, useState, useEffect, useRef } from 'react'
import Editor, { DiffEditor, OnMount, DiffOnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { initializeLSP, sendDocumentContent, disconnectLSP, triggerCompletion, setOnSuggestionsReady } from '../utils/lsp-client'
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
    
    console.log('[Editor] LSP initialization check:', {
      enableLSP,
      language,
      hasEditor: !!editorRef.current,
      editorMounted,
      alreadyInitialized: lspInitialized.current,
      hasFactObject: !!factObject,
      bddTestsDefined: bddTests !== undefined
    })
    
    if (!enableLSP || language !== 'java' || !editorRef.current || lspInitialized.current) {
      if (!enableLSP) console.log('[Editor] LSP disabled')
      if (language !== 'java') console.log('[Editor] Language is not java:', language)
      if (!editorRef.current) console.log('[Editor] Editor ref not available')
      if (lspInitialized.current) console.log('[Editor] LSP already initialized')
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
      if (e.key === 'Escape' && showSuggestionsDropdown) {
        setShowSuggestionsDropdown(false)
        setSuggestions([])
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [showSuggestionsDropdown])

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

  const handleSuggestionSelect = (suggestion: monaco.languages.CompletionItem) => {
    if (editorRef.current) {
      const editor = editorRef.current
      const model = editor.getModel()
      const position = editor.getPosition()
      
      if (model && position && suggestion.insertText) {
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
    setShowSuggestionsDropdown(false)
    setSuggestions([])
  }

  return (
    <>
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
              onClick={() => handleSuggestionSelect(suggestion)}
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
            onClick={() => setShowSuggestionsDropdown(false)}
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
                onClick={() => {
                  if (editorRef.current) {
                    triggerCompletion(editorRef.current)
                  } else {
                    console.warn('[Editor] Editor ref not available')
                    triggerCompletion() // Fallback to global ref
                  }
                }}
                disabled={!lspReady}
                style={{ 
                  padding: '6px 12px', 
                  fontSize: '12px', 
                  backgroundColor: lspReady ? '#3b82f6' : '#9ca3af', 
                  color: 'white', 
                  border: 'none', 
                  borderRadius: '4px', 
                  cursor: lspReady ? 'pointer' : 'not-allowed',
                  opacity: lspReady ? 1 : 0.6
                }}
                title={lspReady ? "Generate Rule Snippet (Ctrl+Space)" : "Waiting for LSP initialization..."}
              >
                Generate Rule
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


import { useMemo, useState, useEffect, useRef } from 'react'
import Editor, { DiffEditor, OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { initializeLSP, sendDocumentContent, disconnectLSP } from '../utils/lsp-client'
import { extractFactSchema } from '../utils/factSchema'

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
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const lspInitialized = useRef(false)

  const monacoOptions = useMemo(
    () => ({
      fontSize: 14,
      minimap: { enabled: false },
      wordWrap: 'on',
      automaticLayout: true,
      scrollBeyondLastLine: false,
      readOnly: false,
      renderSideBySide: true
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

  // Initialize LSP when editor mounts and context is available
  useEffect(() => {
    if (!enableLSP || language !== 'java' || !editorRef.current || lspInitialized.current) {
      return
    }

    if (factObject && bddTests !== undefined) {
      const factSchema = extractFactSchema(factObject)
      initializeLSP(editorRef.current, {
        factObject,
        factSchema,
        bddTests: bddTests || '',
        currentDrl: value
      }).then(() => {
        lspInitialized.current = true
      }).catch((err) => {
        console.error('[Editor] LSP initialization failed:', err)
      })
    }
  }, [enableLSP, language, factObject, bddTests, value])

  // Send document updates to LSP
  useEffect(() => {
    if (enableLSP && language === 'java' && lspInitialized.current) {
      sendDocumentContent(value)
    }
  }, [value, enableLSP, language])

  // Cleanup LSP on unmount
  useEffect(() => {
    return () => {
      if (enableLSP && language === 'java') {
        disconnectLSP()
        lspInitialized.current = false
      }
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
    
    // For diff editor, get the modified editor
    if (showDiff) {
      const modifiedEditor = editor.getModifiedEditor()
      editorRef.current = modifiedEditor
    }
  }

  return (
    <>
      <div className="editor-card">
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
                onMount={(editor) => {
                  handleEditorMount(editor)
                  // Listen for changes in the modified editor
                  const modifiedEditor = editor.getModifiedEditor()
                  modifiedEditor.onDidChangeModelContent(() => {
                    onChange(modifiedEditor.getValue())
                  })
                }}
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
                onMount={handleEditorMount}
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


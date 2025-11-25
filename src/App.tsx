import { useEffect, useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import { fetchRule, runPipeline, saveRule, type PipelineResult } from './api'
import { StatusPanel } from './components/StatusPanel'

function App() {
  const [ruleText, setRuleText] = useState('')
  const [status, setStatus] = useState<PipelineResult>()
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    fetchRule()
      .then((text) => setRuleText(text))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  const monacoOptions = useMemo(
    () => ({
      fontSize: 14,
      minimap: { enabled: false },
      wordWrap: 'on',
      automaticLayout: true,
      scrollBeyondLastLine: false
    }),
    []
  )

  async function handleSave() {
    setError(undefined)
    try {
      await saveRule(ruleText)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleRun() {
    setError(undefined)
    setRunning(true)
    try {
      const result = await runPipeline(ruleText)
      setStatus(result)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="page">
      <header>
        <div>
          <p className="eyebrow">Drools | Monaco</p>
          <h1>DRL Playground</h1>
          <p className="muted">
            Load, edit, and validate Drools rules with a lightweight background pipeline.
          </p>
        </div>
        <div className="actions">
          <button onClick={handleSave} disabled={loading || running}>
            Save
          </button>
          <button className="primary" onClick={handleRun} disabled={loading || running}>
            Run compile &amp; tests
          </button>
        </div>
      </header>

      <main>
        <div className="editor-card">
          <div className="card-header">
            <h2>Rule</h2>
            <span className="muted">sample.drl</span>
          </div>
          <Editor
            height="480px"
            defaultLanguage="java"
            theme="vs-dark"
            value={ruleText}
            onChange={(value) => setRuleText(value ?? '')}
            options={monacoOptions}
          />
          {loading && <p className="muted">Loading rule…</p>}
        </div>

        <StatusPanel result={status} isRunning={running} error={error} />
      </main>
    </div>
  )
}

export default App

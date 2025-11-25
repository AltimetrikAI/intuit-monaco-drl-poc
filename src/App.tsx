import { useEffect, useState } from 'react'
import { fetchRule, runPipeline, saveRule, fetchBdd, saveBdd, fetchFact, type PipelineResult } from './api'
import { StatusPanel } from './components/StatusPanel'
import { FactObjectView } from './components/FactObjectView'
import { EditorWithDiff } from './components/EditorWithDiff'

function App() {
  const [ruleText, setRuleText] = useState('')
  const [originalRuleText, setOriginalRuleText] = useState('')
  const [bddText, setBddText] = useState('')
  const [originalBddText, setOriginalBddText] = useState('')
  const [factObject, setFactObject] = useState<Record<string, unknown>>({})
  const [status, setStatus] = useState<PipelineResult>()
  const [loading, setLoading] = useState(true)
  const [bddLoading, setBddLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string>()
  const [bddError, setBddError] = useState<string>()
  const [savingRule, setSavingRule] = useState(false)
  const [savingBdd, setSavingBdd] = useState(false)

  useEffect(() => {
    fetchRule()
      .then((text) => {
        setRuleText(text)
        setOriginalRuleText(text)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
    
    fetchBdd()
      .then((text) => {
        setBddText(text)
        setOriginalBddText(text)
      })
      .catch((err) => setBddError(err.message))
      .finally(() => setBddLoading(false))
    
    fetchFact()
      .then((fact) => {
        setFactObject(fact)
      })
      .catch((err) => {
        console.error('Failed to load fact object:', err)
      })
  }, [])

  async function handleSaveRule() {
    setError(undefined)
    setSavingRule(true)
    try {
      await saveRule(ruleText)
      setOriginalRuleText(ruleText) // Update original after successful save
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSavingRule(false)
    }
  }

  async function handleSaveBdd() {
    setBddError(undefined)
    setSavingBdd(true)
    try {
      await saveBdd(bddText)
      setOriginalBddText(bddText) // Update original after successful save
    } catch (err) {
      setBddError((err as Error).message)
    } finally {
      setSavingBdd(false)
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
          <button className="primary" onClick={handleRun} disabled={loading || running}>
            Run compile &amp; tests
          </button>
        </div>
      </header>

      <main>
        <div className="editor-section">
          <EditorWithDiff
            value={ruleText}
            originalValue={originalRuleText}
            onChange={setRuleText}
            language="java"
            height="480px"
            loading={loading}
            error={error}
            onSave={handleSaveRule}
            saving={savingRule}
            disabled={running}
            title="Rule"
            filename="sample.drl"
            factObject={factObject}
            bddTests={bddText}
            enableLSP={true}
          />

          <FactObjectView />
          
          <EditorWithDiff
            value={bddText}
            originalValue={originalBddText}
            onChange={setBddText}
            language="markdown"
            height="300px"
            loading={bddLoading}
            error={bddError}
            onSave={handleSaveBdd}
            saving={savingBdd}
            disabled={running}
            title="BDD Test Cases"
            filename="bdd-tests.md"
          />
        </div>

        <StatusPanel result={status} isRunning={running} error={error} />
      </main>
    </div>
  )
}

export default App

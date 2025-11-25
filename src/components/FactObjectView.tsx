import { useEffect, useState } from 'react'
import { fetchFact } from '../api'
import { jsonToTypeSchema } from '../utils/factSchema'

export function FactObjectView() {
  const [factSchema, setFactSchema] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  useEffect(() => {
    fetchFact()
      .then((fact) => {
        const schema = jsonToTypeSchema(fact)
        setFactSchema(schema)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="editor-card">
      <div className="card-header">
        <h2>Fact Object Schema</h2>
        <span className="muted">quote.json</span>
      </div>
      {loading && <p className="muted">Loading fact schema…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && (
        <pre className="fact-schema">
          <code>{factSchema}</code>
        </pre>
      )}
    </div>
  )
}


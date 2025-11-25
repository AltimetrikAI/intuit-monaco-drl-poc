export interface PipelineResult {
  compile: {
    status: 'passed' | 'failed'
    warnings: string[]
    errors: string[]
    durationMs: number
    javaLogs?: string[]
    firedRules?: string[]
    firedCount?: number
  }
  tests: {
    status: 'passed' | 'failed'
    summary: string
    cases: { name: string; status: 'passed' | 'failed'; details?: string }[]
    durationMs: number
    javaLogs?: string[]
  }
  timestamp: string
}

export async function fetchRule(): Promise<string> {
  const response = await fetch('/api/drl')
  if (!response.ok) {
    throw new Error('Unable to load DRL file')
  }
  return response.text()
}

export async function saveRule(content: string): Promise<void> {
  const response = await fetch('/api/drl', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: content
  })
  if (!response.ok) {
    throw new Error('Unable to save DRL file')
  }
}

export async function runPipeline(content: string): Promise<PipelineResult> {
  const response = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  })
  if (!response.ok) {
    throw new Error('Unable to run compile/test pipeline')
  }
  return response.json()
}

export async function fetchFact(): Promise<Record<string, unknown>> {
  const response = await fetch('/api/fact')
  if (!response.ok) {
    throw new Error('Unable to load fact object')
  }
  return response.json()
}

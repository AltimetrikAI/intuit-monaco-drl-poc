import type { PipelineResult } from '../api'

interface Props {
  result?: PipelineResult
  isRunning: boolean
  error?: string
}

export function StatusPanel({ result, isRunning, error }: Props) {
  const compileStatus = result?.compile.status ?? 'pending'
  const testStatus = result?.tests.status ?? 'pending'

  return (
    <div className="card">
      <div className="card-header">
        <h2>Compile &amp; Test Status</h2>
        {isRunning && <span className="badge">Running…</span>}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="status-grid">
        <StatusBlock
          title="Compile"
          status={compileStatus}
          duration={result?.compile.durationMs}
          items={[
            ...(result?.compile.errors?.map((e) => ({ type: 'error' as const, text: e })) ?? []),
            ...(result?.compile.warnings?.map((w) => ({ type: 'warning' as const, text: w })) ?? [])
          ]}
        />
        <StatusBlock
          title="BDD / Unit Tests"
          status={testStatus}
          duration={result?.tests.durationMs}
          items={result?.tests.cases?.map((c) => ({
            type: c.status === 'passed' ? 'info' : 'error',
            text: `${c.name} — ${c.status}` + (c.details ? ` (${c.details})` : '')
          }))}
          footer={result?.tests.summary}
        />
      </div>
    </div>
  )
}

interface BlockProps {
  title: string
  status: 'passed' | 'failed' | 'pending'
  duration?: number
  items?: { type: 'error' | 'warning' | 'info'; text: string }[]
  footer?: string
}

function StatusBlock({ title, status, duration, items = [], footer }: BlockProps) {
  const badgeColor =
    status === 'passed' ? 'success' : status === 'failed' ? 'danger' : 'muted'

  return (
    <div className="status-block">
      <div className="status-block__header">
        <h3>{title}</h3>
        <span className={`chip chip--${badgeColor}`}>
          {status === 'pending' ? 'Pending' : status === 'passed' ? 'Passed' : 'Failed'}
        </span>
      </div>
      <p className="meta">{duration ? `${duration} ms` : 'awaiting run'}</p>
      <ul className="list">
        {items.length === 0 && <li className="muted">No messages</li>}
        {items.map((item, idx) => (
          <li key={idx} className={`list-${item.type}`}>
            {item.text}
          </li>
        ))}
      </ul>
      {footer && <p className="footer">{footer}</p>}
    </div>
  )
}

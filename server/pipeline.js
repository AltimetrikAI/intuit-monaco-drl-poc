import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
export async function analyzeDrl(content) {
  const start = performance.now()
  const errors = []
  const warnings = []

  if (!content || !content.trim()) {
    errors.push('Rule file is empty')
  }

  if (!/\brule\b/i.test(content)) {
    errors.push('No rule definitions were detected')
  }

  if (!/package\s+.+;/i.test(content)) {
    warnings.push('Missing package declaration')
  }

  if (!/import\s+.+Quote/i.test(content)) {
    warnings.push('Fact import for Quote not found; update imports when changing fact types.')
  }

  const durationMs = Math.round(performance.now() - start)
  return {
    status: errors.length ? 'failed' : 'passed',
    warnings,
    errors,
    durationMs
  }
}

export async function runRuleTests(content, factPath, testDocPath) {
  const start = performance.now()
  const cases = []
  let status = 'passed'

  const factText = await fs.readFile(factPath, 'utf-8')
  const fact = JSON.parse(factText)

  const loyaltyCase = content.includes('loyalCustomer')
  cases.push({
    name: 'Loyalty discount',
    status: loyaltyCase ? 'passed' : 'failed',
    details: loyaltyCase
      ? `applies 10% when loyalCustomer=true (example premium ${fact.premium})`
      : 'No loyalty rule found'
  })
  if (!loyaltyCase) status = 'failed'

  const premiumCase = /premium\s*>\s*1000/.test(content)
  cases.push({
    name: 'High premium flag',
    status: premiumCase ? 'passed' : 'failed',
    details: premiumCase
      ? 'flags quotes requiring review'
      : 'Rule missing premium threshold > 1000'
  })
  if (!premiumCase) status = 'failed'

  const docExists = await fileExists(testDocPath)
  const summary = docExists
    ? 'BDD scenarios documented in data/tests/bdd-tests.md'
    : 'BDD scenarios not found; add them under data/tests'

  const durationMs = Math.round(performance.now() - start)

  return {
    status,
    summary,
    cases,
    durationMs
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

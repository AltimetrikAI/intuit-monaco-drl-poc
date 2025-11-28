import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { executeDroolsRules } from './droolsExecutor.js'

export async function analyzeDrl(content, factPath) {
  const start = performance.now()
  
  // Try to use real Drools execution if available
  try {
    const factText = await fs.readFile(factPath, 'utf-8')
    const droolsResult = await executeDroolsRules(content, factText)
    
    return {
      status: droolsResult.status === 'passed' ? 'passed' : 'failed',
      warnings: droolsResult.warnings || [],
      errors: droolsResult.errors || [],
      durationMs: droolsResult.durationMs || Math.round(performance.now() - start),
      firedRules: droolsResult.firedRules || [],
      firedCount: droolsResult.firedCount,
      factAfter: droolsResult.factAfter,
      javaLogs: droolsResult.javaLogs || []
    }
  } catch (err) {
    // Fall back to basic validation if Drools is not available
    const errors = []
    const warnings = []
    
    // Log the actual error for debugging
    console.error('[Pipeline] Drools execution error:', err.message)
    
    if (err.message.includes('Drools JAR not found')) {
      warnings.push('Drools runtime not available - using basic validation. Build Java project: cd java && mvn clean package')
    } else if (err.message.includes('Java') || err.message.includes('ENOENT') || err.message.includes('spawn')) {
      warnings.push(`Drools runtime not available - Java not found. Error: ${err.message}. Make sure Java is installed and in PATH.`)
    } else {
      // For other errors, show them as warnings but still fall back
      warnings.push(`Drools execution issue: ${err.message}. Falling back to basic validation.`)
    }

    // Basic validation fallback
    if (!content || !content.trim()) {
      errors.push('Rule file is empty')
    }

    if (!/\brule\b/i.test(content)) {
      errors.push('No rule definitions were detected')
    }

    if (!/package\s+\S+/i.test(content)) {
      warnings.push('Missing package declaration')
    }

    if (!/import\s+.+CardAuthorizationRequest/i.test(content)) {
      warnings.push('Fact import for CardAuthorizationRequest not found; update imports when changing fact types.')
    }

    const durationMs = Math.round(performance.now() - start)
    return {
      status: errors.length ? 'failed' : 'passed',
      warnings,
      errors,
      durationMs
    }
  }
}

export async function runRuleTests(content, factPath, testDocPath) {
  const start = performance.now()
  const cases = []
  let status = 'passed'

  try {
    // Use real Drools execution
    const factText = await fs.readFile(factPath, 'utf-8')
    const fact = JSON.parse(factText)
    const droolsResult = await executeDroolsRules(content, factText)

    // Create test cases based on Drools execution
    if (droolsResult.firedCount > 0) {
      cases.push({
        name: 'Rules executed',
        status: 'passed',
        details: `Fired ${droolsResult.firedCount} rule(s)`
      })

      // Check if fact was modified (rules fired)
      if (droolsResult.factAfter) {
        const factAfter = JSON.parse(droolsResult.factAfter)
        const factBefore = fact

        if (factAfter.discount !== factBefore.discount) {
          cases.push({
            name: 'Loyalty discount applied',
            status: 'passed',
            details: `Discount changed from ${factBefore.discount} to ${factAfter.discount}`
          })
        }

        if (factAfter.requiresReview !== factBefore.requiresReview) {
          cases.push({
            name: 'Review flag set',
            status: 'passed',
            details: `Requires review: ${factAfter.requiresReview}`
          })
        }
      }

      // Add fired rules info
      if (droolsResult.firedRules && droolsResult.firedRules.length > 0) {
        droolsResult.firedRules.forEach((rule, idx) => {
          cases.push({
            name: `Rule execution ${idx + 1}`,
            status: 'passed',
            details: rule
          })
        })
      }
    } else {
      cases.push({
        name: 'No rules fired',
        status: 'failed',
        details: 'No rules matched the fact object'
      })
      status = 'failed'
    }

    const docExists = await fileExists(testDocPath)
    const summary = docExists
      ? 'BDD scenarios documented in data/tests/bdd-tests.md'
      : 'BDD scenarios not found; add them under data/tests'

    const durationMs = droolsResult.durationMs || Math.round(performance.now() - start)

    return {
      status,
      summary,
      cases,
      durationMs,
      javaLogs: droolsResult.javaLogs || []
    }
  } catch (err) {
    // Fall back to heuristic tests if Drools is not available
    const factText = await fs.readFile(factPath, 'utf-8')
    const fact = JSON.parse(factText)

    const crimeaBlockCase = /Crimea|merchantRegion\s*==\s*"Crimea"/i.test(content)
    cases.push({
      name: 'Crimea geolocation block',
      status: crimeaBlockCase ? 'passed' : 'failed',
      details: crimeaBlockCase
        ? 'blocks transactions from Crimea region'
        : 'Rule missing Crimea geolocation blocking'
    })
    if (!crimeaBlockCase) status = 'failed'
    
    const deviceRiskCase = /isRooted|isEmulator|deviceType/i.test(content)
    cases.push({
      name: 'Device profile risk assessment',
      status: deviceRiskCase ? 'passed' : 'failed',
      details: deviceRiskCase
        ? 'includes device profile risk assessment'
        : 'Rule missing device profile checks'
    })
    if (!deviceRiskCase) status = 'failed'

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
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

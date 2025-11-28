import { WebSocketServer, WebSocket } from 'ws'
import { generateRuleWithLLM } from './llm-rule-creation-handler.js'
import { modifyRuleWithLLM } from './llm-rule-updation-handler.js'

// Session storage: map WebSocket to context
const sessions = new Map()

// WebSocket server
let wss = null

/**
 * Rule Template Configuration
 * This structure makes it easy to modify, reuse, and extend rule suggestions
 */
const ruleTemplates = [
  {
    // Rule metadata (header, description, documentation)
    label: 'Flag high premium greater than 500',
    detail: 'DRL Rule Template',
    documentation: 'A rule that flags quotes with premium greater than 500 for review',
    
    // Rule content
    ruleContent: `rule "Flag high premium greater than 500"
when
    $quote : Quote(premium > 500)
then
    $quote.setRequiresReview(true);
    System.out.println("Quote requires case review");
end`,
    
    // Completion item settings
    kind: 14, // Snippet
    insertTextRules: 4, // Snippet mode
  }
]

/**
 * Build completion items from rule templates
 * This function can be extended to support dynamic rule generation
 */
function buildCompletionsFromTemplates(templates = ruleTemplates) {
  return templates.map(template => ({
    label: template.label,
    kind: template.kind || 14, // Default to Snippet
    detail: template.detail || 'DRL Rule Template',
    insertText: template.ruleContent,
    insertTextRules: template.insertTextRules || 4,
    documentation: {
      value: template.documentation || ''
    }
  }))
}

/**
 * Helper functions for template management
 * These make it easy to modify, add, or select templates in the future
 */

/**
 * Get a template by label
 */
function getTemplateByLabel(label) {
  return ruleTemplates.find(t => t.label === label)
}

/**
 * Add or update a template
 */
function upsertTemplate(template) {
  const index = ruleTemplates.findIndex(t => t.label === template.label)
  if (index >= 0) {
    ruleTemplates[index] = { ...ruleTemplates[index], ...template }
  } else {
    ruleTemplates.push(template)
  }
}

/**
 * Get templates filtered by criteria (for future use)
 */
function getTemplatesByFilter(filterFn) {
  return ruleTemplates.filter(filterFn)
}

/**
 * Indent a block of text with specified number of spaces
 */
function indentBlock(text, spaces = 4) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map(line => (line.trim().length ? pad + line.trim() : ''))
    .join('\n')
}

/**
 * Build a mock modified rule from existing rule and user prompt
 * Parses the rule structure and generates a properly formatted modified version
 */
function buildMockModifiedRule(existingRule, userPrompt) {
  const safePrompt = (userPrompt && userPrompt.trim()) || 'user modification request'
  const baseRule = existingRule && existingRule.trim().length > 0
    ? existingRule
    : `rule "Sample Rule"
when
    $quote : Quote(premium > 500)
then
    $quote.setRequiresReview(true);
end`
  
  // Extract rule name
  const nameMatch = baseRule.match(/rule\s+"([^"]+)"/i)
  const baseName = nameMatch ? nameMatch[1] : 'Rule'
  const newRuleName = `${baseName} (Modified)`
  
  // Extract when and then clauses
  const conditionMatch = baseRule.match(/when([\s\S]*?)then/i)
  const actionMatch = baseRule.match(/then([\s\S]*?)end/i)
  
  const rawCondition = (conditionMatch && conditionMatch[1].trim()) || '$quote : Quote(premium > 750)'
  const rawAction = (actionMatch && actionMatch[1].trim()) || '$quote.setRequiresReview(true);\n$quote.setEscalated(true);'
  
  // Format with indentation
  const condition = indentBlock(rawCondition, 4)
  const action = indentBlock(rawAction, 4)
  
  const modifiedRule = `rule "${newRuleName}"

when
${condition}

then
${action}

end`
  
  return {
    ruleName: newRuleName,
    ruleText: modifiedRule
  }
}

/**
 * Initialize a session with fact object, BDD tests, and schema
 */
function initializeSession(ws, params) {
  const { factObject, factSchema, bddTests, currentDrl } = params
  const session = sessions.get(ws)
  
  if (session) {
    session.factObject = factObject || {}
    session.factSchema = factSchema || {}
    session.bddTests = bddTests || ''
    session.documentContent = currentDrl || ''
    session.initialized = true
    
    console.log(`[LSP] ========================================`)
    console.log(`[LSP] Session ${session.sessionId} initialized`)
    console.log(`[LSP] ----------------------------------------`)
    console.log(`[LSP] Fact Object Fields:`)
    Object.keys(factObject || {}).forEach(key => {
      const type = factSchema?.[key] || typeof factObject[key]
      const value = factObject[key]
      console.log(`[LSP]   - ${key}: ${type} = ${JSON.stringify(value)}`)
    })
    console.log(`[LSP] BDD Tests (${(bddTests || '').split('\n').length} lines):`)
    const bddPreview = (bddTests || '').substring(0, 200)
    console.log(`[LSP]   ${bddPreview}${bddTests && bddTests.length > 200 ? '...' : ''}`)
    console.log(`[LSP] DRL Content (${(currentDrl || '').length} chars)`)
    console.log(`[LSP] ========================================`)
  }
}

/**
 * Get fact object fields for completions
 */
function getFactFields(session) {
  if (!session?.factObject) return []
  return Object.keys(session.factObject).map(key => ({
    name: key,
    type: session.factSchema[key] || typeof session.factObject[key],
    value: session.factObject[key]
  }))
}

/**
 * Generate method suggestions based on fact object
 */
function getFactMethods(fieldName, fieldType) {
  const methods = []
  
  // Getter methods
  if (fieldType === 'boolean') {
    methods.push({
      label: `is${capitalize(fieldName)}()`,
      kind: 2, // Method
      detail: `boolean`,
      insertText: `is${capitalize(fieldName)}()`
    })
  } else {
    methods.push({
      label: `get${capitalize(fieldName)}()`,
      kind: 2,
      detail: fieldType,
      insertText: `get${capitalize(fieldName)}()`
    })
  }
  
  // Setter methods
  const setterParam = fieldType === 'boolean' ? 'true' : fieldType === 'number' ? '0' : '""'
  methods.push({
    label: `set${capitalize(fieldName)}(${setterParam})`,
    kind: 2,
    detail: `void`,
    insertText: `set${capitalize(fieldName)}($1)`,
    insertTextRules: 4 // Snippet
  })
  
  return methods
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Parse DRL context to understand what user is typing
 */
function parseContext(documentContent, position) {
  const lines = documentContent.split('\n')
  const line = lines[position.line] || ''
  const beforeCursor = line.substring(0, position.character)
  const afterCursor = line.substring(position.character)
  const fullLine = line
  
  // Detect context patterns
  const context = {
    afterQuoteConstructor: /Quote\s*\(/.test(beforeCursor),
    afterVariableDot: /\$\w+\./.test(beforeCursor),
    inWhenClause: isInClause(documentContent, position.line, 'when'),
    inThenClause: isInClause(documentContent, position.line, 'then'),
    currentWord: extractCurrentWord(beforeCursor),
    lineContent: fullLine
  }
  
  return context
}

function isInClause(content, lineNum, clause) {
  const lines = content.split('\n')
  let foundClause = false
  
  for (let i = 0; i <= lineNum; i++) {
    if (lines[i]?.includes(`rule`) && i < lineNum) {
      foundClause = false
    }
    if (lines[i]?.includes(clause)) {
      foundClause = true
    }
    if (lines[i]?.includes('end') && foundClause) {
      return false
    }
  }
  
  return foundClause
}

function extractCurrentWord(text) {
  const match = text.match(/(\w+)$/)
  return match ? match[1] : ''
}

/**
 * Handler for CREATE mode (generate new rule)
 * Uses LLM to generate DRL rules
 */
async function handleCreateRequest(session, userPrompt, position, documentContent) {
  try {
    const result = await generateRuleWithLLM(
      userPrompt || 'Generate a DRL rule',
      documentContent,
      session.factObject || {},
      session.factSchema || {}
    )
    
    return [{
      label: 'Generated DRL Rule',
      kind: 14, // Snippet
      detail: result.reasoning,
      insertText: result.drl,
      insertTextRules: 4, // Snippet mode
      documentation: {
        value: `**Reasoning:**\n${result.reasoning}\n\n**Generated DRL:**\n\`\`\`drl\n${result.drl}\n\`\`\``
      }
    }]
  } catch (error) {
    console.error(`[LSP] ❌ Rule creation failed:`, error.message)
    return buildCompletionsFromTemplates()
  }
}

/**
 * Handler for MODIFY mode (update existing rule)
 * Uses LLM to modify existing rules
 */
async function handleModifyRequest(session, userPrompt, existingRule, position, documentContent) {
  console.log(`[LSP] ========================================`)
  console.log(`[LSP] 📝 MODIFY HANDLER - INPUTS & CONTEXT`)
  console.log(`[LSP] ========================================`)
  
  // Log direct inputs (parameters)
  console.log(`[LSP] 📥 DIRECT INPUTS (Parameters):`)
  console.log(`[LSP]   - userPrompt: "${userPrompt || 'N/A'}"`)
  console.log(`[LSP]   - existingRule length: ${existingRule ? existingRule.length : 0} chars`)
  if (existingRule) {
    console.log(`[LSP]   - existingRule full text:`)
    console.log(`[LSP]     ${existingRule.split('\n').map((line, idx) => `${idx + 1}: ${line}`).join('\n     ')}`)
  } else {
    console.log(`[LSP]   - existingRule: N/A (not provided)`)
  }
  console.log(`[LSP]   - position: Line ${position.line + 1}, Column ${position.character + 1} (0-based: ${position.line}, ${position.character})`)
  console.log(`[LSP]   - documentContent length: ${documentContent.length} chars`)
  console.log(`[LSP]   - documentContent preview: "${documentContent.substring(0, 200)}${documentContent.length > 200 ? '...' : ''}"`)
  
  // Log session context (available via session object)
  console.log(`[LSP] 📋 SESSION CONTEXT (Available via session):`)
  console.log(`[LSP]   - session.initialized: ${session.initialized}`)
  
  // Fact Object - concise summary
  if (session.factObject && Object.keys(session.factObject).length > 0) {
    console.log(`[LSP]   - session.factObject: ${Object.keys(session.factObject).length} field(s)`)
    Object.keys(session.factObject).forEach(key => {
      const type = session.factSchema?.[key] || typeof session.factObject[key]
      const value = session.factObject[key]
      const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value)
      const preview = valueStr.length > 50 ? valueStr.substring(0, 50) + '...' : valueStr
      console.log(`[LSP]     • ${key} (${type}): ${preview}`)
    })
  } else {
    console.log(`[LSP]   - session.factObject: N/A or empty`)
  }
  
  // Fact Schema - concise summary
  if (session.factSchema && Object.keys(session.factSchema).length > 0) {
    console.log(`[LSP]   - session.factSchema: ${Object.keys(session.factSchema).length} field(s)`)
    Object.keys(session.factSchema).forEach(key => {
      console.log(`[LSP]     • ${key}: ${session.factSchema[key]}`)
    })
  } else {
    console.log(`[LSP]   - session.factSchema: N/A or empty`)
  }
  
  // BDD Tests - concise summary
  if (session.bddTests && session.bddTests.trim().length > 0) {
    const bddLines = session.bddTests.split('\n')
    console.log(`[LSP]   - session.bddTests: ${bddLines.length} line(s), ${session.bddTests.length} chars`)
    console.log(`[LSP]     Preview (first 3 lines):`)
    bddLines.slice(0, 3).forEach((line, idx) => {
      if (line.trim()) {
        console.log(`[LSP]       ${idx + 1}: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`)
      }
    })
    if (bddLines.length > 3) {
      console.log(`[LSP]       ... (${bddLines.length - 3} more lines)`)
    }
  } else {
    console.log(`[LSP]   - session.bddTests: N/A or empty`)
  }
  
  // Document Content - concise summary
  console.log(`[LSP]   - session.documentContent: ${(session.documentContent || '').length} chars`)
  if (session.documentContent && session.documentContent.length > 0) {
    const drlLines = session.documentContent.split('\n')
    console.log(`[LSP]     Preview (first 5 lines):`)
    drlLines.slice(0, 5).forEach((line, idx) => {
      console.log(`[LSP]       ${idx + 1}: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`)
    })
    if (drlLines.length > 5) {
      console.log(`[LSP]       ... (${drlLines.length - 5} more lines)`)
    }
  }
  
  // Log derived context
  console.log(`[LSP] 🔍 DERIVED CONTEXT (Can be extracted):`)
  const factFields = getFactFields(session)
  console.log(`[LSP]   - Fact fields count: ${factFields.length}`)
  factFields.forEach((field, idx) => {
    console.log(`[LSP]     Field ${idx + 1}: ${field.name} (${field.type})`)
  })
  
  const lines = documentContent.split('\n')
  const currentLine = lines[position.line] || ''
  const beforeCursor = currentLine.substring(0, position.character)
  const afterCursor = currentLine.substring(position.character)
  console.log(`[LSP]   - Current line: "${currentLine}"`)
  console.log(`[LSP]   - Before cursor: "${beforeCursor}"`)
  console.log(`[LSP]   - After cursor: "${afterCursor}"`)
  
  // Extract rule context from existingRule
  if (existingRule) {
    const ruleNameMatch = existingRule.match(/rule\s+"([^"]+)"/i)
    const ruleName = ruleNameMatch ? ruleNameMatch[1] : 'Unknown'
    console.log(`[LSP]   - Rule being modified: "${ruleName}"`)
    console.log(`[LSP]   - Rule structure: ${existingRule.includes('when') ? 'Has when clause' : 'No when clause'}, ${existingRule.includes('then') ? 'Has then clause' : 'No then clause'}`)
  }
  
  console.log(`[LSP] ========================================`)
  
  // Call LLM to modify the rule
  try {
    const { drl: modifiedRule, reasoning } = await modifyRuleWithLLM(
      userPrompt,
      existingRule,
      documentContent,
      session.factObject || {},
      session.factSchema || {}
    )
    
    const completions = [{
      label: 'Modified Rule',
      kind: 14, // Snippet
      detail: 'Modified DRL Rule',
      insertText: modifiedRule,
      insertTextRules: 4, // Snippet mode
      documentation: {
        value: `Modified rule based on: ${userPrompt || 'user request'}\n\nReasoning: ${reasoning}`
      }
    }]
    
    return completions
  } catch (error) {
    console.error(`[LSP] ❌ Error in LLM rule modification:`, error)
    // Fallback to mock response on error
    const { ruleText: mockModifiedRule } = buildMockModifiedRule(existingRule, userPrompt)
    return [{
      label: 'Modified Rule (Fallback)',
      kind: 14,
      detail: 'Modified DRL Rule (Mock)',
      insertText: mockModifiedRule,
      insertTextRules: 4,
      documentation: {
        value: `Modified rule based on: ${userPrompt || 'user request'} (Fallback due to LLM error)`
      }
    }]
  }
}

/**
 * Handler for COMPLETION mode (inline auto-completion)
 * Always returns completions regardless of what user types - ready for LLM integration
 */
function handleCompletionRequest(session, position, documentContent) {
  console.log(`[LSP] ========================================`)
  console.log(`[LSP] 💡 COMPLETION HANDLER - INPUTS & CONTEXT`)
  console.log(`[LSP] ========================================`)
  
  // Log direct inputs (parameters)
  console.log(`[LSP] 📥 DIRECT INPUTS (Parameters):`)
  console.log(`[LSP]   - position: Line ${position.line + 1}, Column ${position.character + 1} (0-based: ${position.line}, ${position.character})`)
  console.log(`[LSP]   - documentContent length: ${documentContent.length} chars`)
  console.log(`[LSP]   - documentContent preview: "${documentContent.substring(0, 200)}${documentContent.length > 200 ? '...' : ''}"`)
  
  // Log session context (available via session object)
  console.log(`[LSP] 📋 SESSION CONTEXT (Available via session):`)
  console.log(`[LSP]   - session.initialized: ${session.initialized}`)
  
  // Fact Object - concise summary
  if (session.factObject && Object.keys(session.factObject).length > 0) {
    console.log(`[LSP]   - session.factObject: ${Object.keys(session.factObject).length} field(s)`)
    Object.keys(session.factObject).forEach(key => {
      const type = session.factSchema?.[key] || typeof session.factObject[key]
      const value = session.factObject[key]
      const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value)
      const preview = valueStr.length > 50 ? valueStr.substring(0, 50) + '...' : valueStr
      console.log(`[LSP]     • ${key} (${type}): ${preview}`)
    })
  } else {
    console.log(`[LSP]   - session.factObject: N/A or empty`)
  }
  
  // Fact Schema - concise summary
  if (session.factSchema && Object.keys(session.factSchema).length > 0) {
    console.log(`[LSP]   - session.factSchema: ${Object.keys(session.factSchema).length} field(s)`)
    Object.keys(session.factSchema).forEach(key => {
      console.log(`[LSP]     • ${key}: ${session.factSchema[key]}`)
    })
  } else {
    console.log(`[LSP]   - session.factSchema: N/A or empty`)
  }
  
  // BDD Tests - concise summary
  if (session.bddTests && session.bddTests.trim().length > 0) {
    const bddLines = session.bddTests.split('\n')
    console.log(`[LSP]   - session.bddTests: ${bddLines.length} line(s), ${session.bddTests.length} chars`)
    console.log(`[LSP]     Preview (first 3 lines):`)
    bddLines.slice(0, 3).forEach((line, idx) => {
      if (line.trim()) {
        console.log(`[LSP]       ${idx + 1}: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`)
      }
    })
    if (bddLines.length > 3) {
      console.log(`[LSP]       ... (${bddLines.length - 3} more lines)`)
    }
  } else {
    console.log(`[LSP]   - session.bddTests: N/A or empty`)
  }
  
  // Document Content - concise summary
  console.log(`[LSP]   - session.documentContent: ${(session.documentContent || '').length} chars`)
  if (session.documentContent && session.documentContent.length > 0) {
    const drlLines = session.documentContent.split('\n')
    console.log(`[LSP]     Preview (first 5 lines):`)
    drlLines.slice(0, 5).forEach((line, idx) => {
      console.log(`[LSP]       ${idx + 1}: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`)
    })
    if (drlLines.length > 5) {
      console.log(`[LSP]       ... (${drlLines.length - 5} more lines)`)
    }
  }
  
  // Log derived context
  console.log(`[LSP] 🔍 DERIVED CONTEXT (Can be extracted):`)
  const lines = documentContent.split('\n')
  const currentLine = lines[position.line] || ''
  const beforeCursor = currentLine.substring(0, position.character)
  const afterCursor = currentLine.substring(position.character)
  console.log(`[LSP]   - Current line: "${currentLine}"`)
  console.log(`[LSP]   - Before cursor: "${beforeCursor}"`)
  console.log(`[LSP]   - After cursor: "${afterCursor}"`)
  console.log(`[LSP]   - Total lines in document: ${lines.length}`)
  console.log(`[LSP]   - Current line number: ${position.line + 1}`)
  
  // Extract context around cursor (surrounding lines) - limit to avoid long logs
  const contextLines = 2 // Reduced from 3 to 2
  const startLine = Math.max(0, position.line - contextLines)
  const endLine = Math.min(lines.length - 1, position.line + contextLines)
  const contextAroundCursor = lines.slice(startLine, endLine + 1)
  console.log(`[LSP]   - Context around cursor (±${contextLines} lines, ${contextAroundCursor.length} lines):`)
  contextAroundCursor.forEach((line, idx) => {
    const lineNum = startLine + idx + 1
    const isCurrentLine = (startLine + idx) === position.line
    const marker = isCurrentLine ? '>>>' : '   '
    console.log(`[LSP]     ${marker} ${lineNum}: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`)
  })
  
  const factFields = getFactFields(session)
  console.log(`[LSP]   - Fact fields count: ${factFields.length}`)
  if (factFields.length > 0) {
    factFields.slice(0, 5).forEach((field, idx) => {
      console.log(`[LSP]     Field ${idx + 1}: ${field.name} (${field.type})`)
    })
    if (factFields.length > 5) {
      console.log(`[LSP]     ... (${factFields.length - 5} more fields)`)
    }
  }
  
  // Detect what user is typing
  const currentWord = beforeCursor.trim().split(/\s+/).pop() || ''
  console.log(`[LSP]   - Current word being typed: "${currentWord}"`)
  
  console.log(`[LSP] 💡 READY FOR LLM INTEGRATION:`)
  console.log(`[LSP]   - All context available: documentContent, position, factObject, factSchema, bddTests, beforeCursor, afterCursor, contextAroundCursor`)
  console.log(`[LSP]   - TODO: Replace mock completions with LLM call`)
  console.log(`[LSP] ========================================`)
  
  // TODO: Replace with LLM call
  // const completions = await callLLMForInlineCompletion(beforeCursor, afterCursor, documentContent, session)
  
  // Mock response - always provide suggestions
  const completions = []
  
  // Always provide rule template suggestion
  completions.push({
    label: 'rule "Rule Name"',
    kind: 14, // Snippet
    detail: 'DRL rule template',
    insertText: 'rule "$1"\nwhen\n    $2\nthen\n    $3\nend',
    insertTextRules: 4
  })
  
  // Always provide common DRL keywords
  completions.push(
    { label: 'when', kind: 14, detail: 'DRL keyword', insertText: 'when' },
    { label: 'then', kind: 14, detail: 'DRL keyword', insertText: 'then' },
    { label: 'end', kind: 14, detail: 'DRL keyword', insertText: 'end' },
    { label: 'package', kind: 14, detail: 'DRL keyword', insertText: 'package ' },
    { label: 'import', kind: 14, detail: 'DRL keyword', insertText: 'import ' }
  )
  
  // Always provide Quote fact suggestions
  completions.push({
    label: 'Quote',
    kind: 7, // Class
    detail: 'Quote fact object',
    insertText: 'Quote'
  })
  completions.push({
    label: '$quote',
    kind: 6, // Variable
    detail: 'Quote variable',
    insertText: '$quote'
  })
  
  // Always provide field suggestions
  factFields.forEach(field => {
    if (field.type === 'number') {
      completions.push({
        label: `${field.name} > 0`,
        kind: 5, // Field
        detail: `${field.type} field`,
        insertText: `${field.name} > 0`
      })
    } else if (field.type === 'boolean') {
      completions.push({
        label: `${field.name} == true`,
        kind: 5,
        detail: `${field.type} field`,
        insertText: `${field.name} == true`
      })
    }
  })
  
  // Always provide method suggestions
  factFields.forEach(field => {
    const methods = getFactMethods(field.name, field.type)
    methods.forEach(method => {
      completions.push(method)
    })
  })
  
  return completions
}

/**
 * Start LSP server with WebSocket
 */
export function startLSPServer(port = 4001) {
  wss = new WebSocketServer({ port })
  
  wss.on('connection', (ws) => {
    const sessionId = `${Date.now()}-${Math.random()}`
    console.log(`[LSP] 🔌 New WebSocket connection: ${sessionId}`)
    
    // Initialize session
    sessions.set(ws, {
      sessionId,
      initialized: false,
      factObject: {},
      factSchema: {},
      bddTests: '',
      documentContent: ''
    })
    
    // Handle messages
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString())
        const session = sessions.get(ws)
        
        if (!session) {
          console.error('[LSP] No session found for connection')
          return
        }
        
        // Custom initialization with fact object and BDD
        if (message.method === 'initialize/context') {
          console.log(`[LSP] 📥 Received: initialize/context`)
          console.log(`[LSP]   - Fact object keys: ${Object.keys(message.params?.factObject || {}).join(', ')}`)
          console.log(`[LSP]   - BDD tests length: ${(message.params?.bddTests || '').length} chars`)
          console.log(`[LSP]   - DRL content length: ${(message.params?.currentDrl || '').length} chars`)
          
          initializeSession(ws, message.params)
          
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { initialized: true }
          }))
          console.log(`[LSP] 📤 Sent: initialization confirmation`)
          return
        }
        
        // Update document content
        if (message.method === 'textDocument/didChange') {
          if (message.params?.contentChanges?.[0]?.text) {
            const newContent = message.params.contentChanges[0].text
            const oldLength = session.documentContent.length
            session.documentContent = newContent
            // Only log if there's a significant change (more than 10 chars difference) to reduce noise
            const changeSize = Math.abs(newContent.length - oldLength)
            if (changeSize > 10) {
              console.log(`[LSP] 📝 Document updated: ${oldLength} → ${newContent.length} chars (${changeSize > 0 ? '+' : ''}${changeSize})`)
            }
          }
          return
        }
        
        // Handle completion requests (Ctrl+Space / Button / Right-click / Inline)
        if (message.method === 'textDocument/completion') {
          const position = message.params.position
          const line = position.line + 1 // Convert to 1-based for display
          const char = position.character + 1
          
          // Check request mode first to differentiate between create, modify, and inline
          const requestMode = message.params?.mode || 'generate' // Default to 'generate' if not specified
          const isModifyMode = requestMode === 'modify'
          const isGenerateMode = requestMode === 'generate'
          const isInlineMode = requestMode === 'inline'
          
          // Clear visual differentiation in logs
          if (isModifyMode) {
            console.log(`[LSP] ========================================`)
            console.log(`[LSP] 🔄 MODIFY RULE REQUEST (UPDATE EXISTING)`)
            console.log(`[LSP] ========================================`)
          } else if (isInlineMode) {
            console.log(`[LSP] ========================================`)
            console.log(`[LSP] 💡 INLINE AUTO-COMPLETION REQUEST`)
            console.log(`[LSP] ========================================`)
          } else {
            console.log(`[LSP] ========================================`)
            console.log(`[LSP] ✨ CREATE RULE REQUEST (GENERATE NEW)`)
            console.log(`[LSP] ========================================`)
          }
          console.log(`[LSP] Request ID: ${message.id}`)
          console.log(`[LSP] Request Mode: ${requestMode.toUpperCase()}`)
          console.log(`[LSP] Position: Line ${line}, Column ${char} (0-based: ${position.line}, ${position.character})`)
          
          const userPrompt = message.params?.userPrompt
          const existingRule = message.params?.existingRule
          
          // Get context around cursor (if session has document content)
          const documentContent = session.documentContent || ''
          const lines = documentContent.split('\n')
          const currentLine = lines[position.line] || ''
          const beforeCursor = currentLine.substring(0, position.character)
          const afterCursor = currentLine.substring(position.character)
          
          if (isGenerateMode || isInlineMode) {
            console.log(`[LSP] Context around cursor:`)
            console.log(`[LSP]   Before: "${beforeCursor}"`)
            console.log(`[LSP]   After:  "${afterCursor}"`)
            console.log(`[LSP]   Full line: "${currentLine}"`)
          }
          
          // Route to appropriate handler based on mode
          let completions = []
          
          if (isInlineMode) {
            // COMPLETION mode - always provide suggestions
            console.log(`[LSP] ========================================`)
            console.log(`[LSP] 📥 RECEIVED INLINE COMPLETION REQUEST`)
            console.log(`[LSP] ----------------------------------------`)
            console.log(`[LSP]   - Request ID: ${message.id}`)
            console.log(`[LSP]   - Request Mode: ${requestMode}`)
            console.log(`[LSP]   - Position: Line ${line}, Column ${char}`)
            console.log(`[LSP]   - Document length: ${documentContent.length} chars`)
            console.log(`[LSP]   - Session initialized: ${session.initialized}`)
            console.log(`[LSP] ----------------------------------------`)
            
            completions = handleCompletionRequest(session, position, documentContent)
            
          } else if (isModifyMode) {
            // MODIFY mode
            console.log(`[LSP] ========================================`)
            console.log(`[LSP] 📥 RECEIVED MODIFY REQUEST`)
            console.log(`[LSP] ----------------------------------------`)
            console.log(`[LSP]   - Request ID: ${message.id}`)
            console.log(`[LSP]   - Position: Line ${line}, Column ${char}`)
            
            completions = await handleModifyRequest(session, userPrompt, existingRule, position, documentContent)
            
          } else {
            // GENERATE mode (default)
            console.log(`[LSP] ========================================`)
            console.log(`[LSP] 📥 RECEIVED CREATE REQUEST`)
            console.log(`[LSP] ----------------------------------------`)
            console.log(`[LSP]   - Request ID: ${message.id}`)
            console.log(`[LSP]   - Position: Line ${line}, Column ${char}`)
            
            completions = await handleCreateRequest(session, userPrompt, position, documentContent)
          }
          
          // Send response (common for all modes)
          console.log(`[LSP] ----------------------------------------`)
          console.log(`[LSP] 📤 SENDING RESPONSE TO CLIENT`)
          console.log(`[LSP] ----------------------------------------`)
          console.log(`[LSP]   - Total completions: ${completions.length}`)
          completions.forEach((item, index) => {
            console.log(`[LSP]     Item ${index + 1}:`)
            console.log(`[LSP]       - Label: "${item.label}"`)
            console.log(`[LSP]       - Kind: ${item.kind || 'N/A'}`)
            console.log(`[LSP]       - Detail: "${item.detail || 'N/A'}"`)
            console.log(`[LSP]       - Insert Text Length: ${(item.insertText || '').length} chars`)
            const preview = (item.insertText || '').substring(0, 150)
            console.log(`[LSP]       - Insert Text Preview: "${preview}${(item.insertText || '').length > 150 ? '...' : ''}"`)
            if (item.insertTextRules) {
              console.log(`[LSP]       - Insert Text Rules: ${item.insertTextRules}`)
            }
          })
          
          const response = {
            jsonrpc: '2.0',
            id: message.id,
            result: { items: completions }
          }
          
          const responseJson = JSON.stringify(response)
          console.log(`[LSP]   - Response JSON length: ${responseJson.length} bytes`)
          console.log(`[LSP]   - Response preview:`, responseJson.substring(0, 300) + (responseJson.length > 300 ? '...' : ''))
          
          ws.send(responseJson)
          console.log(`[LSP] ✅ RESPONSE SENT TO CLIENT`)
          console.log(`[LSP]   - Response ID: ${message.id}`)
          console.log(`[LSP]   - Items in response: ${completions.length}`)
          console.log(`[LSP] ========================================`)
          return
        }
        
        // Log unknown message types
        console.log(`[LSP] ⚠️  Unknown message type: ${message.method}`)
        
      } catch (e) {
        console.error('[LSP] ❌ Message handling error:', e)
        console.error('[LSP]   Message was:', JSON.stringify(message, null, 2))
      }
    })
    
    ws.on('close', () => {
      const session = sessions.get(ws)
      if (session) {
        console.log(`[LSP] 🔌 WebSocket connection closed: ${session.sessionId}`)
      }
      sessions.delete(ws)
    })
    
    ws.on('error', (error) => {
      const session = sessions.get(ws)
      if (session) {
        console.error(`[LSP] WebSocket error for session ${session.sessionId}:`, error)
      } else {
        console.error('[LSP] WebSocket error:', error)
      }
    })
  })
  
  console.log(`[LSP] Language Server started on WebSocket port ${port}`)
  return wss
}


import { WebSocketServer, WebSocket } from 'ws'

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
 * Generate completions based on context
 */
function getCompletions(session, documentContent, position) {
  const context = parseContext(documentContent, position)
  const completions = []
  const factFields = getFactFields(session)
  
  // Log detected context
  const contextFlags = []
  if (context.afterQuoteConstructor) contextFlags.push('afterQuoteConstructor')
  if (context.afterVariableDot) contextFlags.push('afterVariableDot')
  if (context.inWhenClause) contextFlags.push('inWhenClause')
  if (context.inThenClause) contextFlags.push('inThenClause')
  if (context.currentWord) contextFlags.push(`currentWord="${context.currentWord}"`)
  
  if (contextFlags.length > 0) {
    console.log(`[LSP]   - Detected context: ${contextFlags.join(', ')}`)
  }
  
  // After Quote( - suggest fields
  if (context.afterQuoteConstructor) {
    factFields.forEach(field => {
      const prefix = context.currentWord.toLowerCase()
      if (field.name.toLowerCase().startsWith(prefix)) {
        // Type-aware suggestions
        if (field.type === 'boolean') {
          completions.push({
            label: `${field.name} == true`,
            kind: 5, // Field
            detail: `boolean field`,
            insertText: `${field.name} == true`
          })
          completions.push({
            label: `${field.name} == false`,
            kind: 5,
            detail: `boolean field`,
            insertText: `${field.name} == false`
          })
        } else if (field.type === 'number') {
          completions.push({
            label: `${field.name} > 0`,
            kind: 5,
            detail: `number field`,
            insertText: `${field.name} > 0`
          })
          completions.push({
            label: `${field.name} == 0`,
            kind: 5,
            detail: `number field`,
            insertText: `${field.name} == 0`
          })
        }
      }
    })
  }
  
  // After $quote. - suggest methods
  if (context.afterVariableDot) {
    factFields.forEach(field => {
      const prefix = context.currentWord.toLowerCase()
      const methods = getFactMethods(field.name, field.type)
      methods.forEach(method => {
        if (method.label.toLowerCase().includes(prefix)) {
          completions.push(method)
        }
      })
    })
  }
  
  // DRL keywords
  const drlKeywords = [
    { label: 'rule', kind: 14, detail: 'DRL keyword', insertText: 'rule "$1"\nwhen\n    $2\nthen\n    $3\nend' },
    { label: 'when', kind: 14, detail: 'DRL keyword', insertText: 'when' },
    { label: 'then', kind: 14, detail: 'DRL keyword', insertText: 'then' },
    { label: 'end', kind: 14, detail: 'DRL keyword', insertText: 'end' },
    { label: 'package', kind: 14, detail: 'DRL keyword', insertText: 'package ' },
    { label: 'import', kind: 14, detail: 'DRL keyword', insertText: 'import ' }
  ]
  
  drlKeywords.forEach(keyword => {
    if (keyword.label.startsWith(context.currentWord)) {
      completions.push(keyword)
    }
  })
  
  // BDD-informed suggestions (parse BDD for patterns)
  if (session.bddTests) {
    const bddLines = session.bddTests.split('\n')
    bddLines.forEach(line => {
      if (line.includes('loyal') && context.currentWord.toLowerCase().includes('loyal')) {
        completions.push({
          label: 'loyalCustomer == true',
          kind: 5,
          detail: 'From BDD: loyalty discount scenario',
          insertText: 'loyalCustomer == true'
        })
      }
      if (line.includes('premium') && context.currentWord.toLowerCase().includes('premium')) {
        completions.push({
          label: 'premium > 1000',
          kind: 5,
          detail: 'From BDD: high premium scenario',
          insertText: 'premium > 1000'
        })
      }
    })
  }
  
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
    ws.on('message', (data) => {
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
            console.log(`[LSP] 📝 Document updated: ${oldLength} → ${newContent.length} chars`)
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
          
          // Handle INLINE mode (auto-completion during typing)
          if (isInlineMode) {
            console.log(`[LSP] ========================================`)
            console.log(`[LSP] 📥 RECEIVED INLINE COMPLETION REQUEST`)
            console.log(`[LSP] ----------------------------------------`)
            console.log(`[LSP]   - Request ID: ${message.id}`)
            console.log(`[LSP]   - Request Mode: ${requestMode}`)
            console.log(`[LSP]   - Position: Line ${line}, Column ${char}`)
            console.log(`[LSP]   - Before cursor: "${beforeCursor}"`)
            console.log(`[LSP]   - After cursor: "${afterCursor}"`)
            console.log(`[LSP]   - Full line: "${currentLine}"`)
            console.log(`[LSP]   - Document length: ${documentContent.length} chars`)
            console.log(`[LSP]   - Session initialized: ${session.initialized}`)
            console.log(`[LSP] ----------------------------------------`)
            console.log(`[LSP] 💡 GENERATING INLINE COMPLETIONS:`)
            
            // Mock inline completion suggestions based on context
            const completions = []
            
            // Check if user is typing after "Quote("
            if (beforeCursor.includes('Quote(') && !beforeCursor.includes(')')) {
              // Suggest field completions
              const factFields = getFactFields(session)
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
            }
            
            // Check if user is typing after "$quote."
            if (beforeCursor.includes('$quote.') || beforeCursor.includes('$Quote.')) {
              const factFields = getFactFields(session)
              factFields.forEach(field => {
                const methods = getFactMethods(field.name, field.type)
                methods.forEach(method => {
                  completions.push(method)
                })
              })
            }
            
            // Check if user is typing "rule"
            if (beforeCursor.trim().toLowerCase().startsWith('rule') && beforeCursor.length < 20) {
              completions.push({
                label: 'rule "Rule Name"',
                kind: 14, // Snippet
                detail: 'DRL rule template',
                insertText: 'rule "$1"\nwhen\n    $2\nthen\n    $3\nend',
                insertTextRules: 4
              })
            }
            
            // Check if user is typing "when" or "then"
            if (beforeCursor.trim().toLowerCase() === 'when') {
              completions.push({
                label: 'when clause',
                kind: 14,
                detail: 'DRL when clause',
                insertText: 'when\n    $quote : Quote($1)\n'
              })
            }
            
            if (beforeCursor.trim().toLowerCase() === 'then') {
              completions.push({
                label: 'then clause',
                kind: 14,
                detail: 'DRL then clause',
                insertText: 'then\n    $quote.setRequiresReview(true);\n    System.out.println("$1");\n'
              })
            }
            
            // If no context-specific completions, provide some general ones
            if (completions.length === 0) {
              // Always provide at least one mock suggestion for testing
              const currentWord = beforeCursor.trim().toLowerCase()
              
              // If user typed "rule", provide rule template
              if (currentWord === 'rule' || currentWord.startsWith('rule')) {
                completions.push({
                  label: 'rule "Rule Name"',
                  kind: 14, // Snippet
                  detail: 'DRL rule template',
                  insertText: 'rule "Rule Name"\nwhen\n    $quote : Quote(premium > 0)\nthen\n    $quote.setRequiresReview(true);\n    System.out.println("Rule executed");\nend'
                })
              } else {
                // Default suggestions
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
              }
            }
            
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
              console.log(`[LSP]       - Insert Text Preview: "${(item.insertText || '').substring(0, 150)}${(item.insertText || '').length > 150 ? '...' : ''}"`)
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
            console.log(`[LSP] ✅ INLINE COMPLETION RESPONSE SENT TO CLIENT`)
            console.log(`[LSP]   - Response ID: ${message.id}`)
            console.log(`[LSP]   - Items in response: ${completions.length}`)
            console.log(`[LSP] ========================================`)
            return
          }
          
          if (isModifyMode) {
            console.log(`[LSP] ----------------------------------------`)
            console.log(`[LSP] 📝 MODIFY DETAILS:`)
            console.log(`[LSP]   - Modify prompt: "${userPrompt}"`)
            console.log(`[LSP]   - Existing rule length: ${existingRule ? existingRule.length : 0} chars`)
            if (existingRule) {
              console.log(`[LSP]   - Existing rule preview: ${existingRule.substring(0, 100)}...`)
            }
            
            // Use buildMockModifiedRule to generate properly formatted modified rule
            const { ruleText: mockModifiedRule } = buildMockModifiedRule(existingRule, userPrompt)
            
            console.log(`[LSP]   - Mock modified rule length: ${mockModifiedRule.length} chars`)
            console.log(`[LSP]   - Mock modified rule preview:`)
            console.log(`[LSP]     ${mockModifiedRule.split('\n').slice(0, 3).join('\n     ')}...`)
            
            const completions = [{
              label: 'Modified Rule',
              kind: 14, // Snippet
              detail: 'Modified DRL Rule',
              insertText: mockModifiedRule,
              insertTextRules: 4, // Snippet mode
              documentation: {
                value: `Modified rule based on: ${userPrompt || 'user request'}`
              }
            }]
            
            console.log(`[LSP]   - Returning modified rule (${mockModifiedRule.length} chars)`)
            console.log(`[LSP] ----------------------------------------`)
            console.log(`[LSP] 📋 MODIFIED RULE SUGGESTIONS TO SEND:`)
            console.log(`[LSP]   Total items: ${completions.length}`)
            completions.forEach((item, index) => {
              console.log(`[LSP]   Item ${index + 1}:`)
              console.log(`[LSP]     - Label: "${item.label}"`)
              console.log(`[LSP]     - Kind: ${item.kind} (Snippet)`)
              console.log(`[LSP]     - Detail: "${item.detail}"`)
              console.log(`[LSP]     - Insert Text Length: ${item.insertText.length} characters`)
            })
            
            const response = {
              jsonrpc: '2.0',
              id: message.id,
              result: { items: completions }
            }
            
            ws.send(JSON.stringify(response))
            console.log(`[LSP] 📤 MODIFY RESPONSE SENT:`)
            console.log(`[LSP]   Response ID: ${message.id}`)
            console.log(`[LSP]   Items count: ${completions.length}`)
            console.log(`[LSP] ========================================`)
            return
          }
          
          // Handle GENERATE mode (create new rule)
          if (isGenerateMode) {
            console.log(`[LSP] ----------------------------------------`)
            // Check for user prompt (for future AI generation)
            if (userPrompt) {
              console.log(`[LSP] 📝 CREATE DETAILS:`)
              console.log(`[LSP]   - Generate prompt: "${userPrompt}"`)
              console.log(`[LSP]   (Note: Currently using mock response, but prompt is logged for future AI integration)`)
            }
            
            // Build completions from reusable rule templates
          // 
          // FUTURE USAGE EXAMPLES:
          // 
          // 1. Get specific template by label:
          //    const template = getTemplateByLabel('Flag high premium greater than 500')
          //    const completions = buildCompletionsFromTemplates([template])
          //
          // 2. Modify a template dynamically:
          //    const template = getTemplateByLabel('Flag high premium greater than 500')
          //    template.ruleContent = modifiedRuleContent
          //    template.documentation = 'Updated description'
          //    upsertTemplate(template)
          //    const completions = buildCompletionsFromTemplates()
          //
          // 3. Filter templates based on context:
          //    const relevantTemplates = getTemplatesByFilter(t => 
          //      t.ruleContent.includes(session.factObject.type)
          //    )
          //    const completions = buildCompletionsFromTemplates(relevantTemplates)
          //
          // 4. Add new template programmatically:
          //    upsertTemplate({
          //      label: 'New Rule Name',
          //      detail: 'New Rule Description',
          //      documentation: 'New rule documentation',
          //      ruleContent: 'rule "New Rule"\nwhen\n...\nthen\n...\nend',
          //      kind: 14,
          //      insertTextRules: 4
          //    })
          //    const completions = buildCompletionsFromTemplates()
          //
          const completions = buildCompletionsFromTemplates()
          
          console.log(`[LSP] ----------------------------------------`)
          console.log(`[LSP] 📋 COMPLETION SUGGESTIONS TO SEND:`)
          console.log(`[LSP]   Total items: ${completions.length}`)
          completions.forEach((item, index) => {
            console.log(`[LSP]   Item ${index + 1}:`)
            console.log(`[LSP]     - Label: "${item.label}"`)
            console.log(`[LSP]     - Kind: ${item.kind} (Snippet)`)
            console.log(`[LSP]     - Detail: "${item.detail}"`)
            console.log(`[LSP]     - Insert Text Rules: ${item.insertTextRules} (Snippet mode)`)
            console.log(`[LSP]     - Insert Text Length: ${item.insertText.length} characters`)
            console.log(`[LSP]     - Insert Text Preview:`)
            const preview = item.insertText.split('\n').slice(0, 3).join('\n')
            console.log(`[LSP]       ${preview}...`)
            if (item.documentation) {
              console.log(`[LSP]     - Documentation: "${item.documentation.value}"`)
            }
          })
          
          const response = {
            jsonrpc: '2.0',
            id: message.id,
            result: { items: completions }
          }
          
          ws.send(JSON.stringify(response))
          console.log(`[LSP] ----------------------------------------`)
          console.log(`[LSP] 📤 CREATE RESPONSE SENT:`)
          console.log(`[LSP]   Response ID: ${message.id}`)
          console.log(`[LSP]   Items count: ${completions.length}`)
          console.log(`[LSP]   Response size: ${JSON.stringify(response).length} bytes`)
          console.log(`[LSP] ========================================`)
          return
          }
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


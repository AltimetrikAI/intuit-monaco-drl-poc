import { WebSocketServer, WebSocket } from 'ws'

// Session storage: map WebSocket to context
const sessions = new Map()

// WebSocket server
let wss = null

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
        
        // Handle completion requests
        if (message.method === 'textDocument/completion') {
          const position = message.params.position
          const line = position.line + 1 // Convert to 1-based for display
          const char = position.character + 1
          
          console.log(`[LSP] 🔍 Completion request received:`)
          console.log(`[LSP]   - Position: Line ${line}, Column ${char}`)
          
          if (!session.initialized) {
            console.log(`[LSP]   ⚠️  Session not initialized, returning empty completions`)
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { items: [] }
            }))
            return
          }
          
          // Get context around cursor
          const lines = session.documentContent.split('\n')
          const currentLine = lines[position.line] || ''
          const beforeCursor = currentLine.substring(0, position.character)
          const afterCursor = currentLine.substring(position.character)
          
          console.log(`[LSP]   - Context: "${beforeCursor}|${afterCursor}"`)
          
          const completions = getCompletions(
            session,
            session.documentContent,
            position
          )
          
          console.log(`[LSP]   - Generated ${completions.length} completion(s):`)
          completions.slice(0, 10).forEach((comp, idx) => {
            console.log(`[LSP]     ${idx + 1}. ${comp.label}${comp.detail ? ` (${comp.detail})` : ''}`)
          })
          if (completions.length > 10) {
            console.log(`[LSP]     ... and ${completions.length - 10} more`)
          }
          
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { items: completions }
          }))
          console.log(`[LSP] 📤 Sent: ${completions.length} completion(s)`)
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


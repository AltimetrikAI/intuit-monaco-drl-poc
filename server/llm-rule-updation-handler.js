/**
 * LLM Rule Updation Handler
 * Modifies existing DRL rules using OpenAI API
 */

/**
 * Modify DRL rule using OpenAI
 * @param {string} userPrompt - User's request for rule modification
 * @param {string} existingRule - The existing rule to be modified
 * @param {string} documentContent - Current DRL file content
 * @param {Object} factObject - Fact object with field values
 * @param {Object} factSchema - Fact schema with field types
 * @returns {Promise<{drl: string, reasoning: string}>}
 */
export async function modifyRuleWithLLM(userPrompt, existingRule, documentContent, factObject, factSchema) {
  console.log(`[LLM] ========================================`)
  console.log(`[LLM] 🔄 RULE MODIFICATION REQUEST`)
  console.log(`[LLM] ========================================`)
  console.log(`[LLM] 📥 INPUTS:`)
  console.log(`[LLM]   - User Prompt: "${userPrompt}"`)
  console.log(`[LLM]   - Existing Rule: ${existingRule.length} chars`)
  console.log(`[LLM]   - Document Content: ${documentContent.length} chars`)
  console.log(`[LLM]   - Fact Object: ${Object.keys(factObject).length} field(s)`)
  console.log(`[LLM]   - Fact Schema: ${Object.keys(factSchema).length} field(s)`)
  
  const apiKey = process.env.OPENAI_API_KEY
  
  if (!apiKey) {
    console.error(`[LLM] ❌ OPENAI_API_KEY not found in environment variables`)
    throw new Error('OPENAI_API_KEY not found in environment variables')
  }

  // Build context for LLM
  const factContext = buildFactContext(factObject, factSchema)
  console.log(`[LLM] 📋 CONTEXT BUILT:`)
  console.log(`[LLM]   - Fact Context: ${factContext.length} chars`)
  
  const systemPrompt = `You are an expert Drools Rule Language (DRL) developer. Modify the existing rule based on the user's request.

IMPORTANT:
- Return ONLY the modified rule (rule "name" ... end block)
- DO NOT include package, import, or other existing rules
- DO NOT repeat the entire DRL file
- Preserve the rule structure unless explicitly asked to change it
- Make only the modifications requested by the user

Response format (JSON):
{
  "drl": "rule \"Rule Name\"\nwhen\n    ...\nthen\n    ...\nend",
  "reasoning": "brief explanation of the modifications made"
}`

  const userMessage = buildUserMessage(userPrompt, existingRule, documentContent, factContext)
  console.log(`[LLM] 📤 REQUEST DETAILS:`)
  console.log(`[LLM]   - System Prompt: ${systemPrompt.length} chars`)
  console.log(`[LLM]   - User Message: ${userMessage.length} chars`)
  console.log(`[LLM]   - Model: gpt-4.1-mini`)
  console.log(`[LLM]   - Temperature: 0.3`)
  console.log(`[LLM]   - Max Tokens: 2000`)
  console.log(`[LLM] 📝 FULL PROMPT BEING SENT:`)
  console.log(`[LLM] ========================================`)
  console.log(`[LLM] SYSTEM PROMPT:`)
  console.log(systemPrompt)
  console.log(`[LLM] ========================================`)
  console.log(`[LLM] USER MESSAGE:`)
  console.log(userMessage)
  console.log(`[LLM] ========================================`)
  
  const startTime = Date.now()
  console.log(`[LLM] 🚀 Calling OpenAI API...`)
  console.log(`[LLM] ⏱️  Request started at: ${new Date(startTime).toISOString()}`)

  try {
    const fetchStartTime = Date.now()
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 2000
      })
    })

    const fetchTime = Date.now() - fetchStartTime
    const totalTime = Date.now() - startTime
    console.log(`[LLM] ⏱️  TIMING BREAKDOWN:`)
    console.log(`[LLM]   - Fetch request time: ${fetchTime}ms`)
    console.log(`[LLM]   - Total elapsed time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`)

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[LLM] ❌ API Error:`)
      console.error(`[LLM]   - Status: ${response.status}`)
      console.error(`[LLM]   - Error: ${errorText}`)
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`)
    }

    const data = await response.json()
    console.log(`[LLM] ✅ API Response Received:`)
    console.log(`[LLM]   - Model Used: ${data.model || 'N/A'}`)
    console.log(`[LLM]   - Tokens Used: ${data.usage?.total_tokens || 'N/A'}`)
    console.log(`[LLM]   - Prompt Tokens: ${data.usage?.prompt_tokens || 'N/A'}`)
    console.log(`[LLM]   - Completion Tokens: ${data.usage?.completion_tokens || 'N/A'}`)

    const content = data.choices[0]?.message?.content

    if (!content) {
      console.error(`[LLM] ❌ No content in OpenAI response`)
      throw new Error('No content in OpenAI response')
    }

    console.log(`[LLM] 📥 FULL RESPONSE FROM LLM:`)
    console.log(`[LLM] ========================================`)
    console.log(content)
    console.log(`[LLM] ========================================`)

    const parseStartTime = Date.now()
    console.log(`[LLM] 📝 Parsing JSON response...`)
    const result = JSON.parse(content)
    const parseTime = Date.now() - parseStartTime
    
    const finalTotalTime = Date.now() - startTime
    console.log(`[LLM] ✅ RESPONSE PARSED:`)
    console.log(`[LLM]   - Parse time: ${parseTime}ms`)
    console.log(`[LLM]   - Total time: ${finalTotalTime}ms (${(finalTotalTime / 1000).toFixed(2)}s)`)
    console.log(`[LLM]   - DRL Length: ${result.drl?.length || 0} chars`)
    console.log(`[LLM]   - Reasoning Length: ${result.reasoning?.length || 0} chars`)
    console.log(`[LLM]   - DRL Preview: ${(result.drl || '').substring(0, 100)}${(result.drl || '').length > 100 ? '...' : ''}`)
    console.log(`[LLM]   - Reasoning: ${(result.reasoning || '').substring(0, 100)}${(result.reasoning || '').length > 100 ? '...' : ''}`)
    console.log(`[LLM] ========================================`)
    
    return {
      drl: result.drl || '',
      reasoning: result.reasoning || 'Rule modified successfully'
    }
  } catch (error) {
    console.error(`[LLM] ❌ ERROR:`)
    console.error(`[LLM]   - Message: ${error.message}`)
    console.error(`[LLM]   - Stack: ${error.stack}`)
    console.log(`[LLM] ========================================`)
    throw error
  }
}

/**
 * Build fact context string
 */
function buildFactContext(factObject, factSchema) {
  if (!factObject || Object.keys(factObject).length === 0) {
    return 'No fact object available'
  }

  const fields = Object.keys(factSchema || factObject).map(key => {
    const type = factSchema?.[key] || typeof factObject[key]
    const value = factObject[key]
    return `  - ${key} (${type}): ${JSON.stringify(value)}`
  }).join('\n')

  return `Fact Object Schema:
${fields}`
}

/**
 * Build user message for LLM
 */
function buildUserMessage(userPrompt, existingRule, documentContent, factContext) {
  const existingCode = documentContent.trim() 
    ? `\n\nExisting DRL file (for context only - DO NOT repeat this):\n\`\`\`\n${documentContent}\n\`\`\``
    : '\n\nNo existing DRL code.'

  return `User Request: ${userPrompt}

Existing Rule to Modify:
\`\`\`
${existingRule}
\`\`\`

${factContext}
${existingCode}

IMPORTANT: Modify ONLY the rule shown above based on the user's request. Return JSON with:
- "drl": Only the modified rule block (rule "name" ... end), no package/import
- "reasoning": Brief explanation of the modifications made`
}


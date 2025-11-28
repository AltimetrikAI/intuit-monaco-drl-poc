#!/usr/bin/env node
import 'dotenv/config'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error('❌ OPENAI_API_KEY not found')
  process.exit(1)
}

const res = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  },
  body: JSON.stringify({
    model: 'gpt-5-mini',
    messages: [{ role: 'user', content: 'Say hello in one word' }]
  })
})

const data = await res.json()
console.log('✅', data.choices[0].message.content)
console.log('📊', data.usage)


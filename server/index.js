import express from 'express'
import cors from 'cors'
import bodyParser from 'body-parser'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { analyzeDrl, runRuleTests } from './pipeline.js'
import { startLSPServer } from './lsp-server.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const RULE_PATH = path.resolve(__dirname, '../data/rules/sample.drl')
const FACT_PATH = path.resolve(__dirname, '../data/facts/quote.json')
const TEST_DOC_PATH = path.resolve(__dirname, '../data/tests/bdd-tests.md')

const app = express()
app.use(cors())
app.use(bodyParser.json({ limit: '1mb' }))
app.use(bodyParser.text({ type: 'text/plain', limit: '1mb' }))

app.get('/api/drl', async (_req, res) => {
  try {
    const content = await fs.readFile(RULE_PATH, 'utf-8')
    res.type('text/plain').send(content)
  } catch (err) {
    res.status(500).json({ message: 'Unable to load DRL', error: String(err) })
  }
})

app.get('/api/fact', async (_req, res) => {
  try {
    const content = await fs.readFile(FACT_PATH, 'utf-8')
    res.type('application/json').send(content)
  } catch (err) {
    res.status(500).json({ message: 'Unable to load fact object', error: String(err) })
  }
})

app.get('/api/bdd', async (_req, res) => {
  try {
    const content = await fs.readFile(TEST_DOC_PATH, 'utf-8')
    res.type('text/plain').send(content)
  } catch (err) {
    res.status(500).json({ message: 'Unable to load BDD test cases', error: String(err) })
  }
})

app.post('/api/bdd', async (req, res) => {
  try {
    const content = typeof req.body === 'string' ? req.body : ''
    await fs.writeFile(TEST_DOC_PATH, content, 'utf-8')
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ message: 'Unable to save BDD test cases', error: String(err) })
  }
})

app.post('/api/drl', async (req, res) => {
  try {
    const content = typeof req.body === 'string' ? req.body : ''
    await fs.writeFile(RULE_PATH, content, 'utf-8')
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ message: 'Unable to save DRL', error: String(err) })
  }
})

app.post('/api/run', async (req, res) => {
  const content = req.body?.content ?? ''
  const compile = await analyzeDrl(content, FACT_PATH)
  const tests = await runRuleTests(content, FACT_PATH, TEST_DOC_PATH)

  res.json({
    timestamp: new Date().toISOString(),
    compile,
    tests
  })
})

const DIST_PATH = path.resolve(__dirname, '../dist')
app.use(express.static(DIST_PATH))
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next()
  res.sendFile(path.join(DIST_PATH, 'index.html'))
})

const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})

// Start LSP server
const LSP_PORT = process.env.LSP_PORT || 4001
startLSPServer(LSP_PORT)

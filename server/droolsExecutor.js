import { spawn, execSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { accessSync, constants } from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const JAVA_DIR = path.resolve(__dirname, '../java')
const JAR_PATH = path.resolve(JAVA_DIR, 'target/drools-executor-1.0.0-jar-with-dependencies.jar')

/**
 * Execute Drools rules using the Java runtime
 * @param {string} drlContent - The DRL rule content
 * @param {string} factJson - The fact object as JSON string
 * @returns {Promise<Object>} Execution result
 */
export async function executeDroolsRules(drlContent, factJson) {
  const start = performance.now()

  // Check if JAR exists, auto-build if missing
  try {
    await fs.access(JAR_PATH)
  } catch (err) {
    console.log('[Drools Executor] JAR not found, attempting to build...')
    try {
      execSync('mvn clean package', {
        cwd: JAVA_DIR,
        stdio: 'inherit',
        env: { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' }
      })
      // Verify JAR was created
      await fs.access(JAR_PATH)
      console.log('[Drools Executor] JAR built successfully')
    } catch (buildErr) {
      throw new Error(
        `Drools JAR not found and auto-build failed. Please build manually:\n` +
        `  cd java && mvn clean package\n` +
        `Error: ${buildErr.message}`
      )
    }
  }

  return new Promise((resolve, reject) => {
    // Escape the DRL content and fact JSON for command line
    // Use base64 encoding to avoid shell escaping issues
    const drlBase64 = Buffer.from(drlContent).toString('base64')
    const factBase64 = Buffer.from(factJson).toString('base64')

    // Find Java executable - try common locations
    let javaCmd = 'java'
    try {
      // Try to find Java in PATH
      const javaPath = execSync('which java', { encoding: 'utf-8' }).trim()
      if (javaPath) {
        javaCmd = javaPath
      }
    } catch (e) {
      // If which fails, try common Java locations
      const commonPaths = [
        '/usr/local/opt/openjdk@17/bin/java',
        '/usr/bin/java',
        '/usr/local/bin/java'
      ]
      for (const javaPath of commonPaths) {
        try {
          accessSync(javaPath, constants.F_OK)
          javaCmd = javaPath
          break
        } catch {
          // Continue to next path
        }
      }
    }

    // Spawn Java process
    const javaProcess = spawn(javaCmd, [
      '-jar',
      JAR_PATH,
      drlBase64,
      factBase64
    ], {
      cwd: JAVA_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' }
    })

    let stdout = ''
    let stderr = ''

    javaProcess.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    javaProcess.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    javaProcess.on('close', (code) => {
      const durationMs = Math.round(performance.now() - start)

      if (code !== 0) {
        reject(new Error(`Drools execution failed: ${stderr || stdout}`))
        return
      }

      try {
        // Try to extract JSON from stdout (it should be the last line)
        // Everything before the JSON is considered log output
        const lines = stdout.trim().split('\n')
        let jsonLine = ''
        let javaLogs = []
        
        // Find the JSON line (should be valid JSON)
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            JSON.parse(lines[i])
            jsonLine = lines[i]
            // Everything before this is logs
            javaLogs = lines.slice(0, i)
            break
          } catch {
            // Not JSON, continue
          }
        }
        
        if (!jsonLine) {
          // If no JSON found, try parsing the whole stdout
          const result = JSON.parse(stdout.trim())
          result.durationMs = durationMs
          result.javaLogs = stderr ? [stderr] : []
          resolve(result)
          return
        }
        
        // Parse the JSON result from Java
        const result = JSON.parse(jsonLine)
        result.durationMs = durationMs
        
        // Add Java logs (stdout logs + stderr)
        result.javaLogs = []
        if (javaLogs.length > 0) {
          result.javaLogs.push(...javaLogs.filter(line => line.trim()))
        }
        if (stderr && stderr.trim()) {
          result.javaLogs.push(`[STDERR] ${stderr.trim()}`)
        }
        
        resolve(result)
      } catch (err) {
        reject(new Error(`Failed to parse Drools result: ${stdout}\nError: ${err.message}`))
      }
    })

    javaProcess.on('error', (err) => {
      reject(new Error(`Failed to start Java process: ${err.message}. Make sure Java is installed.`))
    })
  })
}


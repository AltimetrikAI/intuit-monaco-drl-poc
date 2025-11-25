/**
 * Converts a JSON object to a type schema representation
 * showing attribute types instead of values for AI context
 */
export function jsonToTypeSchema(obj: unknown, indent = 0): string {
  const spaces = '  '.repeat(indent)
  
  if (obj === null) {
    return 'null'
  }
  
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      return 'array<unknown>'
    }
    const itemType = jsonToTypeSchema(obj[0], 0)
    return `array<${itemType}>`
  }
  
  if (typeof obj === 'object' && obj !== null) {
    const entries = Object.entries(obj)
    if (entries.length === 0) {
      return 'object {}'
    }
    
    const lines = entries.map(([key, value]) => {
      const valueType = jsonToTypeSchema(value, indent + 1)
      return `${spaces}  ${key}: ${valueType}`
    })
    
    return `{\n${lines.join('\n')}\n${spaces}}`
  }
  
  // Primitive types
  if (typeof obj === 'string') return 'string'
  if (typeof obj === 'number') return 'number'
  if (typeof obj === 'boolean') return 'boolean'
  if (typeof obj === 'undefined') return 'undefined'
  
  return 'unknown'
}

/**
 * Extracts a schema object mapping field names to their types
 */
export function extractFactSchema(factObject: Record<string, unknown>): Record<string, string> {
  const schema: Record<string, string> = {}
  
  for (const [key, value] of Object.entries(factObject)) {
    if (value === null) {
      schema[key] = 'null'
    } else if (Array.isArray(value)) {
      schema[key] = 'array'
    } else {
      schema[key] = typeof value
    }
  }
  
  return schema
}


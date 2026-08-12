const splitShellArgs = (input) => {
  const args = []
  let current = ""
  let quote = null
  let escaping = false
  let tokenStarted = false

  const pushCurrent = () => {
    if (!tokenStarted) return
    args.push(current)
    current = ""
    tokenStarted = false
  }

  for (const char of input) {
    if (escaping) {
      if (quote === '"' && char === "\n") {
        escaping = false
        continue
      }
      if (quote === '"' && !['"', "\\", "$", "`"].includes(char)) {
        current += "\\"
      }
      current += char
      tokenStarted = true
      escaping = false
      continue
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null
      } else {
        current += char
      }
      tokenStarted = true
      continue
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null
      } else if (char === "\\") {
        escaping = true
      } else {
        current += char
      }
      tokenStarted = true
      continue
    }

    if (/\s/.test(char)) {
      pushCurrent()
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      tokenStarted = true
      continue
    }

    if (char === "\\") {
      escaping = true
      tokenStarted = true
      continue
    }

    current += char
    tokenStarted = true
  }

  if (escaping) current += "\\"
  if (quote !== null)
    throw new Error("Unterminated quote in /benchmark command")
  pushCurrent()
  return args
}

export const parsePrBenchmarkCommand = (body) => {
  const command = body.trim()
  if (!/^\/benchmark(?:\s|$)/.test(command)) {
    throw new Error("Expected /benchmark [benchmark.sh args...]")
  }

  return {
    benchmarkArgs: splitShellArgs(command.slice("/benchmark".length).trim()),
  }
}

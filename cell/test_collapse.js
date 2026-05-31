function collapseBashMultilineCommand(command) {
  const lines = command.split(/\r\n|\n|\r/);
  const result = [];
  for (const line of lines) {
    if (result.length > 0 && result[result.length - 1].trimEnd().endsWith('\\')) {
      const prev = result[result.length - 1].trimEnd();
      result[result.length - 1] = prev.slice(0, -1) + ' + line.trimStart();
    } else if (result.length > 0 && lineHasUnclosedQuote(result[result.length - 1])) {
      result[result.length - 1] += ' + line;
    } else {
      result.push(line);
    }
  }
  return result.join('\n');
}

function lineHasUnclosedQuote(line) {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') { i++; continue; }
    if (ch === "'" && !double) { single = !single; }
    if (ch === '"' && !single) { double = !double; }
  }
  return single || double;
}

const NL = String.fromCharCode(10);

// Test 1
const t1 = 'git add \' + NL + '  file1.py \' + NL + '  file2.py';
const r1 = collapseBashMultilineCommand(t1);
console.log('T1:', JSON.stringify(r1));
console.log('  OK:', r1 === 'git add file1.py file2.py');

// Test 2
const t2 = 'git commit -m \"line1' + NL + 'line2' + NL + 'line3\"';
const r2 = collapseBashMultilineCommand(t2);
console.log('T2:', JSON.stringify(r2));
console.log('  OK:', !r2.includes(NL));

// Test 3
const t3 = 'python3 - <<PY' + NL + 'print(1)' + NL + 'PY';
const r3 = collapseBashMultilineCommand(t3);
console.log('T3:', JSON.stringify(r3));
console.log('  Multiline:', r3.includes(NL));

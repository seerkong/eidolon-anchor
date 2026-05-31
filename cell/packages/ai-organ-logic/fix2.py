p='/Users/kongweixian/ai/eidolon/eidolon-anchor/cell/packages/ai-organ-logic/src/permissions/LocalPermissionEvaluator.ts'
c=open(p).read()
# Fix: result[result.length - 1] += " + line;  ->  result[result.length - 1] += " + line;
# (add a closing " for the string literal)
c=c.replace('+= \x22 + line;','+= \x22 \x22 + line;')
open(p,'w').write(c)
print('ok')

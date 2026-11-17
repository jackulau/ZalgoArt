#!/bin/bash
# Builds docs/index.html, the page GitHub Pages serves: one file holding the shared core, the font
# calibration and the sample image. Run it after changing anything in src/ or examples/burger.jpg.
# ./build.sh <file> writes the page somewhere else (an absolute path), which is how the tests check the build.
cd "$(dirname "$0")"
python3 - "$@" <<'PY'
import base64,sys
s=open('src/site.html',encoding='utf8').read()
for mark,path in (('__CORE__','src/zalgo-core.js'),('__CAL__','src/zalgo-cal.js')):
    assert s.count(mark)==1,mark
    s=s.replace(mark,open(path,encoding='utf8').read().replace('</script','<\\/script'))
assert s.count('__BURGER__')==1
s=s.replace('__BURGER__','data:image/jpeg;base64,'+base64.b64encode(open('examples/burger.jpg','rb').read()).decode())
out=sys.argv[1] if len(sys.argv)>1 else 'docs/index.html'
open(out,'w',encoding='utf8').write(s)
print(out,len(s.encode('utf8')),'bytes')
PY

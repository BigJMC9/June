"""Render-only fallback: bundle modules in-memory, not a native ESM/CSP test."""
from pathlib import Path
import re

def renderer_bundle(root: Path):
    def strip_imports(s): return re.sub(r'^import .*?;\n', '', s, flags=re.M)
    markup=re.sub(r'\bexport ', '', (root/'extras-markup.mjs').read_text())
    data=(root/'workspace-data.mjs').read_text()
    result='(() => {\n'+markup+'\n})();\n'
    names=['KNOWLEDGE_KEY','COOKBOOK_KEY','knowledgeDefaults','cookbookDefaults','validEndpoint','normalizeKnowledge','normalizeCookbook','eligibleKnowledge','buildContext','serializeChat','memoryCandidates','parseSkill','duplicateMemoryIds','quoteArgument','launchCommand','downloadCommand']
    result+='const __data=(()=>{\n'+re.sub(r'\bexport ', '', data)+'\nreturn {'+','.join(names)+'};})();\n'
    extra=(root/'extras.js').read_text()
    imported=re.search(r'^import \{(.*?)\} from',extra,re.M).group(1)
    result+='const {installExtras}=(()=>{\nconst {'+imported+'}=__data;\n'+re.sub(r'\bexport ', '',strip_imports(extra))+'\nreturn {installExtras};})();\n'
    result+=strip_imports((root/'app.js').read_text())
    return result

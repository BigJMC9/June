"""Render-only fallback: bundle modules in-memory, not a native ESM/CSP test."""
from pathlib import Path
import re

def renderer_bundle(root: Path):
    def strip_imports(s): return re.sub(r'^import .*?;\n', '', s, flags=re.M)
    markup=re.sub(r'\bexport ', '', (root/'extras-markup.mjs').read_text())
    data=(root/'workspace-data.mjs').read_text()
    result='(() => {\n'+markup+'\n})();\n'
    result+='(() => {\n'+(root/'backend-markup.mjs').read_text()+'\n})();\n'
    names=['KNOWLEDGE_KEY','COOKBOOK_KEY','AGENTS_KEY','DEFAULT_CONDENSATION_INSTRUCTIONS','DEFAULT_CONDENSATION_POLICY','normalizeAgentStore','normalizeAgentOverride','resolveAgentConfig','condensationCutoff','condensationTriggerTokens','estimatedInputTokens','knowledgeDefaults','cookbookDefaults','validEndpoint','normalizeKnowledge','normalizeCookbook','eligibleKnowledge','buildContext','buildCondensationPrompt','serializeChat','memoryCandidates','parseSkill','duplicateMemoryIds','quoteArgument','launchCommand','downloadCommand']
    result+='const __data=(()=>{\n'+re.sub(r'\bexport ', '', data)+'\nreturn {'+','.join(names)+'};})();\n'
    extra=(root/'extras.js').read_text()
    imported=re.search(r'^import \{(.*?)\} from',extra,re.M).group(1)
    result+='const {installExtras}=(()=>{\nconst {'+imported+'}=__data;\n'+re.sub(r'\bexport ', '',strip_imports(extra))+'\nreturn {installExtras};})();\n'
    result+='const {renderMarkdown}=(()=>{\n'+re.sub(r'\bexport ', '',(root/'chat-format.mjs').read_text())+'\nreturn {renderMarkdown};})();\n'
    result+='const {installBackend}=(()=>{\nconst {resolveAgentConfig,condensationTriggerTokens}=__data;\n'+re.sub(r'\bexport ', '',strip_imports((root/'backend-ui.js').read_text()))+'\nreturn {installBackend};})();\n'
    result+='const {installAgents}=(()=>{\nconst {AGENTS_KEY,normalizeAgentStore,normalizeAgentOverride,resolveAgentConfig}=__data;\n'+re.sub(r'\bexport ', '',strip_imports((root/'agents-ui.js').read_text()))+'\nreturn {installAgents};})();\n'
    result+='const {AGENTS_KEY,DEFAULT_CONDENSATION_INSTRUCTIONS,normalizeAgentStore}=__data;\n'
    result+=strip_imports((root/'app.js').read_text())
    return result

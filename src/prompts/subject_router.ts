// Subject-aware prompt routing.
// Returns a subject-specific context block for the orchestrator.
// The AI uses this to adapt its explanations for each subject.
// Nothing hardcoded — the AI generates the actual analogies and explanations.
// These are just GUIDES, not scripts.

export function getSubjectContext(subject: string, topic: string, knowledgeLevel: number): string {
  const subjectMap: Record<string, { focus: string; analogyDomains: string[]; watchFor: string[]; format: string }> = {
    mathematics: {
      focus: 'Show the WHY before the HOW. Concrete before abstract. Never skip steps.',
      analogyDomains: ['market trading (buying/selling)', 'cooking measurements', 'football statistics', 'building/construction', 'sharing money'],
      watchFor: ['multiplication always makes bigger', 'division always makes smaller', 'negative numbers are confusing for many students', 'BODMAS order errors', 'fraction misconceptions'],
      format: 'Concept intuition → Formula → Worked example → Student tries parallel problem',
    },
    physics: {
      focus: 'Start with observable phenomenon. Model it after. Connect to Nigerian daily life.',
      analogyDomains: ['NEPA/generators', 'danfo buses and keke napep', 'football', 'cooking fire', 'phone charging', 'water flow and pipes'],
      watchFor: ['heavier objects fall faster', 'force needed to maintain motion', 'current flows positive to negative (electron vs conventional)', 'heat as substance (caloric theory)', 'speed vs velocity confusion'],
      format: 'Observable phenomenon → Physical model → Equation → WAEC-style application',
    },
    chemistry: {
      focus: 'Use particulate models before equations. Connect reactions to everyday Nigerian chemistry.',
      analogyDomains: ['cooking and food chemistry', 'soap making (saponification)', 'palm wine fermentation', 'dyeing fabrics', 'battery and phones'],
      watchFor: ['atoms as tiny solid balls', 'bonds as physical sticks', 'mass not conserved in nuclear reactions confusion', 'pH scale is linear confusion', 'electronegativity vs electron affinity'],
      format: 'Macro observation → Particulate model → Symbolic equation → Calculation',
    },
    biology: {
      focus: 'Use local organisms. Connect to Nigerian health, farming, and ecosystems.',
      analogyDomains: ['local farming (cassava, yam, maize)', 'family traits and inheritance', 'malaria and local diseases', 'goats and market animals', 'local plants and medicines'],
      watchFor: ['plants get food from soil', 'evolution has a purpose', 'humans evolved from monkeys (vs shared ancestor)', 'antibiotics kill viruses', 'osmosis direction confusion'],
      format: 'Observable organism/phenomenon → Structure → Function → Nigerian application → WAEC connection',
    },
    english: {
      focus: 'Connect grammar to how language is actually used in Nigerian English and daily communication.',
      analogyDomains: ['daily conversation', 'WhatsApp messages', 'market interactions', 'Nigerian news and media'],
      watchFor: ['direct translation from Pidgin/local language', 'tense confusion especially perfect tenses', 'article usage (a, an, the)', 'sentence structure influenced by local language patterns'],
      format: 'Rule → Why it exists → Common error → Correct example → Nigerian context example',
    },
    economics: {
      focus: 'Use Nigerian market and business examples. Connect macro concepts to everyday life.',
      analogyDomains: ['Lagos market', 'naira exchange rate', 'fuel subsidy', 'local business', 'petty trading'],
      watchFor: ['supply/demand direction confusion', 'GDP vs GDP per capita', 'inflation vs deflation direction', 'opportunity cost misunderstood as actual cost'],
      format: 'Real Nigerian example → Economic principle → Model → Graph/diagram description → WAEC application',
    },
  };

  const subjectLower = subject.toLowerCase();
  const config = subjectMap[subjectLower] || {
    focus: 'Be clear, patient, and use Nigerian everyday examples.',
    analogyDomains: ['daily life in Nigeria', 'market and business', 'family and community'],
    watchFor: ['common student misconceptions in this subject'],
    format: 'Concept → Example → Application',
  };

  const levelDescription = knowledgeLevel < 0.3 ? 'beginner — build from absolute basics, nothing assumed'
    : knowledgeLevel < 0.6 ? 'intermediate — some foundation exists, can use subject vocabulary'
    : 'advanced — can handle complexity, push to connect concepts';

  return `SUBJECT CONTEXT — ${subject.toUpperCase()} (${topic || 'general'}):
Knowledge level: ${levelDescription}

Teaching focus: ${config.focus}
Analogy domains to draw from: ${config.analogyDomains.join(', ')}
Common misconceptions to watch for: ${config.watchFor.join('; ')}
Effective response format: ${config.format}

Important: Use this as guidance, not a script. Adapt to what the student actually said. One concept at a time.`;
}
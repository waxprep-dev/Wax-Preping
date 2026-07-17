# WaxPrep v1 — Teach-First Teaching Engine

## Why this release exists

A real WhatsApp transcript showed the tutor behaving like an interviewer, not a teacher:

1. Opened with a robotic script: *"Welcome to our tutoring sessions..."*
2. Asked a question almost every turn, even after the student said **"Ok I am ready"** and **"I don't know"**
3. Forced the same analogy formula (*"So in the same way..."*) repeatedly
4. When the student disclosed anatomy + poor foundation + no SS3, the tutor kept probing instead of teaching
5. After "I don't know", it asked *another* Socratic question instead of explaining

That is the opposite of elite human tutoring.

## Research grounding

| Principle | Source | Application in v1 |
|---|---|---|
| Explicit / Direct Instruction for novices | Rosenshine; Engelmann DI | When foundation is weak or student is ready → micro-chunk teaching, not Socratic grilling |
| Cognitive Load Theory | Sweller | Low foundation / high load → cut interrogation, increase structured explanation |
| Productive struggle only after a model | Kapur; worked-example research | "I don't know" → teach model first |
| Expert tutor dialogue | Chi; Graesser AutoTutor; Bloom 2-sigma | Alternate explain / model / sparse questions — not question every turn |
| Retrieval practice timing | Roediger & Karpicke | Only after a concept was actually taught |
| Zone of Proximal Development | Vygotsky | Scaffold the next doable step; don't ask the student to invent the map |

## Root causes found in the codebase

1. **`normalizePlan` bug** — `askQuestion: parsed.askQuestion !== false` forced questions whenever the model omitted the field.
2. **Fallback plan** — `askQuestion: perception.primaryIntent !== 'expressing_emotion'` defaulted to true almost always.
3. **Generation prompt** — "End with exactly one question when the plan says askQuestion" + plans almost always said true → perpetual quiz mode.
4. **No question budget** — session state had no `consecutiveQuestions` / `turnsSinceLastTeach`.
5. **Late memory** — student facts only updated async after the reply, so the next turn often re-asked known goals.
6. **Prompt seeds in DB** — even after code changes, old `generation.v1` / `deliberation.v1` rows could keep running. Bumped to `.v2`.

## What shipped

### New
- `src/teaching/policy.ts` — hard teach-first policy engine (moves, question budget, signal detectors)
- `src/memory/instant_facts.ts` — zero-LLM extraction of course, exam, foundation, school, scores
- `scripts/simulate_policy.ts` — offline replay of the failing WhatsApp transcript

### Changed
- `src/teaching/deliberation.ts` — policy before + after LLM; fixed `askQuestion` default
- `src/teaching/generation.ts` — hard question strip when forbidden; robotic opener strip; single-question collapse
- `src/config/prompts.ts` — `deliberation.v2`, `generation.v2` teach-first seeds
- `src/agents/crew.ts` — instant facts, policy accounting in session state, subject/concept inference from goals
- `src/defense/defense.ts` — `human_teaching_voice` layer (robotic scripts + multi-question)
- `src/types/student.ts` + `session/manager.ts` — session accounting fields
- `src/types/teaching.ts` — `policyMove`, `mustTeachContent`, `maxQuestionsThisTurn` on plan

## Policy moves (summary)

| Student signal | Move | Ask? | Teach? |
|---|---|---|---|
| First message | `welcome_and_orient` | at most 1 | no |
| "I'm ready" | `teach_micro_chunk` | **no** | **yes** |
| "I don't know" | `teach_micro_chunk` | **no** | **yes** |
| Foundation poor / no SS3 | `teach_micro_chunk` | usually no | **yes** |
| Bye / busy / overloaded | `wrap_and_invite_back` | **no** | no |
| 2+ consecutive questions | force teach | **no** | **yes** |
| Volunteered goals + subject known | teach | **no** | **yes** |
| Short ack but facts known | teach | **no** | **yes** |

## How to verify

```bash
npx tsc --noEmit
npx tsx scripts/simulate_policy.ts
```

Critical checks that must pass on the sample transcript:
- Ready turn → teach, no question
- Don't-know turn → teach, no question
- Bye turn → no question

## Deploy notes

1. Deploy code as usual.
2. New prompt IDs (`deliberation.v2`, `generation.v2`) seed automatically on first use.
3. Optional: delete old `prompt_components` rows for `deliberation.v1` / `generation.v1` if you want a clean table.
4. Session JSONB is additive — old sessions get defaults via `{ ...EMPTY_SESSION_STATE, ...row.state }`.

## What this is not (yet)

Full multi-agent infrastructure rewrite, BKT parameter learning, hierarchical memory consolidation, or multi-region scale-out. Those are next phases. v1 deliberately fixes the **student-facing teaching failure** first — the only failure that made a real student say bye after six minutes of interrogation.

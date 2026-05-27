# Research Foundations

Goblintown is built around a small set of pragmatic multi-agent bets:

- diverse first drafts are useful only when review is stricter than generation;
- a context step should reduce noise, not spray every file into every prompt;
- critique is more useful when it happens before final selection;
- recovery should target the failure mode, not restart from a blank prompt;
- memory has to be structured enough to reuse later.

The names are theatrical. The contracts are not.

## Decomposition

Planner mode turns broad work into a DAG of narrower Rites. The executor passes
parent Artifacts into dependent nodes and caps replanning after failures.

## Diversity

The Goblin pack varies prompts and personality labels. This is not because
personality is magic; it is because candidate diversity gives the reviewer
something to compare.

## Adversarial Review

Gremlin critique and Troll review are separate stages. The Gremlin creates
failure pressure. The Troll decides whether a candidate is acceptable and may
call verifier tools before scoring.

## Recovery

When the whole pack fails, Goblintown clusters the failures and asks Specialist
Goblins to repair the best seed. This keeps useful work instead of discarding
everything because the first pass missed one important constraint.

## Durable Memory

Pigeon-Scribe Artifacts are the memory boundary. Raw transcripts are too much;
single-line summaries are too little. Artifacts preserve claims, evidence, open
questions, next steps, keywords, and parent links.

# Self-heal review overlay — linkedin-stats weekly scrape

Pipeline-specific half of the review protocol. Read AFTER
`.claude/skills/pipeline-shared/references/self-heal-review-core.md`; this
file is additive — it cannot relax the core's rules.

Extra context keys from the caller: `WEEK` (the ISO-Monday week that was
scraped). `WRAPPER` is `.claude/skills/linkedin-stats/run-weekly.sh`.

Pipeline specifics that matter for the critique:

- The 429 budget is the scarcest resource (~23 paced loads/min safe, shared
  across ALL analytics surfaces). The successful rerun just spent a full
  scrape's worth — zero LinkedIn navigations in this phase.
- "What breaks it next Monday?" is the right time horizon for the codex
  brief: the next verification of any fix is next week's fire.
- An `accepted_partial` here means per-post coverage gaps and/or a demoted
  hollow surface (the semantic canaries) — name the concrete gaps
  (FAILED_IDS, missing phases) in the Resolution.

---
name: write-agent-task
description: Write or review concise, executable tasks for coding agents. Use when creating, delegating, rewriting, or assessing a task, issue, work order, or implementation brief for another agent.
---

# Write an agent task

Create a compact execution contract, not a transcript, full design document, or hidden worker prompt.

## Write the task

Lead with one actionable outcome. Make it explicit whether the agent should implement, investigate, review, or advise.

Include only information that changes execution:

- the observable result and why it matters;
- the workspace, repository, service, or artifact in scope;
- essential facts the assignee cannot reliably discover;
- three to seven verifiable acceptance criteria;
- a concrete validation method or evidence requirement;
- material authorization limits and excluded external effects;
- links or paths to detailed plans, designs, analysis, or source material.

Give the assignee room to choose routine implementation details. Name likely files or existing patterns when useful, but do not prescribe a long procedure unless the order itself is required for correctness or safety.

Keep the visible task to one screen when practical: about 150–350 words. This is a readability target, not a hard correctness limit. When necessary detail exceeds it, put that detail in a durable referenced artifact and summarize only what the assignee must know to start and finish.

## Leave out

Do not copy a full plan or conversation into the task. Omit:

- generic repository conventions already available in `AGENTS.md` or project documentation;
- internal coordinator protocol, routing markers, credentials, or reporting mechanics;
- repeated constraints stated in multiple ways;
- exhaustive test matrices when a linked specification already contains them;
- speculative implementation micromanagement;
- narrative history or rationale that does not affect a decision;
- boilerplate demands to be thorough, careful, or professional.

Never place secrets in a task. Do not use a task description to expand the user's authorization.

## Structure

Use only the sections the task needs. A useful default is:

```markdown
# <Imperative outcome>

## Goal
<The observable result in one short paragraph.>

## Scope
- <Target and essential context>

## Done when
- <Observable result>
- <Validation evidence>
- <Clear stopping condition>

## Boundaries
- <Only material limits or out-of-scope effects>

## References
- <Canonical plan, issue, design, analysis, or source>
```

For a small task, collapse this into a short paragraph and bullets rather than forcing every heading.

## Review before filing

Confirm that:

- the requested action is unmistakable;
- a reader can identify the outcome, scope, and definition of done in under a minute;
- every acceptance criterion is observable;
- detailed material is linked once instead of pasted;
- authorization boundaries are precise and proportionate;
- every remaining sentence changes execution or verification.

If the task fails this review, rewrite it before creating or delegating it.

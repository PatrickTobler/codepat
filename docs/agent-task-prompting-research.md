# Research: writing effective tasks for coding agents

Research date: 2026-09-24

## Conclusion

A good coordinator task is a compact execution contract, not a transcript or a complete design document. It should state the outcome, supply only non-discoverable context, define verifiable completion criteria, identify material authority boundaries, and link to deeper specifications. There is broad first-party agreement on clarity, scope, relevant context, explicit validation, and structured separation of instructions from reference material. There is no primary-source basis for a universal character limit.

## Broadly supported principles

1. **Lead with one clear, actionable outcome.** Google recommends stating the goal clearly and concisely, defining ambiguous parameters, and avoiding unnecessary persuasive language. GitHub says coding-agent tasks should clearly describe the problem or required work. Anthropic similarly recommends explicit instructions that a minimally informed colleague could follow. ([Google](https://ai.google.dev/gemini-api/docs/prompting-strategies), [GitHub](https://docs.github.com/en/copilot/tutorials/cloud-agent/get-the-best-results), [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices))

2. **Make “done” observable.** GitHub explicitly recommends complete acceptance criteria, including whether tests are required. Anthropic advises giving the coding agent a check it can run—such as tests, a build, a linter, or a screenshot—so it can close its own verification loop. OpenAI also recommends requiring testing and validation for coding work. ([GitHub](https://docs.github.com/en/copilot/tutorials/cloud-agent/get-the-best-results), [Anthropic](https://code.claude.com/docs/en/best-practices), [OpenAI](https://developers.openai.com/api/docs/guides/prompt-engineering))

3. **Include relevant context, not all available context.** OpenAI recommends providing context that is relevant to the result or constrains the model to useful resources. Anthropic recommends specific files, constraints, and existing patterns, while explicitly excluding information the agent can discover, long tutorials, and detailed API documentation that can be linked instead. Google also treats prompt design as an iterative exercise in supplying the context needed to understand the task. ([OpenAI](https://developers.openai.com/api/docs/guides/prompt-engineering), [Anthropic](https://code.claude.com/docs/en/best-practices), [Google](https://ai.google.dev/gemini-api/docs/prompting-strategies))

4. **Separate task, context, constraints, and expected output.** OpenAI and Google both recommend Markdown headings or XML tags to make logical boundaries and hierarchy clear. This does not require elaborate formatting; a few stable headings are sufficient for coordinator tasks. ([OpenAI](https://developers.openai.com/api/docs/guides/prompt-engineering), [Google](https://ai.google.dev/gemini-api/docs/prompting-strategies))

5. **Scope the work and point to likely locations without over-prescribing the solution.** GitHub recommends directions about relevant files, but notes that a coding agent can often discover exact paths itself. Anthropic recommends naming the file, scenario, constraints, and testing preference, and pointing to an existing pattern when useful. ([GitHub](https://docs.github.com/en/copilot/tutorials/cloud-agent/get-the-best-results), [Anthropic](https://code.claude.com/docs/en/best-practices))

6. **Keep persistent conventions outside individual tasks.** GitHub treats `AGENTS.md` and repository custom instructions as the place for build commands, coding standards, repository structure, and conventions that apply across tasks. OpenAI similarly distinguishes higher-authority application rules from task-specific user input. Repeating those rules in each task wastes context and makes the actual objective harder to find. ([GitHub](https://docs.github.com/en/copilot/tutorials/cloud-agent/get-the-best-results), [OpenAI](https://developers.openai.com/api/docs/guides/prompt-engineering))

7. **Put large specifications in a referenced artifact.** Anthropic recommends a self-contained implementation spec that names files and interfaces, states what is out of scope, and ends with end-to-end verification; a fresh implementation session can then work from that artifact. It also warns that long, irrelevant context degrades performance and that over-specified instruction files hide important rules in noise. This supports a short task that links to a plan rather than reproducing it. ([Anthropic](https://code.claude.com/docs/en/best-practices))

8. **State authority boundaries precisely and proportionately.** Material exclusions—production deployment, financial actions, destructive operations, external communication—belong in the task when relevant. Generic safety prose and long lists of impossible edge cases do not. OpenAI recommends layered guardrails and human review for high-risk actions rather than relying on instructions alone. ([OpenAI](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/))

9. **Evaluate task templates with real cases.** OpenAI recommends keeping production prompts in code and adding representative fixtures, tests, and evaluation checks before changing them. Google describes prompt engineering as iterative and recommends refining prompts based on observed results. ([OpenAI](https://developers.openai.com/api/docs/guides/prompt-engineering), [Google](https://ai.google.dev/gemini-api/docs/prompting-strategies))

Long-context research gives a supporting reason for relevance and prominence: models can use information less reliably when it is buried in the middle of a long context. The result argues against duplicated or indiscriminate context, but it does **not** establish a universal task-length threshold. ([Liu et al., *Lost in the Middle*](https://arxiv.org/abs/2307.03172))

## Provider-specific advice

- Anthropic recommends positive directives, matching the prompt's style to the desired output, and, for some complex prompts, XML tags. Those are useful techniques, not requirements for every task.
- Google currently recommends putting critical behavioral constraints near the beginning while placing the specific query after a large context block. That ordering is Gemini-specific; portable tasks should prioritize a consistent, scannable structure.
- OpenAI distinguishes durable developer instructions from task-specific user input and recommends prompt tests and evaluations. The exact message-role mechanism is OpenAI-specific, while the separation of stable policy from per-task intent generalizes.
- GitHub's request for likely file paths is tailored to repository tasks. Other agents may need analogous targets such as a service, document, account, or dataset.

## Recommended coordinator task contract

Use this as a house style, derived from the sources above:

```markdown
# <Imperative outcome>

## Goal
<One short paragraph describing the observable result and why it matters.>

## Scope
- Workspace/repository and relevant components
- Essential facts the agent cannot reliably discover

## Acceptance criteria
- <Three to seven observable, testable outcomes>
- <Required validation command or evidence>
- <Clear stopping condition>

## Boundaries
- <Only material authorization limits and out-of-scope actions>

## References
- <Plan, analysis, issue, design, or source paths/links>
```

Omit internal coordinator protocol, duplicated plan prose, secrets, generic conventions already present in repository instructions, speculative implementation micromanagement, and narrative history that does not change execution.

A practical house target is one screen—roughly 150–350 words—for the visible task. This is a usability convention, not a research-backed universal limit. Complex work may need a longer linked specification, but the task itself should remain scannable.

## Preflight check

- Is the requested action unmistakable, including whether the agent should implement or merely advise?
- Can a reader identify the outcome, scope, and definition of done in under a minute?
- Is every acceptance criterion observable or verifiable?
- Are critical authorization limits prominent and exact?
- Is detailed material linked once rather than copied?
- Does every sentence change the agent's decisions or ability to verify the result?

---
name: readability
description: Enforce code readability, consistency, and coherent conventions for general software work. Use when Codex is planning, writing, reviewing, or refactoring code and must keep the implementation on the golden path between terse cleverness and noisy over-engineering, align naming and structure with the rest of the codebase, minimize inline hardcoded values, and work together with $reuse so shared solutions stay elegant and easy to follow.
---

# Readability

Write code that humans can scan, trust, and modify without re-parsing the whole file. Keep the structure obvious, the naming stable, the branching explicit, and the conventions coherent across the repo.

Always use this skill together with `$reuse` for implementation work:

1. Ask `$reuse` where the behavior should live.
2. Ask `readability` how that shared path and its callers should be written.
3. Re-check `$reuse` if a readability improvement introduces duplication.
4. Re-check `readability` if a reuse improvement introduces indirection, flags, or awkward naming.

## Default Stance

- Prefer obvious control flow over compact cleverness.
- Prefer names that explain intent over short names that need surrounding context.
- Prefer one local level of abstraction at a time.
- Prefer consistency with nearby code over inventing a new style.
- Prefer deleting noise over adding explanatory scaffolding.
- Prefer explicit constants, config, and injected text over scattered magic values.
- Treat hardcoded business values, labels, and repeated literals as a design smell unless extraction would clearly make the code worse.

## Readability Workflow

Before writing or approving code:

1. Load `$reuse` and decide the shared owner of the behavior.
2. Identify the dominant convention already used in the surrounding module or layer.
3. Write the happy path so it can be understood top-to-bottom without jumping around.
4. Move distracting details into well-named helpers only if that makes the main path easier to read.
5. Extract meaningful literals into constants, config, or injected inputs unless the inline form is clearly more readable.
6. Normalize names, branching style, error shape, and file structure to match nearby patterns.
7. Re-check whether the result still feels like one coherent system rather than a local style island.

## Hardcoded Values Rule

Default to extracting values out of inline code.

Prefer these sources, in this order, when they fit the problem:

1. Existing shared constants or enums.
2. Local named constants in the owning module.
3. Config files or environment-backed config.
4. Database-backed or CMS-backed content for user-facing text that should not live in code.
5. Parameters, dependency injection, or caller-provided values for contextual variation.

Keep literals inline only when the extraction would be more artificial than helpful. Common acceptable inline cases:

- `0`, `1`, `-1`, `true`, `false`, `null`
- trivial punctuation or syntax glue
- very local string values whose meaning is fully obvious at the point of use

Do not scatter:

- business limits
- role names
- status strings
- feature keys
- repeated labels
- provider identifiers
- error messages used in more than one place
- user-facing copy that is likely to change

When keeping a meaningful literal inline, say why readability is better that way.

## Conventions Rule

Make similar problems look similarly solved.

Align with the existing codebase on:

- naming shape
- function size
- branching style
- error handling style
- logging style
- data mapping style
- file layout
- test structure

If the local area is inconsistent, choose the clearest existing pattern with the widest reuse potential, then normalize toward it instead of adding a third style.

## Structure Rule

- Keep call sites thin and intention-revealing.
- Keep helpers focused and named by purpose, not mechanism.
- Avoid helpers that only save two lines but hide the story.
- Avoid long functions that mix parsing, validation, branching, formatting, persistence, and side effects.
- Avoid abstractions that force readers to chase simple behavior across multiple files.
- Allow a thin wrapper when it improves API clarity or preserves a readable narrative around a shared implementation.

## When Extraction Or Abstraction Hurts Readability

Do not extract by reflex.

Reject the extraction if it causes:

- indirection without reuse
- constants that are farther away than the code they clarify
- helper names that say less than the inline code
- parameter lists full of booleans or toggles
- configuration plumbing that obscures a fixed local rule

When you choose the inline or local form, state the specific readability reason.

## Review Checklist

Before finalizing:

- Does the main path read clearly from top to bottom?
- Does the code follow the same conventions as the surrounding system?
- Did `$reuse` confirm the behavior lives in the right shared place?
- Did I remove or avoid meaningful hardcoded values?
- Are extracted constants and config values named clearly and stored in the right owner?
- Did any helper, abstraction, or wrapper make the code harder to follow?
- If I kept a literal or local branch inline, can I defend why that is more readable?

## Response Expectations

When this skill is active, state the readability decision briefly before implementation:

- Which existing conventions you are following.
- Which literals or texts you extracted and where they now live.
- Which literals remained inline and why.
- How the structure balances readability with `$reuse`.

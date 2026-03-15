---
name: reuse
description: Enforce a reuse-first implementation strategy for general software work. Use when Codex is planning or writing code, refactoring, fixing bugs, adding features, designing APIs, helpers, utilities, components, hooks, services, or data transformations and should first decide the most reusable, universal place to implement the behavior with the least duplication, exposing narrow parameters instead of rewriting similar logic at each call site.
---

# Reuse

Think before implementing. First decide where the behavior should live so the codebase gets one reusable path instead of multiple local copies.

Default stance:

- Prefer one shared implementation over repeated caller-specific implementations.
- Prefer extending an existing shared primitive over creating a new near-duplicate.
- Prefer parameterization or composition over copy-paste variation.
- Prefer placing logic at the lowest sensible common layer that all callers can use.
- Treat duplicated code as a design failure unless there is a concrete reason it cannot be shared.

## Reuse-First Workflow

Before writing code:

1. Identify the exact behavior being added or changed.
2. Search for existing helpers, utilities, services, components, hooks, adapters, or shared modules that already own similar behavior.
3. Decide the narrowest shared location that can own the logic for all current and likely-near-future callers.
4. Implement the behavior once in that shared location.
5. Let callers pass arguments, configuration, or callbacks only when variation is genuinely required.
6. Keep call sites thin. A caller should orchestrate inputs and outputs, not reimplement the core behavior.

## Placement Rules

- If a shared module already exists for the concern, extend it there.
- If multiple features need the same logic, move that logic below the feature layer.
- If a utility can serve many callers with one or two arguments, write the utility and pass arguments.
- If the only difference between callers is naming, formatting, small conditionals, or mapping, do not duplicate the function. Generalize the shared path.
- If a new abstraction would only be used once and clearly has no realistic second caller, keep it local but still check whether an adjacent shared primitive should absorb part of the behavior.

## Strong Defaults

Unless absolutely and extremely impossible:

- Do not rewrite the same functionality in each user function.
- Do not clone an existing function just to tweak one branch.
- Do not introduce parallel helpers that drift apart over time.
- Do not hide duplication behind slightly different names.

Instead:

- Put the main behavior in one place.
- Add arguments for the small variations.
- Add a thin wrapper only when it materially improves readability or API clarity.
- Keep the wrapper delegating to the shared implementation.

## When Duplication Is Acceptable

Allow duplication only when the shared abstraction would be materially worse than the duplication. Examples:

- Different runtime boundaries make sharing unsafe or misleading.
- Different domains only look similar superficially but have meaningfully different invariants.
- The shared abstraction would need so many flags or branches that it becomes harder to understand than two clear paths.

When taking this exception, say so explicitly and name the constraint that blocked reuse.

## Review Checklist

Before finalizing:

- Is there now exactly one obvious place for this behavior?
- Did I reuse or extend an existing shared path instead of adding a sibling?
- Can call sites stay thin and declarative?
- Did I eliminate or avoid duplicated branches?
- If I kept logic local, can I defend why a shared abstraction would be worse?

## Response Expectations

When this skill is active, state the reuse decision briefly before implementation:

- What shared location you chose.
- Whether you extended an existing abstraction or created a new shared one.
- What parameters or customization points callers use.
- If reuse was not possible, the exact reason.

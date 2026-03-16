---
name: reuse
description: Enforce a reuse-first implementation strategy for general software work. Use when Codex is planning or writing code, refactoring, fixing bugs, adding features, designing APIs, helpers, utilities, components, hooks, services, or data transformations and should first decide the most reusable, universal place to implement the behavior with the least duplication, exposing narrow parameters instead of rewriting similar logic at each call site, while working together with $readability so shared solutions remain clear, coherent, and light on inline hardcoded values.
---

# Reuse

Think before implementing. First decide where the behavior should live so the codebase gets one reusable path instead of multiple local copies.

Always pair this skill with `$readability` for implementation work:

1. Use `$reuse` to choose the shared owner.
2. Use `$readability` to keep the shared path simple, readable, and convention-aligned.
3. Revisit the reuse decision if readability exposes over-abstraction.
4. Revisit the readability decision if reuse exposes duplication or scattered literals.

Default stance:

- Prefer one shared implementation over repeated caller-specific implementations.
- Prefer extending an existing shared primitive over creating a new near-duplicate.
- Prefer parameterization or composition over copy-paste variation.
- Prefer placing logic at the lowest sensible common layer that all callers can use.
- Treat duplicated code as a design failure unless there is a concrete reason it cannot be shared.
- Prefer one named source of truth for meaningful values over repeated inline literals.

## Reuse-First Workflow

Before writing code:

1. Identify the exact behavior being added or changed.
2. Search for existing helpers, utilities, services, components, hooks, adapters, or shared modules that already own similar behavior.
3. Decide the narrowest shared location that can own the logic for all current and likely-near-future callers.
4. Implement the behavior once in that shared location.
5. Move meaningful repeated or configurable literals into constants, config, or injected inputs owned by that shared path whenever that improves clarity.
6. Let callers pass arguments, configuration, or callbacks only when variation is genuinely required.
7. Ask `$readability` whether the abstraction is still easier to understand than the duplicated local code.
8. Keep call sites thin. A caller should orchestrate inputs and outputs, not reimplement the core behavior.

## Placement Rules

- If a shared module already exists for the concern, extend it there.
- If multiple features need the same logic, move that logic below the feature layer.
- If a utility can serve many callers with one or two arguments, write the utility and pass arguments.
- If the only difference between callers is naming, formatting, small conditionals, or mapping, do not duplicate the function. Generalize the shared path.
- If multiple callers reuse the same business string, status, key, label, or numeric threshold, give it one named owner instead of repeating inline literals.
- If a new abstraction would only be used once and clearly has no realistic second caller, keep it local but still check whether an adjacent shared primitive should absorb part of the behavior.

## Strong Defaults

Unless absolutely and extremely impossible:

- Do not rewrite the same functionality in each user function.
- Do not clone an existing function just to tweak one branch.
- Do not introduce parallel helpers that drift apart over time.
- Do not hide duplication behind slightly different names.
- Do not repeat meaningful literals inline across modules when one constant, config value, or injected source would serve them all.

Instead:

- Put the main behavior in one place.
- Add arguments for the small variations.
- Centralize meaningful constants and configurable text near the owning behavior or in the proper config source.
- Add a thin wrapper only when it materially improves readability or API clarity.
- Keep the wrapper delegating to the shared implementation.

## When Duplication Is Acceptable

Allow duplication only when the shared abstraction would be materially worse than the duplication. Examples:

- Different runtime boundaries make sharing unsafe or misleading.
- Different domains only look similar superficially but have meaningfully different invariants.
- The shared abstraction would need so many flags or branches that it becomes harder to understand than two clear paths.
- Extracting a literal or configuration point would make the code less readable than keeping a truly local obvious value inline.

When taking this exception, say so explicitly and name the constraint that blocked reuse.

## Review Checklist

Before finalizing:

- Is there now exactly one obvious place for this behavior?
- Did I reuse or extend an existing shared path instead of adding a sibling?
- Did I centralize meaningful repeated literals instead of leaving them scattered inline?
- Can call sites stay thin and declarative?
- Did I eliminate or avoid duplicated branches?
- If I kept logic or literals local, can I defend why a shared abstraction or extraction would be worse?

## Response Expectations

When this skill is active, state the reuse decision briefly before implementation:

- What shared location you chose.
- Whether you extended an existing abstraction or created a new shared one.
- What parameters, constants, config, or customization points callers use.
- How `$readability` affected the abstraction shape.
- If reuse was not possible, the exact reason.

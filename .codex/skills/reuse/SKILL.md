---
name: reuse
description: Enforce a reuse-first implementation strategy for general software work. Use when Codex is planning or writing code, refactoring, fixing bugs, adding features, designing APIs, helpers, utilities, components, hooks, services, or data transformations and should first decide the most reusable, universal place to implement the behavior with the least duplication, exposing narrow parameters instead of rewriting similar logic at each call site, while working together with $readability so shared solutions remain clear, coherent, and light on inline hardcoded values.
---

# Reuse

Think before implementing. First decide where the behavior should live so the codebase gets one reusable path instead of multiple local copies.

Reuse applies to whole workflows, not just helper functions. A codebase can look "shared" while still duplicating the real owner across multiple execution paths, state machines, polling loops, persistence steps, or lifecycle handlers. Treat that as reuse failure, not success.

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
- Prefer one lifecycle engine over multiple path-specific orchestration flows when the same process is being executed.
- Prefer one state machine owner over multiple partial owners that each update part of the same workflow.
- Treat "shared helpers inside duplicated workflows" as a design failure.

## Reuse-First Workflow

Before writing code:

1. Identify the exact behavior being added or changed.
2. Identify whether the behavior is really a larger workflow, lifecycle, or state machine rather than a single helper-sized concern.
3. Search for existing helpers, utilities, services, components, hooks, adapters, execution engines, polling loops, or shared modules that already own similar behavior.
4. Decide the narrowest shared location that can own the full logic for all current and likely-near-future callers.
5. If similar callers still have separate orchestration, sequencing, retries, persistence, or finalization, treat that as a sign the current owner is too high-level or incomplete.
6. Implement the behavior once in that shared location.
7. Move meaningful repeated or configurable literals into constants, config, or injected inputs owned by that shared path whenever that improves clarity.
8. Let callers pass arguments, configuration, or callbacks only when variation is genuinely required.
9. Ask `$readability` whether the abstraction is still easier to understand than the duplicated local code.
10. Keep call sites thin. A caller should orchestrate inputs and outputs, not reimplement the core behavior.

## Workflow Ownership Rule

If multiple code paths perform the same multi-step process, they must share one workflow owner.

Examples of one process:

- create row, execute external call, persist result, finalize status
- create event, create children, run attempts, retry, mark final outcome
- start async job, poll status, stop on terminal result or timeout
- validate permissions, evaluate branch, log decision, emit error envelope
- create payment artifact, send email, reconcile webhook, finalize record

For these, reuse is not satisfied by sharing one or two helpers. Reuse is only satisfied when the sequencing itself has one owner.

If two paths differ only by trigger source, transport, caller type, or timing, they still count as the same workflow and should use the same engine.

## Masquerade Detection

Be explicitly suspicious of fake reuse. The following are masquerades and must be called out:

- Two callers share helper functions but still each implement their own sequencing.
- Realtime and cron paths execute the same lifecycle with different orderings.
- Backend and frontend each reimplement the same polling rules, timeout rules, or result interpretation.
- A "shared service" exists, but separate handlers still decide retries, persistence, logging, or completion themselves.
- Similar status transitions are spread across multiple files instead of one state owner.
- Multiple modules each perform a subset of the same persistence lifecycle.
- There are parallel "shared" abstractions for near-identical concerns that drift by branch logic rather than true domain differences.

When you detect a masquerade:

1. Name the real duplicated workflow.
2. Name the fragments currently pretending to own it.
3. Choose the lowest sensible shared owner for the whole workflow.
4. Move sequencing, retries, logging, persistence, and finalization there.
5. Leave callers as thin trigger adapters only.

## Placement Rules

- If a shared module already exists for the concern, extend it there.
- If multiple features need the same logic, move that logic below the feature layer.
- If multiple triggers execute the same lifecycle, move that lifecycle below the trigger layer.
- If multiple runtimes use the same state progression, create one shared state owner and make each runtime call it.
- If a utility can serve many callers with one or two arguments, write the utility and pass arguments.
- If the only difference between callers is naming, formatting, small conditionals, or mapping, do not duplicate the function. Generalize the shared path.
- If multiple callers reuse the same business string, status, key, label, or numeric threshold, give it one named owner instead of repeating inline literals.
- If a new abstraction would only be used once and clearly has no realistic second caller, keep it local but still check whether an adjacent shared primitive should absorb part of the behavior.
- If the process includes attempts, retries, statuses, persistence, and finalization, prefer a shared engine over scattered helper calls.
- If a module only owns one stage of a workflow while callers own the rest, consider lowering the owner to a workflow primitive rather than extending the partial module.

## Strong Defaults

Unless absolutely and extremely impossible:

- Do not rewrite the same functionality in each user function.
- Do not clone an existing function just to tweak one branch.
- Do not introduce parallel helpers that drift apart over time.
- Do not hide duplication behind slightly different names.
- Do not repeat meaningful literals inline across modules when one constant, config value, or injected source would serve them all.
- Do not maintain multiple sequencing implementations for the same process.
- Do not split one state machine across multiple handlers, jobs, hooks, or UI screens if one owner can exist.
- Do not accept "shared business logic" as sufficient when persistence, retries, logging, or completion are still duplicated.
- Do not let transport differences justify separate orchestration when the domain workflow is the same.

Instead:

- Put the main behavior in one place.
- Add arguments for the small variations.
- Centralize meaningful constants and configurable text near the owning behavior or in the proper config source.
- Add a thin wrapper only when it materially improves readability or API clarity.
- Keep the wrapper delegating to the shared implementation.
- Centralize the full lifecycle when the concern is a lifecycle.
- Centralize result interpretation and polling rules when multiple callers wait on the same backend process.

## When Duplication Is Acceptable

Allow duplication only when the shared abstraction would be materially worse than the duplication. Examples:

- Different runtime boundaries make sharing unsafe or misleading.
- Different domains only look similar superficially but have meaningfully different invariants.
- The shared abstraction would need so many flags or branches that it becomes harder to understand than two clear paths.
- Extracting a literal or configuration point would make the code less readable than keeping a truly local obvious value inline.
- The workflows appear similar but actually have different correctness models, retry semantics, or terminal states.
- Separate orchestration is required because one path is intentionally lossy, fire-and-forget, or externally constrained in a way the other path is not.

When taking this exception, say so explicitly and name the constraint that blocked reuse.

## Review Checklist

Before finalizing:

- Is there now exactly one obvious place for this behavior?
- Is there exactly one obvious owner for the full workflow, not just a helper inside it?
- Did I reuse or extend an existing shared path instead of adding a sibling?
- Did I accidentally preserve duplicate sequencing while only sharing helper functions?
- Did I centralize meaningful repeated literals instead of leaving them scattered inline?
- Can call sites stay thin and declarative?
- Did I eliminate or avoid duplicated branches?
- Did I eliminate or avoid duplicated retries, status transitions, persistence, logging, and finalization logic?
- If multiple triggers or runtimes touch the same process, do they now call the same engine?
- If I kept logic or literals local, can I defend why a shared abstraction or extraction would be worse?

## Response Expectations

When this skill is active, state the reuse decision briefly before implementation:

- What shared location you chose.
- Whether you extended an existing abstraction or created a new shared one.
- Whether the real owner is a helper, a state machine, a workflow engine, or a polling primitive.
- What parameters, constants, config, or customization points callers use.
- How `$readability` affected the abstraction shape.
- Whether you found any reuse masquerade and how you collapsed it.
- If reuse was not possible, the exact reason.

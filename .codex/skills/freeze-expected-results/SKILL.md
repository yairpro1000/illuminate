---
name: freeze-expected-results
description: Analyze a codebase and freeze production user-facing end-to-end scenarios into a dated markdown document, with iterative refinement, grouping, critique, and contradiction checking before future product changes. Use when Codex must extract current expected user outcomes from the full project or from a specified domain/component, document them precisely, and pause future implementation work until freeze contradictions or additions are reviewed with the user.
---

# Freeze Expected Results

Produce a durable snapshot of the product's expected production behavior from the user's point of view. Focus on end-to-end outcomes, not implementation details, except for behind-the-scenes assets that must exist for a scenario to succeed.

## Required Behavior

1. Check for the canonical documentation location before any codebase scan.
2. Scan the relevant codebase scope.
3. Extract only production user-facing E2E scenarios and their expected results.
4. Refine and regroup the scenarios through scored iterations.
5. Write the final freeze document to the approved documentation folder.
6. On later change requests, inspect the latest freeze document first and stop for user confirmation before implementing.

## Step 0: Confirm Documentation Location First

Before scanning the codebase, inspect the repository for likely documentation locations, including:

- `documentation/`
- `docs/`
- `doc/`
- any folder that appears dedicated to Markdown, specs, references, or project notes

Report the candidate folder or folders to the user immediately. Wait for confirmation.

After the user replies:

- Remember the approved existing folder, or
- Create the approved new folder name, defaulting to `documentation/` only if the user explicitly approves that name, or
- Use another folder name the user specifies

Once the folder is confirmed, start the scan immediately without asking another planning question.

## Scope Rules

Default to the full codebase. Narrow the scan only when the user explicitly scopes the task to a domain, flow, or component.

Use production-user perspective only:

- keep admin or operator internals out unless they are themselves part of the production product
- keep implementation details out unless they directly affect the user's observable outcome
- include hidden dependencies only when their presence or connection is necessary for the scenario to succeed

## Scenario Extraction Standard

For each scenario, reduce it to its essence. Avoid ambiguity about start state or end state.

Use this structure:

```md
### Scenario: <one-sentence title>

Given: <one sentence describing the exact user-visible starting point>

Expected: <one sentence describing the exact user-visible end state>

Visible steps:
- <only include if the user is exposed to explicit intermediate steps>

Clarification:
<2-3 short sentences only if needed to remove ambiguity>

Artifacts:
- <artifact/object/element/item the user must have, or that must be updated/deleted/connected>

Behind-the-scenes dependencies:
- <only if required for success and not directly user-facing>
```

Rules:

- Title must be one sentence.
- `Given` must be one sentence.
- `Expected` must be one sentence.
- `Clarification` is optional and only for ambiguity reduction.
- `Artifacts` must contain at least one concrete item.
- State updates must be explicit, for example created, connected, updated to a named state, removed, or replaced.
- If there are user-visible steps between start and end, list them concisely.

## What Counts as a Scenario

Include:

- a meaningful user journey with a clear start and finish
- a user-triggered flow that results in a changed state, visible confirmation, access grant, submission, booking, payment, message, generated object, or updated relationship
- a negative path only when it is part of the expected production experience

Exclude:

- unit-level or purely technical behavior
- internal helper functions
- low-level implementation branches with no user-visible effect
- speculative features not supported by the current codebase

## Iterative Workflow

Perform the work in iterations.

### Step 1: First Scan And Draft

Inspect the approved scope and draft an initial set of candidate scenarios from the production user perspective. Prefer breadth first, then precision.

### Step 2: List Of Scenarios

List the current scenario set in short form so coverage gaps and overlap are visible.

### Step 3: Refine Each Scenario

Rewrite every scenario into the required structure until the starting point, visible path, end state, and artifact list are concrete.

### Step 4: Group By Domain

Group scenarios by product domain or business area.

### Step 5: Group By Flows

Group scenarios by cross-domain user flows when that reveals dependencies or ordering.

### Step 6: Group By Components If Applicable

Group by components only when the product structure makes this useful. Skip forced component groupings.

### Step 7: Critique And Score

Critique the current output dryly and precisely. Score it from `1-100`.

Judge at least these dimensions:

- coverage of real production user journeys
- clarity of starting and end states
- precision of expected outcomes
- usefulness of artifact lists
- separation of user-facing outcomes from technical internals
- duplication or overlap
- grouping quality
- actionability for future contradiction checks

### Step 8: Self-Report Corrective Actions

Write a short internal report that states:

- what is weak
- what will be corrected next
- whether the next pass should merge, split, drop, or rewrite scenarios

### Step 9: Repeat

Repeat Steps `2-8` until either:

- score is greater than `95`, or
- iteration `4` is complete

Aim for `2-3` iterations when possible.

If iteration `4` still scores below `95`, alert the user immediately and state exactly where the difficulty remains.

## Final Document

Write the output to the approved documentation folder using this file name:

`expected_user_scenarios_freeze_<YYYY-MM-DD>.md`

Use the current local date for the file name.

Recommended document structure:

```md
# Expected User Scenarios Freeze - <YYYY-MM-DD>

## Scope

## Documentation Location

## Iteration Summary

## Scenario List

## Scenarios By Domain

## Scenarios By Flow

## Scenarios By Component

## Behind-the-Scenes Dependencies

## Final Critique And Score

## Follow-up Notes
```

## Future Change Requests

For any later request to refactor, remove, revert, fix a bug, or add new code:

1. Read the latest freeze document first.
2. Compare the requested change against the frozen expectations.
3. Report whether the request:
   - contradicts an existing frozen expectation
   - adds a new expectation
   - changes the scope or outcome of an existing scenario
   - has no freeze impact
4. Present that report to the user before implementation.
5. Ask for confirmation and wait.
6. Do not implement until the user confirms how to proceed.

If the freeze document is missing, stale, or obviously incomplete, say so explicitly before continuing.

## Output Expectations

When using this skill, report:

- which documentation folder candidates were found
- which folder the user confirmed
- whether a folder was created
- the scope scanned
- the current iteration count and score
- whether the final freeze document was written
- the exact path of the freeze document

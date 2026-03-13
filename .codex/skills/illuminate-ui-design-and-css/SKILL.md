---
name: illuminate-ui-design-and-css
description: Apply the Illuminate design system and CSS conventions to new or existing pages, components, and websites. Use when Codex must design, restyle, or extend public-facing marketing or booking pages, or internal admin and backoffice screens, so they match the project's Illuminate visual language, variant rules, color tokens, typography, layout patterns, and interaction behavior.
---

# Illuminate UI Design And CSS

Apply the Illuminate visual system to the target UI without drifting into generic defaults or inventing a second design language.

## Workflow

1. Determine the correct variant before writing code.
2. Inspect the task description, route names, file paths, surrounding components, and intended audience.
3. Classify the work as either Full Illuminate UI for public-facing surfaces or Lean Admin UI for internal operational surfaces.
4. Before editing any file, send a short confirmation message naming the chosen variant, the target file or feature, and the concrete reason for the choice. Wait for explicit confirmation unless the user has already confirmed the variant in the current turn.
5. Read only the relevant sections in [references/design-system.md](./references/design-system.md).
6. Adapt the design system to the existing framework and code style in the repo. Preserve architecture and component structure when possible.

## Implementation Rules

- Define reusable CSS custom properties before adding component styling.
- Keep colors in OKLCH tokens and avoid hardcoded design values in component rules.
- Prefer BEM-style naming for new CSS blocks, elements, and modifiers.
- Use explicit transitions only where the chosen variant allows them.
- Keep the dark-default Illuminate tone unless the current product area already establishes another approved pattern.
- Preserve responsive behavior and ensure the result works on desktop and mobile.
- Treat the admin variant as a functional simplification of the same brand system, not a separate product aesthetic.

## Existing Codebase Rule

- If the target area already follows an established project design system, preserve it unless the user is explicitly migrating that area to Illuminate.
- If the existing markup or component structure conflicts with the reference examples, keep the structure that best fits the codebase and transfer the Illuminate tokens, spacing, typography, and interaction principles onto it.
- Avoid introducing Tailwind utility sprawl into CSS-file work. Keep design rules in CSS variables and named classes.

## Deliverable Expectations

- State which variant was used.
- Name any deliberate deviations from the reference and why they were necessary.
- Verify the result against the relevant checklist in [references/design-system.md](./references/design-system.md).

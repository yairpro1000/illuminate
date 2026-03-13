# Illuminate Design System Reference

Use this file only after the skill triggers. Read the variant-selection section first, then load only the relevant variant section.

## Table Of Contents

- Variant selection
- Full Illuminate UI
- Lean Admin UI

## Variant Selection

Choose the variant from the task context before writing code.

Signals for `Lean Admin UI`:

- path contains `/admin`, `/dashboard`, `/backoffice`, `/internal`, `/ops`, or `/manage`
- page lists records, tables, CRUD forms, filters, statuses, or operational controls
- page is for staff, operators, or authenticated internal users only

Signals for `Full Illuminate UI`:

- page is a landing page, marketing page, booking flow, or public-facing feature
- task mentions "website", "site", "user-facing", "public", or "customer"

Before editing any file, send a short confirmation in this format:

```text
I'm about to apply the [Full Illuminate UI / Lean Admin UI] to [file or feature name].
[One sentence explaining why you chose that variant based on the signals above.]
Shall I proceed?
```

Wait for explicit confirmation unless the user already confirmed the variant in the current turn.

## Full Illuminate UI

Use this for public-facing and experiential surfaces. Keep the dark-default, teal-accent, glass-card aesthetic.

### Core Tokens

Define these CSS custom properties in `:root` and use them throughout:

```css
:root {
  --color-bg: oklch(11% 0.022 210);
  --color-bg-alt: oklch(14% 0.025 208);
  --color-bg-card: oklch(17% 0.030 207);

  --color-lake-deep: oklch(44% 0.155 204);
  --color-lake: oklch(59% 0.160 200);
  --color-lake-lt: oklch(73% 0.130 195);
  --color-lake-mist: oklch(59% 0.160 200 / 0.14);
  --color-lake-glow: oklch(59% 0.160 200 / 0.35);

  --color-stone: oklch(78% 0.030 75);
  --color-stone-muted: oklch(58% 0.025 78);

  --color-text: oklch(91% 0.015 200);
  --color-text-muted: oklch(65% 0.020 207);
  --color-text-subtle: oklch(48% 0.018 210);

  --color-border: oklch(59% 0.160 200 / 0.18);
  --color-border-hover: oklch(59% 0.160 200 / 0.42);

  --section-py: clamp(5rem, 10vw, 8rem);
  --container: min(64rem, 100% - 3rem);

  --radius-sm: 0.375rem;
  --radius-md: 0.75rem;
  --radius-lg: 1.25rem;
  --radius-xl: 1.75rem;

  --ease: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1);

  --shadow-glow: 0 0 25px var(--color-lake-glow);
  --shadow-card: 0 8px 32px oklch(0% 0 0 / 0.4);
}
```

For light mode, override colors in `body.theme-light {}` and persist the choice in `localStorage` under `yb-theme`.

### Typography

- Load Google Fonts with `display=swap`.
- Preconnect to `fonts.googleapis.com` and `fonts.gstatic.com`.
- Use `Inter` for body and UI.
- Use `Nunito` at `800` for hero display text only.
- Use `Poppins` for special headers.

Use these type scales:

- hero display: `clamp(2.6rem, 6vw, 5rem)`
- section h2: `clamp(2rem, 4.5vw, 3.5rem)`
- subsection h3: `clamp(1.5rem, 3vw, 2.25rem)`
- h4: `clamp(1.125rem, 2vw, 1.375rem)`
- feature body: `clamp(1.0625rem, 1.5vw, 1.1875rem)`
- body: `1rem`
- labels: `0.75rem`, uppercase, `letter-spacing: 0.12em`

Keep heading line-height around `1.1` to `1.3`. Keep body line-height around `1.6` to `1.8`.

### Layout

```css
.container {
  width: var(--container);
  margin-inline: auto;
}

.section {
  padding-block: var(--section-py);
}
```

- Use CSS Grid for multi-column layouts.
- Use Flexbox for nav, button groups, and inline alignment.
- Use `48rem` as the main responsive breakpoint.

### Components

Buttons:

```css
.btn-primary {
  background: linear-gradient(135deg, var(--color-lake-deep), var(--color-lake));
  color: var(--color-text);
  border-radius: var(--radius-md);
  padding: 0.75rem 1.75rem;
  font-weight: 600;
  box-shadow: var(--shadow-glow);
  transition: transform 0.3s var(--ease), box-shadow 0.3s var(--ease);
}

.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 0 35px var(--color-lake-glow);
}

.btn-secondary {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-lake-lt);
  border-radius: var(--radius-md);
  padding: 0.75rem 1.75rem;
  transition: background 0.2s, border-color 0.2s;
}

.btn-secondary:hover {
  background: var(--color-lake-mist);
  border-color: var(--color-border-hover);
}
```

Glass cards:

```css
.glass-card {
  background: var(--color-bg-card);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 2rem;
  box-shadow: var(--shadow-card);
  transition: border-color 0.3s, box-shadow 0.3s;
}

.glass-card:hover {
  border-color: var(--color-border-hover);
  box-shadow: var(--shadow-glow), var(--shadow-card);
}
```

Inputs:

```css
.form-input {
  background: var(--color-bg-alt);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  padding: 0.75rem 1rem;
  width: 100%;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.form-input:focus {
  outline: none;
  border-color: var(--color-lake);
  box-shadow: 0 0 0 3px var(--color-lake-mist);
}
```

### Scroll Reveal

Add this when the page benefits from staged reveal motion:

```css
.fade-up {
  opacity: 0;
  transform: translateY(28px);
  transition: opacity 0.75s var(--ease), transform 0.75s var(--ease);
}

.fade-up.is-visible {
  opacity: 1;
  transform: none;
}

.fade-up--delay-1 { transition-delay: 0.1s; }
.fade-up--delay-2 { transition-delay: 0.2s; }
.fade-up--delay-3 { transition-delay: 0.3s; }
.fade-up--delay-4 { transition-delay: 0.4s; }
.fade-up--delay-5 { transition-delay: 0.5s; }
```

```js
const observer = new IntersectionObserver(
  (entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) entry.target.classList.add('is-visible');
  }),
  { threshold: 0.15 }
);

document.querySelectorAll('.fade-up').forEach((element) => observer.observe(element));
```

### Aesthetic Rules

- Keep dark mode as the default.
- Use teal as the only accent color unless the task gives a concrete exception.
- Use hover lift plus glow for interactive emphasis.
- Use fluid heading sizes with `clamp()`.
- Use BEM naming.
- Never use `transition: all`.
- Avoid inline styles for design values.
- Keep section rhythm consistent with `--section-py` and `.container`.
- Prefer subtle borders and shadows over noisy decoration.

### Full UI Checklist

- all colors come from `--color-*` variables
- all headings use fluid `clamp()` sizing
- fonts are loaded with preconnect and `display=swap`
- `.container` and `.section` wrappers exist
- card components follow the glass-card pattern
- CTAs map to `.btn-primary` or `.btn-secondary`
- scroll reveal is present where appropriate
- no `transition: all`
- no hardcoded colors outside token definitions
- `body.theme-light {}` exists
- hover states lift or glow instead of changing color alone

## Lean Admin UI

Use this for internal tools and backoffice surfaces. Preserve the same tokens and typography direction but remove delight-only effects.

### Keep

- color system
- typography family choices
- layout discipline
- BEM naming
- light and dark mode with `yb-theme`
- responsive breakpoint at `48rem`
- input and focus conventions

### Remove

- all transitions and animations
- glassmorphism and `backdrop-filter`
- glow shadows
- hover transforms
- gradient backgrounds
- scroll reveal
- display-style fluid hero sizing
- easing variables that only support motion

### Additional Tokens

```css
:root {
  --admin-sidebar-w: 15rem;
  --admin-header-h: 3.5rem;
  --admin-content-p: 1.5rem;
  --admin-row-h: 2.75rem;
}
```

### Admin Shell

```css
.admin-shell {
  display: grid;
  grid-template-columns: var(--admin-sidebar-w) 1fr;
  grid-template-rows: var(--admin-header-h) 1fr;
  min-height: 100dvh;
}

@media (max-width: 48rem) {
  .admin-shell {
    grid-template-columns: 1fr;
    grid-template-rows: var(--admin-header-h) 1fr;
  }

  .admin-sidebar { display: none; }

  .admin-sidebar.is-open {
    display: block;
    position: fixed;
    inset: var(--admin-header-h) 0 0 0;
    z-index: 100;
  }
}

.admin-header {
  grid-column: 1 / -1;
  background: var(--color-bg-alt);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  padding-inline: 1rem;
  gap: 1rem;
}

.admin-sidebar {
  background: var(--color-bg-alt);
  border-right: 1px solid var(--color-border);
  padding: 1rem 0;
  overflow-y: auto;
}

.admin-content {
  padding: var(--admin-content-p);
  overflow-y: auto;
}
```

### Admin Components

Navigation:

```css
.admin-nav__item {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.5rem 1rem;
  color: var(--color-text-muted);
  font-size: 0.875rem;
  font-weight: 500;
  border-left: 2px solid transparent;
  cursor: pointer;
}

.admin-nav__item:hover {
  color: var(--color-text);
  background: var(--color-lake-mist);
}

.admin-nav__item.is-active {
  color: var(--color-lake-lt);
  border-left-color: var(--color-lake);
  background: var(--color-lake-mist);
}
```

Buttons:

```css
.btn-primary {
  background: var(--color-lake-deep);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 600;
  border: 1px solid transparent;
}

.btn-primary:hover {
  background: var(--color-lake);
}

.btn-secondary {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-lake-lt);
  border-radius: var(--radius-sm);
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
}

.btn-secondary:hover {
  background: var(--color-lake-mist);
  border-color: var(--color-border-hover);
}

.btn-danger {
  background: oklch(40% 0.18 25);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 600;
}

.btn-danger:hover {
  background: oklch(50% 0.20 25);
}
```

Cards:

```css
.admin-card {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 1.25rem;
}
```

Tables:

```css
.admin-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.admin-table th {
  text-align: left;
  padding: 0.625rem 0.75rem;
  color: var(--color-text-subtle);
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  border-bottom: 1px solid var(--color-border);
}

.admin-table td {
  padding: 0.625rem 0.75rem;
  color: var(--color-text);
  border-bottom: 1px solid var(--color-border);
  height: var(--admin-row-h);
}

.admin-table tr:hover td {
  background: var(--color-lake-mist);
}
```

Badges:

```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.badge--success { background: oklch(35% 0.12 145 / 0.25); color: oklch(75% 0.14 145); }
.badge--warning { background: oklch(40% 0.14 75 / 0.25); color: oklch(80% 0.14 75); }
.badge--danger { background: oklch(35% 0.18 25 / 0.25); color: oklch(72% 0.18 25); }
.badge--neutral { background: var(--color-lake-mist); color: var(--color-lake-lt); }
```

Inputs:

```css
.form-input {
  background: var(--color-bg-alt);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  width: 100%;
}

.form-input:focus {
  outline: none;
  border-color: var(--color-lake);
}
```

### Admin Rules

- use flat colors, not gradients
- keep state changes instant
- avoid glow, blur, and decorative depth
- keep sizing compact
- keep the same base color tokens
- prefix admin-specific blocks with `admin-`
- keep the same theme toggle persistence pattern

### Admin Checklist

- all colors come from token variables
- no `transition`, `animation`, or `@keyframes`
- no `backdrop-filter`, glow shadows, or gradients
- no hover transforms
- primary buttons are flat solid teal
- cards are opaque
- tables and forms stay compact
- mobile sidebar collapses at `48rem`

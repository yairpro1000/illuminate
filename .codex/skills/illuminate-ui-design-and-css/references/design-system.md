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

Use this for public-facing and experiential surfaces. Match the current live site, not the older teal-only design language.

### Source Of Truth

Check the relevant shipped CSS before changing or extending public styling:

- `apps/site/css/main.css` for global tokens, nav, hero, cards, buttons, theme behavior
- `apps/site/css/book.css` for booking, form, review, and recovery patterns
- `apps/site/css/contact.css` for contact-form and light-panel behavior
- `apps/site/css/evenings.css` and `apps/site/css/sessions.css` for public content-card and event-list patterns

When the live CSS and this reference disagree, prefer the live CSS and update the skill later if needed.

### Core Tokens

Define these CSS custom properties in `:root` and use them throughout:

```css
:root {
  --color-bg: oklch(10% 0.026 230);
  --color-bg-alt: oklch(13% 0.030 228);
  --color-bg-card: oklch(16% 0.036 226);

  --color-lake-deep: oklch(44% 0.185 196);
  --color-lake: oklch(60% 0.200 192);
  --color-lake-light: oklch(74% 0.165 188);
  --color-lake-mist: oklch(60% 0.200 192 / 0.13);
  --color-lake-glow: oklch(60% 0.200 192 / 0.38);

  --color-sword: oklch(62% 0.220 240);
  --color-sword-glow: oklch(62% 0.220 240 / 0.40);
  --color-valley: oklch(52% 0.160 155);
  --color-valley-mist: oklch(52% 0.160 155 / 0.12);

  --color-stone: oklch(80% 0.018 230);
  --color-stone-muted: oklch(60% 0.015 228);

  --color-text: oklch(92% 0.012 220);
  --color-text-muted: oklch(82% 0.014 222);
  --color-text-subtle: oklch(70% 0.012 224);

  --color-border: oklch(60% 0.200 192 / 0.18);
  --color-border-hover: oklch(60% 0.200 192 / 0.42);
  --color-white: oklch(99% 0.004 220);

  --color-word-highlight: oklch(87% 0.175 85);
  --color-word-highlight-glow: oklch(84% 0.200 82 / 0.60);

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
  --shadow-card: 0 8px 32px oklch(0% 0 0 / 0.45);
}
```

Public surfaces are dual-mode. When the surface supports theme switching, keep `body.theme-light {}` and persist the choice in `localStorage` under `yb-theme`.

Light mode uses an alpine-lake treatment instead of a flat white reset:

```css
body.theme-light {
  --color-bg: oklch(96.5% 0.008 185);
  --color-bg-alt: oklch(93% 0.011 183);
  --color-bg-card: oklch(99% 0.005 190);

  --color-lake-deep: oklch(36% 0.185 196);
  --color-lake: oklch(44% 0.190 192);
  --color-lake-light: oklch(38% 0.175 188);
  --color-lake-mist: oklch(44% 0.190 192 / 0.09);
  --color-lake-glow: oklch(44% 0.190 192 / 0.22);

  --color-text: oklch(13% 0.028 228);
  --color-text-muted: oklch(35% 0.022 226);
  --color-text-subtle: oklch(55% 0.018 224);

  --color-border: oklch(44% 0.190 192 / 0.14);
  --color-border-hover: oklch(44% 0.190 192 / 0.34);

  --shadow-glow: 0 0 22px oklch(44% 0.190 192 / 0.18);
  --shadow-card:
    0 4px 24px oklch(13% 0.028 228 / 0.08),
    0 1px 4px oklch(13% 0.028 228 / 0.06);
}
```

### Typography

Use the live site's type pairing:

- Use self-hosted `Canela` as the core public serif.
- Use Google `Nunito` at `800` for the brand wordmark and selected focal branding moments.
- Keep body copy, labels, forms, and UI controls in `Canela`, not a generic sans.
- Use `display=swap` for loaded fonts.

Use these type scales:

- hero brand: `clamp(2.6rem, 9vw, 6.5rem)` with wide tracking
- hero display: `clamp(2.6rem, 6vw, 5rem)`
- section h2: `clamp(2rem, 4.5vw, 3.5rem)`
- subsection h3: `clamp(1.5rem, 3vw, 2.25rem)`
- h4: `clamp(1.125rem, 2vw, 1.375rem)`
- feature body: `clamp(1.0625rem, 1.5vw, 1.1875rem)`
- body: `1rem`
- labels: `0.75rem`, uppercase, `letter-spacing: 0.12em`

Keep heading line-height around `1.1` to `1.3`. Keep body line-height around `1.6` to `1.8`.
Use italics intentionally for prelude copy, teasers, and reflective secondary text.

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
- Keep narrow reading widths around `38rem` to `40rem` for hero copy, booking flows, event intros, and form panels.
- On public pages, let major sections breathe. Do not collapse spacing to generic app density.

### Components

Buttons:

```css
.btn-primary {
  background: linear-gradient(135deg, var(--color-lake-deep), var(--color-lake));
  color: var(--color-white);
  border-radius: var(--radius-md);
  padding: 0.875rem 2.25rem;
  font-weight: 600;
  box-shadow: 0 0 20px var(--color-lake-glow);
  transition:
    transform 1s var(--ease),
    box-shadow 1s var(--ease),
    background 0.3s var(--ease);
}

.btn-primary:hover {
  transform: translateY(-3px);
  box-shadow: 0 0 38px var(--color-lake-glow), 0 8px 24px oklch(0% 0 0 / 0.35);
}

.btn-secondary {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-lake-light);
  border-radius: var(--radius-md);
  padding: 0.8125rem 2.125rem;
  transition: background 0.2s, border-color 0.2s, transform 0.2s;
}

.btn-secondary:hover {
  background: var(--color-lake-mist);
  border-color: var(--color-border-hover);
  transform: translateY(-2px);
}
```

In dark mode, the live site sometimes upgrades focal CTAs from teal to divine-gold glow. Use that only for hero-grade or conversion-grade emphasis, and revert to teal in `body.theme-light`.

Link-style CTA:

```css
.btn-arrow {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--color-lake-light);
  font-size: 2.25rem;
  font-weight: 500;
  font-style: italic;
  transition: gap 0.25s var(--ease), color 0.2s, transform 1s var(--ease);
}

.btn-arrow:hover {
  gap: 0.85rem;
}
```

Glass cards and content cards:

```css
.glass-card {
  background: oklch(16% 0.036 226 / 0.7);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  padding: 2.25rem;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  transition:
    border-color 0.3s var(--ease),
    transform 0.35s var(--ease),
    box-shadow 0.35s var(--ease);
}

.glass-card:hover {
  border-color: var(--color-border-hover);
  transform: translateY(-5px) scale(1.01);
  box-shadow: var(--shadow-card), 0 0 30px var(--color-lake-mist);
}
```

Inputs:

```css
.form-input {
  background: oklch(12% 0.028 228);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  padding: 0.75rem 0.875rem;
  width: 100%;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.form-input:focus {
  outline: none;
  border-color: var(--color-lake);
  box-shadow: 0 0 0 3px var(--color-lake-mist);
}
```

Public booking and form work should also reuse these recurring patterns where applicable:

- sticky coupon banner with gradient or frosted-light treatment
- pill chips for labels, prices, states, and selected slots
- booking cards with large radii and restrained borders
- event cards with glass or frosted panels, pill tags, and image/date overlays
- progress steppers, calendars, and slot buttons that use mist fills instead of loud solid fills

### Theme Behavior

- Dark mode is the primary mood: cosmic navy base, teal water accents, gold focal glow.
- Light mode is not a neutral reset. It uses a warm pearl base, alpine-lake photography, translucent overlays, and teal-darkened text tokens.
- Keep component-specific light-mode overrides where readability depends on them.
- If a section intentionally lets the background image breathe through, prefer overlay changes and token overrides over inventing a separate component style.

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

- Keep dark mode as the default mood.
- Use teal-water accents as the base system.
- Use divine-gold glow only for focal public emphasis in dark mode.
- Keep the brand feeling spiritual, atmospheric, and deliberate, not SaaS-generic.
- Use hover lift plus glow for interactive emphasis on public surfaces.
- Use fluid heading sizes with `clamp()`.
- Use BEM naming.
- Never use `transition: all`.
- Avoid inline styles for design values.
- Keep section rhythm consistent with `--section-py` and `.container`.
- Prefer subtle borders, glow, blur, and image layering over noisy ornament.

### Full UI Checklist

- all colors come from `--color-*` variables
- public tokens match the live Divine Valley palette
- all headings use fluid `clamp()` sizing
- typography follows `Canela` plus `Nunito`, not generic sans substitutions
- `.container` and `.section` wrappers exist
- card components follow the glass-card or shipped event-card pattern
- CTAs map to `.btn-primary`, `.btn-secondary`, or `.btn-arrow`
- scroll reveal is present where appropriate
- no `transition: all`
- no hardcoded colors outside token definitions
- `body.theme-light {}` exists when the surface supports theme switching
- hover states lift, glow, or deepen mist instead of changing color alone
- dark-mode gold emphasis is used sparingly and intentionally
- public light mode keeps the alpine-lake treatment instead of flattening to plain white

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

- long cinematic transitions and animations
- hero-brand glow treatments
- decorative `text-shadow` glow stacks
- most hover transforms
- background photography as a core layout device
- scroll reveal
- display-style fluid hero sizing
- non-essential blur and halo effects

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
  color: var(--color-white);
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
  color: var(--color-lake-light);
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
.badge--neutral { background: var(--color-lake-mist); color: var(--color-lake-light); }
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
- keep state changes quick and restrained
- avoid glow, heavy blur, brand-wordmark theatrics, and decorative depth
- keep sizing compact
- keep the same base color tokens
- prefix admin-specific blocks with `admin-`
- keep the same theme toggle persistence pattern
- keep the same OKLCH token language, but bias toward clarity over atmosphere

### Admin Checklist

- all colors come from token variables
- no decorative `@keyframes`
- no brand-glow text or CTA treatments
- no photography-dependent layouts
- hover behavior stays functional and restrained
- primary buttons are flat solid teal
- cards are opaque
- tables and forms stay compact
- mobile sidebar collapses at `48rem`

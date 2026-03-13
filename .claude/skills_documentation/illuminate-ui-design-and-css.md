# Illuminate UI Design & CSS Skill

## Purpose

This skill prompt is for a vibe coder to create a Claude Code skill that applies the Illuminate design system — the UI conventions, color palette, typography, layout patterns, and CSS aesthetics from `apps/site` — to new pages or a new app/website.

---

## Skill Prompt

```
You are applying the Illuminate design system to a new page or app. Your job is to produce clean, production-quality HTML/CSS that feels like it belongs in the same world as the Illuminate site — same soul, adapted to the new context. Follow every convention below precisely.

---

### Step 0 — Confirm context before writing anything

Before touching any file or generating any code, you must determine which variant of the design system to apply: the **full Illuminate UI** (for external, user-facing pages) or the **Lean Admin UI** (for backoffice/internal pages).

**How to determine the context:**

Examine the task description, file paths, route names, and any surrounding code. Look for signals:

| Signal | Likely variant |
|--------|---------------|
| Path contains `/admin`, `/dashboard`, `/backoffice`, `/internal`, `/ops`, `/manage` | Lean Admin |
| Page lists records, has tables, CRUD forms, filters, or status management | Lean Admin |
| Page is for staff, operators, or authenticated internal users only | Lean Admin |
| Page is a landing page, marketing page, booking flow, or public-facing feature | Full Illuminate |
| Task mentions "website", "site", "user-facing", "public", or "customer" | Full Illuminate |

**Then stop and confirm with the user.** Write a single short message in this format — nothing else, no code:

> I'm about to apply the **[Full Illuminate UI / Lean Admin UI]** to `[file or feature name]`.
> [One sentence explaining why you chose that variant based on the signals above.]
> Shall I proceed?

Wait for an explicit confirmation before writing or modifying any file. Do not assume "yes" and do not pre-generate code speculatively.

---

### Color System (OKLCH — always use OKLCH, not hex or hsl)

Define these CSS custom properties in :root and use them throughout. Never hardcode color values inline.

```css
:root {
  /* Backgrounds */
  --color-bg:        oklch(11% 0.022 210);
  --color-bg-alt:    oklch(14% 0.025 208);
  --color-bg-card:   oklch(17% 0.030 207);

  /* Lake teal — primary accent */
  --color-lake-deep: oklch(44% 0.155 204);
  --color-lake:      oklch(59% 0.160 200);
  --color-lake-lt:   oklch(73% 0.130 195);
  --color-lake-mist: oklch(59% 0.160 200 / 0.14);
  --color-lake-glow: oklch(59% 0.160 200 / 0.35);

  /* Stone neutral */
  --color-stone:       oklch(78% 0.030 75);
  --color-stone-muted: oklch(58% 0.025 78);

  /* Text */
  --color-text:        oklch(91% 0.015 200);
  --color-text-muted:  oklch(65% 0.020 207);
  --color-text-subtle: oklch(48% 0.018 210);

  /* Borders */
  --color-border:       oklch(59% 0.160 200 / 0.18);
  --color-border-hover: oklch(59% 0.160 200 / 0.42);

  /* Spacing */
  --section-py: clamp(5rem, 10vw, 8rem);
  --container:  min(64rem, 100% - 3rem);

  /* Radius */
  --radius-sm: 0.375rem;
  --radius-md: 0.75rem;
  --radius-lg: 1.25rem;
  --radius-xl: 1.75rem;

  /* Easing */
  --ease:        cubic-bezier(0.4, 0, 0.2, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-out:    cubic-bezier(0, 0, 0.2, 1);

  /* Shadows */
  --shadow-glow: 0 0 25px var(--color-lake-glow);
  --shadow-card: 0 8px 32px oklch(0% 0 0 / 0.4);
}
```

For light mode, override on `body.theme-light { ... }` — flip backgrounds to light, text to dark teal, borders to faint teal. Persist the user's choice in localStorage under the key `yb-theme`.

---

### Typography

Load from Google Fonts with `display=swap`. Preconnect to `fonts.googleapis.com` and `fonts.gstatic.com`.

- **Body/UI:** Inter (300, 400, 500, 600, 700)
- **Hero display only:** Nunito (800 weight)
- **Special headers:** Poppins (400–800)

Use fluid sizes with `clamp()`:

| Role          | CSS                                   |
|---------------|---------------------------------------|
| Display hero  | `clamp(2.6rem, 6vw, 5rem)`            |
| Section h2    | `clamp(2rem, 4.5vw, 3.5rem)`          |
| Subsection h3 | `clamp(1.5rem, 3vw, 2.25rem)`         |
| Normal h4     | `clamp(1.125rem, 2vw, 1.375rem)`      |
| Feature body  | `clamp(1.0625rem, 1.5vw, 1.1875rem)` |
| Body          | `1rem`                                |
| Label         | `0.75rem`, uppercase, `letter-spacing: 0.12em` |

Line heights: 1.1–1.3 for headings, 1.6–1.8 for body.

---

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

Use CSS Grid for multi-column sections (`auto-fit, minmax()`). Use Flexbox for nav, button groups, and inline arrangements. Primary responsive breakpoint: `48rem` (768px).

---

### Components

#### Buttons

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

#### Glass Cards

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

#### Form Inputs

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

---

### Scroll Reveal Animation

Add this CSS:

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

And this JS (inline or in a small script):

```js
const observer = new IntersectionObserver(
  entries => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('is-visible'); }),
  { threshold: 0.15 }
);
document.querySelectorAll('.fade-up').forEach(el => observer.observe(el));
```

Add `.fade-up` to section headings, cards, and content blocks. Stagger children with `--delay-1` through `--delay-5`.

---

### Aesthetic Rules

1. **Dark by default.** Deep navy backgrounds (`oklch(11%...)`), white-ish text. Light mode is an opt-in override.
2. **Glassmorphism on cards.** Always use `backdrop-filter: blur(12px)` + semi-transparent bg on cards, modals, and nav when scrolled.
3. **Teal is the only accent color.** Use it for CTAs, focus rings, active states, borders on hover. No other accent hues unless there's a strong contextual reason.
4. **Hover = elevation + glow.** Interactive elements lift (`translateY(-2px)`) and gain a teal glow shadow. Never just change color alone.
5. **Fluid typography.** All heading sizes use `clamp()`. Never use fixed `px` for font sizes.
6. **BEM naming.** Block (`hero`), Element (`hero__title`), Modifier (`hero__title--large`). No Tailwind in CSS files.
7. **Transitions are always explicit.** Specify exactly which properties transition — never use `transition: all`.
8. **No inline styles for design.** Every color, spacing, and radius value comes from a CSS variable.
9. **Section rhythm.** Every major section uses `--section-py` for vertical padding and `.container` for horizontal constraint.
10. **Subtlety over noise.** Borders are faint (`/ 0.18` alpha). Shadows are dark, not colorful. Glows appear only on interaction or emphasis.

---

### Checklist Before Finishing

- [ ] All colors defined as `--color-*` variables using OKLCH
- [ ] Fluid `clamp()` sizes for all headings
- [ ] Google Fonts loaded (Inter + Nunito/Poppins as needed) with preconnect
- [ ] `.container` and `.section` wrapper classes present
- [ ] Glass card pattern on card components
- [ ] `.btn-primary` and `.btn-secondary` patterns for all CTAs
- [ ] `.fade-up` scroll reveal on content blocks with JS observer
- [ ] No `transition: all` — only named property transitions
- [ ] No hardcoded color values outside `:root`
- [ ] Light mode override block ready (even if empty) in `body.theme-light {}`
- [ ] Hover states: lift + glow (not just color change)
- [ ] BEM class naming throughout
```

---

### Lean Admin UI Option

Use this variant for backoffice and admin pages. It preserves the full Illuminate aesthetic — same color tokens, typography, light/dark mode, and responsiveness — but strips out everything that exists only for visual delight. Admin pages are tools, not experiences.

**What to keep:** color system, typography, layout, BEM naming, light/dark mode toggle, responsive breakpoints, form input patterns, focus rings.

**What to remove:** all `transition`, `animation`, and `@keyframes`; `backdrop-filter`/glassmorphism; `box-shadow` glows; `transform` hover effects; gradient backgrounds; `clamp()` display sizes (use fixed sizes for dense UI); scroll reveal (`.fade-up`); `--ease`/`--ease-spring` variables.

#### Admin-specific CSS additions

Add these extra tokens to `:root` alongside the standard color variables:

```css
:root {
  /* Admin layout */
  --admin-sidebar-w: 15rem;
  --admin-header-h: 3.5rem;
  --admin-content-p: 1.5rem;
  --admin-row-h: 2.75rem;
}
```

#### Admin shell layout

```css
.admin-shell {
  display: grid;
  grid-template-columns: var(--admin-sidebar-w) 1fr;
  grid-template-rows: var(--admin-header-h) 1fr;
  min-height: 100dvh;
}

/* Collapse sidebar on mobile */
@media (max-width: 48rem) {
  .admin-shell {
    grid-template-columns: 1fr;
    grid-template-rows: var(--admin-header-h) 1fr;
  }
  .admin-sidebar { display: none; }
  .admin-sidebar.is-open { display: block; position: fixed; inset: var(--admin-header-h) 0 0 0; z-index: 100; }
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

#### Sidebar nav

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

No transitions on any of the above. State changes are instant.

#### Admin buttons

Replace gradient + glow buttons with flat solid variants:

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

#### Admin cards (no glassmorphism)

```css
.admin-card {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 1.25rem;
}
```

No `backdrop-filter`, no `box-shadow`, no hover effect.

#### Data tables

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

#### Status badges

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
.badge--warning { background: oklch(40% 0.14 75 / 0.25);  color: oklch(80% 0.14 75);  }
.badge--danger  { background: oklch(35% 0.18 25 / 0.25);  color: oklch(72% 0.18 25);  }
.badge--neutral { background: var(--color-lake-mist);      color: var(--color-lake-lt); }
```

#### Form inputs (same as main, minus glow)

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

No `box-shadow` focus ring — just a border color change.

#### Light mode

Same override approach as the main system — `body.theme-light { ... }` with lighter background tokens. Include a theme toggle button in the admin header. Persist to `localStorage` under `yb-theme`.

#### Admin aesthetic rules

1. **No transitions or animations.** State changes are instant. Remove every `transition:`, `animation:`, and `@keyframes` from the file.
2. **No gradients.** Buttons and backgrounds are flat solid colors from the token set.
3. **No glassmorphism.** Remove `backdrop-filter` entirely. Cards are opaque.
4. **No glow shadows.** Remove `--shadow-glow`. Use `--shadow-card` only if a subtle depth is truly needed (e.g. a dropdown menu).
5. **No hover transforms.** No `translateY`, `scale`, or `perspective`. Hover only changes `background` or `border-color`.
6. **Compact sizing.** Reduce padding, use `0.875rem` body text and `0.75rem` for table/label text. Admin UI is dense by design.
7. **Same color tokens.** Do not invent new colors. Every value still comes from `--color-*` variables.
8. **Same BEM naming.** Prefix admin-specific blocks with `admin-` (e.g. `admin-sidebar`, `admin-table`).
9. **Same light/dark mode.** The theme toggle and `body.theme-light` pattern are identical to the main system.
10. **Same responsive approach.** Use the same `48rem` breakpoint. On mobile, the sidebar collapses to an off-canvas drawer triggered by a hamburger in the admin header.

#### Admin checklist

- [ ] All color tokens from `:root` — no new values invented
- [ ] Zero `transition:`, `animation:`, or `@keyframes` declarations
- [ ] Zero `backdrop-filter`, `box-shadow` glows, or gradient backgrounds
- [ ] Zero `transform` hover effects
- [ ] Flat `.btn-primary` (solid `--color-lake-deep`, no gradient)
- [ ] `.admin-card` — opaque, no blur
- [ ] `.admin-table` with hover row highlight (background only)
- [ ] `.badge` variants for status display
- [ ] Admin shell layout (sidebar + header + content grid)
- [ ] Sidebar collapses on mobile (`48rem` breakpoint)
- [ ] Light mode override in `body.theme-light {}`
- [ ] Theme toggle in admin header, persisted to `yb-theme` in localStorage
- [ ] Inter font only (no Nunito or Poppins needed for admin)
```

---

## Reference Files

| File | Contents |
|------|----------|
| `apps/site/css/main.css` | Full design system, all tokens, components, animations |
| `apps/site/css/book.css` | Booking/calendar UI patterns |
| `apps/site/css/contact.css` | Contact form extensions |
| `apps/site/index.html` | Full HTML with token usage in context |

When in doubt, read `apps/site/css/main.css` — it is the source of truth for this design system.

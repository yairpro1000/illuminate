# ui_system.md

## 1. Design Tokens

UI must use **design tokens** (CSS variables) and never hardcode hex
colors in components.

Minimum token groups: - Colors - Typography - Spacing - Radius - Shadows

------------------------------------------------------------------------

## 2. Theme Strategy

-   Themes implemented as CSS variable sets.
-   Example:
    -   `.theme-terracotta`
    -   `.theme-forest`
    -   `.theme-lugano-summer`

Switching theme should require only changing a class on `<body>`.

------------------------------------------------------------------------

## 3. Layout Structure (Public Site)

Core pages: - Home - Book a session - Events - Event details - Contact

Core homepage layout: - Hero with strong positioning + CTA - Problem
resonance section - Method section - Offer cards (session types) -
Testimonials (optional) - Final CTA

------------------------------------------------------------------------

## 4. Accessibility Requirements

-   Text/background contrast meets WCAG AA.
-   Focus states visible.
-   Keyboard navigable forms.
-   Form labels and error messages accessible.

------------------------------------------------------------------------

## 5. Responsive Rules

-   Mobile-first design.
-   Clean stacking of hero and cards.
-   Buttons large enough for touch targets.
-   Avoid layout shift during loading.

------------------------------------------------------------------------

## 6. Visual Guidance (Brand)

-   Swiss / Lugano clarity vibe.
-   Swiss nature background allowed but must remain subtle:
    -   avoid over-saturation
    -   maintain readability with overlays
-   Emphasize typography + whitespace over decoration.

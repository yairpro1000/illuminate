# Phase I -- Implementation Instructions (Mock-First Architecture)

## Goal

Build a fully functional UI and backend skeleton using mock service
adapters before integrating real external services.

------------------------------------------------------------------------

## Architecture Principle

Use an integration-adapter pattern.

Each external dependency must have:

-   Interface (Provider contract)
-   Mock implementation
-   Real implementation (added later)
-   Switch via environment variable (PROVIDERS_MODE=mock\|real)

------------------------------------------------------------------------

## Required Provider Interfaces

-   CalendarProvider
-   EmailProvider
-   PaymentsProvider
-   Repository (DB abstraction)
-   AntiBotProvider

Each provider must return realistic data structures (IDs, URLs,
timestamps), not just true/false.

------------------------------------------------------------------------

## Phase I Scope

### 1. Static + Routing Layer

-   Homepage
-   Conversation booking page
-   Cycle information page
-   Admin login page (placeholder)
-   Admin dashboard shell

### 2. Booking Flow (Mocked)

-   Create booking record in mock repository
-   Return fake booking ID
-   Simulate confirmation email
-   Simulate reminder scheduling

### 3. Payment Flow (Mocked)

-   Simulate payment intent creation
-   Return fake invoice URL
-   Simulate webhook confirmation event

### 4. Admin Area (Mock)

-   View bookings list
-   Update booking status
-   Trigger manual state transitions
-   View failed `booking_side_effect_attempts`

------------------------------------------------------------------------

## Mock Strategy

Mock providers must:

-   Generate deterministic fake IDs (uuid)
-   Return structured objects matching real API responses
-   Log actions to console + `observability.logs`
-   Allow manual error simulation (e.g. simulate Stripe failure)

------------------------------------------------------------------------

## Dev Control Panel

Create hidden route: /\_\_dev

Features: - Create test booking - Simulate payment success - Simulate
payment failure - Trigger reminder job - Inspect last 50 failed side-effect attempts

------------------------------------------------------------------------

## Rollout Order for Real Integrations

1.  Deploy to Cloudflare (static + worker skeleton)
2.  Replace Repository with Supabase
3.  Replace EmailProvider
4.  Replace CalendarProvider
5.  Replace PaymentsProvider (Stripe)

------------------------------------------------------------------------

## Completion Criteria (Phase I)

-   Full UI navigable
-   All flows function with mocks
-   Admin dashboard operational
-   No hard-coded external logic
-   Easy switch from mock to real providers

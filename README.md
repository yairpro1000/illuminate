# ILLUMINATE

This repository contains the ILLUMINATE public website, the organizer/admin frontend, the shared booking backend, and adjacent apps that remain in the monorepo.

The current canonical documentation set in this pass is scoped to the website, booking system, and admin only.

## Main Apps

- `apps/site`: public site at `letsilluminate.co`
- `apps/admin`: organizer/admin frontend at `admin.letsilluminate.co`
- `apps/api-booking`: shared booking and admin Cloudflare Worker

PA apps still exist in the repo, but they are intentionally out of scope for the current docs refresh.

## Canonical Docs

- requirements: [docs/requirements.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/requirements.md)
- technical companion: [docs/technical_companion.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/technical_companion.md)
- frozen user scenarios: [docs/expected_user_scenarios_freeze_illuminate_2026-03-15.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/expected_user_scenarios_freeze_illuminate_2026-03-15.md)
- pay-later refinement: [docs/pay_later_refined_flow_2026-03-15.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/pay_later_refined_flow_2026-03-15.md)
- documentation gap audit: [docs/documentation_gap_audit_2026-03-23.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/documentation_gap_audit_2026-03-23.md)
- live schema snapshot: [docs/public_schema_snapshot_2026-03-23.sql](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/public_schema_snapshot_2026-03-23.sql)
- editor-ready DDL: [docs/public_schema_editor_ddl_2026-03-23.sql](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/public_schema_editor_ddl_2026-03-23.sql)
- manual testing companion: [docs/test-plans/manual_testing_companion.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/test-plans/manual_testing_companion.md)
- E2E UI matrix: [docs/test-plans/e2e_ui_test_matrix.xlsx](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/test-plans/e2e_ui_test_matrix.xlsx)
- test-plan and E2E gap audit: [docs/test-plans/test_plan_and_e2e_gap_audit_2026-03-23.md](/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/docs/test-plans/test_plan_and_e2e_gap_audit_2026-03-23.md)

## Notes

- The full schema snapshot is the literal current Supabase `public` dump.
- The shorter DDL companion is the authored editor reference and normalizes value sets to `text` plus `CHECK` constraints.
- Superseded documentation is archived under `docs/old/`.

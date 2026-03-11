export interface Env {
  // Per-provider mode flags — each defaults to 'mock' in wrangler.toml
  REPOSITORY_MODE: string; // 'mock' | 'supabase'
  EMAIL_MODE:      string; // 'mock' | 'resend'
  CALENDAR_MODE:   string; // 'mock' | 'google'
  PAYMENTS_MODE:   string; // 'mock' | 'stripe'
  ANTIBOT_MODE:    string; // 'mock' | 'turnstile'

  SITE_URL: string;       // e.g. https://yairb.com (no trailing slash)
  SESSION_ADDRESS: string;
  SESSION_MAPS_URL: string;
  API_ALLOWED_ORIGINS?: string;
  ADMIN_ALLOWED_EMAILS?: string;
  ADMIN_DEV_EMAIL?: string;
  ADMIN_AUTH_DISABLED?: string;
  CLOUDFLARE_ACCESS_AUD?: string;

  // Set as secrets in prod — may be undefined in mock mode
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  OBSERVABILITY_SCHEMA?: string;

  RESEND_API_KEY: string;

  // Used by both calendar paths (availability reads and booking writes).
  GOOGLE_CALENDAR_ID: string;

  // Google Calendar OAuth refresh-token credentials.
  // Used only by calendar write operations: createEvent/updateEvent/deleteEvent.
  GOOGLE_CLIENT_CALENDAR: string;
  GOOGLE_CLIENT_SECRET_CALENDAR: string;
  GOOGLE_REFRESH_TOKEN_CALENDAR: string;

  // Service account credentials.
  // Used by calendar availability reads: getBusyTimes/freeBusy.
  // Also reused by optional Google Drive backup code.
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_TOKEN_URI: string;

  TIMEZONE: string; // e.g. 'Europe/Zurich'

  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PUBLISHABLE_KEY: string;

  TURNSTILE_SECRET_KEY: string;

  JOB_SECRET: string; // Bearer token required on POST /api/jobs/:name
  ADMIN_MANAGE_TOKEN_SECRET?: string;

  // R2 images
  IMAGES_BUCKET: R2Bucket;
  IMAGE_BASE_URL?: string; // e.g. https://assets.example.com

  // Google Drive backup (service account)
  GOOGLE_DRIVE_FOLDER_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string; // optional; overrides GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY
}

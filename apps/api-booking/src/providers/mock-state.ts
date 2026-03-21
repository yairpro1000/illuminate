/**
 * Module-level singleton that holds all in-memory state for mock providers.
 * Persists across requests within a Worker isolate (wrangler dev / single instance).
 */
import type {
  Booking,
  BookingSideEffectAttempt,
  BookingSideEffect,
  BookingEventRecord,
  Client,
  ContactMessage,
  Coupon,
  Event,
  EventLateAccessLink,
  EventReminderSubscription,
  Payment,
  SessionTypeAvailabilityWindow,
  SessionTypeWeekOverride,
  SystemSetting,
} from '../types.js';

export interface SentEmail {
  id: string;
  from: string;
  to: string;
  subject: string;
  kind: string;
  email_kind: string;
  replyTo: string;
  text: string;
  html?: string;
  body: string;
  sentAt: string;
  sent_at: string;
  booking_id: string | null;
  event_id: string | null;
  contact_message_id: string | null;
}

export const mockState = {
  clients: new Map<string, Client>(),
  coupons: new Map<string, Coupon>(),
  bookings: new Map<string, Booking>(),
  events: new Map<string, Event>(),
  eventLateAccessLinks: new Map<string, EventLateAccessLink>(),
  eventReminderSubscriptions: new Map<string, EventReminderSubscription>(),
  contactMessages: new Map<string, ContactMessage>(),
  payments: new Map<string, Payment>(),
  systemSettings: new Map<string, SystemSetting>(),
  sessionTypeAvailabilityWindows: new Map<string, SessionTypeAvailabilityWindow[]>(),
  sessionTypeWeekOverrides: new Map<string, SessionTypeWeekOverride>(),
  sentEmails: [] as SentEmail[],
  // booking audit/events recorded by the mock repository
  bookingEvents: [] as BookingEventRecord[],
  // one row per intended system reaction linked to a booking_event
  sideEffects: [] as Array<BookingSideEffect & { booking_id: string }>,
  // concrete retries/executions for side effects
  sideEffectAttempts: [] as BookingSideEffectAttempt[],
};

const nowIso = '2026-01-01T00:00:00Z';

const SEED_EVENTS: Event[] = [
  {
    id: 'ev-01-body',
    slug: 'ev-01-body',
    title: 'Listening to the Body',
    description: 'A guided evening of embodied presence: gentle pair connection, a deep body-listening meditation, and grounded sharing.',
    marketing_content: {
      subtitle: 'A guided evening to reconnect with the intelligence of your body, intuition, and inner calm.',
      intro: 'Instead of trying to think your way forward, this evening helps you slow down, feel inward, and hear what your body has already been saying.',
      what_to_expect: [
        'guided body-listening meditation',
        'grounded sharing in a calm atmosphere',
        'space to notice the difference between mind, gut, and heart',
      ],
      takeaways: [
        'more inner clarity',
        'a deeper felt sense of self-trust',
        'a simple embodied practice to return to afterwards',
      ],
    },
    starts_at: '2026-03-20T19:00:00+01:00',
    ends_at: '2026-03-20T20:55:00+01:00',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano (venue TBA)',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.google.com/?q=Lugano+Switzerland',
    is_paid: false,
    price_per_person: null,
    currency: 'CHF',
    capacity: 24,
    status: 'published',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    id: 'ev-02-inner-compass',
    slug: 'ev-02-inner-compass',
    title: 'Inner Compass Night',
    description: 'We explore what becomes possible when conversation is structured with care.',
    marketing_content: {
      subtitle: 'A structured conversation evening to help you hear what is truly yours beneath noise, pressure, and habit.',
      intro: 'Through carefully held questions and present connection, this evening supports you in listening more honestly to yourself while meeting others from a more rooted place.',
      what_to_expect: [
        'guided pair and group questions',
        'moments of reflection and inner-guidance practice',
        'a thoughtful social atmosphere with real conversation',
      ],
      takeaways: [
        'more clarity about what matters to you',
        'a stronger connection to your own inner compass',
        'fresh insight through authentic human contact',
      ],
    },
    starts_at: '2026-04-17T19:00:00+02:00',
    ends_at: '2026-04-17T21:00:00+02:00',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano (venue TBA)',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.google.com/?q=Lugano+Switzerland',
    is_paid: false,
    price_per_person: null,
    currency: 'CHF',
    capacity: 24,
    status: 'published',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    id: 'ev-03-mirror',
    slug: 'ev-03-mirror',
    title: 'Mirrors & Gifts',
    description: 'A warm, imaginative evening where we practice affirming connection.',
    marketing_content: {
      subtitle: 'A warm and imaginative evening of reflection, affirmation, and being seen through the eyes of others.',
      intro: 'Sometimes our gifts become easier to recognize when they are mirrored back to us. This evening creates a gentle space to explore that with openness and playfulness.',
      what_to_expect: [
        'guided connection in pairs or small groups',
        'gentle mirroring of strengths, qualities, and gifts',
        'an intuitive but grounded atmosphere',
      ],
      takeaways: [
        'a clearer sense of your natural gifts',
        'the experience of seeing and being seen beautifully',
        'more warmth and confidence in how you relate to others',
      ],
    },
    starts_at: '2026-05-15T19:00:00+02:00',
    ends_at: '2026-05-15T20:55:00+02:00',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano (venue TBA)',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.google.com/?q=Lugano+Switzerland',
    is_paid: true,
    price_per_person: 45,
    currency: 'CHF',
    capacity: 24,
    status: 'published',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    id: 'ev-04-new-earth',
    slug: 'ev-04-new-earth',
    title: 'New Earth Conversations',
    description: 'A guided dialogue evening using New Earth themes as inspiration.',
    marketing_content: {
      subtitle: 'A guided dialogue evening for exploring meaning, change, and the kind of world we want to help create.',
      intro: 'Rather than staying trapped in reaction or abstraction, this evening invites a grounded conversation about personal and collective transformation.',
      what_to_expect: [
        'guided dialogue around New Earth themes',
        'reflection on the link between inner and outer change',
        'space for different perspectives without pressure to agree',
      ],
      takeaways: [
        'a larger frame for current times',
        'more grounded hope and orientation',
        'a deeper sense of meaningful participation',
      ],
    },
    starts_at: '2026-06-19T19:00:00+02:00',
    ends_at: '2026-06-19T21:00:00+02:00',
    timezone: 'Europe/Zurich',
    location_name: 'Lugano (venue TBA)',
    address_line: 'Lugano, Switzerland',
    maps_url: 'https://maps.google.com/?q=Lugano+Switzerland',
    is_paid: false,
    price_per_person: null,
    currency: 'CHF',
    capacity: 24,
    status: 'published',
    created_at: nowIso,
    updated_at: nowIso,
  },
];

const SEED_SYSTEM_SETTINGS: SystemSetting[] = [
  {
    domain: 'booking',
    keyname: 'slotLeadTimeHours',
    readable_name: 'Slot lead time',
    value_type: 'integer',
    unit: 'hours',
    value: '24',
    description: 'Minimum time before start required for a slot to appear bookable.',
    description_he: 'מספר השעות המינימלי לפני תחילת סלוט שבו ניתן להציג אותו כזמין להזמנה.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'booking',
    keyname: 'selfServiceLockWindowHours',
    readable_name: 'Self-service lock window',
    value_type: 'integer',
    unit: 'hours',
    value: '24',
    description: 'Time before booking start when users can no longer cancel or reschedule online.',
    description_he: 'מספר השעות לפני תחילת ההזמנה שלאחריהן המשתמש כבר לא יכול לבטל או לשנות מועד אונליין.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'payment',
    keyname: 'nonPaidConfirmationWindowMinutes',
    readable_name: 'Non-paid confirmation window',
    value_type: 'integer',
    unit: 'minutes',
    value: '1',
    description: 'Time allowed to confirm a free or pay-later booking before the confirmation link expires.',
    description_he: 'מספר הדקות לאישור הזמנה חינמית או תשלום-אחר-כך לפני שפג תוקף קישור האישור.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'payment',
    keyname: 'payNowCheckoutWindowMinutes',
    readable_name: 'Pay-now checkout window',
    value_type: 'integer',
    unit: 'minutes',
    value: '2',
    description: 'Time allowed to complete checkout after starting an immediate payment.',
    description_he: 'מספר הדקות להשלמת תשלום לאחר התחלת תהליך תשלום מיידי.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'payment',
    keyname: 'payNowReminderGraceMinutes',
    readable_name: 'Pay-now reminder grace period',
    value_type: 'integer',
    unit: 'minutes',
    value: '1',
    description: 'Delay before sending a reminder to complete an unfinished pay-now checkout.',
    description_he: 'עיכוב קצר לפני שליחת תזכורת להשלמת תשלום שהתחיל אך לא הסתיים.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'payment',
    keyname: 'paymentDueBeforeStartHours',
    readable_name: 'Payment due threshold',
    value_type: 'integer',
    unit: 'hours',
    value: '24',
    description: 'Time before the booking start when payment officially becomes due.',
    description_he: 'מספר השעות לפני תחילת ההזמנה שבהן התשלום נחשב כמועד לפירעון.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'reminder',
    keyname: 'paymentDueReminderLeadHours',
    readable_name: 'Payment reminder lead time',
    value_type: 'integer',
    unit: 'hours',
    value: '6',
    description: 'Preferred time before payment due when the reminder should be sent.',
    description_he: 'מספר השעות לפני מועד פירעון התשלום שבו מתוזמנת שליחת התזכורת.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'reminder',
    keyname: 'paymentDueReminderSleepHoursStart',
    readable_name: 'Reminder sleep window start',
    value_type: 'integer',
    unit: 'hour_of_day',
    value: '22',
    description: 'Local hour when sending payment reminders pauses for the night.',
    description_he: 'השעה המקומית שבה מפסיקים לשלוח תזכורות תשלום בלילה.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'reminder',
    keyname: 'paymentDueReminderSleepHoursEnd',
    readable_name: 'Reminder sleep window end',
    value_type: 'integer',
    unit: 'hour_of_day',
    value: '8',
    description: 'Local hour when sending payment reminders resumes in the morning.',
    description_he: 'השעה המקומית שבה חוזרים לשלוח תזכורות תשלום בבוקר.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'reminder',
    keyname: 'paymentDueReminderFallbackHourPreviousDay',
    readable_name: 'Reminder fallback hour (previous day)',
    value_type: 'integer',
    unit: 'hour_of_day',
    value: '18',
    description: 'Fallback hour on the previous day if the preferred reminder time falls during the sleep window.',
    description_he: 'השעה ביום הקודם שבה משתמשים אם זמן התזכורת המועדף נופל בתוך חלון השינה.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'reminder',
    keyname: 'paymentDueReminderFallbackHourNextMorning',
    readable_name: 'Reminder fallback hour (next morning)',
    value_type: 'integer',
    unit: 'hour_of_day',
    value: '8',
    description: 'Fallback hour next morning if the preferred reminder time has already passed.',
    description_he: 'השעה בבוקר הבא שבה משתמשים אם זמן התזכורת המועדף כבר עבר.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'reminder',
    keyname: 'eventReminderLeadHours',
    readable_name: 'Event reminder lead time',
    value_type: 'integer',
    unit: 'hours',
    value: '24',
    description: 'Time before an event when the reminder is scheduled to be sent.',
    description_he: 'מספר השעות לפני תחילת האירוע שבהן נשלחת תזכורת.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'event',
    keyname: 'publicEventCutoffAfterStartMinutes',
    readable_name: 'Public event cutoff after start',
    value_type: 'integer',
    unit: 'minutes',
    value: '30',
    description: 'Time after an event starts when normal public registration closes.',
    description_he: 'מספר הדקות לאחר תחילת האירוע שלאחריהן ההרשמה הציבורית נסגרת.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'event',
    keyname: 'eventLateAccessLinkExpiryHours',
    readable_name: 'Late-access link expiry',
    value_type: 'integer',
    unit: 'hours',
    value: '2',
    description: 'Time after event end during which organizer-generated late access links remain valid.',
    description_he: 'מספר השעות לאחר סיום האירוע שבהן קישור הרשמה מאוחרת עדיין תקף.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'processing',
    keyname: 'processingMaxAttempts',
    readable_name: 'Side-effect max attempts',
    value_type: 'integer',
    unit: 'count',
    value: '5',
    description: 'Maximum retry attempts for a side-effect before it is marked as failed.',
    description_he: 'מספר ניסיונות העיבוד המקסימלי לפני שתופעת לוואי מסומנת ככושלת.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'processing',
    keyname: 'sideEffectProcessingTimeoutMinutes',
    readable_name: 'Stale processing timeout',
    value_type: 'integer',
    unit: 'minutes',
    value: '10',
    description: 'Time after which a stuck processing task is reset to pending.',
    description_he: 'מספר הדקות שלאחריהן עיבוד שנתקע מאופס חזרה למצב ממתין.',
    created_at: nowIso,
    updated_at: nowIso,
  },
  {
    domain: 'admin',
    keyname: 'adminManageTokenExpiryMinutes',
    readable_name: 'Admin manage token expiry',
    value_type: 'integer',
    unit: 'minutes',
    value: '30',
    description: 'Time an admin-generated management token remains valid.',
    description_he: 'מספר הדקות שטוקן ניהול שנוצר על ידי אדמין נשאר תקף.',
    created_at: nowIso,
    updated_at: nowIso,
  },
];

const SEED_COUPONS: Coupon[] = [
  {
    code: 'ISRAEL',
    discount_percent: 25,
  },
];

for (const coupon of SEED_COUPONS) {
  mockState.coupons.set(coupon.code, { ...coupon });
}

for (const ev of SEED_EVENTS) {
  mockState.events.set(ev.id, ev);
}

for (const setting of SEED_SYSTEM_SETTINGS) {
  mockState.systemSettings.set(setting.keyname, setting);
}

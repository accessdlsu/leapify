/**
 * Discriminated union of all async job types processed by the CF Queue consumer.
 */
export type LeapifyJob =
  | {
      type: 'send_reminder_email'
      payload: { eventId: string; hoursBeforeEvent: 24 | 1 }
    }
  | {
      type: 'send_email'
      payload: { to: string; subject: string; html: string }
    }
  | {
      type: 'audit_log'
      payload: { action: string; userId: string; meta: unknown }
    }
  | {
      type: 'notify_batch_release'
      payload: { eventIds: string[]; releasedAt: number }
    }
  | {
      type: 'renew_forms_watch'
      payload: { formId: string; watchId: string }
    }

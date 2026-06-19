import type { TrackStatus } from '../carriers/types.js';

// A carrier-agnostic notification. Each channel turns this into its own wire
// format (ntfy headers, Pushover form fields, an email, and so on).

export interface NotificationMessage {
  title: string;
  body: string;
  /** Normalized status, used to set priority/emphasis where relevant. */
  status?: TrackStatus;
  /** Click-through URL, deep-linked to the package when possible. */
  url?: string;
  /** Short tags for channels that support them (e.g. ntfy emoji tags). */
  tags?: string[];
}

export interface NotificationChannel {
  id: string;
  name: string;
  /** True once this channel has everything it needs to send. */
  isConfigured(): boolean;
  send(msg: NotificationMessage): Promise<void>;
}

// Coarse urgency for channels that have priority levels.
export type Urgency = 'low' | 'normal' | 'high';

export function urgencyFor(status: TrackStatus | undefined): Urgency {
  if (status === 'exception' || status === 'out_for_delivery') return 'high';
  if (status === 'delivered') return 'normal';
  return 'low';
}

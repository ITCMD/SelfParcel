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

/** A channel instance's saved settings: a flat map of field key -> value. */
export type ChannelConfig = Record<string, string>;

// One input the UI renders when adding/editing a channel of a given type.
export interface ChannelField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'email' | 'textarea' | 'select';
  required?: boolean;
  placeholder?: string;
  /** Options for type 'select'. The first is the default. */
  options?: { value: string; label: string }[];
  /** Help text shown under the field. */
  hint?: string;
}

export interface NotificationChannel {
  /** Stable type id stored on each instance, e.g. 'ntfy'. */
  type: string;
  /** Display name in the type dropdown. */
  name: string;
  /** Fields the UI collects for this type. */
  fields: ChannelField[];
  /** Email needs the server's SMTP relay to actually send. */
  requiresSmtpRelay?: boolean;
  /** Return an error string if the config is incomplete, else null. */
  validate(config: ChannelConfig): string | null;
  send(msg: NotificationMessage, config: ChannelConfig): Promise<void>;
}

// Coarse urgency for channels that have priority levels.
export type Urgency = 'low' | 'normal' | 'high';

export function urgencyFor(status: TrackStatus | undefined): Urgency {
  if (status === 'exception' || status === 'out_for_delivery') return 'high';
  if (status === 'delivered') return 'normal';
  return 'low';
}

/** Small helper for channels: trim a config value. */
export function field(config: ChannelConfig, key: string): string {
  return (config[key] ?? '').trim();
}

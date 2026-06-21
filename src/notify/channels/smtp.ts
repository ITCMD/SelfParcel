import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../../config.js';
import { field, type NotificationChannel } from '../types.js';

// Email via SMTP. The relay (host/from) is the one server-wide piece of notify
// config; each user only supplies their recipient address. Transporter is built
// lazily and reused.

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.notify.smtp.host,
      port: config.notify.smtp.port,
      secure: config.notify.smtp.secure,
      auth: config.notify.smtp.user
        ? { user: config.notify.smtp.user, pass: config.notify.smtp.pass }
        : undefined,
    });
  }
  return transporter;
}

export function smtpRelayConfigured(): boolean {
  return Boolean(config.notify.smtp.host && config.notify.smtp.from);
}

export const smtpChannel: NotificationChannel = {
  type: 'email',
  name: 'Email',
  requiresSmtpRelay: true,
  fields: [
    { key: 'to', label: 'Recipient address', type: 'email', required: true, placeholder: 'you@example.com' },
  ],
  validate: (c) => {
    if (!field(c, 'to')) return 'A recipient address is required';
    if (!smtpRelayConfigured()) return 'The server has no SMTP relay configured (admin must set SMTP_HOST/SMTP_FROM)';
    return null;
  },

  async send(msg, c) {
    if (!smtpRelayConfigured()) throw new Error('SMTP relay not configured on the server');
    const text = msg.url ? `${msg.body}\n\n${msg.url}` : msg.body;
    await getTransporter().sendMail({
      from: config.notify.smtp.from,
      to: field(c, 'to'),
      subject: msg.title,
      text,
    });
  },
};

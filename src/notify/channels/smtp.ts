import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../../config.js';
import type { NotificationChannel } from '../types.js';

// Email via SMTP. Transporter is built lazily and reused.

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

// The relay (host/from) is server-wide; each user supplies their own recipient.
export const smtpChannel: NotificationChannel = {
  id: 'smtp',
  name: 'Email',
  isConfigured: (t) =>
    Boolean(config.notify.smtp.host && config.notify.smtp.from && t.channels.smtpTo),

  async send(msg, t) {
    const text = msg.url ? `${msg.body}\n\n${msg.url}` : msg.body;
    await getTransporter().sendMail({
      from: config.notify.smtp.from,
      to: t.channels.smtpTo,
      subject: msg.title,
      text,
    });
  },
};

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

export const smtpChannel: NotificationChannel = {
  id: 'smtp',
  name: 'Email (SMTP)',
  isConfigured: () =>
    Boolean(config.notify.smtp.host && config.notify.smtp.from && config.notify.smtp.to),

  async send(msg) {
    const text = msg.url ? `${msg.body}\n\n${msg.url}` : msg.body;
    await getTransporter().sendMail({
      from: config.notify.smtp.from,
      to: config.notify.smtp.to,
      subject: msg.title,
      text,
    });
  },
};

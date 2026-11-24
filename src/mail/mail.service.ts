import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

/**
 * Sends the account emails through SMTP (any provider: Gmail, Resend, SES...).
 *
 * Without SMTP configured, outside production the message is written to the
 * log so the flows can be tested locally.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter?: Transporter;

  constructor(private readonly config: ConfigService) {}

  async sendVerificationCode(to: string, code: string, minutesValid: number) {
    await this.send(
      to,
      'Tu código de verificación',
      `Tu código para verificar tu correo es ${code}.\n\n` +
        `Caduca en ${minutesValid} minutos. Si no creaste una cuenta, ` +
        'ignora este mensaje.',
    );
  }

  async sendPasswordResetCode(to: string, code: string, minutesValid: number) {
    await this.send(
      to,
      'Restablece tu contraseña',
      `Tu código para restablecer tu contraseña es ${code}.\n\n` +
        `Caduca en ${minutesValid} minutos. Si no lo pediste, ignora este ` +
        'mensaje: tu contraseña no cambiará.',
    );
  }

  private async send(to: string, subject: string, text: string) {
    const transporter = this.getTransporter();
    if (!transporter) {
      if (this.config.get('NODE_ENV') === 'production') {
        this.logger.warn(`SMTP is not configured, email to ${to} not sent`);
      } else {
        this.logger.log(`Email to ${to} (SMTP not configured): ${text}`);
      }
      return;
    }

    await transporter.sendMail({
      from: this.config.get<string>('MAIL_FROM'),
      to,
      subject,
      text,
    });
  }

  private getTransporter() {
    const host = this.config.get<string>('SMTP_HOST');
    if (!host) return undefined;

    const port = Number(this.config.get('SMTP_PORT') ?? 587);
    this.transporter ??= createTransport({
      host,
      port,
      // 465 is implicit TLS; other ports upgrade with STARTTLS.
      secure: port === 465,
      auth: {
        user: this.config.get<string>('SMTP_USER'),
        pass: this.config.get<string>('SMTP_PASSWORD'),
      },
    });
    return this.transporter;
  }
}

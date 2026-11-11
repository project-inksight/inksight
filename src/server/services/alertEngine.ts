import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { AIEvent, Camera, SmtpSettings } from '../../shared/types.js';
import { EventRepository, SettingsRepository } from '../db/repositories.js';
import { wsHub } from './wsHub.js';

export class AlertEngineService {
  /**
   * Dispatches all configured Blue Iris-style Action Sets for a confirmed AI Event:
   * 1. SMTP HTML Email with inline annotated high-res snapshot + attached MP4 clip (or LAN playback link)
   * 2. Outbound HTTP POST Webhook (JSON payload)
   * 3. Local Python / Batch / PowerShell Action Script execution
   */
  public async dispatchAlertActions(camera: Camera, event: AIEvent): Promise<void> {
    const settings = SettingsRepository.getSettings();

    // 1. Outbound Webhook (Camera-specific or Global)
    const webhookUrl = camera.webhook_url || settings.ai.globalWebhookUrl;
    if (webhookUrl && webhookUrl.trim().startsWith('http')) {
      void this.fireWebhook(webhookUrl.trim(), camera, event);
    }

    // 2. Local Script Runner (Camera-specific or Global)
    const scriptPath = camera.action_script || settings.ai.globalScriptPath;
    if (scriptPath && scriptPath.trim()) {
      void this.executeActionScript(scriptPath.trim(), camera, event);
    }

    // 3. SMTP Email Alert
    if (settings.smtp.enabled && settings.smtp.host && settings.smtp.recipients) {
      const sent = await this.sendEventEmail(settings.smtp, camera, event);
      if (sent) {
        EventRepository.markEmailSent(event.id);
        const updated = EventRepository.getById(event.id);
        if (updated) {
          wsHub.broadcast({ type: 'AI_EVENT_UPDATED', event: updated });
        }
      }
    }

    // 4. Instant Mobile Push Notifications (Telegram / Ntfy.sh / Pushover)
    if (
      settings.smtp.telegramEnabled &&
      settings.smtp.telegramBotToken?.trim() &&
      settings.smtp.telegramChatId?.trim()
    ) {
      void this.sendTelegramAlert(settings.smtp, camera, event);
    }

    if (settings.smtp.ntfyEnabled && settings.smtp.ntfyTopic?.trim()) {
      void this.sendNtfyAlert(settings.smtp, camera, event);
    }

    if (
      settings.smtp.pushoverEnabled &&
      settings.smtp.pushoverUserKey?.trim() &&
      settings.smtp.pushoverApiToken?.trim()
    ) {
      void this.sendPushoverAlert(settings.smtp, camera, event);
    }
  }

  public async sendEventEmail(
    smtp: SmtpSettings,
    camera: Camera,
    event: AIEvent
  ): Promise<boolean> {
    try {
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port || 587),
        secure: Boolean(smtp.secure),
        auth: smtp.username
          ? {
              user: smtp.username,
              pass: smtp.password,
            }
          : undefined,
        tls: {
          rejectUnauthorized: false,
        },
      });

      const formattedTime = new Date(event.timestamp).toLocaleString();
      const classLabel = event.object_class.toUpperCase();
      const confidenceStr = `${Math.round(event.confidence)}%`;
      const lanLink = `${smtp.lanBaseUrl || 'http://localhost:5173'}/?event=${encodeURIComponent(event.id)}`;

      const attachments: Array<{
        filename: string;
        path: string;
        cid?: string;
        contentType?: string;
      }> = [];

      // Attach inline high-res annotated snapshot
      const hasSnapshot = Boolean(event.snapshot_path && fs.existsSync(event.snapshot_path));
      if (hasSnapshot) {
        attachments.push({
          filename: `snapshot_${camera.id}_${event.timestamp}.jpg`,
          path: event.snapshot_path,
          cid: 'sentinel_alert_snapshot',
          contentType: 'image/jpeg',
        });
      }

      // Check MP4 clip size against maxAttachmentSizeMb
      let clipAttached = false;
      let clipSizeMb = 0;
      const maxMb = smtp.maxAttachmentSizeMb || 20;

      if (event.clip_path && fs.existsSync(event.clip_path)) {
        const stat = fs.statSync(event.clip_path);
        clipSizeMb = Math.round((stat.size / (1024 * 1024)) * 100) / 100;
        if (clipSizeMb <= maxMb) {
          attachments.push({
            filename: `${camera.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${event.timestamp}.mp4`,
            path: event.clip_path,
            contentType: 'video/mp4',
          });
          clipAttached = true;
        }
      }

      const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
</head>
<body style="margin:0;padding:24px;background-color:#0B0F17;color:#F8FAFC;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:680px;margin:0 auto;background-color:#111827;border:1px solid #1E293B;border-radius:12px;overflow:hidden;">
    <div style="padding:18px 24px;background:linear-gradient(90deg,#0F172A,#1E293B);border-bottom:1px solid #334155;">
      <div style="font-size:12px;letter-spacing:1.5px;color:#10B981;font-weight:700;text-transform:uppercase;">Inksight // AI Security Alert</div>
      <h2 style="margin:6px 0 0;font-size:20px;color:#FFFFFF;">${classLabel} Detected (${confidenceStr}) — ${camera.name}</h2>
    </div>

    <div style="padding:24px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;background-color:#0B0F17;border-radius:8px;overflow:hidden;">
        <tr>
          <td style="padding:10px 14px;color:#94A3B8;font-size:13px;border-bottom:1px solid #1E293B;">Camera</td>
          <td style="padding:10px 14px;color:#F8FAFC;font-size:13px;font-weight:600;border-bottom:1px solid #1E293B;">${camera.name} (${camera.ip_address})</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;color:#94A3B8;font-size:13px;border-bottom:1px solid #1E293B;">Verified Object</td>
          <td style="padding:10px 14px;color:#10B981;font-size:13px;font-weight:700;border-bottom:1px solid #1E293B;">${classLabel} — ${confidenceStr} Confidence</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;color:#94A3B8;font-size:13px;border-bottom:1px solid #1E293B;">Timestamp</td>
          <td style="padding:10px 14px;color:#F8FAFC;font-size:13px;border-bottom:1px solid #1E293B;">${formattedTime}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;color:#94A3B8;font-size:13px;">Video Clip</td>
          <td style="padding:10px 14px;color:#E2E8F0;font-size:13px;">
            ${
              clipAttached
                ? `Attached (${clipSizeMb} MB MP4 Direct-to-Disk clip)`
                : `Clip exceeds ${maxMb} MB attachment limit (${clipSizeMb} MB) — use direct LAN link below`
            }
          </td>
        </tr>
      </table>

      ${
        hasSnapshot
          ? `<div style="margin-bottom:20px;border:1px solid #334155;border-radius:8px;overflow:hidden;">
              <img src="cid:sentinel_alert_snapshot" alt="AI Detection Snapshot" style="width:100%;height:auto;display:block;" />
            </div>`
          : ''
      }

      <div style="text-align:center;margin-top:24px;">
        <a href="${lanLink}" style="display:inline-block;padding:12px 24px;background-color:#10B981;color:#052E16;font-weight:700;text-decoration:none;border-radius:8px;font-size:14px;">
          Open Forensic Timeline in Inksight
        </a>
      </div>
    </div>

    <div style="padding:14px 24px;background-color:#090D14;border-top:1px solid #1E293B;font-size:11px;color:#64748B;text-align:center;">
      Inksight Local NVR • Zero-Cloud Architecture • Direct-to-Disk Event Engine
    </div>
  </div>
</body>
</html>`;

      await transporter.sendMail({
        from: smtp.sender || 'Inksight NVR <alerts@inksight.local>',
        to: smtp.recipients,
        subject: `[Inksight] ${classLabel} (${confidenceStr}) detected on ${camera.name}`,
        html,
        attachments,
      });

      wsHub.notify(
        'info',
        'SMTP Video Alert Sent',
        `Dispatched ${classLabel} alert email for ${camera.name} to ${smtp.recipients}`
      );
      return true;
    } catch (err) {
      console.error('[AlertEngine] SMTP email dispatch failed:', (err as Error).message);
      wsHub.notify('error', 'SMTP Alert Failed', (err as Error).message);
      return false;
    }
  }

  public async sendTestEmail(customSmtp?: Partial<SmtpSettings>): Promise<{
    success: boolean;
    message: string;
  }> {
    const current = SettingsRepository.getSettings().smtp;
    const smtp: SmtpSettings = { ...current, ...(customSmtp || {}) };

    if (!smtp.host || !smtp.recipients) {
      return {
        success: false,
        message: 'SMTP Host and Recipients are required to send a test email.',
      };
    }

    try {
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: Number(smtp.port || 587),
        secure: Boolean(smtp.secure),
        auth: smtp.username
          ? {
              user: smtp.username,
              pass: smtp.password,
            }
          : undefined,
        tls: {
          rejectUnauthorized: false,
        },
        connectionTimeout: 8000,
      });

      await transporter.sendMail({
        from: smtp.sender || 'Inksight NVR <alerts@inksight.local>',
        to: smtp.recipients,
        subject: '[Inksight] Test Video Alert Configuration Verified',
        html: `
          <div style="padding:24px;background:#0B0F17;color:#F8FAFC;font-family:sans-serif;border-radius:10px;">
            <h2 style="color:#10B981;margin-top:0;">Inksight — SMTP Alert Engine Ready</h2>
            <p>Your local NVR SMTP notification pipeline is configured and ready to deliver high-resolution annotated snapshots and Direct-to-Disk MP4 video clips.</p>
            <p style="color:#94A3B8;font-size:12px;">Timestamp: ${new Date().toISOString()}</p>
          </div>
        `,
      });

      return {
        success: true,
        message: `Test email successfully sent via ${smtp.host}:${smtp.port} to ${smtp.recipients}`,
      };
    } catch (err) {
      return {
        success: false,
        message: `SMTP Error: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Instant Mobile Push via Telegram Bot API (sendPhoto with annotated 4K JPEG or sendMessage fallback)
   */
  public async sendTelegramAlert(
    smtp: SmtpSettings,
    camera: Camera,
    event: AIEvent
  ): Promise<boolean> {
    const token = smtp.telegramBotToken?.trim();
    const chatId = smtp.telegramChatId?.trim();
    if (!token || !chatId) return false;

    const classLabel = event.object_class.toUpperCase();
    const confidenceStr = `${Math.round(event.confidence)}%`;
    const timeStr = new Date(event.timestamp).toLocaleTimeString();
    const caption = `🛡️ *Inksight AI Alert*\n📹 *Camera:* ${camera.name}\n🎯 *Detected:* ${classLabel} (${confidenceStr})\n🕒 *Time:* ${timeStr}`;

    try {
      const hasSnapshot = Boolean(event.snapshot_path && fs.existsSync(event.snapshot_path));
      if (hasSnapshot) {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('caption', caption);
        form.append('parse_mode', 'Markdown');
        const imgBuf = fs.readFileSync(event.snapshot_path);
        const blob = new Blob([imgBuf], { type: 'image/jpeg' });
        form.append('photo', blob, `alert_${camera.id}_${event.timestamp}.jpg`);

        const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) {
          throw new Error(`Telegram HTTP ${resp.status}`);
        }
      } else {
        const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: caption,
            parse_mode: 'Markdown',
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
          throw new Error(`Telegram HTTP ${resp.status}`);
        }
      }
      console.log(`[AlertEngine] Sent Telegram push notification for ${camera.name} (${classLabel})`);
      return true;
    } catch (err) {
      console.warn('[AlertEngine] Telegram push failed:', (err as Error).message);
      return false;
    }
  }

  /**
   * Instant Mobile Push via Ntfy.sh (or self-hosted Ntfy server) with inline JPEG snapshot attachment
   */
  public async sendNtfyAlert(
    smtp: SmtpSettings,
    camera: Camera,
    event: AIEvent
  ): Promise<boolean> {
    const baseUrl = (smtp.ntfyServerUrl || 'https://ntfy.sh').trim().replace(/\/+$/, '');
    const topic = smtp.ntfyTopic?.trim();
    if (!topic) return false;

    const classLabel = event.object_class.toUpperCase();
    const confidenceStr = `${Math.round(event.confidence)}%`;
    const timeStr = new Date(event.timestamp).toLocaleTimeString();
    const title = `Inksight: ${classLabel} (${confidenceStr}) on ${camera.name}`;
    const message = `Detected ${classLabel} (${confidenceStr} confidence) at ${timeStr} on ${camera.name}`;

    try {
      const headers: Record<string, string> = {
        Title: title,
        Priority: 'high',
        Tags: 'rotating_light,camera',
      };
      if (smtp.ntfyToken?.trim()) {
        headers['Authorization'] = `Bearer ${smtp.ntfyToken.trim()}`;
      }

      const hasSnapshot = Boolean(event.snapshot_path && fs.existsSync(event.snapshot_path));
      if (hasSnapshot) {
        headers['Filename'] = `alert_${camera.id}_${event.timestamp}.jpg`;
        headers['Message'] = message;
        const imgBuf = fs.readFileSync(event.snapshot_path);
        const resp = await fetch(`${baseUrl}/${encodeURIComponent(topic)}`, {
          method: 'PUT',
          headers,
          body: imgBuf,
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) {
          throw new Error(`Ntfy HTTP ${resp.status}`);
        }
      } else {
        const resp = await fetch(`${baseUrl}/${encodeURIComponent(topic)}`, {
          method: 'POST',
          headers,
          body: message,
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
          throw new Error(`Ntfy HTTP ${resp.status}`);
        }
      }
      console.log(`[AlertEngine] Sent Ntfy push notification to ${baseUrl}/${topic}`);
      return true;
    } catch (err) {
      console.warn('[AlertEngine] Ntfy push failed:', (err as Error).message);
      return false;
    }
  }

  /**
   * Instant Mobile Push via Pushover API with image attachment
   */
  public async sendPushoverAlert(
    smtp: SmtpSettings,
    camera: Camera,
    event: AIEvent
  ): Promise<boolean> {
    const userKey = smtp.pushoverUserKey?.trim();
    const apiToken = smtp.pushoverApiToken?.trim();
    if (!userKey || !apiToken) return false;

    const classLabel = event.object_class.toUpperCase();
    const confidenceStr = `${Math.round(event.confidence)}%`;
    const timeStr = new Date(event.timestamp).toLocaleTimeString();

    try {
      const form = new FormData();
      form.append('token', apiToken);
      form.append('user', userKey);
      form.append('title', `Inksight: ${classLabel} on ${camera.name}`);
      form.append(
        'message',
        `Detected ${classLabel} (${confidenceStr} confidence) on ${camera.name} at ${timeStr}.`
      );
      form.append('priority', '1');

      if (event.snapshot_path && fs.existsSync(event.snapshot_path)) {
        const imgBuf = fs.readFileSync(event.snapshot_path);
        const blob = new Blob([imgBuf], { type: 'image/jpeg' });
        form.append('attachment', blob, `alert_${camera.id}.jpg`);
      }

      const resp = await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        throw new Error(`Pushover HTTP ${resp.status}`);
      }
      console.log(`[AlertEngine] Sent Pushover notification for ${camera.name}`);
      return true;
    } catch (err) {
      console.warn('[AlertEngine] Pushover push failed:', (err as Error).message);
      return false;
    }
  }

  /**
   * Sends a live test push notification to all enabled push channels (Telegram, Ntfy.sh, Pushover)
   */
  public async sendTestPushNotification(customSmtp?: Partial<SmtpSettings>): Promise<{
    success: boolean;
    message: string;
  }> {
    const current = SettingsRepository.getSettings().smtp;
    const smtp: SmtpSettings = { ...current, ...(customSmtp || {}) };
    const delivered: string[] = [];
    const errors: string[] = [];

    // 1. Test Telegram
    if (smtp.telegramEnabled) {
      if (!smtp.telegramBotToken?.trim() || !smtp.telegramChatId?.trim()) {
        errors.push('Telegram enabled but Bot Token or Chat ID is missing');
      } else {
        try {
          const resp = await fetch(
            `https://api.telegram.org/bot${smtp.telegramBotToken.trim()}/sendMessage`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: smtp.telegramChatId.trim(),
                text: `🛡️ *Inksight — Mobile Push Connected!*\nInstant YOLO11 4K snapshot notifications are active.\n🕒 ${new Date().toLocaleTimeString()}`,
                parse_mode: 'Markdown',
              }),
              signal: AbortSignal.timeout(8000),
            }
          );
          if (resp.ok) {
            delivered.push('Telegram');
          } else {
            const errText = await resp.text();
            errors.push(`Telegram HTTP ${resp.status}: ${errText.slice(0, 80)}`);
          }
        } catch (err) {
          errors.push(`Telegram: ${(err as Error).message}`);
        }
      }
    }

    // 2. Test Ntfy.sh
    if (smtp.ntfyEnabled) {
      if (!smtp.ntfyTopic?.trim()) {
        errors.push('Ntfy.sh enabled but Topic Name is missing');
      } else {
        try {
          const baseUrl = (smtp.ntfyServerUrl || 'https://ntfy.sh').trim().replace(/\/+$/, '');
          const headers: Record<string, string> = {
            Title: 'Inksight — Mobile Push Connected!',
            Priority: 'high',
            Tags: 'white_check_mark,shield',
          };
          if (smtp.ntfyToken?.trim()) {
            headers['Authorization'] = `Bearer ${smtp.ntfyToken.trim()}`;
          }
          const resp = await fetch(`${baseUrl}/${encodeURIComponent(smtp.ntfyTopic.trim())}`, {
            method: 'POST',
            headers,
            body: `Instant 4K AI security alerts from Inksight are active (${new Date().toLocaleTimeString()}).`,
            signal: AbortSignal.timeout(8000),
          });
          if (resp.ok) {
            delivered.push(`Ntfy (${smtp.ntfyTopic.trim()})`);
          } else {
            errors.push(`Ntfy HTTP ${resp.status}`);
          }
        } catch (err) {
          errors.push(`Ntfy: ${(err as Error).message}`);
        }
      }
    }

    // 3. Test Pushover
    if (smtp.pushoverEnabled) {
      if (!smtp.pushoverUserKey?.trim() || !smtp.pushoverApiToken?.trim()) {
        errors.push('Pushover enabled but User Key or API Token is missing');
      } else {
        try {
          const form = new FormData();
          form.append('token', smtp.pushoverApiToken.trim());
          form.append('user', smtp.pushoverUserKey.trim());
          form.append('title', 'Inksight — Mobile Push Connected!');
          form.append(
            'message',
            `Instant 4K AI security alerts from Inksight are active (${new Date().toLocaleTimeString()}).`
          );
          const resp = await fetch('https://api.pushover.net/1/messages.json', {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(8000),
          });
          if (resp.ok) {
            delivered.push('Pushover');
          } else {
            errors.push(`Pushover HTTP ${resp.status}`);
          }
        } catch (err) {
          errors.push(`Pushover: ${(err as Error).message}`);
        }
      }
    }

    if (delivered.length === 0 && errors.length === 0) {
      return {
        success: false,
        message: 'Enable at least one mobile push provider (Telegram, Ntfy.sh, or Pushover) first.',
      };
    }

    if (errors.length > 0 && delivered.length === 0) {
      return {
        success: false,
        message: errors.join(' | '),
      };
    }

    return {
      success: true,
      message: `Sent test push via ${delivered.join(', ')}${errors.length ? ` (Warnings: ${errors.join('; ')})` : ''}`,
    };
  }

  private async fireWebhook(url: string, camera: Camera, event: AIEvent): Promise<void> {
    try {
      const payload = {
        source: 'Inksight',
        eventId: event.id,
        cameraId: camera.id,
        cameraName: camera.name,
        timestamp: event.timestamp,
        isoTime: new Date(event.timestamp).toISOString(),
        objectClass: event.object_class,
        confidence: event.confidence,
        boundingBox: event.bounding_box,
        snapshotUrl: `/api/media/snapshots/${path.basename(event.snapshot_path)}`,
        clipUrl: event.clip_path ? `/api/media/clips/${path.basename(event.clip_path)}` : null,
      };

      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      console.log(`[AlertEngine] Fired outbound webhook to ${url}`);
    } catch (err) {
      console.warn(`[AlertEngine] Webhook POST to ${url} failed:`, (err as Error).message);
    }
  }

  private async executeActionScript(
    scriptCommand: string,
    camera: Camera,
    event: AIEvent
  ): Promise<void> {
    const env = {
      ...process.env,
      SENTINEL_CAMERA_ID: camera.id,
      SENTINEL_CAMERA_NAME: camera.name,
      SENTINEL_OBJECT: event.object_class,
      SENTINEL_CONFIDENCE: String(event.confidence),
      SENTINEL_TIMESTAMP: String(event.timestamp),
      SENTINEL_SNAPSHOT: event.snapshot_path,
      SENTINEL_CLIP: event.clip_path || '',
    };

    exec(scriptCommand, { env, timeout: 15000, windowsHide: true }, (err) => {
      if (err) {
        console.warn(`[AlertEngine] Action script error (${scriptCommand}):`, err.message);
      } else {
        console.log(`[AlertEngine] Executed action script: ${scriptCommand}`);
      }
    });
  }
}

export const alertEngine = new AlertEngineService();


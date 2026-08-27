import { db } from '../config/db.js';

export interface ScheduledJob {
  id: number;
  user_id?: number | null;
  contact_name: string;
  phone: string;
  message_text: string;
  execute_at: string;
  recurrence: 'once' | 'daily' | 'weekly' | 'monthly';
  stop_on_reply: boolean;
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  sent_at?: string | null;
  error_message?: string | null;
  created_at: string;
}

export interface CreateScheduledJobInput {
  userId?: number;
  contactName: string;
  phone: string;
  messageText: string;
  executeAt: Date | string;
  recurrence?: 'once' | 'daily' | 'weekly' | 'monthly';
  stopOnReply?: boolean;
}

export class ScheduledJobService {
  static async create(input: CreateScheduledJobInput): Promise<ScheduledJob> {
    const query = `
      INSERT INTO scheduled_jobs (
        user_id, contact_name, phone, message_text, execute_at, recurrence, stop_on_reply, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      RETURNING *;
    `;

    const values = [
      input.userId || null,
      input.contactName,
      input.phone,
      input.messageText,
      new Date(input.executeAt),
      input.recurrence || 'once',
      input.stopOnReply !== undefined ? input.stopOnReply : true
    ];

    const result = await db.query(query, values);
    return result.rows[0];
  }

  static async list(userId?: number): Promise<ScheduledJob[]> {
    let query = `SELECT * FROM scheduled_jobs`;
    const values: any[] = [];

    if (userId) {
      query += ` WHERE user_id = $1 OR user_id IS NULL`;
      values.push(userId);
    }

    query += ` ORDER BY execute_at ASC;`;
    const result = await db.query(query, values);
    return result.rows;
  }

  static async cancel(id: number, userId?: number): Promise<ScheduledJob | null> {
    let query = `
      UPDATE scheduled_jobs
      SET status = 'cancelled'
      WHERE id = $1
    `;
    const values: any[] = [id];

    if (userId) {
      query += ` AND (user_id = $2 OR user_id IS NULL)`;
      values.push(userId);
    }

    query += ` RETURNING *;`;
    const result = await db.query(query, values);
    return result.rows[0] || null;
  }

  static async delete(id: number, userId?: number): Promise<boolean> {
    let query = `DELETE FROM scheduled_jobs WHERE id = $1`;
    const values: any[] = [id];

    if (userId) {
      query += ` AND (user_id = $2 OR user_id IS NULL)`;
      values.push(userId);
    }

    const result = await db.query(query, values);
    return (result.rowCount ?? 0) > 0;
  }

  static async getDueJobs(): Promise<ScheduledJob[]> {
    const query = `
      SELECT * FROM scheduled_jobs
      WHERE status = 'pending' AND execute_at <= NOW()
      ORDER BY execute_at ASC;
    `;
    const result = await db.query(query);
    return result.rows;
  }

  static async markSent(id: number, recurrence: string, executeAt: Date): Promise<void> {
    if (recurrence === 'once') {
      await db.query(
        `UPDATE scheduled_jobs SET status = 'sent', sent_at = NOW() WHERE id = $1;`,
        [id]
      );
      return;
    }

    // Calcular próxima fecha para repetición
    const nextDate = new Date(executeAt);
    if (recurrence === 'daily') nextDate.setDate(nextDate.getDate() + 1);
    else if (recurrence === 'weekly') nextDate.setDate(nextDate.getDate() + 7);
    else if (recurrence === 'monthly') nextDate.setMonth(nextDate.getMonth() + 1);

    await db.query(
      `UPDATE scheduled_jobs 
       SET execute_at = $1, sent_at = NOW() 
       WHERE id = $2;`,
      [nextDate, id]
    );
  }

  static async markFailed(id: number, errorMessage: string): Promise<void> {
    await db.query(
      `UPDATE scheduled_jobs SET status = 'failed', error_message = $1 WHERE id = $2;`,
      [errorMessage, id]
    );
  }

  static async cancelPendingOnContactReply(phone: string): Promise<number> {
    // Normalizar teléfono (remover símbolos)
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const query = `
      UPDATE scheduled_jobs
      SET status = 'cancelled', error_message = 'Cancelado automáticamente: el contacto respondió'
      WHERE status = 'pending'
        AND stop_on_reply = true
        AND (phone LIKE '%' || $1 || '%' OR $1 LIKE '%' || phone || '%');
    `;
    const result = await db.query(query, [cleanPhone.slice(-8)]); // Busca por los últimos 8 dígitos
    return result.rowCount ?? 0;
  }
}

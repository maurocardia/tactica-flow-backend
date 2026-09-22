import { db } from '../config/db.js';

// Cola de clientes que pidieron un asesor y ninguno estaba libre (ver AdvisorService.
// pickFreeAdvisor: un asesor atiende UN cliente en relay a la vez). FIFO puro — el orden lo da
// `requested_at`, sin prioridad. Se vacía por AdvisorService.promoteNextFromQueue cuando un
// asesor se libera (por "FIN"/panel, o por el sweep periódico de acá abajo si nadie lo cerró a
// mano y venció solo por inactividad).
export interface QueuedCustomer {
  jid: string;
  customerName: string;
}

function mapRow(row: any): QueuedCustomer {
  return { jid: row.jid, customerName: row.customer_name };
}

export class AdvisorQueueService {
  /** Encola a este cliente si todavía no estaba — ON CONFLICT DO NOTHING porque isQueued/
   * getPosition ya se chequea ANTES desde AdvisorService.handoffConversation (no debería
   * duplicarse, pero por las dudas no rompe si dos mensajes casi simultáneos llegan a pedir
   * asesor). Devuelve la posición (1-based) en la fila. */
  static async enqueue(userId: number, jid: string, customerName: string): Promise<number> {
    await db.query(
      `INSERT INTO advisor_queue (user_id, jid, customer_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, jid) DO NOTHING`,
      [userId, jid, customerName]
    );
    return (await AdvisorQueueService.getPosition(userId, jid)) ?? 1;
  }

  /** Posición 1-based en la fila (por orden de llegada), o null si no está en cola. */
  static async getPosition(userId: number, jid: string): Promise<number | null> {
    const { rows } = await db.query(
      `SELECT position FROM (
         SELECT jid, ROW_NUMBER() OVER (ORDER BY requested_at ASC) AS position
         FROM advisor_queue WHERE user_id = $1
       ) t WHERE jid = $2`,
      [userId, jid]
    );
    return rows.length > 0 ? Number(rows[0].position) : null;
  }

  /** Saca y devuelve al primero de la fila (el más antiguo) — usado al promover a un cliente
   * cuando un asesor se libera. FOR UPDATE SKIP LOCKED evita que dos promociones concurrentes
   * (dos asesores liberándose casi a la vez) se lleven al mismo cliente dos veces. */
  static async dequeueFirst(userId: number): Promise<QueuedCustomer | null> {
    const { rows } = await db.query(
      `DELETE FROM advisor_queue
       WHERE id = (
         SELECT id FROM advisor_queue WHERE user_id = $1 ORDER BY requested_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [userId]
    );
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  static async isQueued(userId: number, jid: string): Promise<boolean> {
    const { rows } = await db.query('SELECT 1 FROM advisor_queue WHERE user_id = $1 AND jid = $2', [userId, jid]);
    return rows.length > 0;
  }

  static async hasQueue(userId: number): Promise<boolean> {
    const { rows } = await db.query('SELECT 1 FROM advisor_queue WHERE user_id = $1 LIMIT 1', [userId]);
    return rows.length > 0;
  }

  /** Todo usuario con al menos un cliente en cola — el sweep periódico solo necesita intentar
   * promover para estos (ver AdvisorQueueWorker). */
  static async listUserIdsWithQueue(): Promise<number[]> {
    const { rows } = await db.query('SELECT DISTINCT user_id FROM advisor_queue');
    return rows.map((r) => r.user_id);
  }

  /** Filas de cola a las que les toca su recordatorio de posición (users.queue_reminder_minutes,
   * default 10 — mismo panel que handoff_reservation_minutes). */
  static async listDueForReminder(): Promise<{ id: number; userId: number; jid: string; customerName: string }[]> {
    const { rows } = await db.query(
      `SELECT q.id, q.user_id, q.jid, q.customer_name
       FROM advisor_queue q
       JOIN users u ON u.id = q.user_id
       WHERE COALESCE(q.last_reminder_at, q.requested_at) <= now() - (u.queue_reminder_minutes || ' minutes')::interval`
    );
    return rows.map((r) => ({ id: r.id, userId: r.user_id, jid: r.jid, customerName: r.customer_name }));
  }

  static async markReminded(id: number): Promise<void> {
    await db.query('UPDATE advisor_queue SET last_reminder_at = now() WHERE id = $1', [id]);
  }
}

import { db } from '../config/db.js';
import { FlowEngineService } from './flowEngine.service.js';
import { trace } from '../utils/trace.js';

// Parada de emergencia (botón rojo de Configuración): mientras está activa, la cuenta no manda
// NADA por WhatsApp desde el backend — ni bot, ni flujos, ni el puente con asesores, ni la cola,
// ni mensajes programados, ni envíos manuales desde el panel. La sesión de WhatsApp queda
// conectada (no hay que volver a escanear el QR) y los mensajes entrantes se siguen guardando.
//
// El estado vive en users.emergency_stop y se espeja acá en memoria: los chequeos están en el
// camino de CADA envío (ver WhatsappService), así que no pueden costar una consulta cada vez.
// No importa whatsapp.service.ts a propósito — es ese módulo el que importa éste.
const stoppedUserIds = new Set<number>();

export interface EmergencyStopCleanup {
  queueCleared: number;
  handoffsCleared: number;
  flowStatesCleared: number;
}

export class EmergencyStopService {
  static readonly BLOCKED_MESSAGE = 'Parada de emergencia activa: no se envió el mensaje.';

  static isActive(userId?: number | null): boolean {
    return userId != null && stoppedUserIds.has(userId);
  }

  /** Al arrancar el servidor: una parada activa tiene que sobrevivir a un reinicio/deploy. */
  static async loadFromDb(): Promise<void> {
    const { rows } = await db.query('SELECT id FROM users WHERE emergency_stop = true');
    stoppedUserIds.clear();
    for (const row of rows) stoppedUserIds.add(row.id);
    if (rows.length > 0) console.log(`🛑 [EmergencyStop] ${rows.length} cuenta(s) con parada de emergencia activa.`);
  }

  /**
   * Activa la parada y limpia lo que quedó a medias, para que nada "residual" se dispare después
   * (ni ahora ni al reactivar): la cola de espera de asesores, las atenciones con asesor en curso,
   * las preguntas pendientes ("¿querés hablar con una persona?", "¿se solucionó?"), las pausas de
   * IA y los temporizadores de flujo en memoria. No toca la configuración, los asesores, los
   * contactos, el historial ni los mensajes programados a futuro (los que venzan DURANTE la parada
   * se marcan como fallidos en vez de mandarse al reactivar — ver SchedulerWorker).
   */
  static async activate(userId: number): Promise<EmergencyStopCleanup> {
    // Primero el flag en memoria: corta al instante cualquier envío que ya esté en vuelo.
    stoppedUserIds.add(userId);
    await db.query('UPDATE users SET emergency_stop = true, updated_at = now() WHERE id = $1', [userId]);

    const flowStatesCleared = FlowEngineService.clearStatesForUser(userId);
    const queue = await db.query('DELETE FROM advisor_queue WHERE user_id = $1', [userId]);
    const handoffs = await db.query(
      `UPDATE bot_contacts
       SET handoff_advisor_id = NULL, handoff_expires_at = NULL, handoff_close_pending_at = NULL,
           handoff_clarify_pending_at = NULL, handoff_clarify_original_text = NULL, ai_paused_until = NULL
       WHERE user_id = $1
         AND (handoff_advisor_id IS NOT NULL OR handoff_expires_at IS NOT NULL OR handoff_close_pending_at IS NOT NULL
              OR handoff_clarify_pending_at IS NOT NULL OR ai_paused_until IS NOT NULL)`,
      [userId]
    );

    const cleanup = { queueCleared: queue.rowCount ?? 0, handoffsCleared: handoffs.rowCount ?? 0, flowStatesCleared };
    trace('PARADA_EMERGENCIA_ACTIVADA', { usuario: userId, cola: cleanup.queueCleared, atenciones: cleanup.handoffsCleared, flujos: cleanup.flowStatesCleared });
    return cleanup;
  }

  static async deactivate(userId: number): Promise<void> {
    await db.query('UPDATE users SET emergency_stop = false, updated_at = now() WHERE id = $1', [userId]);
    stoppedUserIds.delete(userId);
    trace('PARADA_EMERGENCIA_DESACTIVADA', { usuario: userId });
  }
}

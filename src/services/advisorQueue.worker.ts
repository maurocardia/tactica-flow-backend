import { AdvisorQueueService } from './advisorQueue.service.js';
import { AdvisorService } from './advisor.service.js';
import { WhatsappService } from './whatsapp.service.js';
import { trace } from '../utils/trace.js';

let intervalRef: NodeJS.Timeout | null = null;
let isProcessing = false;

// Dos trabajos periódicos para el sistema de colas de asesores (ver comentario de advisor_queue
// en db.ts):
// 1) Avisarle a cada cliente en cola su posición actual, cada users.queue_reminder_seconds.
// 2) Promover al siguiente de la cola apenas un asesor queda libre — cubre el caso de un relay
//    que se cerró SOLO por timeout de inactividad (sliding expiry) sin que el asesor escriba
//    "FIN" (el cierre explícito ya promueve al instante, ver AdvisorService.finishAdvisory).
export class AdvisorQueueWorker {
  static start(intervalMs: number = 60000) {
    if (intervalRef) return;

    console.log('⏱️  [AdvisorQueueWorker] Iniciando worker de cola de asesores...');

    intervalRef = setInterval(async () => {
      if (isProcessing) return;
      isProcessing = true;

      try {
        await AdvisorQueueWorker.sendDueReminders();
        await AdvisorQueueWorker.promoteFreeAdvisors();
      } catch (err) {
        console.error('❌ [AdvisorQueueWorker] Error inesperado en ciclo de evaluación:', err);
      } finally {
        isProcessing = false;
      }
    }, intervalMs);
  }

  static stop() {
    if (intervalRef) {
      clearInterval(intervalRef);
      intervalRef = null;
      console.log('⏱️  [AdvisorQueueWorker] Worker de cola de asesores detenido.');
    }
  }

  private static async sendDueReminders() {
    const due = await AdvisorQueueService.listDueForReminder();
    for (const item of due) {
      try {
        const position = await AdvisorQueueService.getPosition(item.userId, item.jid);
        if (position === null) continue; // se promovió justo entre el listDue y acá
        await WhatsappService.sendTextMessage(
          item.jid.split('@')[0],
          `Seguís en la fila de espera de un asesor — vas en la posición ${position}. En cuanto se libere alguien te conectamos.`,
          item.userId,
          'cola recordatorio→cliente'
        );
        await AdvisorQueueService.markReminded(item.id);
        trace('COLA_RECORDATORIO', { usuario: item.userId, cliente: item.jid, posicion: position });
      } catch (err) {
        console.error(`❌ [AdvisorQueueWorker] Error mandando recordatorio de cola a ${item.jid}:`, err);
      }
    }
  }

  private static async promoteFreeAdvisors() {
    const userIds = await AdvisorQueueService.listUserIdsWithQueue();
    for (const userId of userIds) {
      // Uno por uno: cada promoteNextFromQueue ocupa a ese asesor (reserva un cliente), así que
      // el siguiente pickFreeAdvisor de esta misma vuelta ya no lo vuelve a elegir.
      while (await AdvisorQueueService.hasQueue(userId)) {
        const advisor = await AdvisorService.pickFreeAdvisor(userId);
        if (!advisor) {
          trace('COLA_SIN_ASESOR_LIBRE', { usuario: userId });
          break; // nadie libre por ahora — se reintenta en el próximo tick
        }
        try {
          await AdvisorService.promoteNextFromQueue(userId, advisor);
        } catch (err) {
          console.error(`❌ [AdvisorQueueWorker] Error promoviendo de la cola para el usuario ${userId}:`, err);
          break;
        }
      }
    }
  }
}

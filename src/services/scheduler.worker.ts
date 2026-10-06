import { ScheduledJobService } from './scheduledJob.service.js';
import { WhatsappService } from './whatsapp.service.js';
import { io } from '../server.js';
import { EmergencyStopService } from './emergencyStop.service.js';

let intervalRef: NodeJS.Timeout | null = null;
let isProcessing = false;

export class SchedulerWorker {
  static start(intervalMs: number = 30000) {
    if (intervalRef) return;

    console.log('⏱️  [SchedulerWorker] Iniciando worker de mensajes programados...');

    // Ejecución periódica
    intervalRef = setInterval(async () => {
      if (isProcessing) return;
      isProcessing = true;

      try {
        const dueJobs = await ScheduledJobService.getDueJobs();
        if (dueJobs.length > 0) {
          console.log(`⏱️  [SchedulerWorker] Procesando ${dueJobs.length} mensaje(s) programado(s) pendiente(s)...`);
        }

        for (const job of dueJobs) {
          // Parada de emergencia: lo que vence mientras está activa NO queda pendiente para
          // mandarse de golpe al reactivar — se marca como fallido, a la vista en el panel.
          if (EmergencyStopService.isActive(job.user_id)) {
            await ScheduledJobService.markFailed(job.id, EmergencyStopService.BLOCKED_MESSAGE);
            io.emit('scheduled_job_updated', { id: job.id, status: 'failed', error: EmergencyStopService.BLOCKED_MESSAGE });
            continue;
          }
          try {
            await WhatsappService.sendTextMessage(job.phone, job.message_text, job.user_id || undefined);
            await ScheduledJobService.markSent(job.id, job.recurrence, new Date(job.execute_at));

            console.log(`✅ [SchedulerWorker] Mensaje programado #${job.id} enviado exitosamente a ${job.contact_name} (${job.phone})`);
            io.emit('scheduled_job_updated', { id: job.id, status: 'sent' });
          } catch (jobErr: any) {
            console.error(`❌ [SchedulerWorker] Error enviando mensaje programado #${job.id}:`, jobErr.message);
            await ScheduledJobService.markFailed(job.id, jobErr.message);
            io.emit('scheduled_job_updated', { id: job.id, status: 'failed', error: jobErr.message });
          }
        }
      } catch (err) {
        console.error('❌ [SchedulerWorker] Error inesperado en ciclo de evaluación:', err);
      } finally {
        isProcessing = false;
      }
    }, intervalMs);
  }

  static stop() {
    if (intervalRef) {
      clearInterval(intervalRef);
      intervalRef = null;
      console.log('⏱️  [SchedulerWorker] Worker de mensajes programados detenido.');
    }
  }
}

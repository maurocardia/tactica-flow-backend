import { Router, Request, Response } from 'express';
import { ScheduledJobService } from '../services/scheduledJob.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

const router = Router();

// Listar mensajes programados (opcionalmente filtrados por usuario autenticado)
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id ? Number((req as any).user.id) : undefined;
    const jobs = await ScheduledJobService.list(userId);
    res.json(jobs);
  } catch (error: any) {
    console.error('❌ Error al listar mensajes programados:', error);
    res.status(500).json({ error: error.message || 'Error al listar mensajes programados' });
  }
});

// Crear un nuevo mensaje programado
router.post('/', async (req: Request, res: Response) => {
  try {
    const { contactName, phone, messageText, executeAt, recurrence, stopOnReply } = req.body;
    const userId = (req as any).user?.id ? Number((req as any).user.id) : undefined;

    if (!contactName || !phone || !messageText || !executeAt) {
      return res.status(400).json({
        error: 'Los campos contactName, phone, messageText y executeAt son obligatorios.'
      });
    }

    const job = await ScheduledJobService.create({
      userId,
      contactName,
      phone,
      messageText,
      executeAt,
      recurrence: recurrence || 'once',
      stopOnReply: stopOnReply !== undefined ? stopOnReply : true
    });

    res.status(201).json(job);
  } catch (error: any) {
    console.error('❌ Error al crear mensaje programado:', error);
    res.status(500).json({ error: error.message || 'Error al crear mensaje programado' });
  }
});

// Cancelar un mensaje programado
router.put('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = (req as any).user?.id ? Number((req as any).user.id) : undefined;

    const cancelled = await ScheduledJobService.cancel(id, userId);
    if (!cancelled) {
      return res.status(404).json({ error: 'Mensaje programado no encontrado.' });
    }

    res.json(cancelled);
  } catch (error: any) {
    console.error('❌ Error al cancelar mensaje programado:', error);
    res.status(500).json({ error: error.message || 'Error al cancelar mensaje programado' });
  }
});

// Eliminar un mensaje programado
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = (req as any).user?.id ? Number((req as any).user.id) : undefined;

    const deleted = await ScheduledJobService.delete(id, userId);
    if (!deleted) {
      return res.status(404).json({ error: 'Mensaje programado no encontrado.' });
    }

    res.json({ success: true, message: 'Mensaje programado eliminado.' });
  } catch (error: any) {
    console.error('❌ Error al eliminar mensaje programado:', error);
    res.status(500).json({ error: error.message || 'Error al eliminar mensaje programado' });
  }
});

export default router;

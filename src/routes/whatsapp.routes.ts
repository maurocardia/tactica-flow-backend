import { Router, Request, Response } from 'express';
import { WhatsappService } from '../services/whatsapp.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

const router = Router();

// Todas estas rutas son "del usuario autenticado": cada usuario conecta y controla únicamente
// su propia sesión de WhatsApp.
router.use(authMiddleware);

router.post('/connect', async (req: Request, res: Response) => {
  try {
    const result = await WhatsappService.connect(req.user!.id);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al iniciar la conexión con WhatsApp' });
  }
});

router.post('/disconnect', async (req: Request, res: Response) => {
  try {
    await WhatsappService.disconnect(req.user!.id);
    res.json({ status: 'disconnected' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al desconectar WhatsApp' });
  }
});

router.get('/status', (req: Request, res: Response) => {
  res.json({ status: WhatsappService.getStatus(req.user!.id) });
});

router.get('/qr', (req: Request, res: Response) => {
  const qr = WhatsappService.getQr(req.user!.id);

  if (!qr) {
    return res.status(404).json({ error: 'No hay un código QR disponible en este momento' });
  }

  res.json({ qr });
});

export default router;

import { Router, Request, Response } from 'express';
import { WhatsappService } from '../services/whatsapp.service.js';
import { AuthService } from '../services/auth.service.js';
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

// Enciende/apaga el auto-responder (motor de reglas + IA) para la sesión de Baileys de este
// usuario — ver WhatsappService.handleIncomingMessage, que consulta este flag antes de responder.
router.put('/bot-enabled', async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'El campo "enabled" es requerido y debe ser booleano' });
  }

  try {
    const user = await AuthService.setBotEnabled(req.user!.id, enabled);
    res.json({ botEnabled: user?.botEnabled ?? enabled });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar el estado del bot' });
  }
});

// Enciende/apaga el fallback a IA cuando ninguna regla de palabra clave matchea. Apagado, el bot
// (si está habilitado) solo responde con el chatbot manual — si ninguna regla matchea, no manda
// ninguna respuesta automática. Ver WhatsappService.handleIncomingMessage.
router.put('/ai-fallback-enabled', async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'El campo "enabled" es requerido y debe ser booleano' });
  }

  try {
    const user = await AuthService.setAiFallbackEnabled(req.user!.id, enabled);
    res.json({ aiFallbackEnabled: user?.aiFallbackEnabled ?? enabled });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar el fallback de IA' });
  }
});

// Instrucciones de comportamiento personalizadas para la IA (panel "Comportamiento de IA"):
// texto libre que se inyecta en el system prompt junto con la Base de Conocimiento — ver
// AIService.processMessage.
router.put('/ai-custom-instructions', async (req: Request, res: Response) => {
  const { instructions } = req.body;
  if (typeof instructions !== 'string') {
    return res.status(400).json({ error: 'El campo "instructions" es requerido y debe ser una cadena' });
  }

  try {
    const user = await AuthService.setAiCustomInstructions(req.user!.id, instructions);
    res.json({ aiCustomInstructions: user?.aiCustomInstructions ?? instructions });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar las instrucciones de comportamiento' });
  }
});

// Enciende/apaga que el bot también autoresponda en grupos de WhatsApp (por default solo lo
// hace en chats individuales) — ver WhatsappService.handleIncomingMessage.
router.put('/bot-groups-enabled', async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'El campo "enabled" es requerido y debe ser booleano' });
  }

  try {
    const user = await AuthService.setBotGroupsEnabled(req.user!.id, enabled);
    res.json({ botGroupsEnabled: user?.botGroupsEnabled ?? enabled });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar la respuesta en grupos' });
  }
});

export default router;

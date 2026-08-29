import { Router, Request, Response } from 'express';
import { WhatsappService } from '../services/whatsapp.service.js';
import { AuthService } from '../services/auth.service.js';
import { BotContactService } from '../services/botContact.service.js';
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

router.get('/status', async (req: Request, res: Response) => {
  const status = await WhatsappService.getStatusAsync(req.user!.id);
  res.json({ status });
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

// Enciende/apaga que un contacto NUEVO (que escribe por primera vez, todavía no está en
// bot_contacts) arranque con el switch de bot ya prendido en vez de apagado por default — ver
// WhatsappService.handleIncomingMessage / BotContactService.upsert.
router.put('/bot-enabled-for-new-contacts', async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'El campo "enabled" es requerido y debe ser booleano' });
  }

  try {
    const user = await AuthService.setBotEnabledForNewContacts(req.user!.id, enabled);
    res.json({ botEnabledForNewContacts: user?.botEnabledForNewContacts ?? enabled });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar el switch de contactos nuevos' });
  }
});

// "Responder a todos" vs "Responder a contactos seleccionados": con esto prendido, el bot le
// responde a cualquier contacto sin importar su switch en bot_contacts — ver
// WhatsappService.handleIncomingMessage.
router.put('/bot-reply-to-all', async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'El campo "enabled" es requerido y debe ser booleano' });
  }

  try {
    const user = await AuthService.setBotReplyToAll(req.user!.id, enabled);
    res.json({ botReplyToAll: user?.botReplyToAll ?? enabled });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar el modo de respuesta' });
  }
});

// Lista propia y separada de "conversations" para el panel "Bot habilitado por contacto" — ver
// comentario de la tabla bot_contacts en db.ts. Un grupo es una sola fila acá.
router.get('/bot-contacts', async (req: Request, res: Response) => {
  try {
    res.json(await BotContactService.list(req.user!.id));
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener los contactos administrables' });
  }
});

// Sincronización manual, pensada para dispararse una sola vez al abrir el panel (ver
// WhatsappService.syncBotContacts) — no hace nada pesado del lado de WhatsApp, solo relee grupos y
// nombres de contacto que Baileys ya expone sin costo. Devuelve la lista ya actualizada.
router.post('/bot-contacts/sync', async (req: Request, res: Response) => {
  try {
    await WhatsappService.syncBotContacts(req.user!.id);
    res.json(await BotContactService.list(req.user!.id));
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al sincronizar los contactos' });
  }
});

// Intenta resolver el JID real de una lista de nombres (ej. los que ya están renderizados en la
// lista de chats de WhatsApp Web) cruzando contra lo que el backend ya sabe sin llamar a WhatsApp —
// ver WhatsappService.resolveContactsByName. Los que sí se resuelven quedan sembrados en
// bot_contacts (apagados por default, como cualquier alta pasiva — ver seedIfMissing) para que
// aparezcan en la lista sin que el usuario tenga que buscarlos a mano uno por uno.
router.post('/bot-contacts/resolve-names', async (req: Request, res: Response) => {
  const { names } = req.body;
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
    return res.status(400).json({ error: 'El campo "names" es obligatorio y debe ser un arreglo de strings' });
  }
  try {
    const userId = req.user!.id;
    const resolved = await WhatsappService.resolveContactsByName(userId, names);
    for (const r of resolved) {
      if (r.jid) {
        await BotContactService.seedIfMissing(userId, r.jid, r.name, false);
      }
    }
    res.json(resolved);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al resolver los contactos por nombre' });
  }
});

// "Recargar" un contacto puntual: el frontend ya reabrió su chat y volvió a leer su nombre/número
// real del DOM (por si había quedado mal agregado, ej. con un @lid viejo) — acá solo se corrige el
// JID/nombre de esa fila. Ver BotContactService.updateIdentity.
router.put('/bot-contacts/:id/identity', async (req: Request, res: Response) => {
  const { phone, name } = req.body;
  if (typeof phone !== 'string' || !phone.trim()) {
    return res.status(400).json({ error: 'El campo "phone" es obligatorio' });
  }
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'El campo "name" es obligatorio' });
  }
  try {
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    if (!cleanPhone) {
      return res.status(400).json({ error: 'El número de teléfono no es válido' });
    }
    const jid = `${cleanPhone}@s.whatsapp.net`;
    const updated = await BotContactService.updateIdentity(Number(req.params.id), jid, name.trim());
    if (!updated) return res.status(404).json({ error: 'Contacto no encontrado' });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al recargar el contacto' });
  }
});

// Botón "X" del panel: borra un contacto/grupo puntual de bot_contacts. Solo afecta esta lista
// propia — nunca conversations/messages.
router.delete('/bot-contacts/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await BotContactService.delete(req.user!.id, Number(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Contacto no encontrado' });
    res.json({ status: 'deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al borrar el contacto' });
  }
});

router.put('/bot-contacts/:id/enabled', async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'El campo "enabled" es obligatorio y debe ser booleano' });
  }

  try {
    const contact = await BotContactService.setEnabled(Number(req.params.id), enabled);
    if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' });
    res.json(contact);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar el switch del contacto' });
  }
});

// Registra (o encuentra) un número de teléfono como contacto administrable, con el switch en el
// estado indicado — útil para prender el bot a un número que todavía no le escribió nunca al bot.
router.post('/bot-contacts', async (req: Request, res: Response) => {
  const { phone, name, enabled } = req.body;
  if (typeof phone !== 'string' || !phone.trim()) {
    return res.status(400).json({ error: 'El campo "phone" es obligatorio' });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'El campo "enabled" es obligatorio y debe ser booleano' });
  }

  try {
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    if (!cleanPhone) {
      return res.status(400).json({ error: 'El número de teléfono no es válido' });
    }
    const jid = `${cleanPhone}@s.whatsapp.net`;
    const contact = await BotContactService.addManual(req.user!.id, jid, name?.trim() || cleanPhone, enabled);
    res.json(contact);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al registrar el número de teléfono' });
  }
});

// Transcribe un audio por su identificador de mensaje a demanda vía Baileys
router.post('/transcribe-audio', async (req: Request, res: Response) => {
  try {
    const { dataId } = req.body;
    if (!dataId || typeof dataId !== 'string') {
      return res.status(400).json({ error: 'El campo "dataId" es obligatorio' });
    }

    const transcription = await WhatsappService.transcribeAudioByDataId(req.user!.id, dataId);
    res.json({ success: true, transcription });
  } catch (error: any) {
    console.error('❌ [WhatsApp Route] Error en /transcribe-audio:', error?.message || error);
    res.status(500).json({ error: error.message || 'Error al transcribir audio' });
  }
});

export default router;

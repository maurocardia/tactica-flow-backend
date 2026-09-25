import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { WhatsappService } from '../services/whatsapp.service.js';
import { AuthService, AiPromptSections, AiGeneralRules, BotMode } from '../services/auth.service.js';
import { BotContactService, UNLIMITED_RESERVATION_MINUTES } from '../services/botContact.service.js';
import { AdvisorService } from '../services/advisor.service.js';
import { FlowMediaService } from '../services/flowMedia.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { io } from '../server.js';

const router = Router();

// Adjuntos multimedia de nodos de flujo (Enviar Imagen/Video/Audio/Documento): a diferencia del
// uploader de la Base de Conocimiento (sin límite, uso interno del equipo), acá sí se pone un
// techo — 16 MB es el límite práctico de WhatsApp para adjuntos inline, y evita inflar Postgres
// (los bytes se guardan en flow_media_assets.data, ver FlowMediaService) con archivos que de todas
// formas WhatsApp va a rechazar.
const flowMediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

/** Mismo wrapper que knowledgeBase.routes.ts: multer reporta errores vía next(err), no con throw. */
function handleFlowMediaUpload(req: Request, res: Response, next: NextFunction) {
  flowMediaUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Error al procesar el archivo subido';
      return res.status(400).json({ error: message });
    }
    next();
  });
}

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

// Agente de IA Modular (Issue #21/#25 [EPIC #10]): apartados de texto libre + switches de
// "Reglas generales" que reemplazan el textarea único de ai-custom-instructions en el formulario
// nuevo (ver AiAgentConfigModal.tsx en el frontend). El backend compone el texto final y lo
// guarda en ai_custom_instructions en la misma operación — ver AuthService.setAiPromptConfig.
const AI_PROMPT_SECTION_FIELDS = ['behavior', 'objective', 'rules', 'tone', 'companyInfo', 'callToAction', 'notes'] as const;
const AI_PROMPT_MAX_CHARS = 18000;
const AI_GENERAL_RULE_TOGGLES = [
  'followClientLanguage', 'noSwearing', 'neverInvent', 'shortAnswers', 'focusOnCompany',
  'addressByFirstName', 'noSpecialCharacters', 'noEmojis', 'offerHumanAgent', 'protectSensitiveData'
] as const;
const VALID_LANGUAGES = ['es', 'pt-BR', 'en'];
const DEFAULT_GENERAL_RULES: AiGeneralRules = {
  mainLanguage: 'es',
  followClientLanguage: true,
  noSwearing: true,
  neverInvent: true,
  shortAnswers: true,
  focusOnCompany: true,
  addressByFirstName: true,
  noSpecialCharacters: true,
  noEmojis: false,
  offerHumanAgent: true,
  protectSensitiveData: true
};

router.put('/ai-prompt-config', async (req: Request, res: Response) => {
  const body = req.body || {};
  const sectionsInput = body.sections || {};
  const rulesInput = body.generalRules || {};

  const sections: AiPromptSections = { behavior: '', objective: '', rules: '', tone: '', companyInfo: '', callToAction: '', notes: '' };
  let totalChars = 0;
  for (const field of AI_PROMPT_SECTION_FIELDS) {
    const value = sectionsInput[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      return res.status(400).json({ error: `El campo "sections.${field}" debe ser una cadena de texto` });
    }
    sections[field] = value;
    totalChars += value.length;
  }

  if (totalChars > AI_PROMPT_MAX_CHARS) {
    return res.status(400).json({
      error: `Los apartados superan el límite de ${AI_PROMPT_MAX_CHARS.toLocaleString('es-AR')} caracteres entre todos los campos (tiene ${totalChars.toLocaleString('es-AR')}).`
    });
  }

  const mainLanguage = rulesInput.mainLanguage;
  if (mainLanguage !== undefined && !VALID_LANGUAGES.includes(mainLanguage)) {
    return res.status(400).json({ error: `El campo "generalRules.mainLanguage" debe ser uno de: ${VALID_LANGUAGES.join(', ')}` });
  }

  const generalRules: AiGeneralRules = { ...DEFAULT_GENERAL_RULES, mainLanguage: mainLanguage ?? DEFAULT_GENERAL_RULES.mainLanguage };
  for (const key of AI_GENERAL_RULE_TOGGLES) {
    const value = rulesInput[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      return res.status(400).json({ error: `El campo "generalRules.${key}" debe ser booleano` });
    }
    generalRules[key] = value;
  }

  try {
    const result = await AuthService.setAiPromptConfig(req.user!.id, { sections, generalRules });
    res.json(result ?? { aiPromptConfig: { sections, generalRules }, aiCustomInstructions: AuthService.composeAiPrompt({ sections, generalRules }) });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar la configuración del agente de IA' });
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

// "Delay humanizado": espera un tiempo aleatorio entre minMs y maxMs antes de mandar la
// respuesta del bot — ver ChatbotModule.tsx (sección "replyDelay") y
// WhatsappService.handleIncomingMessage.
const DELAY_MS_MIN_ALLOWED = 0;
const DELAY_MS_MAX_ALLOWED = 60_000; // 1 minuto: un delay mayor no tiene sentido para un chat
router.put('/bot-reply-delay', async (req: Request, res: Response) => {
  const { enabled, minMs, maxMs } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'El campo "enabled" es requerido y debe ser booleano' });
  }
  if (minMs !== undefined && (typeof minMs !== 'number' || minMs < DELAY_MS_MIN_ALLOWED || minMs > DELAY_MS_MAX_ALLOWED)) {
    return res.status(400).json({ error: `El campo "minMs" debe ser un número entre ${DELAY_MS_MIN_ALLOWED} y ${DELAY_MS_MAX_ALLOWED}` });
  }
  if (maxMs !== undefined && (typeof maxMs !== 'number' || maxMs < DELAY_MS_MIN_ALLOWED || maxMs > DELAY_MS_MAX_ALLOWED)) {
    return res.status(400).json({ error: `El campo "maxMs" debe ser un número entre ${DELAY_MS_MIN_ALLOWED} y ${DELAY_MS_MAX_ALLOWED}` });
  }
  if (typeof minMs === 'number' && typeof maxMs === 'number' && minMs > maxMs) {
    return res.status(400).json({ error: 'El "minMs" no puede ser mayor que el "maxMs"' });
  }

  try {
    const user = await AuthService.setBotReplyDelay(req.user!.id, { enabled, minMs, maxMs });
    res.json({
      botReplyDelayEnabled: user?.botReplyDelayEnabled ?? enabled,
      botReplyDelayMinMs: user?.botReplyDelayMinMs,
      botReplyDelayMaxMs: user?.botReplyDelayMaxMs
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar el delay humanizado' });
  }
});

// Minutos que dura la reserva de un asesor antes de vencer sola (ver AdvisorService.
// getReservationMinutes/DEFAULT_HANDOFF_RESERVATION_MINUTES) — configurable por cuenta.
// UNLIMITED_RESERVATION_MINUTES (0) es válido a propósito: "sin límite", ver
// BotContactService.reserveHandoffAdvisor.
const HANDOFF_RESERVATION_MINUTES_MIN = UNLIMITED_RESERVATION_MINUTES;
const HANDOFF_RESERVATION_MINUTES_MAX = 1440; // 24 horas: un límite más alto no tiene sentido práctico
router.put('/handoff-reservation-minutes', async (req: Request, res: Response) => {
  const { minutes } = req.body;
  if (
    typeof minutes !== 'number' ||
    !Number.isInteger(minutes) ||
    minutes < HANDOFF_RESERVATION_MINUTES_MIN ||
    minutes > HANDOFF_RESERVATION_MINUTES_MAX
  ) {
    return res.status(400).json({
      error: `El campo "minutes" debe ser un entero entre ${HANDOFF_RESERVATION_MINUTES_MIN} y ${HANDOFF_RESERVATION_MINUTES_MAX} (${UNLIMITED_RESERVATION_MINUTES} = sin límite)`
    });
  }

  try {
    const user = await AuthService.setHandoffReservationMinutes(req.user!.id, minutes);
    res.json({ handoffReservationMinutes: user?.handoffReservationMinutes ?? minutes });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar la duración de la reserva de asesor' });
  }
});

// Cada cuántos segundos un cliente en la cola de espera (sin asesor todavía) recibe un mensaje con
// su posición actual — ver AdvisorQueueService/AdvisorQueueWorker. En segundos (no minutos, como
// antes) para poder configurar recordatorios de menos de un minuto.
const QUEUE_REMINDER_SECONDS_MIN = 5;
const QUEUE_REMINDER_SECONDS_MAX = 86400; // 24 horas
router.put('/queue-reminder-seconds', async (req: Request, res: Response) => {
  const { seconds } = req.body;
  if (
    typeof seconds !== 'number' ||
    !Number.isInteger(seconds) ||
    seconds < QUEUE_REMINDER_SECONDS_MIN ||
    seconds > QUEUE_REMINDER_SECONDS_MAX
  ) {
    return res.status(400).json({
      error: `El campo "seconds" debe ser un entero entre ${QUEUE_REMINDER_SECONDS_MIN} y ${QUEUE_REMINDER_SECONDS_MAX}`
    });
  }

  try {
    const user = await AuthService.setQueueReminderSeconds(req.user!.id, seconds);
    res.json({ queueReminderSeconds: user?.queueReminderSeconds ?? seconds });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar el intervalo de recordatorio de la cola' });
  }
});

// Timeout de inactividad de un relay YA ACTIVO (distinto de handoff-reservation-minutes, que es
// la ventana antes/al asignar) — ver AdvisorService.getRelayInactivityMinutes.
const RELAY_INACTIVITY_MINUTES_MIN = 1;
const RELAY_INACTIVITY_MINUTES_MAX = 1440;
router.put('/relay-inactivity-minutes', async (req: Request, res: Response) => {
  const { minutes } = req.body;
  if (
    typeof minutes !== 'number' ||
    !Number.isInteger(minutes) ||
    minutes < RELAY_INACTIVITY_MINUTES_MIN ||
    minutes > RELAY_INACTIVITY_MINUTES_MAX
  ) {
    return res.status(400).json({
      error: `El campo "minutes" debe ser un entero entre ${RELAY_INACTIVITY_MINUTES_MIN} y ${RELAY_INACTIVITY_MINUTES_MAX}`
    });
  }

  try {
    const user = await AuthService.setRelayInactivityMinutes(req.user!.id, minutes);
    res.json({ relayInactivityMinutes: user?.relayInactivityMinutes ?? minutes });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar el timeout de inactividad del relay' });
  }
});

// Palabra(s) clave para que el asesor cierre la atención (antes fija: "FIN"/"LISTO") — lista
// separada por comas, ver AdvisorService.getFinishKeywords.
const FINISH_KEYWORDS_MAX_LEN = 200;
router.put('/advisor-finish-keywords', async (req: Request, res: Response) => {
  const { keywords } = req.body;
  if (typeof keywords !== 'string' || !keywords.trim() || keywords.length > FINISH_KEYWORDS_MAX_LEN) {
    return res.status(400).json({
      error: `El campo "keywords" es requerido, no puede estar vacío, y debe tener como máximo ${FINISH_KEYWORDS_MAX_LEN} caracteres`
    });
  }

  try {
    const user = await AuthService.setAdvisorFinishKeywords(req.user!.id, keywords.trim());
    res.json({ advisorFinishKeywords: user?.advisorFinishKeywords ?? keywords.trim() });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar la palabra de cierre del asesor' });
  }
});

// Minutos que la IA queda muda para un cliente DESPUÉS de que se cierra su atención humana — 0 =
// reactivar de inmediato. Ver AdvisorService.getAiPauseAfterCloseMinutes.
const AI_PAUSE_AFTER_ADVISOR_MINUTES_MIN = 0;
const AI_PAUSE_AFTER_ADVISOR_MINUTES_MAX = 1440;
router.put('/ai-pause-after-advisor-minutes', async (req: Request, res: Response) => {
  const { minutes } = req.body;
  if (
    typeof minutes !== 'number' ||
    !Number.isInteger(minutes) ||
    minutes < AI_PAUSE_AFTER_ADVISOR_MINUTES_MIN ||
    minutes > AI_PAUSE_AFTER_ADVISOR_MINUTES_MAX
  ) {
    return res.status(400).json({
      error: `El campo "minutes" debe ser un entero entre ${AI_PAUSE_AFTER_ADVISOR_MINUTES_MIN} y ${AI_PAUSE_AFTER_ADVISOR_MINUTES_MAX}`
    });
  }

  try {
    const user = await AuthService.setAiPauseAfterAdvisorMinutes(req.user!.id, minutes);
    res.json({ aiPauseAfterAdvisorMinutes: user?.aiPauseAfterAdvisorMinutes ?? minutes });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar la pausa de IA post-atención' });
  }
});

// Modo de respuesta del bot (Híbrido/Solo IA/Solo Flujos) — ver ChatbotModule.tsx y
// BotEngineService.processIncomingMessage.
const VALID_BOT_MODES: BotMode[] = ['flow_only', 'ai_only', 'hybrid'];
router.put('/bot-mode', async (req: Request, res: Response) => {
  const { mode } = req.body;
  if (typeof mode !== 'string' || !VALID_BOT_MODES.includes(mode as BotMode)) {
    return res.status(400).json({ error: `El campo "mode" debe ser uno de: ${VALID_BOT_MODES.join(', ')}` });
  }

  try {
    const user = await AuthService.setBotMode(req.user!.id, mode as BotMode);
    res.json({ botMode: user?.botMode ?? mode });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar el modo de respuesta del bot' });
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

// Libera la reserva de asesor de un contacto (bloque "Contactar Asesor" del flujo) — botón
// "Finalizar atención" de la tarjeta del chat activo. NO afecta si el bot responde (nunca lo
// bloqueó) — solo permite que un próximo pedido de asesor elija a cualquiera sin esperar los 30
// minutos. A diferencia de PUT /bot-contacts/:id/resume-bot (de abajo, usado desde la lista de
// Contactos del panel, donde ya se conoce el id de la fila), este va por jid/teléfono porque el
// chat activo solo expone eso.
router.post('/bot-contacts/unpause', async (req: Request, res: Response) => {
  const { jid, phone } = req.body;
  let targetJid: string | undefined = typeof jid === 'string' && jid.trim() ? jid.trim() : undefined;
  if (!targetJid && typeof phone === 'string' && phone.trim()) {
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone) targetJid = `${cleanPhone}@s.whatsapp.net`;
  }
  if (!targetJid) {
    return res.status(400).json({ error: 'Se requiere "jid" o "phone"' });
  }

  try {
    // finishAdvisory libera la reserva y, si había una vigente, le avisa al cliente que el asesor
    // se fue (liberación manual, no por palabra de cierre — ver AdvisorService).
    await AdvisorService.finishAdvisory(req.user!.id, targetJid);
    io.emit('bot_contact_updated', { jid: targetJid, handoffExpiresAt: null });
    res.json({ jid: targetJid, handoffExpiresAt: null });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al liberar la reserva de asesor de este contacto' });
  }
});

// Libera la reserva de asesor de un contacto — botón "Liberar asesor" del panel.
router.put('/bot-contacts/:id/resume-bot', async (req: Request, res: Response) => {
  try {
    const result = await BotContactService.clearHandoffPause(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Contacto no encontrado' });
    if (result.hadActiveReservation) {
      AdvisorService.notifyCustomerAdvisorLeft(result.contact.userId, result.contact.jid).catch((err) => {
        console.error('⚠️ [whatsapp.routes] No se pudo avisarle al cliente que el asesor se fue tras liberarlo:', err);
      });
    }
    res.json(result.contact);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al liberar la reserva de asesor de este contacto' });
  }
});

// Blacklist (pestaña junto a Contactos/Grupos en el panel): bloquea/desbloquea un contacto ya
// existente en bot_contacts — bloquearlo apaga bot_enabled automáticamente (ver
// BotContactService.setBlacklisted).
router.put('/bot-contacts/:id/blacklisted', async (req: Request, res: Response) => {
  const { blacklisted } = req.body;
  if (typeof blacklisted !== 'boolean') {
    return res.status(400).json({ error: 'El campo "blacklisted" es obligatorio y debe ser booleano' });
  }

  try {
    const contact = await BotContactService.setBlacklisted(Number(req.params.id), blacklisted);
    if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' });
    res.json(contact);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar la blacklist' });
  }
});

// Alta directa a la blacklist (número que nunca le escribió al bot pero se quiere bloquear igual,
// mismo patrón que el alta manual de POST /bot-contacts de abajo).
router.post('/bot-contacts/blacklist', async (req: Request, res: Response) => {
  const { phone, name } = req.body;
  if (typeof phone !== 'string' || !phone.trim()) {
    return res.status(400).json({ error: 'El campo "phone" es obligatorio' });
  }

  try {
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    if (!cleanPhone) {
      return res.status(400).json({ error: 'El número de teléfono no es válido' });
    }
    const jid = `${cleanPhone}@s.whatsapp.net`;
    const contact = await BotContactService.addToBlacklist(req.user!.id, jid, name?.trim() || cleanPhone);
    res.json(contact);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al bloquear el número de teléfono' });
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

// Importación masiva desde CSV/Excel ya parseado en el frontend (ver BulkImportPreview.tsx) —
// crea o actualiza (matcheando por teléfono) en bot_contacts, reusando BotContactService.addManual
// fila por fila para no duplicar la lógica de upsert/normalización de JID.
const BULK_IMPORT_MAX_ROWS = 2000;
router.post('/bot-contacts/bulk-import', async (req: Request, res: Response) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts)) {
    return res.status(400).json({ error: 'El campo "contacts" es obligatorio y debe ser un arreglo' });
  }
  if (contacts.length > BULK_IMPORT_MAX_ROWS) {
    return res.status(400).json({ error: `Máximo ${BULK_IMPORT_MAX_ROWS} contactos por importación` });
  }

  try {
    const result = await BotContactService.bulkImport(req.user!.id, contacts);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al importar los contactos' });
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

// Asesores humanos (panel: botón "Asesores" en ChatbotModule.tsx, AdvisorManagerModal.tsx) — a
// quién deriva el bot una conversación cuando decide que necesita intervención humana. Ver
// AdvisorService para la selección equitativa (pickNextAdvisor); estos endpoints solo
// administran el padrón (alta/edición/baja/reseteo de contadores).
// Le suma a cada asesor el cliente que tiene en relay activo AHORA MISMO (si tiene uno) — para que
// el panel pueda mostrar "Atendiendo a: Fulano" y habilitar/deshabilitar el botón "Liberar" sin
// tener que abrir cada fila. N consultas chicas (una por asesor, listas de pocas filas) en vez de
// una sola con JOIN: no vale la pena la complejidad para un endpoint que no es de uso masivo.
router.get('/advisors', async (req: Request, res: Response) => {
  try {
    const advisors = await AdvisorService.list(req.user!.id);
    const withActiveClient = await Promise.all(
      advisors.map(async (advisor) => ({
        ...advisor,
        activeClient: await BotContactService.getActiveClientForAdvisor(req.user!.id, advisor.id)
      }))
    );
    res.json(withActiveClient);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener los asesores' });
  }
});

// Libera al cliente que este asesor tiene asignado ahora mismo — botón "Liberar" de la fila del
// asesor en el panel (a diferencia de POST /bot-contacts/unpause y PUT /bot-contacts/:id/resume-bot,
// que van por el contacto/chat; acá solo se conoce el asesor). Ver AdvisorService.releaseByAdvisorId.
router.post('/advisors/:id/release', async (req: Request, res: Response) => {
  try {
    const result = await AdvisorService.releaseByAdvisorId(req.user!.id, Number(req.params.id));
    if (result === 'no_active_reservation') {
      return res.status(409).json({ error: 'Este asesor no tiene ningún cliente asignado ahora mismo' });
    }
    res.json({ released: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al liberar al asesor' });
  }
});

router.post('/advisors', async (req: Request, res: Response) => {
  const { name, phone } = req.body;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'El campo "name" es obligatorio' });
  }
  if (typeof phone !== 'string' || !phone.trim()) {
    return res.status(400).json({ error: 'El campo "phone" es obligatorio' });
  }
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  if (cleanPhone.length < 8) {
    return res.status(400).json({ error: 'El número de teléfono no es válido' });
  }

  try {
    const advisor = await AdvisorService.create(req.user!.id, name.trim(), cleanPhone);
    // activeClient siempre null acá (recién se crea, no puede tener ningún relay activo todavía)
    // — se agrega para que la forma coincida con GET /advisors, que sí lo trae (ver Advisor en el
    // frontend: activeClient no es opcional).
    res.json({ ...advisor, activeClient: null });
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un asesor con ese número de teléfono' });
    }
    res.status(500).json({ error: error.message || 'Error al crear el asesor' });
  }
});

router.put('/advisors/:id', async (req: Request, res: Response) => {
  const { name, phone, isActive } = req.body;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'El campo "name" no puede quedar vacío' });
  }
  if (phone !== undefined && (typeof phone !== 'string' || !phone.trim())) {
    return res.status(400).json({ error: 'El campo "phone" no puede quedar vacío' });
  }
  if (isActive !== undefined && typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'El campo "isActive" debe ser booleano' });
  }

  let cleanPhone: string | undefined;
  if (phone !== undefined) {
    const digits: string = phone.replace(/[^0-9]/g, '');
    if (digits.length < 8) {
      return res.status(400).json({ error: 'El número de teléfono no es válido' });
    }
    cleanPhone = digits;
  }

  try {
    const advisor = await AdvisorService.update(req.user!.id, Number(req.params.id), {
      name: name?.trim(),
      phone: cleanPhone,
      isActive
    });
    if (!advisor) return res.status(404).json({ error: 'Asesor no encontrado' });
    // Misma razón que en POST /advisors: la forma tiene que coincidir con GET /advisors (activeClient
    // no es opcional en el tipo del frontend).
    const activeClient = await BotContactService.getActiveClientForAdvisor(req.user!.id, advisor.id);
    res.json({ ...advisor, activeClient });
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un asesor con ese número de teléfono' });
    }
    res.status(500).json({ error: error.message || 'Error al actualizar el asesor' });
  }
});

router.delete('/advisors/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await AdvisorService.delete(req.user!.id, Number(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Asesor no encontrado' });
    res.json({ status: 'deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al borrar el asesor' });
  }
});

router.post('/advisors/reset-counts', async (req: Request, res: Response) => {
  try {
    await AdvisorService.resetCounts(req.user!.id);
    res.json({ status: 'ok' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al resetear los contadores' });
  }
});

// --- Adjuntos multimedia de nodos de flujo (Enviar Imagen/Video/Audio/Documento) --------------

const FLOW_MEDIA_KINDS = ['image', 'video', 'audio', 'document'];

router.get('/flow-media', async (req: Request, res: Response) => {
  try {
    res.json(await FlowMediaService.list(req.user!.id));
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al listar los adjuntos' });
  }
});

router.post('/flow-media', handleFlowMediaUpload, async (req: Request, res: Response) => {
  const kind = req.body?.kind;
  if (!FLOW_MEDIA_KINDS.includes(kind)) {
    return res.status(400).json({ error: `El campo "kind" debe ser uno de: ${FLOW_MEDIA_KINDS.join(', ')}` });
  }
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    return res.status(400).json({ error: 'Falta el archivo ("file")' });
  }
  if (!FlowMediaService.isMimeAllowed(kind, file.mimetype)) {
    return res.status(400).json({ error: `Tipo de archivo no permitido para "${kind}": ${file.mimetype}` });
  }

  try {
    const asset = await FlowMediaService.create(req.user!.id, kind, file.originalname, file.mimetype, file.buffer);
    res.json(asset);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al subir el adjunto' });
  }
});

// Bytes crudos para el preview en el editor de flujos (<img src>, <video>, etc. no pueden llevar
// el header Authorization — por eso esta ruta va detrás de authMiddleware igual que el resto,
// pero el frontend la consume con un fetch autenticado que arma un blob: URL, no un <img src>
// directo — ver ApiService.fetchFlowMediaBlob).
router.get('/flow-media/:id/raw', async (req: Request, res: Response) => {
  try {
    const asset = await FlowMediaService.getByIdWithData(req.user!.id, Number(req.params.id));
    if (!asset) return res.status(404).json({ error: 'Adjunto no encontrado' });
    res.setHeader('Content-Type', asset.mimeType);
    res.send(asset.data);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener el adjunto' });
  }
});

router.delete('/flow-media/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await FlowMediaService.delete(req.user!.id, Number(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Adjunto no encontrado' });
    res.json({ status: 'deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al borrar el adjunto' });
  }
});

export default router;

import { Router, Request, Response } from 'express';
import { TacticaApiService } from '../services/tacticaApi.service.js';
import { AIService } from '../services/ai.service.js';
import { BotEngineService } from '../services/botEngine.service.js';
import { KeywordRuleService, type RuleAction } from '../services/keywordRule.service.js';
import { ConversationService, type MessageSender } from '../services/conversation.service.js';
import { AuthService } from '../services/auth.service.js';
import { KnowledgeBaseService } from '../services/knowledgeBase.service.js';
import { io } from '../server.js';

const router = Router();

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'Tactica Flow Backend (TypeScript)', timestamp: new Date() });
});

// Endpoint principal del Motor del Bot Auto-Responder
router.post('/bot/reply', async (req: Request, res: Response) => {
  try {
    const { message, phone, history, tacticaCredentials } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'El campo "message" es obligatorio' });
    }

    const result = await BotEngineService.processIncomingMessage(
      message,
      phone || '5491100000000',
      history || [],
      tacticaCredentials || {}
    );

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error en el motor del Bot Auto-Responder' });
  }
});

// Proxy a Empresas de Táctica
router.post('/tactica/companies', async (req: Request, res: Response) => {
  try {
    const { usuario, contrasena, ...params } = req.body;
    const result = await TacticaApiService.getCompanies({ usuario, contrasena }, params);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener empresas de Táctica' });
  }
});

// Proxy a Contactos de Táctica
router.post('/tactica/contacts', async (req: Request, res: Response) => {
  try {
    const { usuario, contrasena, ...params } = req.body;
    const result = await TacticaApiService.getContacts({ usuario, contrasena }, params);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener contactos de Táctica' });
  }
});

// Usado por utilidades de IA del panel (resumir charla, redactar, etc. — NO es el bot que le
// responde a clientes, ver /bot/reply para eso), así que corre en modo "utility": sin el system
// prompt estricto de "solo responder desde la Base de Conocimiento" (si no, se negaba a resumir
// diciendo "no tengo una base de conocimiento configurada" en vez de hacer la tarea pedida).
router.post('/ai/chat', async (req: Request, res: Response) => {
  try {
    const { message, history, tacticaCredentials } = req.body;
    const aiResponse = await AIService.processMessage(message, history || [], tacticaCredentials || {}, '', '', 'utility');
    res.json({ reply: aiResponse });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al procesar consulta de IA' });
  }
});

// Endpoint para redactar borradores de respuestas con IA según tono, contexto y Base de Conocimiento
router.post('/ai/draft', async (req: Request, res: Response) => {
  try {
    const { conversationText, contactName, tone, instruction, userPrompt } = req.body;

    if (!conversationText) {
      return res.status(400).json({ error: 'El historial de la conversación (conversationText) es obligatorio.' });
    }

    // 1. Consultar prioritariamente la Base de Conocimiento activa
    // Priorizamos las instrucciones o prompt del asesor y limpiamos URLs del historial
    const cleanConversation = conversationText.replace(/https?:\/\/\S+/gi, ' ').slice(-400);
    const searchTarget = `${instruction || ''} ${userPrompt || ''} ${cleanConversation}`.trim();
    let knowledgeContext = '';
    let foundInKb = false;
    let baseIds: number[] = [];

    try {
      const active = await KnowledgeBaseService.getActiveContext(searchTarget);
      if (active.context && active.isRelevant) {
        // isRelevant=true significa que el RAG encontró coincidencias reales con términos de la KB
        knowledgeContext = active.context;
        foundInKb = true;
        baseIds = active.baseIds;
      } else if (active.context) {
        // Hay KB activa pero ningún fragmento es relevante para la consulta: pasamos contexto a la IA
        // pero NO mostramos badge de "respaldado" porque la KB no habla del tema
        knowledgeContext = active.context;
        foundInKb = false;
        baseIds = active.baseIds;
      }
    } catch (kbErr) {
      console.warn('⚠️ [API /ai/draft] Error consultando Base de Conocimiento:', kbErr);
    }

    const { draft } = await AIService.draftReply({
      conversationText,
      contactName,
      tone,
      instruction,
      userPrompt,
      knowledgeContext,
      foundInKb
    });

    res.json({
      success: true,
      draft,
      foundInKb,
      sourceKbIds: baseIds
    });
  } catch (error: any) {
    console.error('❌ Error en /api/ai/draft:', error);
    res.status(500).json({ error: error.message || 'Error al generar borrador de respuesta' });
  }
});

// Endpoint para transcribir audios / notas de voz con IA
router.post('/ai/transcribe', async (req: Request, res: Response) => {
  try {
    const { audioBase64, mimeType = 'audio/ogg' } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: 'Se requiere el audio en formato base64 (audioBase64).' });
    }

    let detectedMime = mimeType;
    if (typeof audioBase64 === 'string' && audioBase64.startsWith('data:')) {
      const match = audioBase64.match(/^data:([^;]+);/);
      if (match && match[1]) {
        detectedMime = match[1];
      }
    }

    const cleanBase64 = typeof audioBase64 === 'string' && audioBase64.includes('base64,')
      ? audioBase64.split('base64,')[1]
      : audioBase64;

    const audioBuffer = Buffer.from(cleanBase64, 'base64');

    const transcription = await AIService.transcribeAudio(audioBuffer, detectedMime);

    res.json({ success: true, transcription });
  } catch (error: any) {
    console.error('❌ Error en /api/ai/transcribe:', error?.message || error);
    res.status(500).json({ error: error.message || 'Error al transcribir el audio' });
  }
});

// Conversation Management Endpoints
router.get('/conversations', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    res.json(await ConversationService.listConversations(userId));
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener conversaciones' });
  }
});

router.get('/conversations/:id/messages', async (req: Request, res: Response) => {
  try {
    const conversationId = Number(req.params.id);
    const messages = await ConversationService.getMessages(conversationId);

    if (messages === null) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    res.json(messages);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener mensajes' });
  }
});

router.post('/conversations/:id/messages', async (req: Request, res: Response) => {
  try {
    const conversationId = Number(req.params.id);
    const { text, sender = 'agent' } = req.body;

    // Validate text
    if (!text || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'El campo "text" es obligatorio y debe ser una cadena no vacía' });
    }

    // Check conversation exists
    const conversation = await ConversationService.getConversation(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    // Add customer/agent message
    const result = await ConversationService.addMessage(conversationId, sender as MessageSender, text.trim());
    if (!result) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const responseMessages = [result.message];

    // Emit new message to the chat room
    io.to(`chat_${conversationId}`).emit('new_message', result.message);
    // Broadcast conversation update to everyone
    io.emit('conversation_updated', result.conversation);

    // Bot auto-reply if customer message in bot mode
    if (sender === 'customer' && conversation.status === 'bot') {
      // Historial previo a este mensaje (que ya se logueó arriba como `result.message`), para
      // que la IA tenga contexto de la conversación en vez de responder cada mensaje aislado.
      const priorMessages = (await ConversationService.getMessages(conversationId)) ?? [];
      const activeBaseIds = await KnowledgeBaseService.getActiveBaseIds();
      const history = ConversationService.toAiHistory(
        priorMessages.filter((msg) => msg.id !== result.message.id),
        activeBaseIds
      );

      // Conversaciones sin dueño (legacy, de antes del multi-tenant de WhatsApp) no tienen de
      // quién leer la preferencia: se mantiene el comportamiento histórico (fallback a IA on,
      // sin instrucciones personalizadas).
      const owner = conversation.userId ? await AuthService.getUserById(conversation.userId) : null;
      const aiFallbackEnabled = owner?.aiFallbackEnabled ?? true;

      const botResult = await BotEngineService.processIncomingMessage(
        text.trim(),
        conversation.phone,
        history,
        {},
        aiFallbackEnabled,
        owner?.aiCustomInstructions ?? ''
      );

      const botReplyResult = botResult
        ? await ConversationService.addMessage(conversationId, 'bot', botResult.replyText, botResult.sourceKbIds)
        : null;

      if (botReplyResult) {
        responseMessages.push(botReplyResult.message);
        // Emit bot message to the chat room
        io.to(`chat_${conversationId}`).emit('new_message', botReplyResult.message);
        // Broadcast conversation update to everyone
        io.emit('conversation_updated', botReplyResult.conversation);
      }
    }

    res.json({ messages: responseMessages });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al procesar el mensaje' });
  }
});

// Sincroniza los mensajes del chat con PostgreSQL (reemplazo o adición)
router.post('/conversations/sync', async (req: Request, res: Response) => {
  try {
    const { phone, name, userId = 1, groupName, messages = [], mode = 'replace' } = req.body;

    if (!phone || !name) {
      return res.status(400).json({ error: 'phone y name son obligatorios' });
    }

    const conversation = await ConversationService.syncMessages({
      phone,
      name,
      userId: Number(userId),
      groupName: groupName || null,
      messages,
      mode
    });

    res.json({ status: 'ok', conversation, syncedCount: messages.length });
  } catch (error: any) {
    console.error('❌ Error en /conversations/sync:', error);
    res.status(500).json({ error: error.message || 'Error al sincronizar conversación' });
  }
});

// Vacía los mensajes de una conversación en PostgreSQL (si el usuario borró el chat)
router.delete('/conversations/:id/messages', async (req: Request, res: Response) => {
  try {
    const conversationId = Number(req.params.id);
    await ConversationService.clearMessages(conversationId);
    res.json({ status: 'ok', message: 'Mensajes eliminados correctamente' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al vaciar mensajes' });
  }
});

// Keyword Rule Management Endpoints
router.get('/bot/rules', async (req: Request, res: Response) => {
  try {
    res.json(await KeywordRuleService.listRules());
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener las reglas' });
  }
});

router.post('/bot/rules', async (req: Request, res: Response) => {
  try {
    const { name, keywords, replyText, action, isActive } = req.body;

    // Validate name
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'El campo "name" es obligatorio y debe ser una cadena no vacía' });
    }

    // Validate keywords
    if (!Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'El campo "keywords" debe ser un array no vacío' });
    }

    const trimmedKeywords = keywords.map((kw: any) => (typeof kw === 'string' ? kw.trim() : '')).filter((kw: string) => kw.length > 0);
    if (trimmedKeywords.length === 0) {
      return res.status(400).json({ error: 'El campo "keywords" debe contener al menos una palabra clave no vacía' });
    }

    // Validate replyText
    if (!replyText || typeof replyText !== 'string' || replyText.trim() === '') {
      return res.status(400).json({ error: 'El campo "replyText" es obligatorio y debe ser una cadena no vacía' });
    }

    const createdRule = await KeywordRuleService.createRule({
      name,
      keywords: trimmedKeywords,
      replyText,
      action: action as RuleAction | undefined,
      isActive
    });

    res.status(201).json(createdRule);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al crear la regla' });
  }
});

router.put('/bot/rules/:id', async (req: Request, res: Response) => {
  try {
    const id = typeof req.params.id === 'string' ? req.params.id : String(req.params.id);
    const { name, keywords, replyText, action, isActive } = req.body;

    // Validate each field if present
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'El campo "name" debe ser una cadena no vacía' });
      }
    }

    let trimmedKeywords: string[] | undefined;
    if (keywords !== undefined) {
      if (!Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({ error: 'El campo "keywords" debe ser un array no vacío' });
      }

      trimmedKeywords = keywords.map((kw: any) => (typeof kw === 'string' ? kw.trim() : '')).filter((kw: string) => kw.length > 0);
      if (trimmedKeywords.length === 0) {
        return res.status(400).json({ error: 'El campo "keywords" debe contener al menos una palabra clave no vacía' });
      }
    }

    if (replyText !== undefined) {
      if (typeof replyText !== 'string' || replyText.trim() === '') {
        return res.status(400).json({ error: 'El campo "replyText" debe ser una cadena no vacía' });
      }
    }

    const updateData: Partial<{
      name: string;
      keywords: string[];
      replyText: string;
      action: RuleAction;
      isActive: boolean;
    }> = {};

    if (name !== undefined) updateData.name = name;
    if (trimmedKeywords !== undefined) updateData.keywords = trimmedKeywords;
    if (replyText !== undefined) updateData.replyText = replyText;
    if (action !== undefined) updateData.action = action as RuleAction;
    if (isActive !== undefined) updateData.isActive = isActive;

    const updatedRule = await KeywordRuleService.updateRule(id, updateData);

    if (!updatedRule) {
      return res.status(404).json({ error: 'Regla no encontrada' });
    }

    res.json(updatedRule);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar la regla' });
  }
});

router.delete('/bot/rules/:id', async (req: Request, res: Response) => {
  try {
    const id = typeof req.params.id === 'string' ? req.params.id : String(req.params.id);
    const deleted = await KeywordRuleService.deleteRule(id);

    if (!deleted) {
      return res.status(404).json({ error: 'Regla no encontrada' });
    }

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al eliminar la regla' });
  }
});

export default router;

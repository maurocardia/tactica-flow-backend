import { AIService } from './ai.service.js';
import { TacticaCredentials } from './tacticaApi.service.js';
import { KeywordRuleService } from './keywordRule.service.js';
import { KnowledgeBaseService } from './knowledgeBase.service.js';
import { FlowEngineService, FlowTimeoutSendContext } from './flowEngine.service.js';
import { FlowOutboundMessage, FlowHandoffRequest } from '../types/flow.js';
import { AdvisorService, Advisor } from './advisor.service.js';
import { BotContactService } from './botContact.service.js';
import {
  classifyHandoffIntent,
  parseClarifyAnswer,
  parseList,
  DEFAULT_EXPLICIT_PHRASES,
  DEFAULT_AMBIGUOUS_WORDS,
  DEFAULT_CLARIFY_QUESTION,
  CLARIFY_PENDING_MINUTES,
  CLARIFY_COOLDOWN_MINUTES
} from './handoffIntent.service.js';
import { trace, preview } from '../utils/trace.js';

type BotEngineResult = {
  replyText: string;
  messages: FlowOutboundMessage[];
  source: 'KEYWORD_RULE' | 'AI_AGENT' | 'TACTICA_API' | 'FLOW_ENGINE' | 'HANDOFF' | 'HANDOFF_CLARIFY';
  sourceKbIds: number[];
  handoff?: FlowHandoffRequest;
  resolvedAdvisor?: Advisor;
};

export type { KeywordRule } from './keywordRule.service.js';

export class BotEngineService {
  /**
   * Procesador principal del Bot Auto-Responder para mensajes entrantes de WhatsApp
   */
  static async processIncomingMessage(
    incomingText: string,
    customerPhoneNumber: string,
    conversationHistory: any[] = [],
    tacticaCredentials: TacticaCredentials = {},
    aiFallbackEnabled: boolean = true,
    customInstructions: string = '',
    aiProvider: string = 'google',
    aiModel: string = '',
    contactName: string = 'Cliente',
    botMode: 'flow_only' | 'ai_only' | 'hybrid' = 'hybrid',
    flowTimeoutContext?: FlowTimeoutSendContext,
    // Issue #30 [BE-049]: sin esto, ni la regla legacy HANDOFF ni la tool de IA
    // handoff_to_advisor pueden derivar de verdad (necesitan saber de qué usuario son los
    // asesores, y desde qué sesión de WhatsApp notificarlos) — undefined en llamadores que no lo
    // tienen a mano (ej. POST /bot/reply de prueba) simplemente los deja sin esa capacidad.
    userId?: number
  ): Promise<{
    replyText: string;
    messages: FlowOutboundMessage[];
    source: 'KEYWORD_RULE' | 'AI_AGENT' | 'TACTICA_API' | 'FLOW_ENGINE' | 'HANDOFF' | 'HANDOFF_CLARIFY';
    sourceKbIds: number[];
    handoff?: FlowHandoffRequest;
    // Cuando el handoff se resolvió acá mismo (no en el editor de flujos) — ver
    // AdvisorService.handoffConversation — whatsapp.service.ts usa esto para reservar el asesor
    // sin volver a elegir/notificar (ver HandoffContext.resolvedAdvisor).
    resolvedAdvisor?: Advisor;
  } | null> {
    const textLower = incomingText.trim().toLowerCase();

    // 0. Historial reciente
    const historyText = conversationHistory
      .slice(-2)
      .map((m: any) => (typeof m === 'string' ? m : m.content || m.text || ''))
      .join(' ');

    // Conversación a la que pertenece este mensaje (el JID del grupo, en un grupo) — hace falta
    // para guardar el estado de la pregunta "¿querés hablar con una persona?". Sin userId o sin
    // este dato (llamadores de prueba), la detección de pedido de asesor no corre.
    const intentJid = flowTimeoutContext?.botContactJid;
    const canDetectIntent = !!userId && !!intentJid && botMode !== 'flow_only' && aiFallbackEnabled;

    // 0. ¿Es la respuesta a "¿querés hablar con una persona?"? Va antes que los flujos: un "1" o
    // "2" no debe terminar en un menú numerado del flujo.
    if (canDetectIntent) {
      const clarifyResult = await BotEngineService.handleClarifyAnswer({
        userId: userId!,
        jid: intentJid!,
        incomingText,
        customerPhoneNumber,
        contactName,
        conversationHistory,
        historyText,
        tacticaCredentials,
        customInstructions,
        aiProvider,
        aiModel
      });
      if (clarifyResult) return clarifyResult;
    }

    // 1. Evaluar Flujo Visual (Con Estado) — se salta por completo en modo "Solo IA" (ver
    // ChatbotModule.tsx, selector de modo de respuesta).
    if (botMode !== 'ai_only') {
      const flowResult = await FlowEngineService.processMessage(incomingText, customerPhoneNumber, contactName, flowTimeoutContext);
      if (flowResult) {
        console.log(`🤖 [BOT ENGINE] Mensaje procesado por FlowEngine (estado guardado).`);
        return flowResult;
      }
    }

    // 2. Evaluar Reglas por Palabras Clave (Keyword Triggers) - Legacy/Global
    for (const rule of await KeywordRuleService.listActiveRules()) {
      // Modo "Solo IA": las reglas de respuesta fija (ej. el "Saludo de bienvenida" que se siembra
      // en una base nueva, que matchea cualquier "hola") no deben ganarle a la IA ni a la
      // detección de pedido de asesor — solo quedan las reglas que justamente llaman a la IA.
      if (botMode === 'ai_only' && rule.action !== 'CALL_AI') continue;
      const matched = rule.keywords.some(kw => textLower.includes(kw));
      if (matched) {
        console.log(`🤖 [BOT ENGINE] Regla activada por palabra clave: ${rule.id} (${rule.name}, acción: ${rule.action})`);

        if (rule.action === 'CALL_AI') {
          // Modo "Solo Flujos": ninguna vía debe invocar a la IA, ni siquiera esta regla legacy
          // — se ignora como si no hubiera matcheado (con "continue", no "return", para no caer
          // en el "if (rule.replyText)" de más abajo, que mandaría la instrucción de IA de esta
          // regla como si fuera el texto literal a enviar) y se sigue evaluando el resto.
          if (botMode === 'flow_only') continue;

          let knowledgeContext = '';
          let sourceKbIds: number[] = [];
          try {
            const active = await KnowledgeBaseService.getActiveContext(incomingText, historyText);
            knowledgeContext = active.context;
            sourceKbIds = active.baseIds;
          } catch (err) {
            console.error('❌ [BOT ENGINE] No se pudo obtener el contexto de KB:', err);
          }
          const customPrompt = `${customInstructions}\nInstrucción de este bloque: ${rule.replyText}`;
          const { text: aiReply, handoffAdvisor } = await AIService.processMessage(
            incomingText, conversationHistory, tacticaCredentials, knowledgeContext, customPrompt, 'bot', aiProvider, aiModel,
            userId, customerPhoneNumber, contactName
          );
          if (handoffAdvisor) {
            return {
              replyText: aiReply,
              messages: [{ kind: 'text', text: aiReply }],
              source: 'HANDOFF',
              sourceKbIds,
              handoff: { nodeId: 'ai_tool', advisorMode: 'auto', advisorId: null },
              resolvedAdvisor: handoffAdvisor
            };
          }
          return {
            replyText: aiReply,
            messages: [{ kind: 'text', text: aiReply }],
            source: 'AI_AGENT',
            sourceKbIds
          };
        }

        // Regla legacy por palabra clave con derivación real (Issue #30 [BE-049]): elige asesor
        // por round-robin, genera el resumen con IA y lo notifica por WhatsApp — ver
        // AdvisorService.handoffConversation. Sin userId (llamador sin sesión real, ej. POST
        // /bot/reply de prueba) o sin ningún asesor configurado, se cae al texto fijo de
        // siempre (mismo criterio que pide el issue).
        if (rule.action === 'HANDOFF') {
          return BotEngineService.deriveToAdvisor({
            userId,
            customerPhoneNumber,
            contactName,
            fullHistory: [...conversationHistory, { role: 'user' as const, content: incomingText }],
            fallbackText: rule.replyText || 'Te estamos transfiriendo con un asesor de nuestro equipo. En instantes te responderán por este chat.',
            nodeId: 'keyword_rule'
          });
        }

        if (rule.replyText) {
          return {
            replyText: rule.replyText,
            messages: [{ kind: 'text', text: rule.replyText }],
            source: 'KEYWORD_RULE',
            sourceKbIds: []
          };
        }
      }
    }

    // Switch "Responder con IA" apagado, O modo "Solo Flujos" (que excluye la IA por completo,
    // no solo el flujo visual) -> ninguna respuesta automática, queda solo el chatbot manual (el
    // mensaje del cliente ya se logueó en el llamador, esto simplemente no genera respuesta).
    if (!aiFallbackEnabled || botMode === 'flow_only') {
      console.log(
        botMode === 'flow_only'
          ? '🤖 [BOT ENGINE] Modo "Solo Flujos": el flujo no matcheó y no se cae a IA — sin respuesta automática.'
          : '🤖 [BOT ENGINE] Ninguna regla matcheó y el fallback de IA está apagado — sin respuesta automática.'
      );
      return null;
    }

    // 2. Pedido de asesor detectado por el código (no por la IA): explícito → deriva directo;
    // ambiguo → pregunta si quiere una persona. Ver handoffIntent.service.ts.
    if (canDetectIntent) {
      const intentResult = await BotEngineService.detectHandoffIntent({
        userId: userId!,
        jid: intentJid!,
        incomingText,
        customerPhoneNumber,
        contactName,
        conversationHistory
      });
      if (intentResult) return intentResult;
    }

    // 3. Si no coincide ninguna palabra clave estática, invocar al Agente Inteligente de IA con Function Calling
    console.log(`🧠 [BOT ENGINE] Invocando Agente IA (${aiProvider}${aiModel ? '/' + aiModel : ''}) con integración Táctica...`);

    // Contexto de la Base de Conocimiento activa (Issue #7): si falla la consulta a la DB, no
    // tumbamos el bot — seguimos sin contexto extra en vez de romper la respuesta al cliente.
    let knowledgeContext = '';
    let sourceKbIds: number[] = [];
    try {
      const active = await KnowledgeBaseService.getActiveContext(incomingText, historyText);
      knowledgeContext = active.context;
      sourceKbIds = active.baseIds;
    } catch (err) {
      console.error('❌ [BOT ENGINE] No se pudo obtener el contexto de la Base de Conocimiento:', err);
    }

    const { text: aiReply, handoffAdvisor } = await AIService.processMessage(
      incomingText, conversationHistory, tacticaCredentials, knowledgeContext, customInstructions, 'bot', aiProvider, aiModel,
      userId, customerPhoneNumber, contactName
    );

    if (handoffAdvisor) {
      return {
        replyText: aiReply,
        messages: [{ kind: 'text', text: aiReply }],
        source: 'HANDOFF',
        sourceKbIds,
        handoff: { nodeId: 'ai_tool', advisorMode: 'auto', advisorId: null },
        resolvedAdvisor: handoffAdvisor
      };
    }

    return {
      replyText: aiReply,
      messages: [{ kind: 'text', text: aiReply }],
      source: 'AI_AGENT',
      sourceKbIds
    };
  }

  /** Configuración de la detección de pedido de asesor de esta cuenta (listas vacías = defaults). */
  private static async getIntentConfig(userId: number): Promise<{ explicit: string[]; ambiguous: string[]; question: string }> {
    const { AuthService } = await import('./auth.service.js');
    const user = await AuthService.getUserById(userId);
    return {
      explicit: parseList(user?.handoffExplicitPhrases, DEFAULT_EXPLICIT_PHRASES),
      ambiguous: parseList(user?.handoffAmbiguousWords, DEFAULT_AMBIGUOUS_WORDS),
      question: user?.handoffClarifyQuestion?.trim() || DEFAULT_CLARIFY_QUESTION
    };
  }

  /**
   * Deriva a un asesor por AdvisorService.handoffConversation y arma la respuesta para el cliente
   * según cómo salió (derivado / ya tenía asesor / a la cola). Usado por la regla por palabra
   * clave HANDOFF, por el pedido explícito y por la respuesta "1" a la pregunta de aclaración.
   * Sin userId (llamador sin sesión real, ej. POST /bot/reply de prueba) responde `fallbackText`.
   */
  private static async deriveToAdvisor(args: {
    userId?: number;
    customerPhoneNumber: string;
    contactName: string;
    fullHistory: any[];
    fallbackText: string;
    nodeId: string;
  }): Promise<BotEngineResult> {
    let text = args.fallbackText;
    let resolvedAdvisor: Advisor | undefined;

    if (args.userId) {
      try {
        const result = await AdvisorService.handoffConversation(args.userId, args.customerPhoneNumber, args.contactName, args.fullHistory);
        if (result.status === 'handed_off') {
          resolvedAdvisor = result.advisor;
          text = `Perfecto, te estoy comunicando con ${result.advisor.name}, nuestro asesor. En breve te contacta para ayudarte.`;
        } else if (result.status === 'already_pending') {
          // Ya se le había derivado antes en esta misma charla — no elegir otro asesor, solo
          // avisarle que sigue en fila (ver AdvisorService.getActiveHandoffAdvisor).
          resolvedAdvisor = result.advisor;
          text = `Ya te había comunicado con ${result.advisor.name}, nuestro asesor — en breve te responde. Si necesitás algo más mientras tanto, contame.`;
        } else if (result.status === 'queued') {
          // Todos los asesores ocupados en relay con otro cliente — a la cola (ver
          // AdvisorService.pickFreeAdvisor). No hay `resolvedAdvisor` porque todavía no hay
          // asesor asignado, así que este mensaje sale como KEYWORD_RULE normal.
          text = `Ahora mismo todos nuestros asesores están ocupados — quedaste en la fila, en la posición ${result.position}. En cuanto se libere alguien te conectamos.`;
        } else if (result.status === 'already_queued') {
          text = `Seguís en la fila de espera de un asesor, en la posición ${result.position}.`;
        }
      } catch (err) {
        console.error(`❌ [BOT ENGINE] Error derivando a un asesor (${args.nodeId}):`, err);
      }
    }

    return {
      replyText: text,
      messages: [{ kind: 'text', text }],
      source: resolvedAdvisor ? 'HANDOFF' : 'KEYWORD_RULE',
      sourceKbIds: [],
      ...(resolvedAdvisor ? { handoff: { nodeId: args.nodeId, advisorMode: 'auto', advisorId: null }, resolvedAdvisor } : {})
    };
  }

  /** Paso 2 del motor: ¿el mensaje pide hablar con una persona? Explícito → deriva; ambiguo →
   * pregunta; nada → null (sigue la IA). */
  private static async detectHandoffIntent(args: {
    userId: number;
    jid: string;
    incomingText: string;
    customerPhoneNumber: string;
    contactName: string;
    conversationHistory: any[];
  }): Promise<BotEngineResult | null> {
    try {
      const config = await BotEngineService.getIntentConfig(args.userId);
      const intent = classifyHandoffIntent(args.incomingText, config.explicit, config.ambiguous);
      if (intent === 'none') return null;

      if (intent === 'explicit') {
        trace('PEDIDO_ASESOR', { usuario: args.userId, cliente: args.jid, tipo: 'explicito', texto: preview(args.incomingText) });
        return BotEngineService.deriveToAdvisor({
          userId: args.userId,
          customerPhoneNumber: args.customerPhoneNumber,
          contactName: args.contactName,
          fullHistory: [...args.conversationHistory, { role: 'user' as const, content: args.incomingText }],
          fallbackText: 'Te estamos transfiriendo con un asesor de nuestro equipo. En instantes te responderán por este chat.',
          nodeId: 'intent_explicit'
        });
      }

      // Ambiguo: no volver a preguntar si hace poco eligió seguir sin una persona.
      const state = await BotContactService.getClarifyState(args.userId, args.jid);
      if (state.declinedAt && Date.now() - state.declinedAt.getTime() < CLARIFY_COOLDOWN_MINUTES * 60_000) {
        trace('PEDIDO_ASESOR', { usuario: args.userId, cliente: args.jid, tipo: 'ambiguo', accion: 'sin preguntar (eligio seguir hace poco)' });
        return null;
      }
      // Ya está en la fila de espera: la IA le informa su posición como siempre, sin preguntar.
      const { AdvisorQueueService } = await import('./advisorQueue.service.js');
      if ((await AdvisorQueueService.getPosition(args.userId, args.jid)) !== null) {
        trace('PEDIDO_ASESOR', { usuario: args.userId, cliente: args.jid, tipo: 'ambiguo', accion: 'sin preguntar (ya en la fila)' });
        return null;
      }

      await BotContactService.setClarifyPending(args.userId, args.jid, args.incomingText);
      trace('PEDIDO_ASESOR', { usuario: args.userId, cliente: args.jid, tipo: 'ambiguo', accion: 'pregunta', texto: preview(args.incomingText) });
      return {
        replyText: config.question,
        messages: [{ kind: 'text', text: config.question }],
        source: 'HANDOFF_CLARIFY',
        sourceKbIds: []
      };
    } catch (err) {
      // Nunca debe dejar al cliente sin respuesta: si algo falla acá, sigue la IA normal.
      console.error('❌ [BOT ENGINE] Error detectando pedido de asesor — sigue la IA normal:', err);
      return null;
    }
  }

  /** Paso 0 del motor: si hay una pregunta de aclaración pendiente, interpreta este mensaje como
   * su respuesta. "1"/persona → deriva; "2"/seguir → la IA responde el mensaje ORIGINAL sin poder
   * derivar; otra cosa → cierra la pregunta y el mensaje sigue su camino normal (null). */
  private static async handleClarifyAnswer(args: {
    userId: number;
    jid: string;
    incomingText: string;
    customerPhoneNumber: string;
    contactName: string;
    conversationHistory: any[];
    historyText: string;
    tacticaCredentials: TacticaCredentials;
    customInstructions: string;
    aiProvider: string;
    aiModel: string;
  }): Promise<BotEngineResult | null> {
    try {
      const state = await BotContactService.getClarifyState(args.userId, args.jid);
      if (!state.pendingAt) return null;
      if (Date.now() - state.pendingAt.getTime() > CLARIFY_PENDING_MINUTES * 60_000) {
        // Pregunta vieja sin responder: ya no se interpreta como respuesta.
        await BotContactService.clearClarifyPending(args.userId, args.jid, false);
        return null;
      }

      const config = await BotEngineService.getIntentConfig(args.userId);
      const answer = parseClarifyAnswer(args.incomingText, config.explicit);
      trace('ACLARACION_RESPUESTA', { usuario: args.userId, cliente: args.jid, respuesta: answer, texto: preview(args.incomingText) });

      if (answer === 'human') {
        await BotContactService.clearClarifyPending(args.userId, args.jid, false);
        const original = state.originalText || args.incomingText;
        return BotEngineService.deriveToAdvisor({
          userId: args.userId,
          customerPhoneNumber: args.customerPhoneNumber,
          contactName: args.contactName,
          fullHistory: [...args.conversationHistory, { role: 'user' as const, content: original }],
          fallbackText: 'Te estamos transfiriendo con un asesor de nuestro equipo. En instantes te responderán por este chat.',
          nodeId: 'intent_clarify'
        });
      }

      await BotContactService.clearClarifyPending(args.userId, args.jid, true);
      if (answer === 'unknown') return null;

      // "Seguir con mi consulta": la IA responde el mensaje original (así el cliente no tiene que
      // repetirlo), sin la tool de derivar — acaba de decir que no quiere una persona.
      const original = state.originalText || args.incomingText;
      let knowledgeContext = '';
      let sourceKbIds: number[] = [];
      try {
        const active = await KnowledgeBaseService.getActiveContext(original, args.historyText);
        knowledgeContext = active.context;
        sourceKbIds = active.baseIds;
      } catch (err) {
        console.error('❌ [BOT ENGINE] No se pudo obtener el contexto de la Base de Conocimiento:', err);
      }
      const customPrompt =
        `${args.customInstructions}\n\nNOTA DEL SISTEMA: el cliente aclaró que por ahora NO quiere hablar con una persona — quiere que lo orientes vos con su consulta. Respondé su consulta y no le ofrezcas derivarlo en esta respuesta.`;
      const { text: aiReply } = await AIService.processMessage(
        original, args.conversationHistory, args.tacticaCredentials, knowledgeContext, customPrompt, 'bot', args.aiProvider, args.aiModel,
        args.userId, args.customerPhoneNumber, args.contactName, { allowHandoff: false }
      );
      return { replyText: aiReply, messages: [{ kind: 'text', text: aiReply }], source: 'AI_AGENT', sourceKbIds };
    } catch (err) {
      console.error('❌ [BOT ENGINE] Error procesando la respuesta a la pregunta de aclaración — sigue normal:', err);
      return null;
    }
  }
}

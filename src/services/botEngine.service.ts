import { AIService } from './ai.service.js';
import { TacticaCredentials } from './tacticaApi.service.js';
import { KeywordRuleService } from './keywordRule.service.js';
import { KnowledgeBaseService } from './knowledgeBase.service.js';
import { FlowEngineService, FlowTimeoutSendContext } from './flowEngine.service.js';
import { FlowOutboundMessage, FlowHandoffRequest } from '../types/flow.js';
import { AdvisorService, Advisor } from './advisor.service.js';

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
    source: 'KEYWORD_RULE' | 'AI_AGENT' | 'TACTICA_API' | 'FLOW_ENGINE' | 'HANDOFF';
    sourceKbIds: number[];
    handoff?: FlowHandoffRequest;
    // Cuando el handoff se resolvió acá mismo (no en el editor de flujos) — ver
    // AdvisorService.handoffConversation — whatsapp.service.ts usa esto para pausar el bot sin
    // volver a elegir/notificar al asesor (ver HandoffContext.resolvedAdvisor).
    resolvedAdvisor?: Advisor;
  } | null> {
    const textLower = incomingText.trim().toLowerCase();

    // 0. Historial reciente
    const historyText = conversationHistory
      .slice(-2)
      .map((m: any) => (typeof m === 'string' ? m : m.content || m.text || ''))
      .join(' ');

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
      const matched = rule.keywords.some(kw => textLower.includes(kw));
      if (matched) {
        console.log(`🤖 [BOT ENGINE] Regla activada por palabra clave: ${rule.id} (${rule.name}, acción: ${rule.action})`);

        if (rule.action === 'CALL_AI') {
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
              handoff: { nodeId: 'ai_tool', advisorMode: 'auto', advisorId: null, pauseMinutes: null },
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
          let text = rule.replyText || 'Te estamos transfiriendo con un asesor de nuestro equipo. En instantes te responderán por este chat.';
          let resolvedAdvisor: Advisor | undefined;

          if (userId) {
            try {
              const fullHistory = [...conversationHistory, { role: 'user' as const, content: incomingText }];
              const result = await AdvisorService.handoffConversation(userId, customerPhoneNumber, contactName, fullHistory);
              if (result) {
                resolvedAdvisor = result.advisor;
                text = `Perfecto, te estoy comunicando con ${result.advisor.name}, nuestro asesor. En breve te va a escribir por este mismo chat o te va a contactar al ${result.advisor.phone}.`;
              }
            } catch (err) {
              console.error('❌ [BOT ENGINE] Error derivando a un asesor (regla HANDOFF):', err);
            }
          }

          return {
            replyText: text,
            messages: [{ kind: 'text', text }],
            source: resolvedAdvisor ? 'HANDOFF' : 'KEYWORD_RULE',
            sourceKbIds: [],
            ...(resolvedAdvisor
              ? { handoff: { nodeId: 'keyword_rule', advisorMode: 'auto', advisorId: null, pauseMinutes: null }, resolvedAdvisor }
              : {})
          };
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

    // 2. Si no coincide ninguna palabra clave estática, invocar al Agente Inteligente de IA con Function Calling
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
        handoff: { nodeId: 'ai_tool', advisorMode: 'auto', advisorId: null, pauseMinutes: null },
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
}

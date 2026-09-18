import { AIService } from './ai.service.js';
import { TacticaCredentials } from './tacticaApi.service.js';
import { KeywordRuleService } from './keywordRule.service.js';
import { KnowledgeBaseService } from './knowledgeBase.service.js';
import { FlowEngineService, FlowTimeoutSendContext } from './flowEngine.service.js';
import { FlowOutboundMessage, FlowHandoffRequest } from '../types/flow.js';

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
    flowTimeoutContext?: FlowTimeoutSendContext
  ): Promise<{
    replyText: string;
    messages: FlowOutboundMessage[];
    source: 'KEYWORD_RULE' | 'AI_AGENT' | 'TACTICA_API' | 'FLOW_ENGINE';
    sourceKbIds: number[];
    handoff?: FlowHandoffRequest;
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
          const aiReply = await AIService.processMessage(incomingText, conversationHistory, tacticaCredentials, knowledgeContext, customPrompt, 'bot', aiProvider, aiModel);
          return {
            replyText: aiReply,
            messages: [{ kind: 'text', text: aiReply }],
            source: 'AI_AGENT',
            sourceKbIds
          };
        }

        // Nota: esta regla legacy por palabra clave es un camino distinto del bloque "Contactar
        // Asesor" del editor visual de flujos — no elige/notifica un asesor real (ver
        // FlowEngineService/HandoffService), solo manda un texto fijo. Se deja así a propósito:
        // el handoff real es exclusivo del flujo visual.
        if (rule.action === 'HANDOFF') {
          const text = rule.replyText || 'Te estamos transfiriendo con un asesor de nuestro equipo. En instantes te responderán por este chat.';
          return {
            replyText: text,
            messages: [{ kind: 'text', text }],
            source: 'KEYWORD_RULE',
            sourceKbIds: []
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

    const aiReply = await AIService.processMessage(incomingText, conversationHistory, tacticaCredentials, knowledgeContext, customInstructions, 'bot', aiProvider, aiModel);

    return {
      replyText: aiReply,
      messages: [{ kind: 'text', text: aiReply }],
      source: 'AI_AGENT',
      sourceKbIds
    };
  }
}

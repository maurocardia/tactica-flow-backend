import { db } from '../config/db.js';
import { FlowOutboundMessage, FlowHandoffRequest } from '../types/flow.js';

interface FlowResponse {
  replyText: string;
  messages: FlowOutboundMessage[];
  source: 'FLOW_ENGINE';
  sourceKbIds: number[];
  action?: string;
  handoff?: FlowHandoffRequest;
}

// Tipos de nodo que se quedan "esperando" la respuesta del cliente (no siguen la conexión default
// solos) — comparten la misma forma de datos (data.options[]) a propósito, así el editor visual
// (FlowEdgeLayer/FlowNodeCard, lado frontend) no necesita ningún cambio de puertos para los tipos
// nuevos: ver plan de arquitectura, sección 0.5.
const INTERACTIVE_NODE_TYPES = new Set(['OPTIONS_MENU', 'BUTTONS_REPLY', 'LIST_MESSAGE']);

// Todo lo que hace falta para poder mandarle un mensaje al cliente MÁS ADELANTE, sin que haya
// escrito nada — ver scheduleTimeout más abajo. Es una copia de lo que whatsapp.service.ts ya
// tiene en scope al momento del mensaje original (no se puede "recuperar" después).
export interface FlowTimeoutSendContext {
  userId: number;
  remoteJid: string;
  botContactJid: string;
  phone: string;
  isGroup: boolean;
  participantJid?: string;
  contactName: string;
  groupName?: string | null;
}

type ProactiveSender = (ctx: FlowTimeoutSendContext & { messages: FlowOutboundMessage[] }) => Promise<void>;
// Inyectado por whatsapp.service.ts (el único módulo con acceso al socket/sesión real de Baileys)
// al importarse — ver el registro al final de ese archivo. FlowEngineService nunca importa
// whatsapp.service.ts directamente (evita un import circular).
let proactiveSender: ProactiveSender | null = null;

interface UserFlowState {
  nodeId: string;
  timestamp: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  sendContext?: FlowTimeoutSendContext;
}

// Memory state for user's current node in the flow.
// Maps customerPhoneNumber -> { nodeId, timestamp, ... }
const userStates = new Map<string, UserFlowState>();
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class FlowEngineService {
  static setProactiveSender(fn: ProactiveSender) {
    proactiveSender = fn;
  }

  static clearUserState(phoneNumber: string) {
    const state = userStates.get(phoneNumber);
    if (state?.timeoutTimer) clearTimeout(state.timeoutTimer);
    userStates.delete(phoneNumber);
  }

  // Guarda en qué nodo quedó el cliente, cancelando cualquier timer de "sin respuesta" que
  // hubiera quedado pendiente de un estado anterior (si no, un cliente que SÍ responde a tiempo
  // igual recibiría después el mensaje de "no respondiste").
  private static setUserState(phoneKey: string, nodeId: string, sendContext?: FlowTimeoutSendContext) {
    const prev = userStates.get(phoneKey);
    if (prev?.timeoutTimer) clearTimeout(prev.timeoutTimer);
    userStates.set(phoneKey, { nodeId, timestamp: Date.now(), sendContext: sendContext ?? prev?.sendContext });
  }

  // Si el nodo en el que quedó esperando el cliente es interactivo y tiene un tiempo de espera
  // configurado (node.data.waitTimeoutMinutes, ver NodeConfigDrawer.tsx), arma un temporizador
  // real: si en ese lapso el cliente no respondió (su estado sigue apuntando a este mismo nodo),
  // sigue la conexión de puerto 'timeout' del nodo y le manda esos mensajes por su cuenta.
  //
  // OJO: esto vive en memoria por proceso, igual que userStates — si el backend se reinicia, los
  // temporizadores pendientes en ese momento se pierden (el cliente simplemente no recibe el
  // mensaje de "no respondiste"), tal como se le advirtió al usuario en el propio editor.
  private static scheduleTimeout(phoneKey: string, node: any, flowData: any, sendContext?: FlowTimeoutSendContext) {
    if (!INTERACTIVE_NODE_TYPES.has(node.type)) return;
    const minutes = node.data?.waitTimeoutMinutes;
    if (!(typeof minutes === 'number' && minutes > 0)) return;
    if (!sendContext || !proactiveSender) return;

    const timer = setTimeout(async () => {
      const state = userStates.get(phoneKey);
      // El cliente ya respondió (se movió a otro nodo) o su estado fue limpiado (ej. handoff a
      // un asesor humano) — este timer quedó obsoleto, no corresponde mandar nada.
      if (!state || state.nodeId !== node.id || state.timeoutTimer !== timer) return;

      const timeoutConn = Array.isArray(flowData.connections)
        ? flowData.connections.find((c: any) => c.sourceNodeId === node.id && c.sourcePortId === 'timeout')
        : null;
      if (!timeoutConn) {
        userStates.delete(phoneKey);
        return;
      }

      try {
        // NOTA: si el puerto 'timeout' se conecta a un bloque "Contactar Asesor", acá SOLO se
        // manda su texto — a diferencia del camino normal (ver whatsapp.service.ts), este disparo
        // proactivo no ejecuta HandoffService (no elige/notifica asesor ni pausa el bot). No se
        // pidió soportar esa combinación todavía; se deja documentado en vez de fallar en silencio.
        const { messages, endNodeId } = this.buildNodeChain(timeoutConn.targetNodeId, flowData);
        const finalMessages = this.applyVariablesToMessages(messages, { nombre: state.sendContext?.contactName || sendContext.contactName });

        // El destino puede ser OTRO nodo interactivo, o incluso el MISMO nodo (loop de "si no
        // responde, reintentá" — el editor ya permite conectar el puerto 'timeout' de un bloque a
        // sí mismo). En ese caso hay que seguir esperando ahí, igual que si el cliente hubiera
        // llegado a ese nodo por cualquier otro camino — si no, el segundo intento ya no
        // rearmaría su propio timer y el loop moriría después de un solo disparo.
        const endNode = flowData.nodes.find((n: any) => n.id === endNodeId);
        if (endNode) {
          this.setUserState(phoneKey, endNodeId, sendContext);
          this.scheduleTimeout(phoneKey, endNode, flowData, sendContext);
        } else {
          userStates.delete(phoneKey);
        }

        if (finalMessages.length === 0) return;
        await proactiveSender!({ ...sendContext, messages: finalMessages });
      } catch (err) {
        console.error(`❌ [FlowEngineService] Error mandando el mensaje de "sin respuesta" (nodo ${node.id}):`, err);
        userStates.delete(phoneKey);
      }
    }, minutes * 60 * 1000);

    const state = userStates.get(phoneKey);
    if (state) state.timeoutTimer = timer;
  }

  static async getFlowData(): Promise<any | null> {
    try {
      const { rows } = await db.query('SELECT data FROM bot_flows WHERE id = $1', ['main_flow']);
      if (rows.length > 0 && rows[0].data) {
        return rows[0].data;
      }
    } catch (err) {
      console.error('Error fetching flow data:', err);
    }
    return null;
  }

  // Formatea las opciones de un nodo interactivo como texto plano numerado/con keyword — WhatsApp
  // vía Baileys 6.7.24 no tiene forma de enviar botones ni listas nativas (confirmado en los
  // tipos de la librería instalada), así que BUTTONS_REPLY y LIST_MESSAGE usan el mismo mecanismo
  // de texto que ya prueba OPTIONS_MENU en producción, en vez de un botón/lista táctil real.
  static renderInteractiveAsText(node: any): string {
    const options: any[] = Array.isArray(node.data?.options) ? node.data.options : [];
    if (options.length === 0) return '';

    if (node.type !== 'LIST_MESSAGE') {
      return options.map((opt: any) => `${opt.keyword}. ${opt.label}`).join('\n');
    }

    // LIST_MESSAGE: agrupa filas consecutivas que comparten sectionTitle bajo un encabezado.
    const lines: string[] = [];
    let lastSection: string | null = null;
    for (const opt of options) {
      const section = String(opt.sectionTitle || '').trim();
      if (section && section !== lastSection) {
        lines.push(`\n*${section}*`);
      }
      lastSection = section || null;
      const desc = opt.description ? ` — ${opt.description}` : '';
      lines.push(`${opt.keyword}. ${opt.label}${desc}`);
    }
    return lines.join('\n').trim();
  }

  // Encuentra la opción que el cliente eligió: por keyword exacto (comportamiento histórico), por
  // el número de orden en la lista ("1", "1."), por el label completo, o por selectionId (si
  // algún día llega una respuesta nativa de botón/lista — ver whatsapp.service.ts).
  static matchOption(node: any, textLower: string, selectionId?: string): any | undefined {
    const options: any[] = Array.isArray(node.data?.options) ? node.data.options : [];
    if (selectionId) {
      const bySelection = options.find((o: any) => o.id === selectionId);
      if (bySelection) return bySelection;
    }
    const exact = options.find((o: any) => String(o.keyword).trim().toLowerCase() === textLower);
    if (exact) return exact;
    const byIndex = options.find((_o: any, i: number) => textLower === String(i + 1) || textLower === `${i + 1}.`);
    if (byIndex) return byIndex;
    return options.find((o: any) => String(o.label).trim().toLowerCase() === textLower);
  }

  // Reemplaza variables tipo {nombre} en textos/captions salientes. `vars` va en minúsculas
  // (la búsqueda de la clave es case-insensitive, no hace falta que el usuario escriba {Nombre}
  // exactamente igual). Además de {nombre} (histórico), HandoffService usa esto para {asesor},
  // {telefono}, etc. en la plantilla de notificación al asesor.
  static applyVariables(text: string, vars: Record<string, string>): string {
    return text.replace(/\{(\w+)\}/g, (match: string, key: string) => {
      const value = vars[key.toLowerCase()];
      return value !== undefined ? value : match;
    });
  }

  static applyVariablesToMessages(messages: FlowOutboundMessage[], vars: Record<string, string>): FlowOutboundMessage[] {
    return messages.map((m) => {
      if (m.kind === 'text') return { ...m, text: this.applyVariables(m.text, vars) };
      if (m.kind === 'media' && m.caption) return { ...m, caption: this.applyVariables(m.caption, vars) };
      return m;
    });
  }

  // Recorre la cadena de nodos a partir de `nodeId` siguiendo las conexiones "default", armando la
  // lista de mensajes a mandar (texto/media/delay) — se corta sola al llegar a un nodo interactivo
  // (espera respuesta del cliente) o a un HANDOFF (deriva a un asesor, no tiene sentido seguir).
  static buildNodeChain(
    nodeId: string,
    flowData: any,
    visited = new Set<string>()
  ): { messages: FlowOutboundMessage[]; action: string; handoff?: FlowHandoffRequest; endNodeId: string } {
    if (visited.has(nodeId)) return { messages: [], action: 'STATIC_REPLY', endNodeId: nodeId };
    visited.add(nodeId);

    const node = flowData.nodes.find((n: any) => n.id === nodeId);
    if (!node) return { messages: [], action: 'STATIC_REPLY', endNodeId: nodeId };

    const messages: FlowOutboundMessage[] = [];
    let action = node.type === 'CALL_AI' ? 'CALL_AI' : node.type === 'HANDOFF' ? 'HANDOFF' : 'STATIC_REPLY';
    let handoff: FlowHandoffRequest | undefined;
    const replyText: string | undefined = node.data?.replyText || undefined;

    switch (node.type) {
      case 'SEND_IMAGE':
      case 'SEND_VIDEO':
      case 'SEND_DOCUMENT': {
        const media = node.data?.media;
        if (media) {
          messages.push({
            kind: 'media',
            mediaKind: media.kind,
            source: media.source,
            url: media.url,
            assetId: media.assetId,
            mimeType: media.mimeType,
            fileName: media.fileName,
            caption: replyText,
            gifPlayback: node.type === 'SEND_VIDEO' ? node.data?.gifPlayback : undefined,
          });
        } else if (replyText) {
          // Nodo todavía sin adjunto configurado — degrada a texto en vez de no mandar nada.
          messages.push({ kind: 'text', text: replyText });
        }
        break;
      }
      case 'SEND_AUDIO': {
        const media = node.data?.media;
        // WhatsApp/Baileys no soporta `caption` en mensajes de audio — si el nodo tiene texto, se
        // manda como mensaje de texto aparte, ANTES del audio.
        if (replyText) messages.push({ kind: 'text', text: replyText });
        if (media) {
          messages.push({
            kind: 'media',
            mediaKind: 'audio',
            source: media.source,
            url: media.url,
            assetId: media.assetId,
            mimeType: media.mimeType,
            fileName: media.fileName,
            ptt: node.data?.asVoiceNote,
          });
        }
        break;
      }
      case 'DELAY': {
        const seconds = node.data?.delaySeconds;
        if (typeof seconds === 'number' && seconds > 0) messages.push({ kind: 'delay', seconds });
        break;
      }
      case 'OPTIONS_MENU':
      case 'BUTTONS_REPLY':
      case 'LIST_MESSAGE': {
        let text = replyText || '';
        const optionsText = this.renderInteractiveAsText(node);
        if (optionsText) text += (text ? '\n\n' : '') + optionsText;
        if (text) messages.push({ kind: 'text', text });
        // Corta acá: espera la elección del cliente, no sigue la conexión default.
        return { messages, action, endNodeId: nodeId };
      }
      case 'HANDOFF': {
        if (replyText) messages.push({ kind: 'text', text: replyText });
        handoff = {
          nodeId: node.id,
          advisorMode: node.data?.advisorMode === 'fixed' ? 'fixed' : 'auto',
          advisorId: node.data?.advisorId ?? null,
          notifyTemplate: node.data?.advisorNotifyTemplate,
          pauseMinutes: typeof node.data?.pauseBotMinutes === 'number' ? node.data.pauseBotMinutes : null,
        };
        // Corta acá: derivar a un asesor termina la cadena automática de este mensaje.
        return { messages, action, handoff, endNodeId: nodeId };
      }
      default: {
        // TRIGGER, STATIC_REPLY, CALL_AI, CONDITION: solo texto, comportamiento histórico.
        if (replyText) messages.push({ kind: 'text', text: replyText });
      }
    }

    let endNodeId = nodeId;
    if (Array.isArray(flowData.connections)) {
      const defaultConn = flowData.connections.find(
        (c: any) => c.sourceNodeId === nodeId && (c.sourcePortId === 'default' || !c.sourcePortId)
      );
      if (defaultConn) {
        const next = this.buildNodeChain(defaultConn.targetNodeId, flowData, visited);
        messages.push(...next.messages);
        if (next.action !== 'STATIC_REPLY') action = next.action;
        if (next.handoff) handoff = next.handoff;
        endNodeId = next.endNodeId;
      }
    }

    return { messages, action, handoff, endNodeId };
  }

  private static toReplyText(messages: FlowOutboundMessage[]): string {
    return messages
      .filter((m): m is Extract<FlowOutboundMessage, { kind: 'text' }> => m.kind === 'text')
      .map((m) => m.text)
      .join('\n\n');
  }

  static async processMessage(
    incomingText: string,
    customerPhoneNumber: string,
    contactName: string = 'Cliente',
    sendContext?: FlowTimeoutSendContext
  ): Promise<FlowResponse | null> {
    const flowData = await this.getFlowData();
    if (!flowData || !Array.isArray(flowData.nodes) || !Array.isArray(flowData.connections)) {
      return null;
    }

    const textLower = incomingText.trim().toLowerCase();
    const vars = { nombre: contactName };

    // Check timeout
    const state = userStates.get(customerPhoneNumber);
    if (state && (Date.now() - state.timestamp > SESSION_TIMEOUT_MS)) {
      this.clearUserState(customerPhoneNumber);
    }
    const currentNodeId = userStates.get(customerPhoneNumber)?.nodeId;

    // 1. If user is in a state, check outgoing options
    if (currentNodeId) {
      const currentNode = flowData.nodes.find((n: any) => n.id === currentNodeId);
      if (currentNode && INTERACTIVE_NODE_TYPES.has(currentNode.type) && Array.isArray(currentNode.data?.options)) {

        // Is the user trying to forcefully exit by hitting a trigger keyword?
        let isGlobalTrigger = false;
        for (const node of flowData.nodes) {
          if (node.data && Array.isArray(node.data.keywords) && node.data.keywords.length > 0) {
            if (node.data.keywords.some((kw: string) => textLower.includes(kw.toLowerCase()))) {
              isGlobalTrigger = true;
              break;
            }
          }
        }

        if (!isGlobalTrigger) {
          const matchedOption = this.matchOption(currentNode, textLower);

          if (matchedOption) {
            const conn = flowData.connections.find((c: any) => c.sourceNodeId === currentNodeId && c.sourcePortId === matchedOption.id);
            if (conn) {
              const { messages, action, handoff, endNodeId } = this.buildNodeChain(conn.targetNodeId, flowData);
              const finalMessages = this.applyVariablesToMessages(messages, vars);
              this.setUserState(customerPhoneNumber, endNodeId, sendContext);
              const endNode = flowData.nodes.find((n: any) => n.id === endNodeId);
              if (endNode) this.scheduleTimeout(customerPhoneNumber, endNode, flowData, sendContext);
              return {
                replyText: this.toReplyText(finalMessages),
                messages: finalMessages,
                source: 'FLOW_ENGINE',
                sourceKbIds: [],
                action,
                handoff
              };
            }
          } else {
            // Invalid option fallback: keep them in the menu and warn (y renueva su propio timer
            // de "sin respuesta", si tenía uno — un intento inválido cuenta como actividad).
            this.setUserState(customerPhoneNumber, currentNodeId, sendContext);
            this.scheduleTimeout(customerPhoneNumber, currentNode, flowData, sendContext);
            const warnText = 'Por favor, elige una opción válida del menú.';
            return {
              replyText: warnText,
              messages: [{ kind: 'text', text: warnText }],
              source: 'FLOW_ENGINE',
              sourceKbIds: []
            };
          }
        }
      }
    }

    // 2. If not in a valid state, or typed a global trigger
    for (const node of flowData.nodes) {
      if (node.data && Array.isArray(node.data.keywords) && node.data.keywords.length > 0) {
        const matched = node.data.keywords.some((kw: string) => textLower.includes(kw.toLowerCase()));
        if (matched) {
          const { messages, action, handoff, endNodeId } = this.buildNodeChain(node.id, flowData);
          const finalMessages = this.applyVariablesToMessages(messages, vars);
          this.setUserState(customerPhoneNumber, endNodeId, sendContext);
          const endNode = flowData.nodes.find((n: any) => n.id === endNodeId);
          if (endNode) this.scheduleTimeout(customerPhoneNumber, endNode, flowData, sendContext);
          return {
            replyText: this.toReplyText(finalMessages),
            messages: finalMessages,
            source: 'FLOW_ENGINE',
            sourceKbIds: [],
            action,
            handoff
          };
        }
      }
    }

    return null;
  }
}

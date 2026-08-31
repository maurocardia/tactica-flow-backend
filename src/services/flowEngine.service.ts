import { db } from '../config/db.js';

interface FlowResponse {
  replyText: string;
  source: 'FLOW_ENGINE';
  sourceKbIds: number[];
  action?: string;
}

// Memory state for user's current node in the flow.
// Maps customerPhoneNumber -> { nodeId, timestamp }
const userStates = new Map<string, { nodeId: string, timestamp: number }>();
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class FlowEngineService {
  static clearUserState(phoneNumber: string) {
    userStates.delete(phoneNumber);
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

  static buildNodeChainResponse(nodeId: string, flowData: any, visited = new Set<string>()): { text: string, action: string, endNodeId: string } {
    if (visited.has(nodeId)) return { text: '', action: 'STATIC_REPLY', endNodeId: nodeId };
    visited.add(nodeId);

    const node = flowData.nodes.find((n: any) => n.id === nodeId);
    if (!node) return { text: '', action: 'STATIC_REPLY', endNodeId: nodeId };

    let text = node.data?.replyText || '';
    let action = node.type === 'CALL_AI' ? 'CALL_AI' : node.type === 'HANDOFF' ? 'HANDOFF' : 'STATIC_REPLY';

    // If it's a menu, format options and stop traversing (wait for user input)
    if (node.type === 'OPTIONS_MENU' && Array.isArray(node.data?.options)) {
      const optionsText = node.data.options.map((opt: any) => `${opt.keyword}. ${opt.label}`).join('\n');
      if (optionsText) {
        text += (text ? '\n\n' : '') + optionsText;
      }
      return { text, action, endNodeId: nodeId };
    }

    // Follow default connection
    let endNodeId = nodeId;
    if (Array.isArray(flowData.connections)) {
      const defaultConn = flowData.connections.find((c: any) => c.sourceNodeId === nodeId && (c.sourcePortId === 'default' || !c.sourcePortId));
      if (defaultConn) {
        const nextResponse = this.buildNodeChainResponse(defaultConn.targetNodeId, flowData, visited);
        if (nextResponse.text) {
          text += (text ? '\n\n' : '') + nextResponse.text;
        }
        if (nextResponse.action !== 'STATIC_REPLY') {
          action = nextResponse.action;
        }
        endNodeId = nextResponse.endNodeId;
      }
    }

    return { text, action, endNodeId };
  }

  static async processMessage(incomingText: string, customerPhoneNumber: string): Promise<FlowResponse | null> {
    const flowData = await this.getFlowData();
    if (!flowData || !Array.isArray(flowData.nodes) || !Array.isArray(flowData.connections)) {
      return null;
    }

    const textLower = incomingText.trim().toLowerCase();
    
    // Check timeout
    const state = userStates.get(customerPhoneNumber);
    if (state && (Date.now() - state.timestamp > SESSION_TIMEOUT_MS)) {
      userStates.delete(customerPhoneNumber);
    }
    const currentNodeId = userStates.get(customerPhoneNumber)?.nodeId;

    // 1. If user is in a state, check outgoing options
    if (currentNodeId) {
      const currentNode = flowData.nodes.find((n: any) => n.id === currentNodeId);
      if (currentNode && currentNode.type === 'OPTIONS_MENU' && Array.isArray(currentNode.data?.options)) {
        
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
          // Find if user typed one of the options
          const matchedOption = currentNode.data.options.find((opt: any) => String(opt.keyword).trim().toLowerCase() === textLower);
          
          if (matchedOption) {
            const conn = flowData.connections.find((c: any) => c.sourceNodeId === currentNodeId && c.sourcePortId === matchedOption.id);
            if (conn) {
              const { text, action, endNodeId } = this.buildNodeChainResponse(conn.targetNodeId, flowData);
              userStates.set(customerPhoneNumber, { nodeId: endNodeId, timestamp: Date.now() });
              return {
                replyText: text,
                source: 'FLOW_ENGINE',
                sourceKbIds: [],
                action
              };
            }
          } else {
            // Invalid option fallback: keep them in the menu and warn
            userStates.set(customerPhoneNumber, { nodeId: currentNodeId, timestamp: Date.now() }); // refresh timeout
            return {
              replyText: 'Por favor, elige una opción válida del menú.',
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
          const { text, action, endNodeId } = this.buildNodeChainResponse(node.id, flowData);
          userStates.set(customerPhoneNumber, { nodeId: endNodeId, timestamp: Date.now() });
          return {
            replyText: text,
            source: 'FLOW_ENGINE',
            sourceKbIds: [],
            action
          };
        }
      }
    }

    return null;
  }
}

// src/types/flow.ts
// Espejo (no compartido — los repos son independientes) de las formas de datos del editor visual
// de flujos en el frontend (tactica-flow-frontend/src/types/bot.ts). El flujo en sí sigue
// guardándose como `any`/JSONB (tabla bot_flows) — estos tipos son solo para lo que
// FlowEngineService construye al RECORRER ese JSON, así el resto del backend (whatsapp.service.ts)
// no tiene que interpretar la forma del nodo de nuevo.

export type FlowOutboundMessage =
  | { kind: 'text'; text: string }
  | {
      kind: 'media';
      mediaKind: 'image' | 'video' | 'audio' | 'document';
      source: 'url' | 'upload';
      url?: string;
      assetId?: number;
      mimeType?: string;
      fileName?: string;
      caption?: string;
      ptt?: boolean;
      gifPlayback?: boolean;
    }
  | { kind: 'delay'; seconds: number };

export interface FlowHandoffRequest {
  nodeId: string;
  advisorMode: 'auto' | 'fixed';
  advisorId: number | null;
  notifyTemplate?: string;
}

// Trazas del recorrido completo de un mensaje: cliente → bot → derivación/cola → asesor → puente →
// cliente. Una línea por paso, siempre con el prefijo "🧭 [TRAZA]" para poder filtrarlas en los logs
// de Railway (filtro: TRAZA) y seguir un mensaje puntual por su msgId o por el número del cliente.
//
// Los textos se recortan a TEXT_PREVIEW caracteres: alcanza para reconocer el mensaje al cruzarlo
// con una captura de pantalla sin volcar conversaciones completas en los logs.
const TEXT_PREVIEW = 40;

export function preview(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TEXT_PREVIEW ? `${flat.slice(0, TEXT_PREVIEW)}…` : flat;
}

export function trace(stage: string, data: Record<string, unknown> = {}): void {
  const fields = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
  console.log(`🧭 [TRAZA] ${stage}${fields.length ? ' ' + fields.join(' ') : ''}`);
}

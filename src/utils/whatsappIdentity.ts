// Identidad de un contacto de WhatsApp. Un contacto normal se identifica por su teléfono
// (@s.whatsapp.net); uno que activó un nombre de usuario (@nombre) tiene el número OCULTO y WhatsApp
// solo comparte un identificador interno (@lid, ~15 dígitos) que NO es un teléfono — no sirve para
// armar links wa.me, ni para mostrarse como "+número", ni para enviarle por teléfono.

export type IdentityType = 'phone' | 'lid';

/** Un teléfono real (E.164) tiene entre 8 y 13 dígitos; un @lid es más largo (~14-15). */
export function looksLikePhoneDigits(digits: string): boolean {
  return /^[0-9]{8,13}$/.test(digits);
}

export function isLidJid(jid: string): boolean {
  return jid.endsWith('@lid');
}

export function identityTypeOfJid(jid: string): IdentityType {
  return isLidJid(jid) ? 'lid' : 'phone';
}

/** Igual que looksLikePhoneDigits pero sobre un valor "phone" que puede traer símbolos o dominio. */
export function hasVisiblePhone(phoneOrJid: string): boolean {
  if (isLidJid(phoneOrJid)) return false;
  return looksLikePhoneDigits(phoneOrJid.split('@')[0].replace(/[^0-9]/g, ''));
}

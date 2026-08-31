const textLower = "Actualizaciones y Mejoras de la versión 7 de TACTICA".toLowerCase();
console.log("textLower:", textLower);
const kw1 = "táctica";
const kw2 = "tactica";

console.log("kw1 match exact:", (textLower.match(new RegExp(`\\b${kw1}s?\\b`, 'g')) || []).length);
console.log("kw2 match exact:", (textLower.match(new RegExp(`\\b${kw2}s?\\b`, 'g')) || []).length);

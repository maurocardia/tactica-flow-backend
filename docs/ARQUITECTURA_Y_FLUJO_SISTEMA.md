# 🏗️ Arquitectura Integral y Flujo del Sistema: TÁCTICA Flow

Esta documentación consolida todo el diseño técnico, funcionamiento y flujo de datos de **TÁCTICA Flow**, destacando el rol protagónico de **Baileys** como la fuente de verdad (Single Source of Truth) para la persistencia y la inteligencia artificial, reduciendo la dependencia del DOM de WhatsApp Web.

---

## 1. 🧠 Rol de Baileys vs DOM de WhatsApp Web

```mermaid
flowchart TD
    subgraph WhatsApp["WhatsApp Cloud / Servidores de Meta"]
        WAChats[Mensajes Entrantes / Salientes]
    end

    subgraph Backend["Backend TÁCTICA Flow (Node.js + Baileys + PostgreSQL)"]
        BSocket["Socket Baileys (@whiskeysockets/baileys)"]
        DB[(PostgreSQL - conversations / messages)]
        RAG[Motor RAG & Chunking Semántico]
        AI[AIService - Gemini con Auto-Fallback]
        Bot[BotEngineService & Reglas]
        Cron[ScheduledJobService]
    end

    subgraph Frontend["Extensión Chrome (React + Tailwind + Vite)"]
        UI[Sidebar & Modales]
        ApiSvc[ApiService - REST & WebSocket]
        DOM[DOMService - Detección de Chat Activo]
    end

    WAChats <-->|Socket Persistente| BSocket
    BSocket -->|Guardar Inbound & Outbound| DB
    BSocket -->|Disparar Bot| Bot
    Bot -->|Consultar Contexto Relevante| RAG
    RAG -->|Contexto Filtrado <3K tokens| AI
    DB -->|Historial & Métricas Reales| ApiSvc
    ApiSvc -->|Datos Fidedignos| UI
    DOM -.->|Solo Identificar Título del Chat| UI
```

### ¿Por qué Baileys es la Fuente Primordial?
*   **Virtualización del DOM:** WhatsApp Web en el navegador destruye y virtualiza los mensajes que no están en pantalla para ahorrar memoria RAM. Depender del DOM hace que se pierdan mensajes viejos, fechas exactas y audios.
*   **Baileys mantiene el 100% del historial:** Conectado directamente a los servidores de WhatsApp mediante WebSockets, Baileys recibe y almacena cada mensaje (entrante y saliente) con su marca de tiempo (`createdAt`) milimétrica y fidedigna en PostgreSQL.
*   **Soporte Multidispositivo:** Si el asesor responde desde su teléfono físico o desde WhatsApp Web, Baileys lo detecta (`fromMe: true`) y lo guarda inmediatamente con rol `agent`.

---

## 2. ⚡ Motor de Optimización de Tokens e Inteligencia Artificial (Ahorro ~95%)

Para evitar saturar los límites de cuota (TPM - Tokens por Minuto) de Google AI Studio:

### 1. RAG Ligero (Retrieval-Augmented Generation)
*   **Ubicación:** `backend/src/services/knowledgeBase.service.ts` (`getActiveContext(query)`).
*   **Problema anterior:** Se volcaban cientos de miles de caracteres de todos los PDFs y documentos de la base de conocimiento en cada mensaje (**~100K tokens por consulta**).
*   **Solución implementada:**
    1. Si los documentos suman menos de 14.000 caracteres (~3.500 tokens), se envían directos.
    2. Si superan ese umbral, el sistema **divide los textos en fragmentos semánticos (chunks de 500-700 chars)**.
    3. Extrae palabras clave de la pregunta del usuario (filtrando *stopwords* en español).
    4. Rankea y selecciona únicamente los **2 a 3 fragmentos más relevantes** (máximo ~12.000 chars / ~3.000 tokens).
    5. **Resultado:** Reducción del **95% del consumo de tokens** por mensaje.

### 2. Ventana de Historial Acotada
*   **Ubicación:** `backend/src/services/ai.service.ts`.
*   Se acota a los últimos **8 mensajes (4 turnos de diálogo)** (`conversationHistory.slice(-8)`), evitando que chats antiguos inflen el consumo de tokens.

### 3. Auto-Fallback Inteligente Multimodelo
*   Si un modelo llega a su límite de cuota temporal (`429 Quota Exceeded / ResourceExhausted`), el backend cambia en **600ms** automáticamente al siguiente modelo disponible (`gemini-2.0-flash` o `gemini-1.5-flash`) sin interrumpir la atención del cliente.

---

## 3. 📊 Resúmenes de Conversación con Rangos de Fechas Reales (Baileys)

*   **Ubicación:** `frontend/src/components/sidebar/ai/AiSummaryModal.tsx`.
*   **Opciones de Alcance:**
    *   `Hoy`: Filtra estrictamente los mensajes con `createdAt >= 00:00:00` del día local.
    *   `24h`: Mensajes de las últimas 24 horas (`createdAt >= Date.now() - 24h`).
    *   `7 días`: Mensajes de los últimos 7 días.
    *   `Pantalla`: Mensajes visibles en el DOM actual de WhatsApp Web.
    *   `Todo`: Historial completo almacenado en Baileys.
*   **Conteo Exacto:** Muestra el número real de mensajes analizados (`Resumen (N mensajes analizados)`).
*   **Cero Falsos Positivos:** Si no hubo mensajes hoy, la IA no inventa ni resume mensajes de ayer, sino que informa claramente y ofrece cambiar a "24h" o "7 días" con un solo clic.

---

## 4. 👥 Aislamiento de Contexto en Grupos de WhatsApp

*   **Formato de Clave Única:** En grupos, Baileys almacena las conversaciones bajo el identificador `phone = "<groupJid>-<participantJid>"`.
*   **Beneficio:** Cada persona en el grupo tiene su propio hilo de memoria con la IA. Si Juan pregunta por precios y María por soporte, la IA no confunde los contextos.
*   **Selector de Participantes:** El modal de resumen permite resumir a todo el grupo o a un participante en particular.

---

## 5. 🎨 UI / UX y Modo Oscuro de Alto Contraste

*   Todos los modales (`AiSummaryModal`, `AiAgentConfigModal`, `AiSummaryConfigModal`, `ChatbotModule`) cuentan con estilos adaptados para Dark Mode (`dark:bg-slate-800`, `dark:text-slate-100`, `border-slate-700`), garantizando legibilidad óptima y botones de acción claros.

---

## 6. 📁 Resumen de Archivos Clave del Repositorio

| Módulo | Archivo | Responsabilidad Principal |
| :--- | :--- | :--- |
| **Backend** | `src/services/whatsapp.service.ts` | Conexión WebSocket Baileys, captura de mensajes entrantes y salientes (`fromMe`), emisión por Socket.io. |
| **Backend** | `src/services/conversation.service.ts` | Persistencia en PostgreSQL de conversaciones y mensajes con `createdAt` ISO. |
| **Backend** | `src/services/knowledgeBase.service.ts` | Extracción de documentos (PDF, DOCX, TXT) y motor RAG de fragmentación y ranking por relevancia. |
| **Backend** | `src/services/ai.service.ts` | Integración con Google Gemini, sanitización de modelos, cola anti-ráfaga y auto-fallback 429. |
| **Backend** | `src/services/botEngine.service.ts` | Motor de evaluación de reglas por palabra clave, transferencia humana (`HANDOFF`) y llamada a IA. |
| **Frontend** | `src/components/sidebar/ai/AiSummaryModal.tsx` | Modal de resumen con selector de fechas (Hoy, 24h, 7d, Pantalla, Todo) y conteo real. |
| **Frontend** | `src/services/dom.service.ts` | Identificación del chat activo y lectura auxiliar de mensajes/audios visibles. |
| **Frontend** | `src/services/api.service.ts` | Cliente HTTP centralizado para consumir la API de Baileys, Base de Conocimiento y Gemini. |

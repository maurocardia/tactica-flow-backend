# 📘 Tactica Flow - Especificación Técnica y Arquitectura (Backend)

Plataforma de comunicación empresarial inteligente (estilo BlueTicks para WhatsApp) integrada de forma nativa con **Táctica ERP** a través de su API .NET / Agente de WebSockets.

---

## 1. Visión y Objetivos del Proyecto

**Tactica Flow Backend** centraliza y automatiza la atención al cliente por WhatsApp (y a futuro Instagram, Messenger, Telegram, Email), combinando:
1. **Bandeja Multiescritorio / Multiagente**: Gestión centralizada de chats con etiquetas, transferencias y notas internas.
2. **Motor de Bots y Automatización**: Diagramación de flujos conversacionales interactivos y disparadores por eventos.
3. **Agentes Inteligentes de IA (OpenAI Function Calling)**: Comprensión del lenguaje natural para resolver solicitudes avanzadas (ej. consultar inventario, agendar soporte, crear cotizaciones o pedidos).
4. **Integración Directa con Táctica ERP**: Ejecución de acciones en tiempo real sobre la base de datos de Táctica mediante el Agente .NET / Backend de Táctica.

---

## 2. Stack Tecnológico

- **Backend**: Node.js (v18+ / v20+), Express, Socket.io (tiempo real).
- **Base de Datos Principal**: PostgreSQL (Gestión de usuarios, chats, mensajes, bots, logs, automatizaciones, credenciales de WhatsApp).
- **ORM / Driver DB**: `pg` / `Knex.js` o `Prisma ORM`.
- **Motor WhatsApp**: `@whiskeysockets/baileys` (o Meta Cloud API).
- **Motor IA**: OpenAI API (GPT-4o / GPT-4o-mini) con Function Calling / Structured Outputs.
- **Integración Táctica**: Proxy HTTP al API .NET de Táctica (`/Tactica/Empresas`, `/Tactica/Contactos`, `/Tactica/soporte`, `/Tactica/Productos`, `/Tactica/Presupuestos`, etc.) o WebSocket directo con Agente .NET.

---

## 3. Arquitectura General del Sistema

```
                  ┌──────────────────────────────────────────────┐
                  │                TÁCTICA ERP                   │
                  │ (Clientes, Pedidos, Soporte, Stock, Cotiz.)  │
                  └──────────────────────▲───────────────────────┘
                                         │
                        API .NET / Agente WebSocket Táctica
                                         │
─────────────────────────────────────────┼──────────────────────────────────────────
                                         │ HTTP REST / WebSocket
                  ┌──────────────────────▼───────────────────────┐
                  │            TACTICA FLOW BACKEND              │
                  │            (Node.js + Express)               │
                  └────────┬─────────────┬──────────────┬────────┘
                           │             │              │
       ┌───────────────────┴──┐   ┌──────┴───────┐  ┌───┴────────────────┐
       │ Motor de WhatsApp    │   │ Motor IA     │  │ PostgreSQL DB      │
       │ (Baileys / WebSockets)│   │ (OpenAI GPT) │  │ (Chats, Bots, Logs)│
       └──────────────────────┘   └──────────────┘  └────────────────────┘
                                         ▲
                                         │ Socket.io (Realtime Events)
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │            TACTICA FLOW FRONTEND             │
                  │               (React + Vite)                 │
                  └──────────────────────────────────────────────┘
```

---

## 4. Esquema de Base de Datos (PostgreSQL)

```sql
-- 1. Empresas / Tenats
CREATE TABLE tenants (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    tactica_client_id VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Usuarios y Roles
CREATE TYPE user_role AS ENUM ('superadmin', 'admin', 'supervisor', 'agent');

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role user_role DEFAULT 'agent',
    tactica_user VARCHAR(100), -- Usuario de Tactica ERP para auditoría
    tactica_password VARCHAR(100),
    is_online BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Sesiones de WhatsApp
CREATE TABLE whatsapp_sessions (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
    phone_number VARCHAR(50),
    session_name VARCHAR(100) NOT NULL,
    status VARCHAR(50) DEFAULT 'DISCONNECTED', -- CONNECTED, DISCONNECTED, QR_READY
    qr_code TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Contactos de WhatsApp
CREATE TABLE whatsapp_contacts (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
    whatsapp_id VARCHAR(100) NOT NULL, -- ej: 5491112345678@s.whatsapp.net
    phone_number VARCHAR(50) NOT NULL,
    name VARCHAR(255),
    email VARCHAR(255),
    tactica_empresa_rec_id VARCHAR(100), -- Enlace a RecId de Empresa en Tactica
    tactica_contacto_rec_id VARCHAR(100), -- Enlace a RecId de Contacto en Tactica
    tags TEXT[],
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Conversaciones (Chats)
CREATE TYPE chat_status AS ENUM ('unassigned', 'assigned', 'bot', 'resolved');

CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
    session_id INT REFERENCES whatsapp_sessions(id),
    contact_id INT REFERENCES whatsapp_contacts(id),
    assigned_user_id INT REFERENCES users(id),
    status chat_status DEFAULT 'unassigned',
    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    unread_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Mensajes
CREATE TYPE message_type AS ENUM ('text', 'image', 'document', 'audio', 'video', 'location', 'system');
CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');

CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
    direction message_direction NOT NULL,
    sender_type VARCHAR(50), -- 'customer', 'agent', 'bot', 'ai'
    sender_id INT, -- ID de usuario si es agente
    type message_type DEFAULT 'text',
    body TEXT,
    media_url TEXT,
    status VARCHAR(50) DEFAULT 'sent', -- sent, delivered, read, failed
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Flujos de Bots
CREATE TABLE bot_flows (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    trigger_keyword VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    flow_json JSONB NOT NULL, -- Configuración de nodos y decisiones
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. Auditoría y Logs de IA / Táctica
CREATE TABLE integration_logs (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES tenants(id),
    conversation_id INT REFERENCES conversations(id),
    action_type VARCHAR(100), -- 'CREAR_PEDIDO', 'CONSULTAR_STOCK', 'CREAR_SOPORTE'
    request_payload JSONB,
    response_payload JSONB,
    status VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 5. Módulos Backend y Servicios

### 5.1 Servicios de Integración

- `src/services/tacticaApi.service.js`: Comunicación con el API .NET de Táctica ERP.
- `src/services/openai.service.js`: Agente de IA conversacional con Function Calling (`consultar_inventario`, `crear_ticket_soporte`, `crear_contacto`).
- `src/services/whatsapp.service.js`: Gestión de conexiones Socket.io y WebSockets con Baileys.

---

## 6. Autenticación y Seguridad

- Autenticación mediante **JWT**.
- Inyección obligatoria de credenciales de usuario local de Táctica (`usuario` y `contrasena`) en el payload de peticiones POST a Táctica.

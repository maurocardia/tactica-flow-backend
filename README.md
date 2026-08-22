# ⚙️ Tactica Flow - Backend (Node.js + Express + PostgreSQL)

Backend modular para la plataforma **Tactica Flow**, diseñado para gestionar sesiones de WhatsApp, chat multiagente, agentes de IA conversacional y la integración directa con **Táctica ERP**.

---

## 🛠️ Requisitos Previos

- **Node.js**: v18.0.0 o superior.
- **PostgreSQL**: v13 o superior.

---

## 🚀 Instalación y Configuración

1. Clonar o navegar a la carpeta del backend:
   ```bash
   cd backend
   ```

2. Instalar dependencias:
   ```bash
   npm install
   ```

3. Configurar variables de entorno:
   Copiar `.env.example` a `.env` y ajustar credenciales de PostgreSQL y `GEMINI_API_KEY` (IA):
   ```bash
   cp .env.example .env
   ```

4. Iniciar en modo desarrollo:
   ```bash
   npm run dev
   ```

---

## 📂 Estructura de Directorios

```
backend/
├── src/
│   ├── config/          # Pool de PostgreSQL, esquema (CREATE TABLE IF NOT EXISTS), initDatabase()
│   ├── routes/          # Todos los endpoints REST (api.routes.ts)
│   ├── services/        # Lógica de negocio: TacticaApiService, AIService (Gemini), BotEngineService,
│   │                     # KeywordRuleService, ConversationService
│   └── server.ts        # Punto de entrada, servidor HTTP/Socket, arranque de DB
├── .env.example
├── package.json
└── README.md
```

Ver [CHATBOT.md](CHATBOT.md) para el detalle de endpoints, esquema de DB y flujo del motor de bot.

---

## 🧰 Comandos útiles

Todos parados en la carpeta `tactica-flow-backend`. Ejemplos en PowerShell (Windows) — si usás bash/WSL, cambiá `Remove-Item -Recurse -Force X -ErrorAction SilentlyContinue` por `rm -rf X`.

### Desarrollo diario

```powershell
npm run dev              # arranca con tsx watch (recarga sola al guardar), puerto 5000
npm run build             # compila TypeScript a dist/ (tsc)
npm start                 # corre el build compilado (dist/server.js) — para producción
npx tsc --noEmit           # solo chequea tipos, sin generar archivos (útil antes de commitear)
```

### Limpiar caché / reinstalar

```powershell
npm cache clean --force                                              # caché global de npm
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue        # build compilado
Remove-Item -Recurse -Force node_modules, package-lock.json -ErrorAction SilentlyContinue
npm install                                                            # reinstalación completa
```

### Puerto ocupado (si `npm run dev` falla con "address already in use")

```powershell
netstat -ano | findstr :5000      # te da el PID que está usando el puerto 5000
taskkill /PID <ese_numero> /F     # lo mata
```

### Probar que la API responde (con el server corriendo)

```powershell
curl http://localhost:5000/api/health
curl http://localhost:5000/api/conversations
curl -X POST http://localhost:5000/api/bot/reply -H "Content-Type: application/json" -d '{\"message\":\"hola\"}'
```

### Base de datos

```powershell
# Conectarse directo a Postgres con psql (necesita psql instalado; usá los valores reales de tu .env, no los pegues en este README)
psql -h <PG_HOST> -p <PG_PORT> -U <PG_USER> -d <PG_DATABASE>

# Copiar el .env de ejemplo la primera vez que clonás el repo
Copy-Item .env.example .env
```

### Git básico

```powershell
git status                        # qué cambió
git add .
git commit -m "mensaje"
git push
git pull
git checkout -b nombre-feature    # nueva rama para no romper main directamente
git log --oneline -10             # últimos 10 commits, resumido
```

### Para más adelante (todavía no configurado, pero probablemente lo necesitemos)

```powershell
npm install eslint --save-dev           # linter, no está configurado todavía
npm install --save-dev vitest           # o jest — no hay tests automatizados todavía
npm install pm2 -g                      # process manager para correr el backend en producción sin caerse
```

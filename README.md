# Penalti Mala Vida — verificación por WhatsApp

El minijuego (`index.html`) valida que cada número de WhatsApp solo pueda registrar **un penalti por día** mediante la API en `server/`.

## Puesta en marcha local

1. Arrancar la API (solo requiere Node.js):

```bash
cd server
node index.js
```

La API queda en `http://localhost:3001`.

2. Abrir el juego sirviendo los archivos estáticos (evita problemas de CORS con `file://`):

```bash
npx --yes serve . -p 8080
```

Abre `http://localhost:8080` y confirma que en `index.html` → `CONFIG.apiBaseUrl` apunta a `http://localhost:3001`.

## Configuración

En `index.html`, sección `CONFIG`:

| Campo | Descripción |
|--------|-------------|
| `apiBaseUrl` | URL base de la API (producción: tu dominio del backend) |
| `defaultCountryCode` | Código de país sin `+` (por defecto `57` Colombia) |

Variables de entorno del servidor (`server/`):

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto (default `3001`) |
| `CORS_ORIGIN` | Origen permitido o `*` |

## Endpoints

- `POST /api/check` — `{ "phone": "573001234567" }` → `{ "allowed": true/false, "result": ... }`
- `POST /api/register` — registra el resultado del tiro (llamado al terminar el penalti)
- `GET /api/health` — comprobación de estado

Los números se guardan en `server/data/shots.json`.

## Producción

Despliega `server/` en Node (Railway, Render, Fly.io, VPS, etc.) y actualiza `CONFIG.apiBaseUrl` al dominio público. Sirve `index.html` desde CDN o hosting estático con `CORS_ORIGIN` apuntando a ese dominio.

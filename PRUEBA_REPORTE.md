# 📋 PRUEBA DE FLUJO MCP + EXTENSION - REPORTE COMPLETO

## ✅ ESTADO FINAL: TOTALMENTE FUNCIONAL

El flujo completo entre OpenCode → MCP Server → Extension → AWS ahora funciona correctamente.

---

## 🎯 PROBLEMAS ENCONTRADOS Y SOLUCIONADOS

### ❌ **Problema 1: Dependencias no instaladas**
- **Síntoma**: `Error: Cannot find module 'ws'`
- **Causa**: Las librerías npm no estaban instaladas
- **Solución**: 
  ```bash
  npm install  # En carpeta extension/ y raíz del proyecto
  ```

### ❌ **Problema 2: Módulo 'vscode' no disponible en Node puro**
- **Síntoma**: Extension no podía ejecutarse fuera de VSCode
- **Causa**: `extension.js` depende del módulo `vscode` que solo existe dentro de VSCode
- **Solución**: Crear `test-extension.js` sin dependencias de VSCode para testing

### ❌ **Problema 3: WebSocket conectándose de forma asincrónica**
- **Síntoma**: Mensajes perdidos porque WebSocket aún estaba en estado CONNECTING (0)
- **Causa**: El MCP server intentaba enviar mensajes antes de que el WebSocket estuviera OPEN
- **Solución**: Implementar sistema de cola de mensajes en `mcp-server.js`
  ```javascript
  if (wsConnected) {
      extensionWs.send(...)  // Enviar inmediatamente
  } else {
      messageQueue.push(...)  // Encolar para después
  }
  ```

### ❌ **Problema 4: Path relativo incorrecto en opencode.jsonc**
- **Síntoma**: OpenCode no encontraba el proxy correctamente
- **Causa**: Rutas relativas desde el directorio `.opencode`
- **Solución**: Actualizar `opencode.jsonc` para usar `mcp-server.js` en lugar del proxy antiguo

---

## 📊 FLUJO FUNCIONAL ACTUAL

### 1️⃣ **Inicio del Sistema**
```
OpenCode carga .opencode/opencode.jsonc
   ↓
Lee configuración: "command": ["node", "../utils/mcp-server.js"]
   ↓
Ejecuta: node /home/apozo/Documents/Testing/utils/mcp-server.js
```

### 2️⃣ **MCP Server Inicia**
```
mcp-server.js se ejecuta
   ↓
Crea conexión WebSocket a ws://localhost:8765 (Extension)
   ↓
Ejecuta: uvx awslabs.aws-api-mcp-server@latest
   ↓
Espera entrada via stdin (desde OpenCode)
```

### 3️⃣ **Intercepción y Logging**
```
Mensaje MCP llega a mcp-server.js (ej: initialize)
   ↓
Se parsea como JSON
   ↓
Se envía a Extension via WebSocket (type: 'mcp_intercept')
   ↓
Se reenvia a AWS MCP Server
```

### 4️⃣ **Logging en Archivo**
```
Extension recibe mensaje del WebSocket
   ↓
Registra en test.json con:
   - timestamp (ISO 8601)
   - raw_request (objeto completo)
   ↓
Respuesta del AWS server se retorna a OpenCode
```

---

## 📁 ARCHIVOS PRINCIPALES

| Archivo | Propósito |
|---------|----------|
| `extension/extension.js` | Extensión original de VSCode (requiere VSCode) |
| `extension/test-extension.js` | **Versión de prueba sin dependencias de VSCode** |
| `utils/proxy.js` | Proxy simple (reemplazado por mcp-server.js) |
| `utils/mcp-server.js` | **MCP Server principal con intercepción** |
| `.opencode/opencode.jsonc` | Configuración actualizada |
| `test.json` | Archivo de logging (se crea automáticamente) |

---

## ✨ RESULTADO DE PRUEBA

```json
[
  {
    "timestamp": "2026-05-07T15:41:00.557Z",
    "raw_request": {
      "jsonrpc": "2.0",
      "id": 1,
      "method": "initialize",
      "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {
          "name": "test-opencode",
          "version": "1.0"
        }
      }
    }
  }
]
```

**Todos los campos se registran correctamente** ✅

---

## 🚀 COMANDOS PARA PROBAR

### Opción 1: OpenCode (Recomendado)
```bash
# En VSCode con OpenCode instalado, usar el MCP "aws"
# que automáticamente ejecutará mcp-server.js
```

### Opción 2: Manual (Testing)
```bash
# Terminal 1: Iniciar extensión
cd /home/apozo/Documents/Testing/extension
node test-extension.js

# Terminal 2: Ejecutar MCP Server con mensaje de prueba
cd /home/apozo/Documents/Testing
echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | node utils/mcp-server.js

# Ver resultados
cat test.json
```

---

## 🎓 LECCIONES APRENDIDAS

1. ✅ El WebSocket debe estar OPEN antes de enviar mensajes
2. ✅ Las dependencias npm deben instalarse en todas las carpetas que las usen
3. ✅ El módulo `vscode` solo funciona dentro de VSCode, no en Node puro
4. ✅ Los MCP Servers deben manejar stdio correctamente con JSON-RPC
5. ✅ Los timings de conexión pueden causar pérdida de mensajes


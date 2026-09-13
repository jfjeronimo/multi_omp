# PROJECT.md — multi_omp

> Lo rellena el orquestador en el primer turno. **Los huecos `<...>` son deuda**: el
> `planner` saca de aquí los comandos y el `verifier` los ejecuta tal cual, así que un
> comando mal escrito aquí es una fase que se cierra sin comprobar nada.

## Qué es

Control plane (gateway) para N instancias de omp-web: un dashboard en un puerto
de control, un proxy transparente por nodo en puertos locales propios (30200-30299),
barra de cambio de nodo inyectada en cada página y notificador Telegram de estados
de sesión.

## Stack

- **Arquetipo**: web
- **Lenguaje / versión**: TypeScript 5.5, runtime Bun ≥ 1.1
- **Gestor de paquetes**: bun
- **Detectado a partir de**: package.json + tsconfig.json o framework web

## Comandos (los ejecuta el `verifier`)

| Paso | Comando |
|---|---|
| instalar | `bun install` |
| build | `ninguno` (sin paso de build; Bun ejecuta TS directamente) |
| tests | `bun test` |
| lint | `ninguno` |
| formato | `ninguno` |
| tipos | `bun run typecheck` (tsc --noEmit) |

`ninguno` es una respuesta válida y honesta. El hueco de "por confirmar"
significa que nadie lo ha comprobado todavía — el `verifier` lo tratará
como `no_verificable`.

## Arrancar en local

```bash
bun run dev          # arranca en http://127.0.0.1:30140 (dashboard + API)
# Puertos de nodo: 30200-30299 asignados en tiempo de ejecución.
# Variables: GATEWAY_PORT, HOSTNAME_BIND, NODE_PORT_FIRST/LAST (ver README).
```

## Qué NO se toca
- `nodes.json` (estado local del gateway, 0600): no editar a mano con el gateway corriendo.
- `tests/helpers/` es infraestructura de test; no tocar sin motivo.

## Requisitos del nodo

Este proyecto necesita `TOOLCHAIN=web` en el `.env` del nodo. Si el nodo no
tiene la herramienta, el `verifier` devuelve `no_verificable` y las fases no cierran —
que es lo correcto, pero significa que ese nodo no es para este proyecto.

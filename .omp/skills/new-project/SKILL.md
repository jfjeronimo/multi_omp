---
name: new-project
description: Preparar y sincronizar un repo para que trabajen los subagentes — materializa .omp/agents, .omp/skills, AGENTS.md, PROJECT.md y DECISIONS.md donde omp los descubre, y confirma los comandos reales de build/test/lint. Úsala en cualquier directorio cuyo --check no salga 0.
---

# Preparar un proyecto

Un repo sin preparar rompe la cadena de calidad **en silencio**: omp no encuentra los
roles ni las skills, no avisa, y la sesión corre sin `planner`, sin `verifier` y sin
rúbrica. Todo parece normal y nada se ha comprobado.

## 0. Qué exige omp, exactamente

Los ficheros se descubren **por ruta y nombre literales**. Un `.md` bien escrito en el
sitio equivocado no existe para omp:

| Ruta | Regla dura |
|---|---|
| `<raíz>/AGENTS.md` | el walk-up de context files **para en la raíz del repo git** |
| `<raíz>/.omp/agents/<rol>.md` | frontmatter con `name` **y** `description`; `main`/`sub` son nombres reservados |
| `<raíz>/.omp/skills/<n>/SKILL.md` | el fichero se llama `SKILL.md` **exactamente**; sin `description` se salta sin avisar |

`.omp/agents/` gana al nivel usuario, y las skills se buscan acotadas a la raíz del
repo. Por eso viven **dentro** del proyecto: así funciona en cualquier máquina y desde
cualquier directorio, esté o no montada la config de la flota.

## 1. Ejecuta el scaffolder

Desde la raíz del proyecto:

```bash
bash ~/.omp/agent/scripts/bootstrap-project.sh
```

Detecta el arquetipo y deja el proyecto completo: `AGENTS.md` (núcleo de la flota +
rúbrica del dominio), `PROJECT.md`, `DECISIONS.md`, los ejemplos del dominio, y
`.omp/` con los 5 roles, las skills y una copia del propio script.

**Es idempotente y además sincroniza**: si el repo de control ha actualizado un rol, la
siguiente ejecución lo trae; si tú editaste un fichero gestionado, no lo pisa — lo
reporta como *editado en local* y sigue. `--force` fuerza la versión de la flota.

Lee su salida. Si el arquetipo que eligió no encaja con lo que ves en el repo,
rehazlo sin dudar:

```bash
bash ~/.omp/agent/scripts/bootstrap-project.sh --type <tipo> --force
```

`code | python | web | trading | unity | blender | media-stack | pentest`

Un caso que se repite: un repo Python con `backtrader` en los requirements sale como
`trading`, y está bien; pero un repo Python que solo *consume* datos de mercado para un
dashboard es `python` o `web`. El arquetipo lo decide **para qué es el repo**, no qué
librerías importa.

## 2. Confirma los comandos (esto es el trabajo de verdad)

El script rellena lo que puede deducir del manifiesto y deja `<pendiente>` en lo demás.
**Ningún `<pendiente>` puede sobrevivir a este paso.** Para cada fila de la tabla de
`PROJECT.md`:

1. **Ejecútalo.** No lo copies del README ni lo supongas: lánzalo y mira el código de
   salida. Un comando que no existe en este nodo es información valiosa.
2. Si funciona, déjalo tal cual, **con las banderas que lo hacen no interactivo**
   (`-q`, `--ci`, `--no-watch`): el `verifier` lo ejecutará sin terminal.
3. Si el proyecto no tiene ese paso, escribe `ninguno`. Es una respuesta honesta.
4. Si el paso existe pero **este nodo** no puede ejecutarlo (falta el Editor de Unity,
   falta Blender, falta Docker), escríbelo igualmente y anota en "Requisitos del nodo"
   qué `TOOLCHAIN` hace falta. El `verifier` devolverá `no_verificable`, que es el
   resultado correcto — no lo disfraces poniendo `ninguno`.

Rellena también "Qué es", el stack y "Qué NO se toca". Esto último ahorra más incidentes
que el resto junto: directorios generados, artefactos, configuración de la máquina.

## 3. Ajusta el arquetipo a este repo

`AGENTS.md` es tuyo desde que se genera. Mira sobre todo la sección **"Rúbrica de
revisión (dominio)"**: si este repo tiene una trampa propia —un módulo que no se puede
tocar sin regenerar algo, una convención de nombres que rompe el build, un test que solo
pasa con una variable de entorno— **añádela como una línea más de la rúbrica**. Eso es lo
que hace que el `reviewer` sea útil aquí y no genérico.

Borra de la rúbrica lo que claramente no aplica. Una rúbrica con ejes muertos enseña a
ignorarla.

## 4. Deja constancia

Primera entrada de `DECISIONS.md`: por qué este arquetipo y cualquier cosa rara que
hayas descubierto montando los comandos (que los tests necesitan un servicio levantado,
que el lint está roto y se ignora a propósito, etc.).

## 5. Versiona `.omp/`

Súbelo al repo del proyecto. Es lo que lo hace autocontenido: quien lo clone en otra
máquina tiene los roles y las skills sin depender de la config de la flota. `.omp/`
lleva su propio `README.md` explicando qué es y cómo se re-sincroniza.

## Cuándo NO hace falta

Cuando `--check` sale 0. Es la comprobación de arranque de toda sesión y no escribe nada:

```bash
bash .omp/scripts/bootstrap-project.sh --check
```

Valida el layout de verdad —nombres de fichero, frontmatter, posición respecto a la raíz
del repo—, no solo que los ficheros existan. Sale 1 y enumera qué falta.

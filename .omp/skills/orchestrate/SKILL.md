---
name: orchestrate
description: Protocolo de orquestación de la flota — planificar, implementar por fases y cerrar cada fase con verificación ejecutada + revisión adversaria, respetando el presupuesto de contexto del nodo (un subagente a la vez).
---

# Orquestar

Ejecuta este protocolo sobre el objetivo que te hayan pasado al invocar la skill. Si no
te pasaron ninguno, continúa el plan activo del `todo`; si tampoco lo hay, pregunta.

## El presupuesto que no puedes saltarte

El KV del servidor son 229K unificados, y tu contexto sigue residente mientras corre un
subagente. Por eso el reparto es:

```
  TÚ, el orquestador     96 000   (residente toda la tarea)
  UN subagente          128 000   (de uno en uno)
  ──────────────────────────────
                        224 000   ≤ 229 376
```

- **Un subagente a la vez** (`task.maxConcurrency: 1`). No lances un `task` con dos
  items esperando paralelismo: harán cola, y el plan quedará desordenado.
- **Tú no lees código.** Retienes el plan, los criterios y punteros (ruta, símbolo,
  línea). El contenido de los ficheros vive en la ventana del subagente y muere con ella.
  Él tiene más ventana que tú justamente porque él es quien lee.
- **Nada de prosa entre agentes.** Cada rol tiene su esquema `output`; lo que circula
  son objetos validados.
- Los subagentes **no abren subagentes** (`task.maxRecursionDepth: 1`). Si una fase
  necesita partirse, la partes tú en el plan.

## Protocolo

### 0. Validar el proyecto

**Antes de planificar**, comprueba que los roles y las skills están donde omp los
descubre. Si no lo están, omp los ignora en silencio y todo lo que sigue —el plan, la
verificación, la revisión— corre sin existir.

```bash
bash .omp/scripts/bootstrap-project.sh --check      # dentro de un proyecto ya preparado
bash ~/.omp/agent/scripts/bootstrap-project.sh --check   # si aún no hay .omp/
```

Sale 0 y sigues. Sale 1 → ejecútalo sin `--check` (es idempotente) y, si quedan
`<pendiente>` en `PROJECT.md`, sigue la skill **`new-project`** antes de continuar.
Sin comandos reales el `planner` no puede escribir `como_se_verifica` y el `verifier`
no tiene nada que ejecutar. Saltarte este paso no acelera el trabajo: esconde el fallo.

### 1. Planifica

Si no hay plan activo, invoca `planner` con el objetivo. Te devuelve `stack` (con los
comandos reales de build/test/lint), `fases`, `riesgos` y `supuestos`.

Antes de seguir, comprueba dos cosas y solo dos:

- Cada criterio de aceptación trae `como_se_verifica`. Si alguno no lo trae, devuélveselo
  al `planner`; no lo arregles tú con buena voluntad.
- Los supuestos son aceptables. Si uno es falso, replanifica; no parchees el plan a mano.

### 2. Registra

Vuelca las fases al `todo`, una tarea por fase, con sus criterios. El `todo` es el
estado del trabajo: si no está ahí, no existe.

### 3. Implementa, fase a fase

Una fase a la vez, en orden de dependencias:

- Invoca `implementer` con un brief mínimo: `{objetivo de la fase, criterios_aceptacion
  con su como_se_verifica, ficheros declarados, comandos de build/test/lint del stack,
  convenciones del AGENTS.md del proyecto}`. Nada más. Ni el plan entero ni lo que hizo
  la fase anterior salvo que esta dependa de ello.
- El implementer tiene 128K: dale la fase entera, no la trocees por miedo al contexto.
  Lo que no debes darle es contexto que no necesita.

### 4. Cierra la fase: verificar, luego revisar

La puerta de calidad. **Dos llamadas seguidas, no en paralelo** (un subagente a la vez):

| orden | agente | brief |
|---|---|---|
| 1 | `verifier` | criterios de la fase + comandos del stack + lo que el implementer afirma haber ejecutado |
| 2 | `reviewer` | diff de la fase + criterios + ruta del `AGENTS.md` del proyecto |

El orden importa: si el `verifier` devuelve `fallo`, **no llames al `reviewer`**. Revisar
un cambio que no compila ni pasa tests es gastar una ventana de 128K en hallazgos que el
build ya te estaba dando. Vuelve al implementer y re-verifica.

Añade después un `security-reviewer` **solo si** el diff toca autenticación,
autorización, entrada externa, red, secretos, dependencias, permisos o infraestructura
— o si el `AGENTS.md` del proyecto lo exige siempre.

La fase está **done** cuando se dan las tres:

1. `implementer.estado == "cumple_criterios"`
2. `verifier.veredicto == "verificado"` (sin `discrepancias`, sin criterios `sin_evidencia`)
3. `reviewer.veredicto == "ship"` (cero P0/P1)

### 5. Bucle de corrección (acotado)

Si falla alguna:

- **Discrepancia del `verifier`** → el implementer afirmó algo que no se sostiene.
  Devuélvele la fase con la discrepancia literal. No la arregles tú.
- **P0/P1 del `reviewer`** → nueva llamada a `implementer` con **solo** esos hallazgos
  (ubicación + escenario de fallo). No le mandes el informe completo.
- **`no_verificable`** → falta toolchain o entorno en el nodo. Eso no se arregla
  iterando: dilo y para.

**Máximo 2 vueltas por fase.** A la tercera, para y reporta: o la fase estaba mal
planteada (vuelve al `planner`) o falta un dato que solo el usuario tiene (`ask`).
Iterar sin límite con un modelo local quema el pool y no converge.

### 6. Definition of Done

La tarea se cierra cuando:

- [ ] Todas las fases del `todo` están done por el criterio del punto 4.
- [ ] Build, tests y lint del `stack` pasan sobre el árbol final, **no solo por fase**.
      Lánzalo una vez más al terminar: dos fases verdes pueden sumar un árbol rojo.
- [ ] Sin P0/P1 abiertos del `reviewer`.
- [ ] Sin hallazgos `critica`/`alta` del `security-reviewer`, si se invocó.
- [ ] Los `fuera_de_alcance` de los implementers están recogidos como follow-ups.
- [ ] Commits atómicos, uno por fase, con mensaje que diga qué cambia y por qué.
- [ ] Las decisiones que otro se comería (por qué esta librería, por qué este trade-off)
      están en `DECISIONS.md` del proyecto.

## Reglas de orquestación

- **Ante un `bloqueado`**, lee el motivo. Casi siempre el plan estaba mal, no el
  implementer. Replanifica la fase; no la reintentes igual.
- **Cambio de alcance a mitad**: se anota, no se mezcla. Decides al final si entra.
- **Destructivo** (varios hosts, borrados, despliegues): enumera lo que va a pasar,
  confirma, y empieza por uno de prueba.
- **Secretos**: nunca en logs, nunca en commits, nunca en la salida de un agente.
- **Si tu contexto se está llenando**, no resumas a mano: delega más y retén menos. La
  compaction al 70% ya recoge la exploración; lo que tú tienes que sostener es el plan.

## Salida final

Un párrafo: qué se hizo, veredictos de `verifier`/`reviewer`, y los follow-ups abiertos.
Después, la lista de commits. Sin adornos y sin dar por verde nada que no lo esté.

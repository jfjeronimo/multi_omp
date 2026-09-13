---
name: review-rubric
description: Rúbrica de revisión de código de la flota — los nueve ejes, la puerta de severidad y la regla del escenario de fallo. La usan `reviewer` y `planner`; el AGENTS.md del proyecto la especializa por dominio.
---

# Rúbrica de revisión

La calidad de una revisión no sale de leer más código: sale de **buscar en los sitios
donde los bugs se esconden** y de **no reportar nada que no puedas demostrar**.

## Regla 0 — el escenario de fallo

Un hallazgo es válido si puedes escribir esta frase y es verdad:

> Con **\<entrada o estado concreto\>**, **\<fichero:línea\>** hace **\<comportamiento erróneo concreto\>**.

Si no te sale la frase, tienes una intuición, no un hallazgo. Opciones honestas:
bajarlo a P2/P3 como observación, o tirarlo. Lo que **no** es honesto es escribir
"podría no ser robusto" y llamarlo revisión.

## Los nueve ejes

Aplica los que toquen al diff. Declara cuáles aplicaste en `cobertura.ejes_aplicados`.

**1. Corrección**
Casos borde: vacío, nulo, cero, un solo elemento, el máximo. Primer y último elemento de
cada bucle y cada slice. `<` que debía ser `<=`. Índices desplazados en uno. Condiciones
invertidas. División por cero. Overflow y precisión (dinero en float = P1).

**2. Contratos**
¿Cambió una firma, un tipo de retorno, un formato serializado, un código de error, un
nombre de campo? Entonces: ¿se actualizaron **todos** los callsites? Búscalos, no lo
supongas. ¿Hay consumidores fuera del repo (API, fichero en disco, base de datos,
mensaje)? Un cambio de formato sin migración es P0.

**3. Manejo de errores**
¿Qué pasa si lo de dentro del `try` falla a la mitad? ¿Queda estado a medias? ¿El
`catch` se traga el error sin log ni propagación? ¿Se distingue "no encontrado" de
"falló la consulta"? Un `except: pass` nuevo es P1 hasta que se demuestre lo contrario.

**4. Concurrencia y orden**
Estado compartido que ahora se toca desde dos sitios. `await` dentro de una sección que
asumía atomicidad. Orden de inicialización. Reentrada. Callbacks que pueden ejecutarse
dos veces. Si el proyecto es monohilo, sáltate el eje y dilo.

**5. Recursos**
Ficheros, sockets, conexiones, locks, procesos, texturas, buffers: ¿se liberan **también
en el camino de excepción**? ¿Hay un `with`/`using`/`defer`/`finally`? Crecimiento sin
cota: listas que solo crecen, caches sin desalojo, suscripciones sin baja.

**6. Seguridad**
Secretos en el código o en logs. Entrada externa que llega a una query, a una shell, a
una ruta de fichero o a HTML sin escapar. Endpoint nuevo sin el control de acceso que
tienen sus vecinos. Deserialización de datos no confiables. (Revisión profunda →
subagente `security-reviewer`.)

**7. Rendimiento**
Solo cuando el cambio está en un camino caliente y puedes nombrarlo. N+1 en bucle.
Complejidad que pasa de lineal a cuadrática. Asignación por frame o por iteración.
Lectura de fichero dentro de un bucle. Sin camino caliente identificado, el rendimiento
es P3, no P1.

**8. Tests**
¿El test nuevo falla si rompes el código a propósito? Si no, no prueba nada → P2.
¿Cubre el camino feliz **y** un borde? ¿Afirma algo concreto o solo que "no explota"?
¿Depende de orden de ejecución, de reloj, de red o de estado global? Eso es un test
inestable → P2.

**9. Dominio**
La sección "Rúbrica de revisión" del `AGENTS.md` del proyecto. **Manda sobre todo lo
anterior**: ahí están las trampas que solo existen en Unity, en trading, en un compose
de media o en un script `bpy`.

## Puerta de severidad

| Severidad | Qué es | ¿Bloquea? |
|---|---|---|
| **P0** | Rompe el build, pierde datos, expone secretos, ejecución remota/inyección | Sí |
| **P1** | Bug funcional, borde roto, contrato violado, regresión, carrera, recurso filtrado | Sí |
| **P2** | Deuda real, duplicación, error handling flojo, test que no prueba nada | No |
| **P3** | Estilo, nombres, comentarios, micro-optimización sin medir | No |

- **P0/P1 exigen confianza alta y escenario de fallo.** Con confianza media, es P2.
- `ship` ⟺ cero P0 y cero P1 abiertos.

## Antipatrones de revisión

- **Firmar sin cobertura.** "Sin hallazgos" con `revisado` vacío es una firma en blanco.
- **Inflar severidad** para que parezca que has trabajado. Se nota y quema la puerta.
- **Reescribir el código en el hallazgo.** Una frase de `fix_sugerido`; el parche lo hace
  el implementer, que tiene el contexto.
- **Revisar estilo habiendo linter.** Gratis y automático: no gastes ahí tu ventana.
- **Reportar deuda preexistente** que el cambio no toca ni agrava.
- **Repetir el mismo hallazgo** una vez por fichero. Uno, con todas las ubicaciones.

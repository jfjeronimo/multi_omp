# DECISIONS.md — multi_omp

Una línea por decisión no obvia, **cuando se toma**. Si alguien tendría que
preguntarte "¿y por qué así?", va aquí.

| Fecha | Decisión | Por qué | Alternativa descartada |
|---|---|---|---|
| 2026-09-12 | Arquetipo `web` para este repo | Detectado por: package.json + tsconfig.json o framework web | — |
| 2026-09-13 | El proxy reescribe `Origin` al origin del nodo (solo si el request trae Origin) | El middleware de omp-web hace 403 en `/api/*` cuando `Origin` ≠ `scheme://host` del request; el browser manda el Origin del puerto del nodo del gateway y todos los prompts morían en el 403 (síntoma: el mensaje desaparecía). Reescritura = misma lógica que la de `Host`, y pasa la comprobación más estricta del middleware (igualdad exacta) | Borrar el header: funcionaría por el hueco "sin Origin", pero dependería de ese camino laxo del middleware en vez de la comprobación estricta, y rompería la semántica del header para navegadores |
| 2026-09-13 | Chip de restauración `#momo-restore` (abajo-izquierda, fijo) cuando la barra está oculta | La barra se ocultaba para siempre en ese browser y no había forma de recuperarla; el chip es la mínima superficie para deshacerlo. El estado es una máquina de dos clases excluyentes en `<body>` (`momo-bar-on`/`momo-bar-hidden`) — antes ambas convivían y el CSS ganaba por orden | Un botón de "mostrar" en el dashboard: obliga a navegar a otro puerto; el chip mantiene la barra autocontenida en la propia página |

# .omp/ — config de agentes de este proyecto

omp descubre aquí los roles (`.omp/agents/`) y las skills (`.omp/skills/`) con
**precedencia sobre la config de usuario**, así que este proyecto funciona igual en
cualquier máquina y desde cualquier directorio, tenga o no la config de la flota.

Lo gestiona `bootstrap-project.sh` y es idempotente:

    bash .omp/scripts/bootstrap-project.sh --check   # ¿al día? 0=sí 1=no
    bash .omp/scripts/bootstrap-project.sh           # sincronizar

Si editas un fichero de `.omp/agents/` o `.omp/skills/`, la sincronización **no lo
pisa**: lo reporta como editado en local y sigue. Para volver a la versión de la flota,
`--force`. Los hashes de control están en `.sync-manifest`.

Conviene versionar `.omp/` con el proyecto: es lo que lo hace autocontenido.

#!/usr/bin/env bash
# bootstrap-project.sh — deja CUALQUIER directorio listo para trabajar con los
# subagentes de la flota, y lo mantiene sincronizado.
#
# Materializa dentro del proyecto los ficheros que omp descubre a nivel de proyecto:
#
#   <proyecto>/AGENTS.md            núcleo de la flota + rúbrica del dominio
#   <proyecto>/PROJECT.md           stack y comandos reales (los ejecuta el verifier)
#   <proyecto>/DECISIONS.md         bitácora de decisiones
#   <proyecto>/.omp/agents/*.md     los 5 roles      (omp: .omp/agents, gana al nivel usuario)
#   <proyecto>/.omp/skills/*/       las skills       (omp: .omp/skills, walk-up desde cwd)
#   <proyecto>/.omp/scripts/        este mismo script, para re-sincronizar sin el nodo
#   <proyecto>/.omp/.sync-manifest  hashes de lo gestionado, para detectar deriva
#
# IDEMPOTENTE: ejecútalo las veces que quieras. Sin cambios, no toca nada y sale 0.
# Cuando el repo de control actualiza un rol, la siguiente ejecución lo actualiza;
# si TÚ has editado un fichero gestionado, no lo pisa: lo reporta y sigue.
#
#   bash bootstrap-project.sh                 # preparar / sincronizar (lo habitual)
#   bash bootstrap-project.sh --check         # ¿está al día? No escribe. 0=sí 1=no
#   bash bootstrap-project.sh --type python   # forzar arquetipo
#   bash bootstrap-project.sh --force         # rehacer AGENTS.md y pisar ediciones locales
#   bash bootstrap-project.sh --dir /ruta     # operar sobre otro directorio
#   bash bootstrap-project.sh --from ~/.omp/agent   # de dónde copiar (por defecto: autodetecta)
#   bash bootstrap-project.sh --no-vendor     # solo los .md del proyecto, sin .omp/
set -uo pipefail

TARGET="$PWD"; TYPE=""; CHECK=0; FORCE=0; VENDOR=1; SRC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)   TYPE="${2:-}"; shift 2 ;;
    --dir)    TARGET="${2:-}"; shift 2 ;;
    --from)   SRC="${2:-}"; shift 2 ;;
    --check)  CHECK=1; shift ;;
    --force)  FORCE=1; shift ;;
    --no-vendor) VENDOR=0; shift ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "argumento desconocido: $1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# De dónde sale la config. El script se ejecuta tanto desde ~/.omp/agent/scripts/
# (nodo con la flota montada) como desde <proyecto>/.omp/scripts/ (copia vendida).
# ---------------------------------------------------------------------------
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
resolve_src() {
  local c
  for c in "$SRC" "${OMP_AGENT_DIR:-}" "$SELF_DIR/.." "$HOME/.omp/agent" "/home/omp/.omp/agent"; do
    [[ -n "$c" ]] || continue
    if [[ -d "$c/agents" && -d "$c/project-templates" ]]; then (cd "$c" && pwd); return 0; fi
  done
  return 1
}
SRC="$(resolve_src)" || SRC=""
TEMPLATES="${SRC:+$SRC/project-templates}"

cd "$TARGET" 2>/dev/null || { echo "ERROR: no puedo entrar en $TARGET" >&2; exit 1; }
TARGET="$PWD"
OMPDIR="$TARGET/.omp"
MANIFEST="$OMPDIR/.sync-manifest"

if [[ -z "$SRC" ]]; then
  # Sin fuente no se puede sincronizar, pero sí decir en qué estado está el proyecto.
  if (( CHECK == 0 )); then
    echo "ERROR: no encuentro la config de la flota (agents/ + project-templates/)." >&2
    echo "       Pásala con --from <dir> o exporta OMP_AGENT_DIR. Buscado en:" >&2
    echo "         \$OMP_AGENT_DIR, $SELF_DIR/.., ~/.omp/agent, /home/omp/.omp/agent" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
have()    { [[ -e "$1" ]]; }
globhit() { compgen -G "$1" >/dev/null 2>&1; }
infile()  { [[ -f "$2" ]] && grep -qiE "$1" "$2" 2>/dev/null; }

if command -v sha256sum >/dev/null 2>&1;  then hashof() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum  >/dev/null 2>&1;  then hashof() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v openssl >/dev/null 2>&1;  then hashof() { openssl dgst -sha256 "$1" | awk '{print $NF}'; }
else hashof() { wc -c < "$1" | tr -d ' '; }   # último recurso: tamaño (detecta la mayoría de cambios)
fi
manifest_hash() { [[ -f "$MANIFEST" ]] && awk -v p="$1" '$2==p {print $1; exit}' "$MANIFEST"; }

# ---------------------------------------------------------------------------
# Arquetipo. Devuelve "<tipo>|<evidencia>": detect() corre en subshell.
# ---------------------------------------------------------------------------
detect() {
  if have "ProjectSettings/ProjectVersion.txt" || { have "Assets" && globhit "*.sln"; }; then
    echo "unity|ProjectSettings/ProjectVersion.txt o Assets/ + *.sln"; return
  fi
  if globhit "*.blend" || grep -rslE "^import bpy|^from bpy" --include="*.py" . 2>/dev/null | head -1 | grep -q .; then
    echo "blender|*.blend o scripts con 'import bpy'"; return
  fi
  if have "SCOPE.yml" || have "SCOPE.yaml" || have "SCOPE.example.yml"; then
    echo "pentest|SCOPE.yml"; return
  fi
  local has_py=0 has_js=0
  { have pyproject.toml || have requirements.txt || have setup.py || have setup.cfg; } && has_py=1
  have package.json && has_js=1

  if (( has_py )) && {
        infile "backtrader|vectorbt|zipline|ccxt|backtesting|nautilus_trader|lean" pyproject.toml ||
        infile "backtrader|vectorbt|zipline|ccxt|backtesting|nautilus_trader|lean" requirements.txt ||
        have backtest || have backtests || have strategies; }; then
    echo "trading|manifiesto Python + librerías o directorios de backtesting"; return
  fi
  if (( has_js )) && { have tsconfig.json ||
        infile '"(next|react|vue|svelte|vite|astro|nuxt|remix|solid-js)"' package.json; }; then
    echo "web|package.json + tsconfig.json o framework web"; return
  fi
  if (( has_py )); then echo "python|pyproject.toml / requirements.txt / setup.py"; return; fi
  if { globhit "docker-compose.y*ml" || globhit "compose.y*ml"; } && (( has_js == 0 )); then
    echo "media-stack|docker-compose.yml sin manifiesto de código"; return
  fi
  if (( has_js )); then echo "code|package.json"; return; fi
  echo "code|ningún manifiesto reconocido"
}

# Un proyecto ya preparado conserva su arquetipo: no se re-adivina en cada pasada.
RECORDED_TYPE=""
[[ -f "$MANIFEST" ]] && RECORDED_TYPE="$(awk '/^# archetype /{print $3; exit}' "$MANIFEST")"
if   [[ -n "$TYPE" ]];           then EVIDENCE="forzado con --type $TYPE"
elif [[ -n "$RECORDED_TYPE" ]];  then TYPE="$RECORDED_TYPE"; EVIDENCE="registrado en .omp/.sync-manifest"
else _d="$(detect)"; TYPE="${_d%%|*}"; EVIDENCE="${_d#*|}"; fi

ARCH_DIR="${TEMPLATES:+$TEMPLATES/$TYPE}"
if [[ -n "$TEMPLATES" && ! -f "$ARCH_DIR/AGENTS.md" ]]; then
  echo "ERROR: arquetipo '$TYPE' desconocido. Disponibles:" >&2
  ls -1 "$TEMPLATES" | grep -v '^_' | sed 's/^/  /' >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Comandos por arquetipo (lo que se puede deducir del manifiesto; el resto queda
# en <pendiente> para que el orquestador lo confirme ejecutándolo).
# ---------------------------------------------------------------------------
CMD_INSTALL="<pendiente>"; CMD_BUILD="<pendiente>"; CMD_TEST="<pendiente>"
CMD_LINT="<pendiente>";    CMD_FORMAT="<pendiente>"; CMD_TYPES="ninguno"
TOOLCHAIN="code"

case "$TYPE" in
  python|trading)
    if   have uv.lock;          then CMD_INSTALL="uv sync";        CMD_TEST="uv run pytest -q"
    elif have poetry.lock;      then CMD_INSTALL="poetry install"; CMD_TEST="poetry run pytest -q"
    elif have pyproject.toml;   then CMD_INSTALL="pip install -e \".[dev]\""; CMD_TEST="pytest -q"
    elif have requirements.txt; then CMD_INSTALL="pip install -r requirements.txt"; CMD_TEST="pytest -q"
    fi
    CMD_BUILD="ninguno"
    if have .ruff.toml || infile "\[tool\.ruff\]" pyproject.toml; then
      CMD_LINT="ruff check ."; CMD_FORMAT="ruff format --check ."
    elif have .flake8 || have setup.cfg; then CMD_LINT="flake8"; CMD_FORMAT="black --check ."; fi
    if   have mypy.ini || infile "\[tool\.mypy\]" pyproject.toml; then CMD_TYPES="mypy ."
    elif infile "\[tool\.pyright\]" pyproject.toml;               then CMD_TYPES="pyright"; fi
    ;;
  web)
    TOOLCHAIN="web"
    if   have pnpm-lock.yaml; then CMD_INSTALL="pnpm install"; CMD_BUILD="pnpm build"; CMD_LINT="pnpm lint"
    elif have bun.lock || have bun.lockb; then CMD_INSTALL="bun install"; CMD_BUILD="bun run build"; CMD_LINT="bun run lint"
    elif have yarn.lock; then CMD_INSTALL="yarn install --frozen-lockfile"; CMD_BUILD="yarn build"; CMD_LINT="yarn lint"
    elif have package-lock.json; then CMD_INSTALL="npm ci"; CMD_BUILD="npm run build"; CMD_LINT="npm run lint"; fi
    have tsconfig.json && CMD_TYPES="tsc --noEmit"
    if   infile '"vitest"' package.json; then CMD_TEST="vitest run"
    elif infile '"jest"'   package.json; then CMD_TEST="jest --ci"
    elif infile '"test":'  package.json; then CMD_TEST="npm test"; fi
    infile '"(biome|@biomejs)' package.json && { CMD_LINT="biome check ."; CMD_FORMAT="biome format ."; }
    ;;
  unity)
    TOOLCHAIN="none"; CMD_INSTALL="ninguno"
    CMD_BUILD="Unity -batchmode -quit -nographics -projectPath . -executeMethod Build.CI -logFile -"
    CMD_TEST="Unity -batchmode -runTests -testPlatform EditMode -projectPath . -testResults results.xml -logFile -"
    CMD_LINT="ninguno"; CMD_FORMAT="dotnet format --verify-no-changes"
    ;;
  blender)
    TOOLCHAIN="blender"; CMD_INSTALL="ninguno"; CMD_BUILD="ninguno"
    CMD_TEST="blender -b <escena>.blend -P scripts/validate.py"
    CMD_LINT="ninguno"; CMD_FORMAT="ruff format --check scripts/"
    ;;
  media-stack)
    TOOLCHAIN="media"; CMD_INSTALL="ninguno"; CMD_BUILD="docker compose config"
    CMD_TEST="docker compose ps --format json"; CMD_LINT="docker compose config --quiet"; CMD_FORMAT="ninguno"
    ;;
  pentest)
    TOOLCHAIN="pentest"; CMD_INSTALL="pip install -r requirements.txt"; CMD_BUILD="ninguno"
    CMD_TEST="ninguno"; CMD_LINT="ninguno"; CMD_FORMAT="ninguno"
    ;;
  code)
    if   have Cargo.toml; then CMD_INSTALL="cargo fetch"; CMD_BUILD="cargo build"; CMD_TEST="cargo test"; CMD_LINT="cargo clippy -- -D warnings"; CMD_FORMAT="cargo fmt --check"
    elif have go.mod;     then CMD_INSTALL="go mod download"; CMD_BUILD="go build ./..."; CMD_TEST="go test ./..."; CMD_LINT="go vet ./..."; CMD_FORMAT="gofmt -l ."
    elif have package.json; then TOOLCHAIN="web"; CMD_INSTALL="npm ci"; CMD_BUILD="npm run build"; CMD_TEST="npm test"; fi
    ;;
esac

PROJECT_NAME="$(basename "$TARGET")"
subst() {
  sed -e "s|{{PROJECT_NAME}}|$PROJECT_NAME|g" -e "s|{{ARCHETYPE}}|$TYPE|g" \
      -e "s|{{EVIDENCE}}|$EVIDENCE|g"         -e "s|{{TOOLCHAIN}}|$TOOLCHAIN|g" \
      -e "s|{{CMD_INSTALL}}|$CMD_INSTALL|g"   -e "s|{{CMD_BUILD}}|$CMD_BUILD|g" \
      -e "s|{{CMD_TEST}}|$CMD_TEST|g"         -e "s|{{CMD_LINT}}|$CMD_LINT|g" \
      -e "s|{{CMD_FORMAT}}|$CMD_FORMAT|g"     -e "s|{{CMD_TYPES}}|$CMD_TYPES|g"
}

# ---------------------------------------------------------------------------
# Qué ficheros se vendan al proyecto (relpath -> origen absoluto)
# ---------------------------------------------------------------------------
declare -a VEND_REL=() VEND_SRC=()
if (( VENDOR )) && [[ -n "$SRC" ]]; then
  for f in "$SRC"/agents/*.md; do
    [[ -e "$f" ]] || continue
    VEND_REL+=(".omp/agents/$(basename "$f")"); VEND_SRC+=("$f")
  done
  for d in "$SRC"/skills/*/; do
    [[ -d "$d" ]] || continue
    sk="$(basename "$d")"
    while IFS= read -r f; do
      [[ -n "$f" ]] || continue
      VEND_REL+=(".omp/skills/$sk/${f#"$d"}"); VEND_SRC+=("$f")
    done < <(find "$d" -type f 2>/dev/null)
  done
  if [[ -f "$SRC/scripts/bootstrap-project.sh" ]]; then
    VEND_REL+=(".omp/scripts/bootstrap-project.sh"); VEND_SRC+=("$SRC/scripts/bootstrap-project.sh")
  fi
fi

# ---------------------------------------------------------------------------
# Validación del LAYOUT que omp exige. No basta con que los ficheros existan:
# si el nombre o el frontmatter no son los que espera el discovery, omp los
# ignora EN SILENCIO y la sesión corre sin roles ni skills, con la calidad que
# eso implica. Esto es lo que comprueba el orquestador al arrancar.
#
# Rutas exigidas (verificadas contra el código de omp 18.1.x):
#   .omp/agents/<n>.md        discovery/config.ts findAllNearestProjectConfigDirs("agents")
#                             -> frontmatter con `name` y `description` o se descarta
#   .omp/skills/<n>/SKILL.md  discovery/builtin.ts loadSkills -> el fichero se llama
#                             SKILL.md EXACTAMENTE, y necesita `description`
#                             (requireDescription: true) o se salta sin avisar
#   AGENTS.md en la raíz      discovery/agents-md.ts, walk-up acotado a la raíz del repo
# ---------------------------------------------------------------------------
frontmatter_has() {  # <fichero> <clave>
  awk 'NR==1 && $0!="---"{exit 1} NR>1 && $0=="---"{exit 0} NR>1' "$1" 2>/dev/null \
    | grep -qE "^$2:[[:space:]]*[^[:space:]]"
}

validate_layout() {   # imprime un problema por línea; vacío = todo bien
  local repo_root=""
  repo_root="$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null)"

  for f in AGENTS.md PROJECT.md DECISIONS.md; do
    [[ -f "$f" ]] || echo "falta $f"
  done

  # Las skills se buscan en ancestros ACOTADOS por la raíz del repo
  # (getAncestorDirs(cwd, repoRoot ?? home)). Si .omp cuelga por encima de la
  # raíz del repo, omp no lo ve.
  if [[ -n "$repo_root" && "$(cd "$TARGET" && pwd)" != "$(cd "$repo_root" && pwd)" ]]; then
    echo "aviso: $TARGET no es la raíz del repo ($repo_root); .omp/ debe estar en la raíz"
  fi

  if [[ -d .omp/agents ]]; then
    local n=0
    for a in .omp/agents/*.md; do
      [[ -e "$a" ]] || continue
      n=$((n+1))
      frontmatter_has "$a" name        || echo "$a: sin \`name\` en frontmatter → omp lo descarta"
      frontmatter_has "$a" description || echo "$a: sin \`description\` en frontmatter → omp lo descarta"
      grep -qE "^name:[[:space:]]*(main|sub)[[:space:]]*$" "$a" 2>/dev/null \
        && echo "$a: \`main\`/\`sub\` son nombres reservados → omp lo descarta"
    done
    (( n > 0 )) || echo ".omp/agents/ sin ningún .md"
  else
    echo "falta .omp/agents/ (los subagentes no existirán en este proyecto)"
  fi

  if [[ -d .omp/skills ]]; then
    local m=0
    for d in .omp/skills/*/; do
      [[ -d "$d" ]] || continue
      m=$((m+1))
      if [[ ! -f "$d/SKILL.md" ]]; then
        echo "${d}: el fichero debe llamarse SKILL.md exactamente → omp ignora esta skill"
      else
        frontmatter_has "$d/SKILL.md" description \
          || echo "$d/SKILL.md: sin \`description\` → omp la salta (requireDescription)"
        grep -qE "^enabled:[[:space:]]*false" "$d/SKILL.md" 2>/dev/null \
          && echo "$d/SKILL.md: \`enabled: false\` → desactivada a propósito"
      fi
    done
    (( m > 0 )) || echo ".omp/skills/ sin ninguna skill"
  else
    echo "falta .omp/skills/ (sin orchestrate ni review-rubric en este proyecto)"
  fi

  grep -q "<pendiente>" PROJECT.md 2>/dev/null \
    && echo "PROJECT.md tiene comandos <pendiente> → el verifier no podrá cerrar fases"
  return 0
}

if (( CHECK )); then
  stale=()
  for i in "${!VEND_REL[@]}"; do
    rel="${VEND_REL[$i]}"; src="${VEND_SRC[$i]}"
    if   [[ ! -f "$rel" ]]; then stale+=("falta $rel")
    elif [[ "$(hashof "$src")" != "$(hashof "$rel")" ]]; then
      [[ "$(hashof "$rel")" == "$(manifest_hash "$rel")" ]] && stale+=("desactualizado $rel") \
                                                            || stale+=("editado en local $rel")
    fi
  done
  mapfile -t layout < <(validate_layout)
  echo "proyecto : $PROJECT_NAME"
  echo "arquetipo: $TYPE   (por: $EVIDENCE)"
  [[ -n "$SRC" ]] && echo "origen   : $SRC" || echo "origen   : (no disponible; solo se valida el layout)"
  if (( ${#stale[@]} == 0 && ${#layout[@]} == 0 )); then echo "estado   : al día"; exit 0; fi
  echo "estado   : $(( ${#stale[@]} + ${#layout[@]} )) pendiente(s)"
  (( ${#layout[@]} )) && printf '  ! %s\n' "${layout[@]}"
  (( ${#stale[@]} ))  && printf '  - %s\n' "${stale[@]}"
  echo "acción   : bash ${BASH_SOURCE[0]}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Documentos del proyecto (crear si faltan; --force solo rehace AGENTS.md)
# ---------------------------------------------------------------------------
created=(); updated=(); kept=(); conflicts=()

if [[ -n "$TEMPLATES" ]]; then
  if have AGENTS.md && (( FORCE == 0 )); then
    kept+=("AGENTS.md (ya existe; --force lo regenera)")
  else
    { subst < "$TEMPLATES/_core.md"; tail -n +2 "$ARCH_DIR/AGENTS.md"; } > AGENTS.md
    have AGENTS.md && (( FORCE )) && updated+=("AGENTS.md [núcleo + $TYPE]") || created+=("AGENTS.md [núcleo + $TYPE]")
  fi
  if have PROJECT.md; then kept+=("PROJECT.md (nunca se sobrescribe)")
  else subst < "$TEMPLATES/_PROJECT.md" > PROJECT.md; created+=("PROJECT.md [huecos <pendiente> por rellenar]"); fi
fi

if have DECISIONS.md; then kept+=("DECISIONS.md")
else
  cat > DECISIONS.md <<EOF
# DECISIONS.md — $PROJECT_NAME

Una línea por decisión no obvia, **cuando se toma**. Si alguien tendría que
preguntarte "¿y por qué así?", va aquí.

| Fecha | Decisión | Por qué | Alternativa descartada |
|---|---|---|---|
| $(date +%Y-%m-%d) | Arquetipo \`$TYPE\` para este repo | Detectado por: $EVIDENCE | — |
EOF
  created+=("DECISIONS.md")
fi

if [[ -n "$ARCH_DIR" ]]; then
  for extra in "$ARCH_DIR"/*.example.*; do
    [[ -e "$extra" ]] || continue
    base="$(basename "$extra")"
    if have "$base"; then kept+=("$base"); else cp "$extra" "$base"; created+=("$base"); fi
  done
fi

# ---------------------------------------------------------------------------
# Vendorizado idempotente de agents / skills / scripts en <proyecto>/.omp/
# ---------------------------------------------------------------------------
for i in "${!VEND_REL[@]}"; do
  rel="${VEND_REL[$i]}"; src="${VEND_SRC[$i]}"
  mkdir -p "$(dirname "$rel")"
  if [[ ! -f "$rel" ]]; then
    cp "$src" "$rel"; created+=("$rel")
    continue
  fi
  h_now="$(hashof "$rel")"; h_src="$(hashof "$src")"
  [[ "$h_now" == "$h_src" ]] && continue                       # ya igual: idempotente
  h_man="$(manifest_hash "$rel")"
  if (( FORCE )) || [[ "$h_now" == "$h_man" ]]; then
    cp "$src" "$rel"; updated+=("$rel")                        # sin tocar en local: se actualiza
  elif [[ -z "$h_man" ]]; then
    conflicts+=("$rel (existía antes del primer sync y difiere)")
  else
    conflicts+=("$rel (editado en local)")
  fi
done

# Manifiesto: arquetipo + hash de cada fichero gestionado TAL COMO queda ahora.
if (( ${#VEND_REL[@]} )); then
  mkdir -p "$OMPDIR"
  {
    echo "# Generado por bootstrap-project.sh. No lo edites a mano."
    echo "# archetype $TYPE"
    echo "# synced $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for rel in "${VEND_REL[@]}"; do [[ -f "$rel" ]] && echo "$(hashof "$rel") $rel"; done
  } > "$MANIFEST"

  if [[ ! -f "$OMPDIR/README.md" ]]; then
    cat > "$OMPDIR/README.md" <<EOF
# .omp/ — config de agentes de este proyecto

omp descubre aquí los roles (\`.omp/agents/\`) y las skills (\`.omp/skills/\`) con
**precedencia sobre la config de usuario**, así que este proyecto funciona igual en
cualquier máquina y desde cualquier directorio, tenga o no la config de la flota.

Lo gestiona \`bootstrap-project.sh\` y es idempotente:

    bash .omp/scripts/bootstrap-project.sh --check   # ¿al día? 0=sí 1=no
    bash .omp/scripts/bootstrap-project.sh           # sincronizar

Si editas un fichero de \`.omp/agents/\` o \`.omp/skills/\`, la sincronización **no lo
pisa**: lo reporta como editado en local y sigue. Para volver a la versión de la flota,
\`--force\`. Los hashes de control están en \`.sync-manifest\`.

Conviene versionar \`.omp/\` con el proyecto: es lo que lo hace autocontenido.
EOF
    created+=(".omp/README.md")
  fi
fi

# ---------------------------------------------------------------------------
echo "proyecto : $PROJECT_NAME"
echo "arquetipo: $TYPE   (por: $EVIDENCE)"
[[ -n "$SRC" ]] && echo "origen   : $SRC"
(( ${#created[@]} ))   && { echo "nuevo    :";   printf '  + %s\n' "${created[@]}"; }
(( ${#updated[@]} ))   && { echo "actualizado:"; printf '  ^ %s\n' "${updated[@]}"; }
(( ${#conflicts[@]} )) && { echo "sin tocar (difiere de la flota):"; printf '  ! %s\n' "${conflicts[@]}"; }
if (( ${#created[@]} == 0 && ${#updated[@]} == 0 && ${#conflicts[@]} == 0 )); then
  echo "estado   : al día, sin cambios"
fi

# Validar SIEMPRE el layout al final: copiar los ficheros no garantiza que omp los
# vea (nombre de fichero, frontmatter, posición respecto a la raíz del repo).
mapfile -t layout < <(validate_layout)
if (( ${#layout[@]} )); then
  echo "layout   : $(( ${#layout[@]} )) cosa(s) que omp NO cargaría tal cual:"
  printf '  ! %s\n' "${layout[@]}"
fi

if grep -q "<pendiente>" PROJECT.md 2>/dev/null; then
  echo
  echo "SIGUIENTE PASO: PROJECT.md tiene comandos <pendiente>. Confírmalos ejecutándolos"
  echo "y sustitúyelos (o pon 'ninguno'). El verifier los lanza tal cual; un <pendiente>"
  echo "se trata como no_verificable y la fase no cerrará."
fi
(( ${#conflicts[@]} )) && {
  echo
  echo "Hay ficheros gestionados que difieren de la flota y NO se han tocado. Si el cambio"
  echo "es tuyo y lo quieres, déjalo. Si quieres la versión de la flota: --force."
}
exit 0

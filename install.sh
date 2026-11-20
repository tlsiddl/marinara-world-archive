#!/bin/sh
# World Archive (세계관 설정집) — 마리나라 서버 모듈 설치·업데이트·되돌리기·제거
#   설치·업데이트:  curl -fsSL https://raw.githubusercontent.com/tlsiddl/marinara-world-archive/main/install.sh | sh
#   이전 버전으로:  ... | sh -s -- rollback
#   제거(데이터는 남김): ... | sh -s -- uninstall
#   main이 아닌 브랜치에서 받기: ... | WORLD_ARCHIVE_REF=feature/phase-1-foundation sh
# 세계관 데이터는 마리나라 데이터 폴더(DATA_DIR/world-archive)에 있어서 설치·업데이트·제거로 지워지지 않는다.
#
# 기억 서재(Memory Module)와 같이 쓸 때: 기억 서재 install.sh가 만든 docker-compose.override.yml에 World Archive를
# 두 줄 끼워 넣는다(원래 파일은 .before-world-archive로 남김). 기억 서재 업데이트는 그 파일을 건드리지 않으니 계속 같이 켜진다.
# 컨테이너 찾기는 기억 서재 install.sh(tlsiddl/marinara-memory-module main 165d488)의 find_container를 옮겨 왔다.
set -e

REPO="tlsiddl/marinara-world-archive"
REF="${WORLD_ARCHIVE_REF:-main}"
ACTION="${1:-install}"
FILES="world-archive/marinara-world-archive-runtime.cjs world-archive/lib/store.cjs world-archive/lib/inject.cjs world-archive/lib/service.cjs world-archive/lib/extract.cjs world-archive/lib/same.cjs world-archive/lib/names.cjs world-archive/lib/search.cjs world-archive/lib/roster.cjs world-archive/lib/timetable.cjs world-archive/lib/vendor/engine.cjs world-archive/lib/vendor/sentences.cjs world-archive/lib/vendor/glossary.cjs world-archive/lib/vendor/storydate.cjs world-archive/lib/calendar.cjs world-archive/lib/profile.cjs"
RUNTIME_IN_DOCKER="/app/world-archive/marinara-world-archive-runtime.cjs"
REQUIRE_OPT="--require=$RUNTIME_IN_DOCKER"
VOLUME_LINE="./world-archive:/app/world-archive:ro"
SERVER_ENTRY="packages/server/dist/index.js"

say() { printf '%s\n' "$*"; }
fail() { printf '\n[실패] %s\n' "$*" >&2; exit 1; }

fetch() { # fetch <url> <file>
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else fail "curl이나 wget이 필요해."
  fi
}

# Every file from one commit, so an update never mixes two versions.
resolve_base() {
  if [ -n "$WORLD_ARCHIVE_BASE" ]; then BASE="$WORLD_ARCHIVE_BASE"; return; fi
  API=""
  if command -v curl >/dev/null 2>&1; then API="$(curl -fsSL -m 15 "https://api.github.com/repos/$REPO/commits/$REF" 2>/dev/null || true)"
  else API="$(wget -q -T 15 -O - "https://api.github.com/repos/$REPO/commits/$REF" 2>/dev/null || true)"; fi
  SHA="$(printf '%s\n' "$API" | sed -n 's/.*"sha": *"\([0-9a-f]\{40\}\)".*/\1/p' | head -n 1)"
  BASE="https://raw.githubusercontent.com/$REPO/${SHA:-$REF}"
}

# Files go to world-archive/.incoming first and are checked; the old ones are kept in world-archive/.prev.
download_module() { # download_module <marinara folder>
  W="$1/world-archive"
  NEW="$W/.incoming"
  rm -rf "$NEW"
  mkdir -p "$NEW/lib/vendor"
  for f in $FILES; do
    rel="${f#world-archive/}"
    if ! fetch "$BASE/$f" "$NEW/$rel" || [ ! -s "$NEW/$rel" ]; then
      rm -rf "$NEW"; fail "$f 를 받지 못했어. 인터넷 연결을 확인해 줘. 기존 파일은 그대로야."
    fi
  done
  grep -q "const VERSION" "$NEW/marinara-world-archive-runtime.cjs" || { rm -rf "$NEW"; fail "받은 파일이 이상해. 잠깐 뒤 다시 해 줘. 기존 파일은 그대로야."; }
  if command -v node >/dev/null 2>&1; then
    for f in $FILES; do node --check "$NEW/${f#world-archive/}" >/dev/null 2>&1 || { rm -rf "$NEW"; fail "받은 파일($f)이 깨져 있어. 기존 파일은 그대로야."; }; done
  fi
  if [ -f "$W/marinara-world-archive-runtime.cjs" ]; then
    rm -rf "$W/.prev"; mkdir -p "$W/.prev/lib/vendor"
    for f in $FILES; do rel="${f#world-archive/}"; [ -f "$W/$rel" ] && cp -p "$W/$rel" "$W/.prev/$rel"; done
  fi
  mkdir -p "$W/lib/vendor"
  for f in $FILES; do rel="${f#world-archive/}"; mv -f "$NEW/$rel" "$W/$rel"; done
  rm -rf "$NEW"
  VER="$(sed -n "s/^const VERSION = '\([^']*\)'.*/\1/p" "$W/marinara-world-archive-runtime.cjs" | head -n 1)"
  say "[1/3] World Archive v${VER:-?} 파일을 받았어: $W"
}

restore_prev() { # restore_prev <marinara folder>
  W="$1/world-archive"
  [ -f "$W/.prev/marinara-world-archive-runtime.cjs" ] || fail "되돌릴 이전 버전이 없어 ($W/.prev)."
  for f in $FILES; do rel="${f#world-archive/}"; [ -f "$W/.prev/$rel" ] && cp -p "$W/.prev/$rel" "$W/$rel"; done
  say "[1/2] 이전 버전으로 되돌렸어."
}

# ---------------------------------------------------------------- docker-compose.override.yml
# merge_override <file> <service> — adds World Archive to an override that already exists (normally the one the
# Memory Module made). Only when the file has exactly one NODE_OPTIONS: "..." line and exactly one volumes: list;
# otherwise it changes nothing and returns 3. Returns 0 changed, 4 already there.
merge_override() {
  F="$1"
  if grep -q "marinara-world-archive-runtime" "$F"; then return 4; fi
  [ "$(grep -c '^[[:space:]]*NODE_OPTIONS:[[:space:]]*".*"[[:space:]]*$' "$F")" = 1 ] || return 3
  [ "$(grep -c '^[[:space:]]*volumes:[[:space:]]*$' "$F")" = 1 ] || return 3
  [ "$(grep -c '^[[:space:]]*environment:[[:space:]]*$' "$F")" = 1 ] || return 3
  TMP="$F.world-archive.tmp"
  awk -v opt="$REQUIRE_OPT" -v vol="$VOLUME_LINE" '
    /^[[:space:]]*volumes:[[:space:]]*$/ { print; match($0, /^[[:space:]]*/); invol = 1; volind = substr($0, 1, RLENGTH) "  "; next }
    invol && /^[[:space:]]*- / { match($0, /^[[:space:]]*/); volind = substr($0, 1, RLENGTH); print; next }
    invol { print volind "- " vol; invol = 0 }
    /^[[:space:]]*NODE_OPTIONS:[[:space:]]*".*"[[:space:]]*$/ { sub(/"[[:space:]]*$/, ""); print $0 " " opt "\""; next }
    { print }
    END { if (invol) print volind "- " vol }
  ' "$F" > "$TMP"
  grep -qF -- "$REQUIRE_OPT\"" "$TMP" && grep -qF -- "- $VOLUME_LINE" "$TMP" || { rm -f "$TMP"; return 3; }
  mv -f "$TMP" "$F"
  return 0
}

# unmerge_override <file> — takes out exactly the two things merge_override put in.
unmerge_override() {
  F="$1"
  TMP="$F.world-archive.tmp"
  awk -v opt=" $REQUIRE_OPT" '
    /^[[:space:]]*- [^ ]*:\/app\/world-archive:ro[[:space:]]*$/ { next }
    { i = index($0, opt); if (i) $0 = substr($0, 1, i - 1) substr($0, i + length(opt)); print }
  ' "$F" > "$TMP"
  mv -f "$TMP" "$F"
}

# new_override <file> <service> <existing NODE_OPTIONS>
new_override() {
  cat > "$1" <<EOF
# World Archive (세계관 설정집) — install.sh가 만든 파일. 지우면 World Archive가 꺼져.
services:
  $2:
    volumes:
      - $VOLUME_LINE
    environment:
      NODE_OPTIONS: "${3:+$3 }$REQUIRE_OPT"
EOF
}

# ---------------------------------------------------------------- docker (find_container: from the Memory Module)
docker_ok() { command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; }
label() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null; }
container_env() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | sed -n "s/^$2=//p" | head -n 1; }
is_marinara() {
  case "$(container_env "$1" NODE_OPTIONS)" in *marinara-memory-runtime*|*marinara-world-archive-runtime*) return 0 ;; esac
  case "$(docker inspect -f '{{.Path}} {{range .Args}}{{.}} {{end}}{{range .Config.Cmd}}{{.}} {{end}}{{range .Config.Entrypoint}}{{.}} {{end}}' "$1" 2>/dev/null)" in
    *"$SERVER_ENTRY"*) return 0 ;;
  esac
  docker exec "$1" sh -c "test -f /app/$SERVER_ENTRY" >/dev/null 2>&1
}
find_container() {
  if [ -n "$MARINARA_CONTAINER" ]; then
    docker inspect "$MARINARA_CONTAINER" >/dev/null 2>&1 || { say "MARINARA_CONTAINER=$MARINARA_CONTAINER 컨테이너를 못 찾았어. docker ps 로 이름을 확인해 줘." >&2; return 2; }
    printf '%s' "$MARINARA_CONTAINER"; return 0
  fi
  NAMED="$(docker ps --format '{{.Names}}	{{.Image}}	{{.Label "com.docker.compose.service"}}	{{.Label "com.docker.compose.project"}}' 2>/dev/null | awk -F '	' 'tolower($0) ~ /marinara/ { print $1 }')"
  FOUND=""
  for c in $NAMED; do is_marinara "$c" && FOUND="$FOUND $c"; done
  if [ -z "$FOUND" ]; then
    for c in $(docker ps --format '{{.Names}}' 2>/dev/null); do
      case " $(printf '%s ' $NAMED)" in *" $c "*) continue ;; esac
      is_marinara "$c" && FOUND="$FOUND $c"
    done
  fi
  set -- $FOUND
  if [ $# -eq 1 ]; then printf '%s' "$1"; return 0; fi
  if [ $# -gt 1 ]; then
    say "마리나라 서버로 보이는 컨테이너가 여러 개야: $*" >&2
    say "이름을 정해서 다시 실행해 줘. 예: ... | MARINARA_CONTAINER=$1 sh" >&2
    return 2
  fi
  return 1
}

compose_args() { # compose_args <config files, comma separated> — ARGS: the same files, in the same order
  ARGS=""; OLDIFS="$IFS"; IFS=','
  for f in $1; do [ -n "$f" ] || continue; ARGS="$ARGS -f $f"; done
  IFS="$OLDIFS"
}

# options_file <config files, comma separated>: the last compose file that sets NODE_OPTIONS. Its value wins whole
# (compose does not join NODE_OPTIONS from several files), so that is the file the require must go into.
options_file() {
  LAST=""; OLDIFS="$IFS"; IFS=','
  for f in $1; do [ -n "$f" ] && [ -f "$f" ] && grep -q 'NODE_OPTIONS' "$f" && LAST="$f"; done
  IFS="$OLDIFS"; printf '%s' "$LAST"
}

# wa_file <config files>: the compose file that carries World Archive's require, if any.
wa_file() {
  FOUND_WA=""; OLDIFS="$IFS"; IFS=','
  for f in $1; do [ -n "$f" ] && [ -f "$f" ] && grep -q 'marinara-world-archive-runtime' "$f" && FOUND_WA="$f"; done
  IFS="$OLDIFS"; printf '%s' "$FOUND_WA"
}

requires_of() { printf '%s\n' "$1" | grep -o -- '--require=[^ "]*' | sort -u; }

# requires_kept <NODE_OPTIONS before> <compose config after> <want: with|without>: every other preload that was
# there before is still there, and World Archive is (with) or is not (without) among them.
requires_kept() {
  AFTER="$(requires_of "$2")"
  for r in $(requires_of "$1"); do
    case "$r" in *marinara-world-archive-runtime*) continue ;; esac
    printf '%s\n' "$AFTER" | grep -qxF -- "$r" || { say "      빠질 뻔한 패치: $r" >&2; return 1; }
  done
  if [ "$3" = with ]; then printf '%s\n' "$AFTER" | grep -qF -- marinara-world-archive-runtime || return 1
  else ! printf '%s\n' "$AFTER" | grep -qF -- marinara-world-archive-runtime || return 1; fi
}

compose_dir() { # sets DIR SERVICE CONFIGS ARGS OVERRIDE VOLUME_LINE for container $1
  DIR="$(label "$1" com.docker.compose.project.working_dir)"
  SERVICE="$(label "$1" com.docker.compose.service)"
  CONFIGS="$(label "$1" com.docker.compose.project.config_files)"
  [ -n "$DIR" ] && [ -d "$DIR" ] || fail "컨테이너 $1 은 docker compose로 켜지지 않았거나 compose 폴더를 못 찾았어."
  OVERRIDE="$DIR/docker-compose.override.yml"
  VOLUME_LINE="$DIR/world-archive:/app/world-archive:ro"
  compose_args "$CONFIGS"
}

compose_up() {
  (cd "$DIR" && docker compose $ARGS up -d) || return 1
}

# restore_and_fail <file> <backup> <why>
restore_and_fail() {
  cp -p "$2" "$1"
  fail "$3 그래서 $1 을(를) 원래대로 되돌렸어. 마리나라는 다시 켜지 않았어. 아무것도 바뀌지 않았어."
}

install_docker() {
  C="$1"
  compose_dir "$C"
  say "마리나라 컨테이너를 찾았어: $C (compose 폴더: $DIR)"
  download_module "$DIR"
  OPTS="$(container_env "$C" NODE_OPTIONS)"
  case "$OPTS" in
    *marinara-world-archive-runtime*)
      say "[2/3] 이미 연결돼 있어."
      docker restart "$C" >/dev/null
      say "[3/3] 마리나라를 다시 켰어. 20초쯤 뒤에 접속해 줘."
      return ;;
  esac
  TARGET="$(options_file "$CONFIGS")"
  if [ -z "$TARGET" ]; then
    # No compose file sets NODE_OPTIONS: use the override file (made here if missing), added to the file list.
    TARGET="$OVERRIDE"
    case ",$CONFIGS," in *",$OVERRIDE,"*) ;; *) [ -n "$CONFIGS" ] && ARGS="$ARGS -f $OVERRIDE" ;; esac
  fi
  STAMP="$(date +%Y%m%d-%H%M%S)"
  BACKUP="$TARGET.before-world-archive-$STAMP"
  if [ -f "$TARGET" ]; then
    cp -p "$TARGET" "$BACKUP"
    RC=0; merge_override "$TARGET" "$SERVICE" || RC=$?
    if [ "$RC" = 3 ]; then
      rm -f "$BACKUP"
      say ""
      say "[2/3] $TARGET 모양이 예상과 달라서 건드리지 않았어. $SERVICE 서비스에 직접 넣어 줘:"
      say "      volumes:      - $VOLUME_LINE"
      say "      environment:  NODE_OPTIONS 끝에  $REQUIRE_OPT"
      say "      그다음: cd \"$DIR\" && docker compose$ARGS up -d"
      exit 0
    fi
    say "[2/3] $TARGET 에 World Archive 두 줄을 넣었어 (원래 파일: $BACKUP)."
  else
    new_override "$TARGET" "$SERVICE" "$OPTS"
    BACKUP=""
    say "[2/3] $TARGET 를 만들었어."
  fi
  CONFIG="$(cd "$DIR" && docker compose $ARGS config 2>/dev/null)" || CONFIG=""
  if [ -z "$CONFIG" ] || ! requires_kept "$OPTS" "$CONFIG" with; then
    if [ -n "$BACKUP" ]; then restore_and_fail "$TARGET" "$BACKUP" "고친 뒤 확인해 보니 원래 붙어 있던 패치가 빠지거나 World Archive가 안 붙어."
    else rm -f "$TARGET"; fail "새로 만든 $TARGET 로는 원래 패치가 유지되지 않아서 지웠어. 아무것도 바뀌지 않았어."; fi
  fi
  if ! compose_up; then
    [ -n "$BACKUP" ] && cp -p "$BACKUP" "$TARGET" && compose_up || true
    fail "docker compose up -d 가 실패해서 $TARGET 을(를) 원래대로 돌려놨어. 위 오류를 봐 줘."
  fi
  say "[3/3] 마리나라를 다시 켰어. 20초쯤 뒤에 접속해 줘."
  say "      참고: $TARGET 을(를) 다른 도구가 통째로 바꾸면 World Archive 줄이 빠질 수 있어. 그러면 이 설치 명령을 다시 실행하면 돼."
}

uninstall_docker() {
  C="$1"
  compose_dir "$C"
  TARGET="$(wa_file "$CONFIGS")"
  [ -z "$TARGET" ] && grep -q 'marinara-world-archive-runtime' "$OVERRIDE" 2>/dev/null && TARGET="$OVERRIDE" && ARGS="$ARGS -f $OVERRIDE"
  [ -n "$TARGET" ] || fail "World Archive가 들어 있는 compose 파일을 못 찾았어. 이미 꺼져 있는 것 같아."
  OPTS="$(container_env "$C" NODE_OPTIONS)"
  BACKUP="$TARGET.before-world-archive-removal-$(date +%Y%m%d-%H%M%S)"
  cp -p "$TARGET" "$BACKUP"
  if head -n 1 "$TARGET" | grep -q "World Archive"; then
    mv -f "$TARGET" "$TARGET.removed-world-archive"
    ARGS="$(printf '%s' "$ARGS" | sed "s# -f $TARGET##")"
    say "[1/2] World Archive만 들어 있던 $TARGET 를 치웠어 (.removed-world-archive로 남김)."
  else
    unmerge_override "$TARGET"
    CONFIG="$(cd "$DIR" && docker compose $ARGS config 2>/dev/null)" || CONFIG=""
    if [ -z "$CONFIG" ] || ! requires_kept "$OPTS" "$CONFIG" without; then restore_and_fail "$TARGET" "$BACKUP" "빼고 나서 확인해 보니 다른 패치가 빠질 것 같아."; fi
    say "[1/2] $TARGET 에서 World Archive 두 줄만 뺐어 (원래 파일: $BACKUP)."
  fi
  compose_up || fail "docker compose up -d 가 실패했어. 위 오류를 봐 줘."
  say "[2/2] 마리나라를 다시 켰어. 세계관 데이터는 데이터 폴더의 world-archive 에 그대로 있어."
}

# ---------------------------------------------------------------- plain install / Termux
find_folder() {
  for d in "$MARINARA_DIR" "$(pwd)" "$HOME/Marinara-Engine" "$HOME/marinara-engine" /root/Marinara-Engine "$HOME/Marinara"; do
    [ -n "$d" ] && [ -d "$d/packages/server" ] && { printf '%s' "$d"; return; }
  done
}

# start-world-archive.sh starts Marinara with World Archive, plus the Memory Module when it is installed there too,
# so one launcher runs both.
write_launcher() { # write_launcher <folder>
  START="$1/start-world-archive.sh"
  cat > "$START" <<'EOF'
#!/usr/bin/env bash
# 마리나라를 World Archive와 함께 켠다. 같은 폴더에 기억 서재(memory-module)가 있으면 그것도 같이 켠다.
cd "$(dirname "$0")"
OPTS="--require=\"$(pwd)/world-archive/marinara-world-archive-runtime.cjs\""
if [ -f memory-module/marinara-memory-runtime.cjs ]; then OPTS="--require=\"$(pwd)/memory-module/marinara-memory-runtime.cjs\" $OPTS"; fi
export NODE_OPTIONS="$OPTS ${NODE_OPTIONS:-}"
if [ -n "$TERMUX_VERSION" ] && [ -f start-termux.sh ]; then exec bash start-termux.sh "$@"; fi
exec bash start.sh "$@"
EOF
  chmod +x "$START"
}

install_local() {
  DIR="$(find_folder)" || true
  [ -n "$DIR" ] || fail "마리나라 폴더를 못 찾았어. 마리나라 폴더 안에서 실행하거나 MARINARA_DIR=/마리나라/폴더 를 붙여 줘."
  say "마리나라 폴더를 찾았어: $DIR"
  download_module "$DIR"
  write_launcher "$DIR"
  say "[2/3] 실행 파일을 만들었어: $DIR/start-world-archive.sh (기억 서재가 있으면 같이 켜져)"
  say "[3/3] 앞으로는 이렇게 켜 줘:  bash $DIR/start-world-archive.sh"
}

if [ "${WORLD_ARCHIVE_FUNCTIONS_ONLY:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

pick_container() {
  C=""
  if [ "$WORLD_ARCHIVE_MODE" != local ] && docker_ok; then
    RC=0; C="$(find_container)" || RC=$?
    [ "$RC" = 2 ] && fail "어느 컨테이너인지 확실하지 않아서 아무것도 바꾸지 않았어."
  fi
  return 0
}

say ""
case "$ACTION" in
  install|update)
    say "== World Archive 설치·업데이트 ($REF) =="
    resolve_base
    pick_container
    if [ -n "$C" ]; then install_docker "$C"; else install_local; fi ;;
  rollback)
    say "== World Archive 이전 버전으로 =="
    pick_container
    if [ -n "$C" ]; then compose_dir "$C"; restore_prev "$DIR"; docker restart "$C" >/dev/null; say "[2/2] 마리나라를 다시 켰어."
    else DIR="$(find_folder)" || true; [ -n "$DIR" ] || fail "마리나라 폴더를 못 찾았어."; restore_prev "$DIR"; say "[2/2] 마리나라를 껐다가 start-world-archive.sh 로 다시 켜 줘."; fi ;;
  uninstall)
    say "== World Archive 제거 (데이터는 남김) =="
    pick_container
    if [ -n "$C" ]; then uninstall_docker "$C"
    else say "start-world-archive.sh 대신 원래 start.sh(기억 서재를 쓰면 start-memory.sh)로 켜면 꺼져. 데이터는 그대로야."; fi ;;
  *) fail "모르는 명령이야: $ACTION (rollback, uninstall 만 돼)" ;;
esac

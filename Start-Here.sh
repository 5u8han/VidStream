#!/usr/bin/env bash
set -euo pipefail
umask 077

project=vidstream-starter
default_image=docker.io/5u8han/vidstream:latest
source_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd -P)
install_dir=${VIDSTREAM_INSTALL_DIR:-$source_dir}
legacy_dir=$HOME/VidStream-setup
if [[ -z "${VIDSTREAM_INSTALL_DIR:-}" && ! -e "$source_dir/compose.yaml" && ! -L "$source_dir/compose.yaml" &&
      ( -e "$legacy_dir/compose.yaml" || -L "$legacy_dir/compose.yaml" ) ]]; then
  install_dir=$legacy_dir
fi
port=${VIDSTREAM_PORT:-8080}
image=${VIDSTREAM_IMAGE:-$default_image}
terminal_only=false
using_sudo=false
install_work=
disk_mount=
draft=
snapshot=
edit_lock=

fail() { printf 'VidStream setup: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ -n "$draft" ]]; then rm -f -- "$draft"; fi
  if [[ -n "$snapshot" ]]; then rm -f -- "$snapshot"; fi
  if [[ -n "$edit_lock" ]]; then rmdir -- "$edit_lock" || true; fi
  if [[ -n "$disk_mount" ]] && ! hdiutil detach "$disk_mount" >/dev/null 2>&1; then
    printf 'The Docker installer disk is still mounted at %s. Eject it from Finder.\n' "$disk_mount" >&2
    return
  fi
  if [[ -n "$install_work" ]]; then rm -rf -- "$install_work"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ask_yes() {
  local answer
  printf '%s [y/N] ' "$1" >&2
  IFS= read -r answer || return 1
  case "$answer" in y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac
}

admin() {
  if [[ "$EUID" -eq 0 ]]; then "$@"; else sudo -- "$@"; fi
}

check_new_install() {
  local filename
  for filename in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
    # The checkout ships a manual setup file. Compose prefers compose.yaml.
    if [[ "$filename" == docker-compose.yml && "$install_dir" == "$source_dir" ]]; then continue; fi
    if [[ -e "$install_dir/$filename" || -L "$install_dir/$filename" ]]; then
      fail "A Compose file already exists at $install_dir/$filename. Use Add a media folder for an existing starter setup."
    fi
  done
}

docker_app() {
  local app
  for app in /Applications/Docker.app "$HOME/Applications/Docker.app"; do
    if [[ -d "$app" ]]; then printf '%s\n' "$app"; return; fi
  done
  return 1
}

find_docker() {
  local app
  if command -v docker >/dev/null 2>&1; then command -v docker; return; fi
  if [[ "$platform" == Darwin ]] && app=$(docker_app) && [[ -x "$app/Contents/Resources/bin/docker" ]]; then
    printf '%s\n' "$app/Contents/Resources/bin/docker"
    return
  fi
  return 1
}

install_mac() {
  local arch installer
  if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]]; then
    arch=arm64
  else
    case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=amd64 ;; *) fail 'This Mac architecture is unsupported.' ;; esac
  fi
  ask_yes 'Download Docker Desktop from Docker and install it with administrator access?' || exit 0
  install_work=$(mktemp -d "${TMPDIR:-/tmp}/vidstream-docker.XXXXXXXX")
  printf 'Downloading Docker Desktop. This can take a few minutes.\n'
  curl --fail --location --proto '=https' --retry 2 \
    "https://desktop.docker.com/mac/main/$arch/Docker.dmg" -o "$install_work/Docker.dmg"
  mkdir "$install_work/mount"
  hdiutil attach -readonly -nobrowse -mountpoint "$install_work/mount" "$install_work/Docker.dmg" >/dev/null
  disk_mount=$install_work/mount
  installer=$disk_mount/Docker.app
  codesign --verify --deep --strict \
    -R='identifier "com.docker.docker" and anchor apple generic and certificate leaf[subject.OU] = "9BNSXJN65R"' \
    "$installer" || fail 'Docker Desktop signature verification failed.'
  admin "$installer/Contents/MacOS/install"
  hdiutil detach "$disk_mount" >/dev/null
  disk_mount=
}

install_linux() {
  local distro suite arch key sources
  if [[ ! -r /etc/os-release ]] || ! command -v apt-get >/dev/null || ! command -v systemctl >/dev/null; then
    fail 'Automatic Linux installation requires Debian or Ubuntu with systemd. Install Docker Engine and Compose from https://docs.docker.com/engine/install/ and rerun setup.'
  fi
  distro=$(. /etc/os-release; printf '%s' "${ID:-}")
  suite=$(. /etc/os-release; printf '%s' "${VERSION_CODENAME:-}")
  case "$distro" in debian|ubuntu) ;; *) fail 'Install Docker Engine and Compose for your distribution from https://docs.docker.com/engine/install/ and rerun setup.' ;; esac
  [[ "$suite" =~ ^[a-z0-9]+$ ]] || fail 'Could not identify this Linux release.'
  arch=$(dpkg --print-architecture)
  case "$arch" in amd64|arm64) ;; *) fail 'Automatic installation supports x86-64 and ARM64 Linux.' ;; esac
  ask_yes 'Install Docker Engine and Compose from Docker’s signed apt repository with administrator access?' || exit 0
  admin apt-get update
  if ! apt-cache show docker-ce >/dev/null 2>&1; then
    key=/etc/apt/keyrings/docker.asc
    sources=/etc/apt/sources.list.d/docker.sources
    if [[ -e "$sources" || -L "$sources" ]]; then
      fail "The existing Docker apt source at $sources needs attention. Check that it supports this Linux release."
    fi
    admin apt-get --no-remove install -y ca-certificates curl
    install_work=$(mktemp -d "${TMPDIR:-/tmp}/vidstream-docker.XXXXXXXX")
    if [[ ! -e "$key" && ! -L "$key" ]]; then
      curl --fail --location --proto '=https' --retry 2 "https://download.docker.com/linux/$distro/gpg" -o "$install_work/docker.asc"
      admin install -m 0755 -d /etc/apt/keyrings
      admin install -m 0644 "$install_work/docker.asc" "$key"
    fi
    cat > "$install_work/docker.sources" <<EOF
Types: deb
URIs: https://download.docker.com/linux/$distro
Suites: $suite
Components: stable
Architectures: $arch
Signed-By: $key
EOF
    admin install -m 0644 "$install_work/docker.sources" "$sources"
    admin apt-get update
  fi
  admin apt-get --no-remove install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

select_local_engine() {
  if [[ -n "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]]; then
    endpoint=$DOCKER_HOST
  else
    local context
    context=$("$docker_bin" context show) || fail 'Could not identify the current Docker context.'
    endpoint=$("$docker_bin" context inspect "$context" --format '{{.Endpoints.docker.Host}}') || fail 'Could not read the current Docker endpoint.'
  fi
  case "$endpoint" in unix:///*) ;; *) fail 'Select a local Docker engine to mount folders on this computer.' ;; esac
  unset DOCKER_CONTEXT DOCKER_HOST
  docker=("$docker_bin" --host "$endpoint")
}

enable_docker_access() {
  case "$endpoint" in
    unix:///var/run/docker.sock|unix:///run/docker.sock)
      if [[ "$using_sudo" == false && "$platform" == Linux && "$EUID" -ne 0 && -S "${endpoint#unix://}" && ! -w "${endpoint#unix://}" ]]; then
        ask_yes 'This Docker socket needs administrator access. Use sudo for Docker during setup?' || exit 0
        sudo -v
        docker=(sudo -- docker --host "$endpoint")
        using_sudo=true
      fi
      ;;
  esac
}

docker_engine_type() (
  # A listening socket alone does not guarantee that the engine will respond.
  "${docker[@]}" info --format '{{.OSType}}' &
  probe=$!
  (sleep 4; kill -KILL "$probe" 2>/dev/null || true) </dev/null >/dev/null 2>&1 &
  timer=$!
  status=0
  wait "$probe" || status=$?
  kill "$timer" 2>/dev/null || true
  wait "$timer" 2>/dev/null || true
  exit "$status"
)

engine_ready() {
  local kind
  kind=$(docker_engine_type 2>/dev/null) || return 1
  [[ "$kind" == linux ]] || fail 'Switch Docker to Linux containers.'
}

start_engine() {
  if [[ "$platform" == Darwin ]]; then
    local app
    app=$(docker_app) || fail 'Start your local Docker engine and rerun setup.'
    printf 'Starting Docker Desktop. Complete any first-launch prompts it displays.\n'
    open -a "$app"
    return
  fi

  case "$endpoint" in
    unix:///var/run/docker.sock|unix:///run/docker.sock)
      command -v systemctl >/dev/null || fail 'Start the Docker service and rerun setup.'
      printf 'Starting the Docker service. Administrator access may be required.\n'
      admin systemctl start docker
      ;;
    "unix://$HOME/.docker/desktop/docker.sock")
      printf 'Starting Docker Desktop. Complete any first-launch prompts it displays.\n'
      "$docker_bin" desktop start --detach
      ;;
    "unix://${XDG_RUNTIME_DIR:-/run/user/$UID}/docker.sock")
      printf 'Starting your user Docker service.\n'
      systemctl --user start docker
      ;;
    *) fail 'Start the selected local Docker engine and rerun setup.' ;;
  esac
}

wait_for_engine() {
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    sleep 2
    enable_docker_access
    if engine_ready; then return; fi
    # Docker Desktop may create its own socket during first launch.
    if [[ "$platform" == Darwin && "$endpoint" == unix:///var/run/docker.sock && -S "$HOME/.docker/run/docker.sock" ]]; then
      endpoint="unix://$HOME/.docker/run/docker.sock"
      docker=("$docker_bin" --host "$endpoint")
    fi
  done
  fail 'Docker is still starting. Complete any Docker prompts, wait for the engine to be ready, and rerun setup.'
}

valid_folder() {
  local input=$1 resolved
  case "$input" in '~') input=$HOME ;; '~/'*) input=$HOME/${input#\~/} ;; /*) ;; *) input=$PWD/$input ;; esac
  resolved=$(cd -P -- "$input" 2>/dev/null && printf '%s:' "$PWD") || return 1
  resolved=${resolved%:}
  [[ "$resolved" != / && "$resolved" != *$'\n'* && "$resolved" != *$'\r'* ]] || return 1
  printf '%s\n' "$resolved"
}

add_folder() {
  local resolved previous
  resolved=$(valid_folder "$1") || { printf 'Choose an existing folder with a single-line path.\n' >&2; return 1; }
  if [[ ${#folders[@]} -gt 0 ]]; then
    for previous in "${folders[@]}"; do
      if [[ "$resolved" == "$previous" ]]; then
        printf 'That folder is already in the list.\n' >&2
        return 0
      fi
    done
  fi
  folders+=("$resolved")
}

pick_mac() {
  osascript - "$1" <<'APPLESCRIPT'
on run argv
  try
    if item 1 of argv is "primary" then
      set chosenFolders to {choose folder with prompt "Choose the folder VidStream should open first."}
    else if item 1 of argv is "add" then
      set chosenFolders to {choose folder with prompt "Choose a media folder to add to VidStream."}
    else
      set chosenFolders to choose folder with prompt "Choose another media folder, or select several." with multiple selections allowed
    end if
  on error number -128
    return ""
  end try
  set output to ""
  repeat with chosenFolder in chosenFolders
    set chosenPath to POSIX path of chosenFolder
    if chosenPath contains linefeed or chosenPath contains return then error "Choose folders with single-line paths."
    set output to output & chosenPath & linefeed
  end repeat
  return output
end run
APPLESCRIPT
}

pick_terminal() {
  local choice
  while :; do
    printf '%s ' "$1" >&2
    IFS= read -r choice || return 1
    [[ -n "$choice" ]] || return 1
    if add_folder "$choice"; then return; fi
  done
}

choose_folder() {
  local mode=$1 choice selected prompt
  case "$mode" in
    primary) prompt='Primary media folder' ;;
    add) prompt='Media folder to add' ;;
    *) prompt='Additional media folder' ;;
  esac
  if [[ "$terminal_only" == false && "$platform" == Darwin && -t 0 ]] && command -v osascript >/dev/null; then
    if choice=$(pick_mac "$mode"); then
      [[ -n "$choice" ]] || return 1
      while IFS= read -r selected; do
        [[ -z "$selected" ]] || add_folder "$selected" || fail 'A selected folder is unavailable.'
      done <<< "$choice"
      return
    fi
  elif [[ "$terminal_only" == false && -t 0 && -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v zenity >/dev/null; then
    # Keep a sentinel so command substitution preserves any newline in a path.
    choice=$(zenity --file-selection --directory --title="$prompt" && printf '.') || return 1
    choice=${choice%.}
    add_folder "${choice%$'\n'}" || fail 'The selected folder is unavailable.'
    return
  fi
  pick_terminal "$prompt (blank cancels):"
}

choose_folders() {
  choose_folder primary || exit 0
  while ask_yes 'Add another media folder?'; do
    choose_folder additional || true
  done
}

choose_theme() {
  local choice
  while :; do
    printf 'Theme: [1] White (default), [2] Dark, [3] System. ' >&2
    IFS= read -r choice || exit 0
    case "$choice" in ''|1) theme=light-table; return ;; 2) theme=darkroom; return ;; 3) theme=system; return ;; esac
    printf 'Choose 1, 2 or 3.\n' >&2
  done
}

prepare_docker() {
  local mode=$1
  if ! docker_bin=$(find_docker); then
    [[ "$mode" == setup ]] || fail 'Install Docker before editing an existing starter setup.'
    case "$platform" in Darwin) install_mac ;; Linux) install_linux ;; esac
    docker_bin=$(find_docker) || fail 'Docker is installed. Open a fresh terminal and run Start-Here again.'
  fi
  select_local_engine
  enable_docker_access
  if ! engine_ready; then
    [[ "$mode" == setup ]] || fail 'Start your local Docker engine, then choose Add a media folder again.'
    start_engine || fail 'Could not start Docker. Open Docker and rerun Start-Here once the engine is ready.'
    enable_docker_access
    wait_for_engine
  fi
  "${docker[@]}" compose version >/dev/null 2>&1 || fail 'Install the Docker Compose plugin from https://docs.docker.com/compose/install/ and rerun Start-Here.'
  export COMPOSE_REMOVE_ORPHANS=0
  compose=("${docker[@]}" compose --project-name "$project" --project-directory "$install_dir" --env-file /dev/null)
}

first_setup() {
  local existing_containers existing_volumes url setup_code attempt
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || fail 'VIDSTREAM_PORT must be a number from 1 to 65535.'
  port=$((10#$port))
  [[ "$port" -ge 1 && "$port" -le 65535 ]] || fail 'VIDSTREAM_PORT must be a number from 1 to 65535.'
  [[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]*$ ]] || fail 'VIDSTREAM_IMAGE must be a Docker image reference.'
  check_new_install
  prepare_docker setup

  existing_containers=$("${docker[@]}" ps -aq --filter "label=com.docker.compose.project=$project")
  existing_volumes=$("${docker[@]}" volume ls --quiet --filter "label=com.docker.compose.project=$project")
  if [[ -n "$existing_containers$existing_volumes" ]]; then
    fail "Docker already contains the $project setup. Start it with its existing Compose file."
  fi
  if command -v nc >/dev/null && nc -z -w 1 127.0.0.1 "$port" >/dev/null 2>&1; then
    fail "Port $port is already in use. Set VIDSTREAM_PORT to an unused port and rerun Start-Here."
  fi

  if ! "${docker[@]}" pull "$image"; then
    [[ -z "${VIDSTREAM_IMAGE:-}" && -f "$source_dir/Dockerfile" && -f "$source_dir/scripts/setup-compose.js" ]] || \
      fail 'The VidStream image could not be downloaded. Check the image name and your registry access.'
    image=vidstream-starter:local
    printf 'Building VidStream from this checkout because the Docker Hub image is unavailable.\n'
    "${docker[@]}" build --tag "$image" "$source_dir"
  fi

  choose_folders
  choose_theme

  mkdir -p -- "$install_dir"
  check_new_install
  draft=$(mktemp "$install_dir/.compose.yaml.XXXXXXXX")
  "${docker[@]}" run --rm --network none "$image" node scripts/setup-compose.js "$image" "$port" "$theme" -- "${folders[@]}" > "$draft"
  [[ -s "$draft" ]] || fail 'The image returned an empty Compose file.'
  "${compose[@]}" --file "$draft" config --quiet
  # An atomic hard link publishes the validated file and refuses a concurrent install.
  ln -n -- "$draft" "$compose_file" || fail "Could not create $compose_file."
  rm -- "$draft"
  draft=
  printf 'Saved your settings to %s.\n' "$compose_file"
  compose+=(--file "$compose_file")
  "${compose[@]}" up -d --pull never || fail "Could not start VidStream. Your configuration is saved at $compose_file."

  url=http://127.0.0.1:$port
  printf '\nOpen %s to create your owner account.\n' "$url"
  setup_code=
  for ((attempt = 0; attempt < 10; attempt++)); do
    setup_code=$("${compose[@]}" logs --no-color --tail 60 stream 2>/dev/null | sed -n 's/.*Owner setup code: \([^[:space:]]*\).*/\1/p' | tail -n 1) || setup_code=
    if [[ -n "$setup_code" ]]; then break; fi
    sleep 1
  done
  if [[ -n "$setup_code" ]]; then
    printf 'One-time owner setup code: %s\n' "$setup_code"
  else
    printf 'Read the one-time owner code from the container logs with this command.\n  '
    printf '%q ' "${compose[@]}" logs stream
    printf '\n'
  fi
  if [[ "$platform" == Darwin && -t 0 ]]; then
    open "$url" || true
  elif [[ -t 0 && -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v xdg-open >/dev/null; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

edit_existing() {
  local existing_image editor editor_source mount_spec lock
  [[ -f "$compose_file" && ! -L "$compose_file" ]] || fail "No starter Compose file found at $compose_file. Check VIDSTREAM_INSTALL_DIR or choose first-time setup."
  editor=$source_dir/scripts/setup-compose.js
  [[ -f "$editor" ]] || fail 'Keep Start-Here.sh in the VidStream checkout so it can find the Compose editor.'
  choose_folder add || exit 0
  prepare_docker edit

  lock=$install_dir/.vidstream-edit.lock
  mkdir -- "$lock" 2>/dev/null || fail 'Another Start-Here edit is in progress. Try again when it finishes.'
  edit_lock=$lock
  snapshot=$(mktemp "$install_dir/.compose-original.XXXXXXXX")
  [[ -f "$compose_file" && ! -L "$compose_file" ]] || fail 'The starter Compose file moved during the edit.'
  cp -- "$compose_file" "$snapshot"
  existing_image=$("${compose[@]}" --file "$snapshot" config --images stream)
  [[ "$existing_image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]*$ ]] || fail 'Could not identify the existing VidStream image.'

  # Docker parses --mount as CSV. Quote the source field, including commas in checkout paths.
  editor_source=${editor//\"/\"\"}
  mount_spec="type=bind,\"source=$editor_source\",target=/tmp/vidstream-setup-compose.js,readonly"
  draft=$(mktemp "$install_dir/.compose.yaml.XXXXXXXX")
  "${docker[@]}" run --rm -i --pull never --network none --mount "$mount_spec" --entrypoint node "$existing_image" \
    /tmp/vidstream-setup-compose.js --add-folder "${folders[0]}" < "$snapshot" > "$draft" || \
    fail 'Could not add the folder. Check the editor message and whether your existing VidStream image is available locally.'
  [[ -s "$draft" ]] || fail 'The editor returned an empty Compose file.'
  "${compose[@]}" --file "$draft" config --quiet
  [[ -f "$compose_file" && ! -L "$compose_file" ]] && cmp -s -- "$snapshot" "$compose_file" || \
    fail 'The Compose file changed during this edit. Open Start-Here and try again.'
  mv -f -- "$draft" "$compose_file"
  draft=
  printf 'Added the folder to %s.\n' "$compose_file"
  printf '\nWhen you are ready, run the command below. It briefly stops and recreates the VidStream container with the updated read-only mounts and reuses its existing volumes.\n  COMPOSE_REMOVE_ORPHANS=0 '
  printf '%q ' "${compose[@]}" --file "$compose_file" up -d --pull never --force-recreate stream
  printf '\n'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --terminal) terminal_only=true ;;
    -h|--help)
      printf 'VidStream setup and folder management for macOS and Linux.\nUse --terminal to type folder paths.\nNew setups save compose.yaml beside this launcher. VIDSTREAM_INSTALL_DIR overrides that location.\nVIDSTREAM_PORT and VIDSTREAM_IMAGE override first-time setup defaults.\n'
      exit 0
      ;;
    *) fail 'Use --help to see the available options.' ;;
  esac
  shift
done

case "$install_dir" in /*) ;; *) fail 'VIDSTREAM_INSTALL_DIR must be an absolute path.' ;; esac
compose_file=$install_dir/compose.yaml
platform=$(uname -s)
case "$platform" in Darwin|Linux) ;; *) fail 'Use Start-Here.bat on Windows.' ;; esac
folders=()
while :; do
  printf '\nVidStream\n  1. First-time setup\n  2. Add a media folder\n  3. Exit\nChoose 1, 2 or 3. ' >&2
  IFS= read -r action || exit 0
  case "$action" in
    1) first_setup; break ;;
    2) edit_existing; break ;;
    3|q|Q) exit 0 ;;
  esac
done

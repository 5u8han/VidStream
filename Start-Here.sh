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
port=${VIDSTREAM_PORT:-80}
image=${VIDSTREAM_IMAGE:-$default_image}
terminal_only=false
using_sudo=false
install_work=
disk_mount=
draft=
snapshot=
edit_lock=
portable_stage=
update_only=false

fail() { printf 'VidStream setup: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ -n "$draft" ]]; then rm -f -- "$draft"; fi
  if [[ -n "$snapshot" ]]; then rm -f -- "$snapshot"; fi
  if [[ -n "$edit_lock" ]]; then rmdir -- "$edit_lock" || true; fi
  if [[ -n "$portable_stage" ]]; then
    printf 'A partial copy is retained for inspection at %s. Your existing storage is still available.\n' "$portable_stage" >&2
  fi
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
    if [[ "$filename" == docker-compose.yml && "$install_dir" == "$source_dir" ]]; then continue; fi
    if [[ -e "$install_dir/$filename" || -L "$install_dir/$filename" ]]; then
      fail "A Compose file already exists at $install_dir/$filename. Use Start existing VidStream instead."
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
  local resolved=$1 previous
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

gui_session() {
  [[ "$terminal_only" == false && -t 0 ]] || return 1
  case "$platform" in
    Darwin) [[ -z "${SSH_CONNECTION:-}" && $(launchctl managername 2>/dev/null) == Aqua ]] ;;
    Linux) [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] ;;
  esac
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

pick_linux() (
  local errors choice status=0
  errors=$(mktemp "${TMPDIR:-/tmp}/vidstream-picker.XXXXXXXX") || return 1
  trap 'rm -f -- "$errors"' EXIT
  choice=$(LC_ALL=C zenity --file-selection --directory --title="$1" 2> "$errors" && printf '.') || status=$?
  if [[ "$status" == 1 ]] && ! grep -Evq '^Gtk-Message: .*GtkDialog mapped without a transient parent\.' "$errors"; then
    return 0
  fi
  [[ "$status" == 0 ]] || return 1
  choice=${choice%.}
  choice=${choice%$'\n'}
  [[ "$choice" != *$'\n'* && "$choice" != *$'\r'* ]] || return 1
  printf '%s\n' "$choice"
)

unescape_completion() {
  local input=$1 prefix output=
  while [[ "$input" == *\\* ]]; do
    prefix=${input%%\\*}
    input=${input#*\\}
    output+=$prefix${input:0:1}
    input=${input:1}
  done
  printf '%s\n' "$output$input"
}

pick_terminal() {
  local choice resolved
  if [[ -t 0 ]]; then
    printf 'Type the start of a mounted folder path and press Tab to complete it. Press Tab twice to list matches.\n' >&2
  fi
  while :; do
    if [[ -t 0 ]]; then
      IFS= read -e -r -p "$1 (blank cancels): " choice || return 1
    else
      printf '%s (blank cancels): ' "$1" >&2
      IFS= read -r choice || return 1
    fi
    [[ -n "$choice" ]] || return 1
    if resolved=$(valid_folder "$choice") ||
       { [[ -t 0 && "$choice" == *\\* ]] && resolved=$(valid_folder "$(unescape_completion "$choice")"); }; then
      add_folder "$resolved"
      return
    fi
    printf 'Choose an existing directory, such as a mounted share under /mnt.\n' >&2
  done
}

choose_folder() {
  local mode=$1 choice selected resolved prompt picker= status=0
  local picked=()
  case "$mode" in
    primary) prompt='Primary media folder' ;;
    add) prompt='Media folder to add' ;;
    *) prompt='Additional media folder' ;;
  esac
  if gui_session; then
    if [[ "$platform" == Darwin ]] && command -v osascript >/dev/null; then
      picker=mac
      choice=$(pick_mac "$mode" 2>/dev/null) || status=$?
    elif [[ "$platform" == Linux ]] && command -v zenity >/dev/null; then
      picker=linux
      choice=$(pick_linux "$prompt") || status=$?
    fi
  fi
  if [[ -n "$picker" && "$status" == 0 ]]; then
    [[ -n "$choice" ]] || return 1
    while IFS= read -r selected; do
      if ! resolved=$(valid_folder "$selected"); then
        printf 'A selected folder is unavailable. Choose a folder in the terminal.\n' >&2
        pick_terminal "$prompt"
        return
      fi
      picked+=("$resolved")
    done <<< "$choice"
    for resolved in "${picked[@]}"; do add_folder "$resolved"; done
    return 0
  fi
  if [[ "$status" != 0 ]]; then
    printf 'The graphical folder picker could not open. Use the terminal picker.\n' >&2
    terminal_only=true
  fi
  pick_terminal "$prompt"
}

choose_folders() {
  choose_folder primary || exit 0
  [[ "$role" == server ]] || return 0
  while ask_yes 'Add another media folder?'; do
    choose_folder additional || true
  done
}

choose_integer() {
  local prompt=$1 default=$2 min=$3 max=$4 answer
  while :; do
    printf '%s [%s] ' "$prompt" "$default" >&2
    IFS= read -r answer || return 1
    answer=${answer:-$default}
    if [[ "$answer" =~ ^[0-9]{1,5}$ ]] && (( 10#$answer >= min && 10#$answer <= max )); then
      printf '%s\n' "$((10#$answer))"
      return
    fi
    printf 'Enter a whole number between %s and %s.\n' "$min" "$max" >&2
  done
}

choose_role() {
  local answer
  while :; do
    printf 'Instance role: [1] Server (default), [2] Library node. ' >&2
    IFS= read -r answer || exit 0
    case "$answer" in ''|1) role=server; return ;; 2) role=node; return ;; esac
    printf 'Choose 1 or 2.\n' >&2
  done
}

choose_deployment() {
  local answer access default_access=1 default_host address part
  if [[ "$bind" != 127.0.0.1 ]]; then default_access=2; fi
  memory=$(choose_integer 'Maximum RAM in GiB' "$memory" 1 99999) || return 1
  swap=$(choose_integer 'Extra swap in GiB (requires host swap)' "$swap" 0 99999) || return 1
  access=$(choose_integer 'Access: [1] This machine only, [2] Other devices on the LAN' "$default_access" 1 2) || return 1
  port=$(choose_integer 'Published HTTP port (80 for a bare URL, 8080 or 4000 as alternatives; 443 needs separate TLS for HTTPS)' "$port" 1 65535) || return 1
  if [[ "$port" == 443 ]]; then
    printf 'Port 443 will still serve HTTP. Use the HTTPS overlay with a certificate for TLS.\n' >&2
  fi
  if [[ "$access" == 1 ]]; then
    bind=127.0.0.1
    host=127.0.0.1
    return
  fi
  [[ "$bind" != 127.0.0.1 ]] || bind=0.0.0.0
  while :; do
    printf 'IPv4 address to listen on (0.0.0.0 for all IPv4 interfaces) [%s] ' "$bind" >&2
    IFS= read -r answer || return 1
    address=${answer:-$bind}
    if [[ "$address" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ && "$address" != 127.* ]]; then
      for part in "${BASH_REMATCH[@]:1}"; do if (( part > 255 )); then continue 2; fi; done
      bind=$address
      break
    fi
    printf 'Enter an IPv4 LAN address or 0.0.0.0.\n' >&2
  done
  default_host=$host
  if [[ "$default_host" == 127.0.0.1 ]]; then
    default_host=$(hostname 2>/dev/null) || default_host=
  fi
  while :; do
    printf 'Hostname or IPv4 address other devices use to reach this server [%s] ' "$default_host" >&2
    IFS= read -r answer || return 1
    address=${answer:-$default_host}
    if [[ "$address" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ &&
          "$address" != 127.* && "$address" != 0.0.0.0 && "$address" != localhost ]]; then
      host=$address
      return
    fi
    printf 'Enter a LAN hostname or IPv4 address, such as subuntu.local.\n' >&2
  done
}

deployment_url() {
  printf 'http://%s' "$host"
  if [[ "$port" != 80 ]]; then printf ':%s' "$port"; fi
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
    [[ "$mode" != edit ]] || fail 'Start your local Docker engine, then reopen Start-Here.'
    start_engine || fail 'Could not start Docker. Open Docker and rerun Start-Here once the engine is ready.'
    enable_docker_access
    wait_for_engine
  fi
  "${docker[@]}" compose version >/dev/null 2>&1 || fail 'Install the Docker Compose plugin from https://docs.docker.com/compose/install/ and rerun Start-Here.'
  export COMPOSE_REMOVE_ORPHANS=0
  compose=("${docker[@]}" compose --project-name "$project" --project-directory "$install_dir" --env-file /dev/null)
}

check_host_network() {
  local engine_version
  engine_version=$("${docker[@]}" version --format '{{.Server.Version}}' 2>/dev/null) || engine_version=
  if [[ "$engine_version" =~ ^([1-9][0-9]*)\. ]] && (( BASH_REMATCH[1] < 28 )); then
    printf 'Docker Engine %s can expose loopback-published ports to peers on the same Ethernet segment. Update Docker Engine to 28 or newer.\n' "$engine_version" >&2
  fi
}

build_checkout_image() {
  local tag=$1 revision changes top
  top=$(git -C "$source_dir" rev-parse --show-toplevel 2>/dev/null) || top=
  if [[ "$top" == "$source_dir" ]] &&
     changes=$(git -C "$source_dir" status --porcelain) && [[ -z "$changes" ]]; then
    revision=$(git -C "$source_dir" rev-parse --verify 'HEAD^{commit}') || return 1
    git -C "$source_dir" archive --format=tar "$revision" |
      "${docker[@]}" build --pull --build-arg "VIDSTREAM_REVISION=$revision" --label "org.opencontainers.image.revision=$revision" --tag "$tag" -
  else
    "${docker[@]}" build --pull --tag "$tag" "$source_dir"
  fi
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
  memory=2 swap=0 bind=127.0.0.1 host=127.0.0.1
  choose_role
  choose_deployment || return 0
  if [[ "$bind" == 127.0.0.1 ]]; then check_host_network; fi
  if command -v nc >/dev/null && nc -z -w 1 "${bind/0.0.0.0/127.0.0.1}" "$port" >/dev/null 2>&1; then
    fail "Port $port is already in use. Choose another port and rerun Start-Here."
  fi

  choose_folders
  choose_theme

  if [[ -z "${VIDSTREAM_IMAGE:-}" && -f "$source_dir/Dockerfile" ]]; then
    image=vidstream-starter:local
    printf 'Building VidStream from this checkout.\n'
    build_checkout_image "$image"
  else
    "${docker[@]}" pull "$image" || fail 'The VidStream image could not be downloaded. Check the image name and your registry access.'
  fi

  mkdir -p -- "$install_dir"
  check_new_install
  draft=$(mktemp "$install_dir/.compose.yaml.XXXXXXXX")
  compose_editor "$image" --storage-dir "$portable_dir" --deployment "$memory" "$swap" "$bind" "$host" "$role" \
    "$image" "$port" "$theme" -- "${folders[@]}" > "$draft"
  [[ -s "$draft" ]] || fail 'The editor returned an empty Compose file.'
  "${compose[@]}" --file "$draft" config --quiet
  mkdir -- "$portable_dir" || fail "Storage already exists at $portable_dir. Use the saved Compose file to reuse it."
  mkdir -- "$portable_dir/data" "$portable_dir/cache" "$portable_dir/originals"
  printf 'VidStream data and generated cache will be saved in %s.\n' "$portable_dir"
  ln -n -- "$draft" "$compose_file" || fail "Could not create $compose_file. If this setup left only empty storage, move $portable_dir aside before retrying."
  rm -- "$draft"
  draft=
  printf 'Saved your settings to %s.\n' "$compose_file"
  compose+=(--file "$compose_file")
  enable_host_updater "$image"
  "${compose[@]}" up -d --pull never || fail "Could not start VidStream. Your configuration is saved at $compose_file."

  url=$(deployment_url)
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
  if [[ -n "${SSH_CONNECTION:-}" && "$bind" == 127.0.0.1 ]]; then
    printf '\nFrom a separate terminal on the computer with your browser, run:\n  ssh -N -L 127.0.0.1:8080:127.0.0.1:%s user@server\n' "$port"
    printf 'Replace user@server with your SSH login. This forwards your computer’s port 8080 to VidStream without publishing it to the network. Leave SSH open and visit http://127.0.0.1:8080 in your browser.\n'
  elif gui_session; then
    if [[ "$platform" == Darwin ]]; then
      open "$url" || true
    elif command -v xdg-open >/dev/null; then
      xdg-open "$url" >/dev/null 2>&1 || true
    fi
  fi
}

snapshot_existing() {
  snapshot=$(mktemp "$install_dir/.compose-original.XXXXXXXX")
  [[ -f "$compose_file" && ! -L "$compose_file" ]] || fail 'The starter Compose file moved during the edit.'
  cp -- "$compose_file" "$snapshot"
}

apply_compose_draft() {
  [[ -s "$draft" ]] || fail 'The editor returned an empty Compose file.'
  "${compose[@]:0:${#compose[@]}-2}" --file "$draft" config --quiet
  [[ -f "$compose_file" && ! -L "$compose_file" ]] && cmp -s -- "$snapshot" "$compose_file" || \
    fail 'The Compose file changed during this edit. Open Start-Here and try again.'
  mv -f -- "$draft" "$compose_file"
  draft=
}

existing_image_name() {
  local saved_image
  saved_image=$("${compose[@]}" config --images stream)
  [[ "$saved_image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]*$ ]] || fail 'Could not identify the existing VidStream image.'
  printf '%s\n' "$saved_image"
}

effective_role() {
  local container running_role
  container=$("${compose[@]}" ps -q --status running stream)
  [[ -n "$container" ]] || fail 'Choose Start existing VidStream before adding a folder so the launcher can check its current role.'
  running_role=$("${docker[@]}" exec "$container" node -e \
    'fetch("http://127.0.0.1:4000/health",{signal:AbortSignal.timeout(3000)}).then(r=>r.json()).then(d=>{if(!d.ok)throw Error();console.log(d.role||"legacy")}).catch(()=>process.exitCode=1)' 2>/dev/null) ||
    fail 'Could not check the VidStream role. Wait until the saved project is healthy and try again.'
  case "$running_role" in
    server|node) printf '%s\n' "$running_role" ;;
    legacy) compose_editor "$1" --role < "$snapshot" ;;
    *) fail 'VidStream returned an unrecognized role.' ;;
  esac
}

edit_existing() {
  local existing_image current_role
  prepare_existing edit
  snapshot_existing
  existing_image=$(existing_image_name)
  current_role=$(effective_role "$existing_image")
  [[ "$current_role" != node ]] || fail 'A node cannot add a library. Change this instance to Server in VidStream before adding a folder.'
  choose_folder add || return 0
  current_role=$(effective_role "$existing_image")
  draft=$(mktemp "$install_dir/.compose.yaml.XXXXXXXX")
  compose_editor "$existing_image" --add-folder "${folders[0]}" "$portable_dir" "$current_role" < "$snapshot" > "$draft"
  apply_compose_draft
  printf 'Added the folder to %s.\n' "$compose_file"
  printf '\nWhen you are ready, run the command below. It briefly stops and recreates the VidStream container with the updated read-only mounts and reuses its existing volumes.\n  COMPOSE_REMOVE_ORPHANS=0 '
  printf '%q ' "${compose[@]}" up -d --pull never --force-recreate stream
  printf '\n'
}

configure_existing() {
  local existing_image current
  prepare_existing edit
  snapshot_existing
  existing_image=$(existing_image_name)
  current=$(compose_editor "$existing_image" --deployment-summary < "$snapshot")
  { read -r memory; read -r swap; read -r bind; read -r host; read -r port; } <<< "$current"
  choose_deployment || return 0
  draft=$(mktemp "$install_dir/.compose.yaml.XXXXXXXX")
  compose_editor "$existing_image" --configure "$memory" "$swap" "$bind" "$host" "$port" < "$snapshot" > "$draft"
  apply_compose_draft
  printf 'Saved RAM and access settings at %s. New address: %s.\n' "$compose_file" "$(deployment_url)"
  if ask_yes 'Apply now? VidStream will restart and reuse its saved media mounts, catalog and cache.'; then
    "${compose[@]}" up -d --pull never --wait stream || fail 'Could not apply the saved settings. Review the Docker error above.'
  else
    printf 'Choose Start existing VidStream when you are ready to apply these settings.\n'
  fi
}

mount_spec() {
  local source=${1//\"/\"\"} target=$2 mode=${3:-}
  printf 'type=bind,"source=%s",target=%s%s' "$source" "$target" "$mode"
}

compose_editor() {
  local editor=$source_dir/scripts/setup-compose.js editor_image=$1
  shift
  [[ -f "$editor" ]] || fail 'Keep Start-Here.sh with the VidStream source files.'
  "${docker[@]}" run --rm -i --pull never --network none \
    --mount "$(mount_spec "$editor" /tmp/vidstream-setup-compose.js ,readonly)" \
    --entrypoint node "$editor_image" /tmp/vidstream-setup-compose.js "$@"
}

lock_existing() {
  local lock=$install_dir/.vidstream-edit.lock
  mkdir -- "$lock" 2>/dev/null || fail 'Another Start-Here operation is in progress.'
  edit_lock=$lock
}

prepare_existing() {
  [[ -f "$compose_file" && ! -L "$compose_file" ]] || fail "No regular starter Compose file found at $compose_file."
  lock_existing
  prepare_docker "$1"
  compose+=(--file "$compose_file")
  local running_config container_ids container
  container_ids=$("${docker[@]}" ps -aq --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=stream' --filter 'label=com.docker.compose.oneoff=False')
  for container in $container_ids; do
    running_config=$("${docker[@]}" inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$container")
    [[ "$running_config" == "$compose_file" || "$running_config" -ef "$compose_file" ]] || fail "The existing project used a different Compose path or added overrides ($running_config). Use that exact configuration."
  done
}

start_existing() {
  prepare_existing start
  local existing_image
  existing_image=$("${compose[@]}" config --images stream)
  if [[ "$existing_image" == vidstream-starter:local ]] && ! "${docker[@]}" image inspect "$existing_image" >/dev/null 2>&1; then
    [[ -f "$source_dir/Dockerfile" ]] || fail 'Build or load the VidStream image before starting the saved project.'
    printf 'Building the missing local image from this checkout.\n'
    build_checkout_image "$existing_image"
  fi
  enable_host_updater "$existing_image"
  "${compose[@]}" up -d --pull never --wait stream || fail 'Could not start the saved project. Make sure its image and media mount paths are available.'
  printf 'Started VidStream with its saved settings at %s.\n' "$compose_file"
}

enable_host_updater() {
  local updater_image=$1 python updater_dir updater_draft updater_before
  [[ "${VIDSTREAM_HELPER_CHILD:-}" != 1 ]] || return 0
  [[ "$updater_image" == vidstream-starter:local && -e "$source_dir/.git" ]] || return 0
  if [[ "$using_sudo" == true ]] || ! command -v python3 >/dev/null 2>&1; then
    printf 'In-app updates need Python 3.8+ on this host and Docker access for your user. Start-Here updates remain available.\n'
    return 0
  fi
  python=$(command -v python3)
  "$python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || {
    printf 'In-app updates need Python 3.8 or newer. Start-Here updates remain available.\n'
    return 0
  }
  updater_dir=$install_dir/.vidstream-updater
  [[ ! -L "$updater_dir" ]] || fail 'The updater directory must be a regular private directory.'
  mkdir -p -- "$updater_dir"
  chmod 700 "$updater_dir"
  updater_draft=$(mktemp "$install_dir/.compose-updater.XXXXXXXX")
  updater_before=$(mktemp "$install_dir/.compose-updater-before.XXXXXXXX")
  cp -- "$compose_file" "$updater_before"
  if ! compose_editor "$updater_image" --enable-updater < "$updater_before" > "$updater_draft"; then
    rm -f -- "$updater_draft" "$updater_before"
    fail 'Could not attach the updater mailbox. Your existing Compose file was kept.'
  fi
  if ! "${compose[@]:0:${#compose[@]}-2}" --file "$updater_draft" config --quiet; then
    rm -f -- "$updater_draft" "$updater_before"
    fail 'The updater configuration did not validate. Your existing Compose file was kept.'
  fi
  if ! cmp -s -- "$updater_before" "$compose_file"; then
    rm -f -- "$updater_draft" "$updater_before"
    fail 'The Compose file changed while attaching the updater. Reopen Start-Here.'
  fi
  if ! cmp -s -- "$updater_draft" "$updater_before"; then
    mv -f -- "$updater_draft" "$compose_file"
  fi
  rm -f -- "$updater_draft" "$updater_before"
  "$python" "$source_dir/scripts/update-helper.py" --source "$source_dir" --install "$install_dir" \
    --docker "$docker_bin" --endpoint "$endpoint" --detach
}

update_existing() {
  local top remote branch changes current target saved_image revision running state
  command -v git >/dev/null 2>&1 || fail 'Install Git to update a VidStream checkout.'
  top=$(git -C "$source_dir" rev-parse --show-toplevel 2>/dev/null) || fail 'Open Start-Here from your VidStream Git checkout to update it.'
  [[ "$top" == "$source_dir" ]] || fail 'Open Start-Here from the root of your VidStream Git checkout.'
  branch=$(git -C "$source_dir" symbolic-ref --quiet --short HEAD) || fail 'Switch this checkout to main before updating.'
  [[ "$branch" == main ]] || fail 'Switch this checkout to main before updating.'
  remote=$(git -C "$source_dir" remote get-url origin) || fail 'This checkout has no GitHub origin.'
  case "$remote" in
    https://github.com/5u8han/VidStream|https://github.com/5u8han/VidStream.git|git@github.com:5u8han/VidStream|git@github.com:5u8han/VidStream.git|ssh://git@github.com/5u8han/VidStream|ssh://git@github.com/5u8han/VidStream.git) ;;
    *) fail 'Automatic updates require the official 5u8han/VidStream GitHub origin.' ;;
  esac
  changes=$(git -C "$source_dir" status --porcelain --untracked-files=no) || fail 'Could not check the checkout for local changes.'
  [[ -z "$changes" ]] || fail 'Save your tracked source edits before using the updater.'
  prepare_existing start
  saved_image=$(existing_image_name)
  [[ "$saved_image" == vidstream-starter:local ]] || fail 'The updater supports starter installations built from this checkout. Update your saved registry or custom image separately.'
  snapshot_existing

  printf 'Checking GitHub main for updates.\n'
  git -C "$source_dir" fetch --no-tags --no-recurse-submodules origin '+refs/heads/main:refs/remotes/origin/main' ||
    fail 'Could not fetch GitHub main. The existing service is still available.'
  [[ "$(git -C "$source_dir" symbolic-ref --quiet --short HEAD)" == main ]] ||
    fail 'The checked-out branch changed during the update. Switch to main and try again.'
  current=$(git -C "$source_dir" rev-parse HEAD)
  target=$(git -C "$source_dir" rev-parse --verify 'refs/remotes/origin/main^{commit}')
  git -C "$source_dir" merge-base --is-ancestor "$current" "$target" ||
    fail 'Local main is ahead of or has diverged from GitHub main. Resolve it before updating.'
  if [[ "$target" != "$current" ]]; then
    git -C "$source_dir" -c merge.autostash=false merge --ff-only --no-overwrite-ignore "$target" ||
      fail 'Could not fast-forward safely. Review the Git error above.'
  fi

  running=$("${compose[@]}" ps -q --status running stream)
  if [[ -n "$running" ]]; then
    [[ "$running" != *$'\n'* ]] || fail 'Could not identify the running service.'
    state=$("${docker[@]}" inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$running")
    if [[ "$state" == "$target healthy" || "$state" == "$target running" ]]; then
      printf 'VidStream is already running the latest build (%.12s). To reconnect in-app updates, choose Start existing VidStream.\n' "$target"
      return
    fi
  fi
  revision=$("${docker[@]}" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$saved_image" 2>/dev/null) || revision=
  if [[ "$revision" != "$target" ]]; then
    printf 'Building VidStream %.12s. The running service stays up during the build.\n' "$target"
    git -C "$source_dir" archive --format=tar "$target" |
      "${docker[@]}" build --pull --build-arg "VIDSTREAM_REVISION=$target" --label "org.opencontainers.image.revision=$target" --tag "$saved_image" - ||
      fail 'The new image did not build. The running container was kept. Retry Update VidStream to build the fetched version again.'
  fi

  [[ -f "$compose_file" && ! -L "$compose_file" ]] && cmp -s -- "$snapshot" "$compose_file" ||
    fail 'The Compose file changed during the update. Reopen Start-Here to apply the current settings.'
  enable_host_updater "$saved_image"
  printf 'Applying the update with your saved Compose file and media mounts.\n'
  "${compose[@]}" up -d --pull never --wait stream ||
    fail 'The image built, but the updated service did not become healthy. Check its logs in Docker. Your saved configuration and storage remain in place.'
  printf 'Updated VidStream to %.12s.\n' "$target"
}

stop_existing() {
  local timeout=300 configured running container exit_code
  running=$("${compose[@]}" ps -q --status running stream)
  for container in $running; do
    configured=$("${docker[@]}" inspect --format '{{.Config.StopTimeout}}' "$container")
    if [[ "$configured" =~ ^[0-9]+$ && "$configured" -gt "$timeout" ]]; then timeout=$configured; fi
  done
  "${compose[@]}" stop --timeout "$timeout" stream
  for container in $running; do
    exit_code=$("${docker[@]}" inspect --format '{{.State.ExitCode}}' "$container")
    [[ "$exit_code" == 0 ]] || fail "VidStream exited with status $exit_code. Review its logs and verify the cache before copying."
  done
  running=$("${compose[@]}" ps -q --status running stream)
  [[ -z "$running" ]] || fail 'The VidStream service is still running.'
}

prepare_move() {
  prepare_existing edit
  local existing_image layout name active names i
  existing_image=$("${compose[@]}" config --images stream)
  [[ "$existing_image" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]*$ ]] || fail 'Could not identify the local VidStream image.'
  layout=$(compose_editor "$existing_image" --storage-status < "$compose_file")
  if [[ "$layout" == portable ]]; then
    [[ -d "$portable_dir/data" && -d "$portable_dir/cache" && -d "$portable_dir/originals" ]] || fail 'The portable storage folder is missing. Restore it before preparing a move.'
    printf 'This stops VidStream for a consistent copy.\n'
    stop_existing
    printf 'Copy %s and %s together to the next installation. Copy or remap the source media separately.\n' "$portable_dir" "$compose_file"
    return
  fi

  [[ ! -e "$portable_dir" && ! -L "$portable_dir" ]] || fail "A directory already exists at $portable_dir. Move it out of the way before migrating; it will not be merged."
  ask_yes 'Stop VidStream and copy its Docker volumes to the local disk? This can take time, and keeps the old volumes.' || return 0
  snapshot=$(mktemp "$install_dir/.compose-original.XXXXXXXX")
  cp -- "$compose_file" "$snapshot"
  local plan_compose=()
  plan_compose=("${compose[@]:0:${#compose[@]}-2}" --file "$snapshot")
  names=$("${plan_compose[@]}" config --format json | compose_editor "$existing_image" --legacy-volume-names "$portable_dir")
  local volumes=()
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    "${docker[@]}" volume inspect "$name" >/dev/null || fail "The existing volume $name is missing."
    volumes+=("$name")
  done <<< "$names"
  [[ "${#volumes[@]}" == 3 ]] || fail 'The existing storage could not be identified.'

  draft=$(mktemp "$install_dir/.compose.yaml.XXXXXXXX")
  compose_editor "$existing_image" --portable < "$snapshot" > "$draft"
  "${plan_compose[@]:0:${#plan_compose[@]}-2}" --file "$draft" config --quiet
  stop_existing
  for name in "${volumes[@]}"; do
    active=$("${docker[@]}" ps -q --filter "volume=$name")
    [[ -z "$active" ]] || fail "Another running container uses $name. Stop it before copying."
  done
  portable_stage=$(mktemp -d "$install_dir/.vidstream-portable.XXXXXXXX")
  local copy_args=() parts=(data cache originals)
  for i in 0 1 2; do
    copy_args+=(--mount "type=volume,source=${volumes[$i]},target=/vidstream-source/${parts[$i]},readonly,volume-nocopy")
  done
  "${docker[@]}" run --rm --pull never --network none --user 0:0 "${copy_args[@]}" \
    --mount "$(mount_spec "$portable_stage" /vidstream-portable)" --entrypoint sh "$existing_image" -eu -c '
      for name in data cache originals; do
        mkdir -m 700 "/vidstream-portable/$name"
        cp -a "/vidstream-source/$name/." "/vidstream-portable/$name/"
      done
      sync -f /vidstream-portable
    '
  for name in "${volumes[@]}"; do
    active=$("${docker[@]}" ps -q --filter "volume=$name")
    [[ -z "$active" ]] || fail "A running container used $name during the copy. Stop it and retry."
  done
  cp -- "$snapshot" "$portable_stage/compose.before-portable.yaml"
  [[ -f "$compose_file" && ! -L "$compose_file" ]] && cmp -s -- "$snapshot" "$compose_file" || \
    fail 'The Compose file changed during migration. The old configuration and volumes are still available.'
  [[ ! -e "$portable_dir" && ! -L "$portable_dir" ]] || fail "Storage now exists at $portable_dir. The copy was kept separate."
  mv -- "$portable_stage" "$portable_dir"
  portable_stage=
  mv -f -- "$draft" "$compose_file" || fail "Could not activate the portable Compose file. Keep the copy at $portable_dir, move it aside before retrying, and retain the old Compose file and volumes."
  draft=
  printf 'VidStream is stopped. Copy %s and %s to your new installation. Your old Docker volumes are preserved for rollback.\n' "$portable_dir" "$compose_file"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --terminal) terminal_only=true ;;
    --update-only) update_only=true ;;
    -h|--help)
      printf 'VidStream setup and folder management for macOS and Linux.\nUse --terminal to type folder paths with Tab completion.\nNew setups save compose.yaml beside this launcher. VIDSTREAM_INSTALL_DIR overrides that location.\nVIDSTREAM_PORT and VIDSTREAM_IMAGE override first-time setup defaults.\n'
      exit 0
      ;;
    *) fail 'Use --help to see the available options.' ;;
  esac
  shift
done

case "$install_dir" in /*) ;; *) fail 'VIDSTREAM_INSTALL_DIR must be an absolute path.' ;; esac
compose_file=$install_dir/compose.yaml
portable_dir=$install_dir/vidstream-local
platform=$(uname -s)
case "$platform" in Darwin|Linux) ;; *) fail 'Use Start-Here.bat on Windows.' ;; esac
folders=()
if [[ "$update_only" == true ]]; then update_existing; exit 0; fi
while :; do
  printf '\nVidStream\n  1. First-time setup\n  2. Add a media folder (server only)\n  3. Start existing VidStream\n  4. Stop VidStream\n  5. Prepare storage to move\n  6. Configure memory and access\n  7. Update VidStream\n  Q. Exit\nChoose an option. ' >&2
  IFS= read -r action || exit 0
  case "$action" in
    1) first_setup; break ;;
    2) edit_existing; break ;;
    3) start_existing; break ;;
    4) prepare_existing edit; stop_existing; break ;;
    5) prepare_move; break ;;
    6) configure_existing; break ;;
    7) update_existing; break ;;
    q|Q) exit 0 ;;
  esac
done

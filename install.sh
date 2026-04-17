#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────
#  Novel Object Storage — Interactive Installer
# ──────────────────────────────────────────────

REPO_URL="https://github.com/xuyuanzhang1122/Novel-Object-Storage.git"
MIN_NODE_VERSION=18

# ── Colors ──────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}${BOLD}║       Novel Object Storage  Installer       ║${NC}"
  echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════╝${NC}"
  echo ""
}

info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()     { echo -e "${RED}[ERROR]${NC} $*"; }

prompt_with_default() {
  local varname="$1" prompt_text="$2" default="$3"
  local input
  echo -en "${BOLD}${prompt_text}${NC} [${CYAN}${default}${NC}]: "
  read -r input
  eval "$varname=\"${input:-$default}\""
}

prompt_password() {
  local varname="$1" prompt_text="$2"
  local pw=""
  while [ -z "$pw" ]; do
    echo -en "${BOLD}${prompt_text}${NC}: "
    read -rs pw
    echo ""
    if [ -z "$pw" ]; then
      warn "Password cannot be empty. Please try again."
    fi
  done
  eval "$varname=\"$pw\""
}

# ── Check dependencies ──────────────────
check_deps() {
  info "Checking dependencies..."

  if ! command -v git &>/dev/null; then
    err "git is not installed. Please install git first."
    exit 1
  fi

  if ! command -v node &>/dev/null; then
    err "Node.js is not installed. Please install Node.js >= ${MIN_NODE_VERSION} first."
    echo "  → https://nodejs.org/"
    exit 1
  fi

  local node_major
  node_major=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
  if [ "$node_major" -lt "$MIN_NODE_VERSION" ]; then
    err "Node.js v${node_major} detected, but >= ${MIN_NODE_VERSION} is required."
    exit 1
  fi

  if ! command -v npm &>/dev/null; then
    err "npm is not installed. Please install npm first."
    exit 1
  fi

  info "git $(git --version | awk '{print $3}')  ✓"
  info "node $(node -v)  ✓"
  info "npm $(npm -v)  ✓"

  if command -v ffmpeg &>/dev/null; then
    info "ffmpeg found  ✓  (video transcoding enabled)"
  else
    warn "ffmpeg not found — video transcoding will be disabled."
  fi
  echo ""
}

# ── Detect public IP ────────────────────
detect_ip() {
  local ip=""
  # Try external services in order
  for svc in "https://ifconfig.me" "https://api.ipify.org" "https://icanhazip.com"; do
    ip=$(curl -s --connect-timeout 3 "$svc" 2>/dev/null | tr -d '[:space:]') && break
  done
  if [ -z "$ip" ]; then
    # Fallback: first non-loopback IPv4
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  echo "$ip"
}

# ── Main ────────────────────────────────
main() {
  banner

  # If stdin is a pipe (curl | bash), reopen /dev/tty for interactive input
  if [ ! -t 0 ]; then
    exec 0</dev/tty
  fi

  check_deps

  echo -e "${BOLD}Please configure your Novel Object Storage instance:${NC}"
  echo ""

  # 1. Install directory
  prompt_with_default INSTALL_DIR "📂  Install directory" "./Novel-Object-Storage"

  # 2. Port
  prompt_with_default PORT "🔌  Server port" "4000"

  # 3. Data directory
  prompt_with_default DATA_DIR "💾  Data storage directory" "./data"

  echo ""

  # 4. BASE_URL — public IP or domain
  echo -e "${BOLD}🌐  How will this service be accessed?${NC}"
  echo -e "   ${CYAN}1)${NC} Public IP  (auto-detect)"
  echo -e "   ${CYAN}2)${NC} Domain name"
  echo -e "   ${CYAN}3)${NC} Local only  (127.0.0.1)"
  echo -en "${BOLD}Choose${NC} [${CYAN}1${NC}]: "
  read -r url_choice
  url_choice="${url_choice:-1}"

  case "$url_choice" in
    1)
      info "Detecting public IP..."
      DETECTED_IP=$(detect_ip)
      if [ -n "$DETECTED_IP" ]; then
        prompt_with_default BASE_URL "   Detected IP — confirm or edit" "http://${DETECTED_IP}:${PORT}"
      else
        warn "Could not detect public IP."
        prompt_with_default BASE_URL "   Enter your public URL" "http://127.0.0.1:${PORT}"
      fi
      ;;
    2)
      echo -en "${BOLD}   Enter your domain (e.g. storage.example.com)${NC}: "
      read -r DOMAIN
      if [[ "$DOMAIN" != http* ]]; then
        echo -e "   ${CYAN}1)${NC} https://${DOMAIN}"
        echo -e "   ${CYAN}2)${NC} http://${DOMAIN}:${PORT}"
        echo -en "${BOLD}   Choose${NC} [${CYAN}1${NC}]: "
        read -r proto_choice
        proto_choice="${proto_choice:-1}"
        if [ "$proto_choice" = "1" ]; then
          BASE_URL="https://${DOMAIN}"
        else
          BASE_URL="http://${DOMAIN}:${PORT}"
        fi
      else
        BASE_URL="$DOMAIN"
      fi
      ;;
    3)
      BASE_URL="http://127.0.0.1:${PORT}"
      ;;
    *)
      BASE_URL="http://127.0.0.1:${PORT}"
      ;;
  esac

  echo ""

  # 5. Admin credentials
  echo -e "${BOLD}🔑  Admin credentials${NC}"
  prompt_with_default ADMIN_USERNAME "   Username" "admin"
  prompt_password ADMIN_PASSWORD "   Password"

  echo ""

  # ── Summary ──────────────────────────
  echo -e "${CYAN}${BOLD}┌─────── Configuration Summary ───────┐${NC}"
  echo -e "  Install dir  :  ${BOLD}${INSTALL_DIR}${NC}"
  echo -e "  Port         :  ${BOLD}${PORT}${NC}"
  echo -e "  Data dir     :  ${BOLD}${DATA_DIR}${NC}"
  echo -e "  BASE_URL     :  ${BOLD}${BASE_URL}${NC}"
  echo -e "  Admin user   :  ${BOLD}${ADMIN_USERNAME}${NC}"
  echo -e "  Admin pass   :  ${BOLD}********${NC}"
  echo -e "${CYAN}${BOLD}└──────────────────────────────────────┘${NC}"
  echo ""
  echo -en "${BOLD}Proceed with installation? ${NC}[${CYAN}Y/n${NC}]: "
  read -r CONFIRM
  CONFIRM="${CONFIRM:-Y}"
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    info "Installation cancelled."
    exit 0
  fi

  echo ""

  # ── Clone ─────────────────────────────
  if [ -d "$INSTALL_DIR" ]; then
    warn "Directory ${INSTALL_DIR} already exists."
    echo -en "${BOLD}   Overwrite? ${NC}[${CYAN}y/N${NC}]: "
    read -r OW
    if [[ "$OW" =~ ^[Yy]$ ]]; then
      rm -rf "$INSTALL_DIR"
    else
      err "Aborting. Please choose a different directory."
      exit 1
    fi
  fi

  info "Cloning repository..."
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  # ── Write .env ────────────────────────
  info "Writing .env..."
  cat > .env <<EOF
# Novel Object Storage — Generated by installer
PORT=${PORT}
HOST=0.0.0.0
BASE_URL=${BASE_URL}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
DATA_DIR=${DATA_DIR}
MAX_FILE_SIZE=524288000
TOKEN_EXPIRY=604800000
EOF

  # ── Install deps ──────────────────────
  info "Installing dependencies..."
  npm install --production

  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║         Installation Complete! 🎉            ║${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  Start the server:"
  echo -e "    ${CYAN}cd ${INSTALL_DIR} && npm start${NC}"
  echo ""
  echo -e "  Then open:  ${BOLD}${BASE_URL}${NC}"
  echo ""
  echo -e "  Login with:"
  echo -e "    Username:  ${BOLD}${ADMIN_USERNAME}${NC}"
  echo -e "    Password:  ${BOLD}(the one you just set)${NC}"
  echo ""

  # ── Optionally start now ──────────────
  echo -en "${BOLD}Start the server now? ${NC}[${CYAN}Y/n${NC}]: "
  read -r START_NOW
  START_NOW="${START_NOW:-Y}"
  if [[ "$START_NOW" =~ ^[Yy]$ ]]; then
    info "Starting Novel Object Storage..."
    npm start
  else
    info "You can start later with: cd ${INSTALL_DIR} && npm start"
  fi
}

main "$@"

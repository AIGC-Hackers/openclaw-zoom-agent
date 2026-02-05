#!/usr/bin/env bash
#
# OpenClaw Zoom Agent CLI
# 
# Join Zoom meetings with an AI-powered participant
#
# Usage:
#   ./cli.sh join --meeting-id 12345678901 --passcode 123456
#   ./cli.sh join --link "https://zoom.us/j/12345678901?pwd=abc123"
#   ./cli.sh status <call_id>
#   ./cli.sh end <call_id>
#

set -euo pipefail

# Load .env if exists
if [[ -f "$(dirname "$0")/.env" ]]; then
    export $(grep -v '^#' "$(dirname "$0")/.env" | xargs)
fi

# Configuration (override via environment or .env)
RETELL_API_KEY="${RETELL_API_KEY:-}"
RETELL_PHONE="${RETELL_PHONE:-}"
RETELL_AGENT_ID="${RETELL_AGENT_ID:-}"
ZOOM_DIALIN="${ZOOM_DIALIN:-+13017158592}"  # Washington DC
HUMAN_NAME="${HUMAN_NAME:-Kai}"
WEBSOCKET_URL="${WEBSOCKET_URL:-}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

usage() {
    cat << 'EOF'
OpenClaw Zoom Agent - AI meeting participant

COMMANDS:
    join        Join a Zoom meeting
    status      Check call status  
    end         End a call
    setup       Interactive setup

JOIN OPTIONS:
    --meeting-id, -m    Zoom meeting ID (digits only)
    --passcode, -p      Meeting passcode (numeric, if required)
    --link, -l          Zoom meeting link (extracts meeting ID)
    --name, -n          Human name to represent (default: Kai)
    --dialin, -d        Override Zoom dial-in number

ENVIRONMENT:
    RETELL_API_KEY      Retell AI API key
    RETELL_PHONE        Your Retell phone number (+1...)
    RETELL_AGENT_ID     Retell agent ID (custom LLM)
    WEBSOCKET_URL       Your WebSocket server URL

EXAMPLES:
    ./cli.sh join -m 12345678901 -p 123456
    ./cli.sh join --link "https://zoom.us/j/12345678901" --passcode 654321
    ./cli.sh status call_abc123...
    ./cli.sh end call_abc123...
EOF
}

log() { echo -e "${BLUE}[zoom-agent]${NC} $*"; }
error() { echo -e "${RED}[error]${NC} $*" >&2; }
success() { echo -e "${GREEN}[success]${NC} $*"; }

check_config() {
    local missing=()
    [[ -z "$RETELL_API_KEY" ]] && missing+=("RETELL_API_KEY")
    [[ -z "$RETELL_PHONE" ]] && missing+=("RETELL_PHONE")
    [[ -z "$RETELL_AGENT_ID" ]] && missing+=("RETELL_AGENT_ID")
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        error "Missing required configuration: ${missing[*]}"
        echo ""
        echo "Set these in .env or as environment variables."
        echo "Run './cli.sh setup' for interactive setup."
        exit 1
    fi
}

# Extract meeting ID from Zoom link
parse_zoom_link() {
    local link="$1"
    MEETING_ID=$(echo "$link" | grep -oE '/j/[0-9]+' | sed 's|/j/||' || true)
    # Note: pwd= in URL is a hash, not the numeric passcode
    PASSCODE=""
}

# Make outbound call to Zoom
join_meeting() {
    local meeting_id="$1"
    local passcode="${2:-}"
    local human_name="${3:-$HUMAN_NAME}"
    local dialin="${4:-$ZOOM_DIALIN}"
    
    check_config
    
    # Clean meeting ID (remove spaces, dashes)
    meeting_id=$(echo "$meeting_id" | tr -d ' -')
    
    log "Joining Zoom meeting..."
    log "  Meeting ID: $meeting_id"
    if [[ -n "$passcode" ]]; then
        log "  Passcode: $passcode"
    else
        echo -e "  ${YELLOW}Passcode: <none> (provide via --passcode if required)${NC}"
    fi
    log "  Dial-in: $dialin"
    log "  Representing: $human_name"
    log "  Agent: $RETELL_AGENT_ID"
    
    # Build dynamic variables for the agent
    local ws_url_with_params=""
    if [[ -n "$WEBSOCKET_URL" ]]; then
        ws_url_with_params="${WEBSOCKET_URL}?meeting_id=${meeting_id}&passcode=${passcode}&human_name=${human_name}"
    fi
    
    # Make the call
    response=$(curl -s -X POST "https://api.retellai.com/v2/create-phone-call" \
        -H "Authorization: Bearer $RETELL_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{
            \"from_number\": \"$RETELL_PHONE\",
            \"to_number\": \"$dialin\",
            \"agent_id\": \"$RETELL_AGENT_ID\",
            \"metadata\": {
                \"meeting_id\": \"$meeting_id\",
                \"passcode\": \"$passcode\",
                \"human_name\": \"$human_name\",
                \"type\": \"zoom_meeting\"
            }
        }")
    
    # Check for errors
    if echo "$response" | grep -q '"status":"error"'; then
        error "Failed to initiate call:"
        echo "$response" | jq -r '.message // .error // .' 2>/dev/null || echo "$response"
        exit 1
    fi
    
    call_id=$(echo "$response" | jq -r '.call_id // empty')
    call_status=$(echo "$response" | jq -r '.call_status // "unknown"')
    
    if [[ -z "$call_id" ]]; then
        error "No call_id in response:"
        echo "$response"
        exit 1
    fi
    
    success "Call initiated!"
    echo -e "  ${YELLOW}Call ID:${NC} $call_id"
    echo -e "  ${YELLOW}Status:${NC} $call_status"
    echo ""
    echo -e "Track progress: ${BLUE}./cli.sh status $call_id${NC}"
    echo -e "End call:       ${BLUE}./cli.sh end $call_id${NC}"
}

# Get call status
get_status() {
    local call_id="$1"
    check_config
    
    response=$(curl -s -X GET "https://api.retellai.com/v2/get-call/$call_id" \
        -H "Authorization: Bearer $RETELL_API_KEY")
    
    if echo "$response" | grep -q '"status":"error"'; then
        error "Failed to get call status"
        echo "$response" | jq -r '.message // .'
        exit 1
    fi
    
    echo "$response" | jq '{
        call_id,
        call_status,
        from_number,
        to_number,
        start_timestamp: (.start_timestamp | if . then (. / 1000 | strftime("%Y-%m-%d %H:%M:%S UTC")) else null end),
        duration_sec: ((.duration_ms // 0) / 1000 | floor),
        disconnection_reason,
        transcript: (.transcript // "No transcript yet")
    }'
}

# End a call
end_call() {
    local call_id="$1"
    check_config
    
    # Note: Retell doesn't have a public end-call API in v2
    # Calls end when the agent hangs up or max duration is reached
    log "Note: Calls end when the agent or remote party hangs up."
    log "Checking call status..."
    get_status "$call_id"
}

# Interactive setup
setup() {
    echo "OpenClaw Zoom Agent Setup"
    echo "========================="
    echo ""
    
    if [[ -f .env ]]; then
        echo "Existing .env found. Current values will be shown as defaults."
        source .env 2>/dev/null || true
    fi
    
    read -p "Retell API Key [$RETELL_API_KEY]: " input
    RETELL_API_KEY="${input:-$RETELL_API_KEY}"
    
    read -p "Retell Phone Number [$RETELL_PHONE]: " input
    RETELL_PHONE="${input:-$RETELL_PHONE}"
    
    read -p "Retell Agent ID [$RETELL_AGENT_ID]: " input
    RETELL_AGENT_ID="${input:-$RETELL_AGENT_ID}"
    
    read -p "WebSocket URL (optional) [$WEBSOCKET_URL]: " input
    WEBSOCKET_URL="${input:-$WEBSOCKET_URL}"
    
    read -p "OpenRouter API Key [$OPENROUTER_API_KEY]: " input
    OPENROUTER_API_KEY="${input:-$OPENROUTER_API_KEY}"
    
    cat > .env << EOF
# OpenClaw Zoom Agent Configuration
RETELL_API_KEY=$RETELL_API_KEY
RETELL_PHONE=$RETELL_PHONE
RETELL_AGENT_ID=$RETELL_AGENT_ID
WEBSOCKET_URL=$WEBSOCKET_URL
OPENROUTER_API_KEY=$OPENROUTER_API_KEY
MODEL=openai/gpt-4o
PORT=8080
EOF
    
    success "Configuration saved to .env"
}

# Main
main() {
    if [[ $# -lt 1 ]]; then
        usage
        exit 1
    fi
    
    local cmd="$1"
    shift
    
    case "$cmd" in
        join)
            local meeting_id=""
            local passcode=""
            local link=""
            local name="$HUMAN_NAME"
            local dialin="$ZOOM_DIALIN"
            
            while [[ $# -gt 0 ]]; do
                case "$1" in
                    -m|--meeting-id) meeting_id="$2"; shift 2 ;;
                    -p|--passcode) passcode="$2"; shift 2 ;;
                    -l|--link) link="$2"; shift 2 ;;
                    -n|--name) name="$2"; shift 2 ;;
                    -d|--dialin) dialin="$2"; shift 2 ;;
                    *) error "Unknown option: $1"; exit 1 ;;
                esac
            done
            
            # Parse link if provided
            if [[ -n "$link" ]]; then
                parse_zoom_link "$link"
                meeting_id="${MEETING_ID:-$meeting_id}"
            fi
            
            if [[ -z "$meeting_id" ]]; then
                error "Meeting ID required. Use --meeting-id or --link"
                exit 1
            fi
            
            join_meeting "$meeting_id" "$passcode" "$name" "$dialin"
            ;;
        
        status)
            if [[ $# -lt 1 ]]; then
                error "Call ID required"
                exit 1
            fi
            get_status "$1"
            ;;
        
        end)
            if [[ $# -lt 1 ]]; then
                error "Call ID required"
                exit 1
            fi
            end_call "$1"
            ;;
        
        setup)
            setup
            ;;
        
        -h|--help|help)
            usage
            ;;
        
        *)
            error "Unknown command: $cmd"
            usage
            exit 1
            ;;
    esac
}

main "$@"

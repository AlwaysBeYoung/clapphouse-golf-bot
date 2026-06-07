#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║     DEPLOY.SH — Golf Bot Full Cloud Deployment Script              ║
# ║     Usage: bash deploy.sh                                          ║
# ╚══════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_NAME="clapphouse-golf-bot"
GITHUB_USER="AlwaysBeYoung"
PROJECT_DIR="/Users/alonso/Desktop/Test of Roborock/Golf Bot"

# ── Colors ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${GREEN}${BOLD}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     ⛳  GOLF BOT — Cloud Deployment Script  ⛳              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

cd "$PROJECT_DIR"

# ── Step 1: Verify project ────────────────────────────────────────────
echo -e "${BOLD}[1/5]${NC} Verifying project files..."
for f in package.json server.js docs/index.html render.yaml; do
  if [ -f "$f" ]; then
    echo -e "  ${GREEN}✅${NC} $f"
  else
    echo -e "  ${RED}❌ MISSING: $f${NC}"
    exit 1
  fi
done
echo ""

# ── Step 2: Ensure git is clean ────────────────────────────────────────
echo -e "${BOLD}[2/5]${NC} Checking git status..."
if [ ! -d ".git" ]; then
  echo -e "  ${RED}❌ Not a git repository. Run 'git init' first.${NC}"
  exit 1
fi

COMMIT_COUNT=$(git rev-list --count HEAD 2>/dev/null || echo 0)
echo -e "  ${GREEN}✅${NC} Git repo ready — ${COMMIT_COUNT} commit(s) on main"
echo ""

# ── Step 3: Create GitHub repository ───────────────────────────────────
echo -e "${BOLD}[3/5]${NC} Creating GitHub repository '${REPO_NAME}'..."

# Try gh CLI first
if command -v gh &> /dev/null; then
  echo "  Using GitHub CLI (gh)..."
  if gh auth status &> /dev/null; then
    gh repo create "$GITHUB_USER/$REPO_NAME" --public --source=. --remote=origin --push
    echo -e "  ${GREEN}✅${NC} Repository created and code pushed via gh CLI"
  else
    echo -e "  ${YELLOW}⚠️  gh CLI not authenticated. Run: gh auth login${NC}"
    echo "  Falling back to manual setup..."
    NEEDS_MANUAL=true
  fi
else
  NEEDS_MANUAL=true
fi

# ── Step 3b: Manual GitHub setup (if gh not available) ─────────────────
if [ "${NEEDS_MANUAL:-false}" = true ]; then
  echo ""
  echo -e "  ${YELLOW}${BOLD}⚠️  GitHub CLI (gh) not available.${NC}"
  echo ""
  echo -e "  ${BOLD}OPTION A — VS Code (Easiest, one click):${NC}"
  echo "    1. Open VS Code Source Control panel (Ctrl+Shift+G)"
  echo "    2. Click the blue ${BOLD}\"Publish Branch\"${NC} button at the top"
  echo "    3. Name the repository: ${BOLD}${REPO_NAME}${NC}"
  echo "    4. Choose \"Public\" visibility"
  echo "    5. VS Code auto-creates the repo and pushes your code"
  echo ""
  echo -e "  ${BOLD}OPTION B — Manual Terminal:${NC}"
  echo "    1. Open: ${BOLD}https://github.com/new${NC}"
  echo "    2. Repository name: ${BOLD}${REPO_NAME}${NC}"
  echo "    3. Select: ${BOLD}Public${NC}"
  echo "    4. ${BOLD}UNCHECK${NC} 'Add a README file'"
  echo "    5. ${BOLD}UNCHECK${NC} 'Add .gitignore'"
  echo "    6. Click ${BOLD}'Create repository'${NC}"
  echo "    7. Then run these commands:"
  echo ""
  echo -e "       ${GREEN}git remote add origin https://github.com/${GITHUB_USER}/${REPO_NAME}.git${NC}"
  echo -e "       ${GREEN}git branch -M main${NC}"
  echo -e "       ${GREEN}git push -u origin main${NC}"
  echo ""
  echo -e "  ${BOLD}OPTION C — Use a Personal Access Token:${NC}"
  echo "    1. Generate a token at: https://github.com/settings/tokens"
  echo "    2. Select scope: ${BOLD}repo${NC} (full control)"
  echo "    3. Copy the token, then run:"
  echo ""
  echo -e "       ${GREEN}export GITHUB_TOKEN='ghp_xxxxxxxxxxxx'${NC}"
  echo -e "       ${GREEN}bash deploy.sh${NC}  (re-run this script)"
  echo ""
  echo -e "  ${YELLOW}After completing any of the above options, re-run this script.${NC}"
  exit 0
fi

# ── Step 4: Push to GitHub ─────────────────────────────────────────────
echo -e "${BOLD}[4/5]${NC} Pushing code to GitHub..."
git branch -M main
git remote add origin "https://github.com/$GITHUB_USER/$REPO_NAME.git" 2>/dev/null || git remote set-url origin "https://github.com/$GITHUB_USER/$REPO_NAME.git"
git push -u origin main
echo -e "  ${GREEN}✅${NC} Code pushed to GitHub"
echo ""

# ── Step 5: Next steps ─────────────────────────────────────────────────
echo -e "${BOLD}[5/5]${NC} Deployment Summary"
echo ""
echo -e "  ${GREEN}${BOLD}✅ Git repository:${NC} https://github.com/${GITHUB_USER}/${REPO_NAME}"
echo ""
echo -e "  ${YELLOW}${BOLD}📋 NEXT: Render Backend Deployment${NC}"
echo "    1. Go to: ${BOLD}https://dashboard.render.com${NC}"
echo "    2. Click ${BOLD}Blueprints${NC} → ${BOLD}New Blueprint Instance${NC}"
echo "    3. Connect your GitHub repo: ${GITHUB_USER}/${REPO_NAME}"
echo "    4. Render auto-detects ${BOLD}render.yaml${NC}"
echo "    5. Click ${BOLD}Apply${NC}"
echo "    → Backend will be live at: ${BOLD}https://${REPO_NAME}-backend.onrender.com${NC}"
echo ""
echo -e "  ${YELLOW}${BOLD}📋 NEXT: GitHub Pages (Frontend)${NC}"
echo "    1. Go to: ${BOLD}https://github.com/${GITHUB_USER}/${REPO_NAME}/settings/pages${NC}"
echo "    2. Source: ${BOLD}Deploy from a branch${NC}"
echo "    3. Branch: ${BOLD}main${NC} / Folder: ${BOLD}/docs${NC}"
echo "    4. Click ${BOLD}Save${NC}"
echo "    → Frontend will be live at: ${BOLD}https://${GITHUB_USER}.github.io/${REPO_NAME}/${NC}"
echo ""
echo -e "  ${GREEN}${BOLD}⛳ Done! Share these URLs with the senior players:${NC}"
echo -e "     📱 Frontend: ${BOLD}https://${GITHUB_USER}.github.io/${REPO_NAME}/${NC}"
echo -e "     ⚙️  Backend:  ${BOLD}https://${REPO_NAME}-backend.onrender.com${NC}"
echo ""

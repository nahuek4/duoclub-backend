#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="${HOME}/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null
fi

cd /home/damianvillaverde-api/htdocs/api.damianvillaverde.com/backend
exec 9>"$HOME/.damian-deploy.lock"
flock -n 9 || exit 0

if [ "$(git branch --show-current)" != "migracion-damian" ]; then
  echo "La carpeta debe estar en migracion-damian." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Hay cambios locales pendientes en el VPS. Revisarlos antes de desplegar." >&2
  exit 1
fi

export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15"
git fetch --quiet origin migracion-damian
target=$(git rev-parse origin/migracion-damian)
marker="$HOME/.damian-deployed-commit"
if [ -f "$marker" ] && [ "$(cat "$marker")" = "$target" ] &&
   [ "$(git rev-parse HEAD)" = "$target" ]; then
  exit 0
fi

git merge --ff-only origin/migracion-damian
npm ci --omit=dev
pm2 restart damianvillaverde-api --update-env
curl --fail --silent --show-error \
  --retry 15 --retry-connrefused --retry-delay 2 --retry-max-time 90 \
  --max-time 5 http://127.0.0.1:3001/health >/dev/null
pm2 save
printf '%s\n' "$target" > "$marker"
printf 'Despliegue completado %s %s\n' "$(date -Is)" "$target"

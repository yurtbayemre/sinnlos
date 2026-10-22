# shellcheck shell=bash
#
# infra/deploy-env.sh — sourced by infra/deploy.sh and infra/backup/pg-backup.sh
# (never run on its own). load_deploy_env FILE CHECKOUT reads the optional
# host settings in FILE (infra/deploy.env, gitignored; infra/deploy.env.example
# documents every key) before the scripts assign their defaults.
#
# The file is data, never code: KEY=value lines, split at the first `=`, the
# value taken literally (no quotes, no expansion); `#` comment lines and blank
# lines are skipped. A key the caller's environment already sets (also to an
# empty value) keeps the caller's value; every other key is exported, so the
# scripts deploy.sh starts (pg-backup.sh, live-smoke.sh) see it too.
#
# Refused with exit 2, before anything is changed:
#   - a file not owned by the checkout's owner or root, or writable by group or
#     others (root's cron and deploy.sh read it; the symlink target counts);
#   - CRLF line endings, a line without `=`, an unknown or a repeated key;
#   - a path setting that is not absolute (cron runs in another directory);
#   - no COMPOSE_PROJECT, or one other than the project the caller deploys
#     (COMPOSE_PROJECT in the environment, else infra): the file belongs to
#     one compose project, so a staging run from the same checkout never takes
#     production's backup dir, .env copy or smoke URL.

DEPLOY_ENV_KEYS=" COMPOSE_PROJECT DEPLOY_EDGE DEPLOY_IMAGE_SOURCE BACKUP_RUN PASSWORDS_FILE SMOKE_URL SMOKE_EMAIL SMOKE_AUTHOR_EMAIL SINNLOS_BACKUP_DIR SINNLOS_ENV_FILE SINNLOS_LOCAL_ENV_BACKUP "
DEPLOY_ENV_PATH_KEYS=" BACKUP_RUN PASSWORDS_FILE SINNLOS_BACKUP_DIR SINNLOS_ENV_FILE SINNLOS_LOCAL_ENV_BACKUP "

deploy_env_refuse() {
  echo "ERROR: ${DEPLOY_ENV_FILE}: $*" >&2
  echo "       Nothing was changed (infra/deploy.env.example describes the file)." >&2
  exit 2
}

load_deploy_env() {
  DEPLOY_ENV_FILE="$1"
  local checkout="$2" real owner mode line key value n=0 seen=" " project=""
  [[ -e "${DEPLOY_ENV_FILE}" || -L "${DEPLOY_ENV_FILE}" ]] || return 0
  real="$(readlink -f -- "${DEPLOY_ENV_FILE}")" && [[ -f "${real}" ]] ||
    deploy_env_refuse "not a regular file"
  read -r owner mode < <(stat -c '%u %a' -- "${real}")
  if [[ "${owner}" != 0 && "${owner}" != "$(stat -c %u -- "${checkout}")" ]]; then
    deploy_env_refuse "owned by uid ${owner}, neither the checkout's owner nor root"
  fi
  (((8#${mode} & 8#022) == 0)) || deploy_env_refuse "writable by group or others (mode ${mode}): chmod 600 it"
  while IFS= read -r line || [[ -n "${line}" ]]; do
    n=$((n + 1))
    [[ "${line}" != *$'\r' ]] || deploy_env_refuse "line ${n}: CRLF line ending (save it with LF)"
    [[ -z "${line//[[:space:]]/}" || "${line}" =~ ^[[:space:]]*# ]] && continue
    [[ "${line}" == *=* ]] || deploy_env_refuse "line ${n}: not KEY=value"
    key="${line%%=*}"
    value="${line#*=}"
    [[ "${DEPLOY_ENV_KEYS}" == *" ${key} "* ]] || deploy_env_refuse "line ${n}: unknown key '${key}'"
    [[ "${seen}" != *" ${key} "* ]] || deploy_env_refuse "line ${n}: ${key} is set twice"
    seen+="${key} "
    if [[ "${DEPLOY_ENV_PATH_KEYS}" == *" ${key} "* && "${value}" != /* ]]; then
      deploy_env_refuse "line ${n}: ${key} must be an absolute path"
    fi
    [[ "${key}" != COMPOSE_PROJECT ]] || project="${value}"
    # The caller's environment wins, an empty value included.
    [[ -v "${key}" ]] || export "${key}=${value}"
  done <"${real}"
  [[ -n "${project}" ]] || deploy_env_refuse "COMPOSE_PROJECT=<name> is missing: the file belongs to one compose project"
  if [[ "${COMPOSE_PROJECT:-infra}" != "${project}" ]]; then
    deploy_env_refuse "it is for compose project ${project}, not ${COMPOSE_PROJECT:-infra}"
  fi
}

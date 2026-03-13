#!/bin/bash
cd "$(dirname "$0")"
GIT_SSH_COMMAND="ssh -i ~/.ssh/tbdeploy -o IdentitiesOnly=yes" git pull
node sqlite-init.js
npm start

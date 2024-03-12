set -x

command -v yarn &> /dev/null || npm i -g yarn
rm -rf typescript-eslint
git clone --depth 1 https://github.com/typescript-eslint/typescript-eslint.git typescript-eslint
cd typescript-eslint

export NX_NO_CLOUD=true

npx json -I -f package.json -e "this.resolutions.typescript = 'file:$TS'"
git diff

yarn
yarn tsc --version

yarn typecheck

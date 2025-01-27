npm i -g pnpm
rm -rf arktype
git clone --depth 1 https://github.com/arktypeio/arktype.git arktype
cd arktype

npx json -I -f package.json -e "this.resolutions.typescript = 'file:$TS'"
pnpm i
pnpm tsc

npm i -g pnpm
rm -rf arktype
git clone --depth 1 https://github.com/arktypeio/arktype.git arktype
cd arktype

pnpm i
pnpm build
